import { randomUUID } from "node:crypto";
import { ForgeError, type Attachment, type Session } from "@forge/protocol";
import { buildAttachmentBlocks } from "../claude/attachments.js";
import type { OutgoingMessage } from "../claude/runtime.js";
import { BUSY, REMOTE_PLACEHOLDER_TITLE, titleFrom, type LiveSession } from "./live-session.js";
import type { RemoteBridge } from "./remote-bridge.js";
import type { SessionCore } from "./session-core.js";
import type { TurnAutomation } from "./turn-automation.js";

/** How long send() waits for a closing process to end before it starts a new one. */
const CLOSE_WAIT_MS = 5_000;

export interface TurnHost {
  /** no process runs for the session: start one with the message */
  resume(sessionId: string, text: string, attachments: Attachment[]): Promise<Session>;
}

/** A user turn built for sending; recorded in the timeline only right before it is handed to the CLI. */
export interface BuiltTurn {
  msg: OutgoingMessage;
  meta: Array<{ name: string; mediaType: string; size: number }>;
}

/**
 * User messages on their way to the CLI: a message starts a turn, joins the running one, or waits
 * until the previous turn's tests and auto-commit are done.
 */
export class TurnDispatch {
  constructor(
    private readonly core: SessionCore,
    private readonly automation: TurnAutomation,
    private readonly remote: RemoteBridge,
    private readonly host: TurnHost,
  ) {}

  /** A CLI turn started: counted for the auto-commit check and shown as running. */
  markRunning(id: string, live: LiveSession) {
    live.turnActive = true;
    this.automation.noteTurnStart(id);
    const status = this.core.db.getSession(id)?.status;
    if (status !== "running" && status !== "waiting_approval") this.core.setStatus(id, "running");
  }

  /** A turn the CLI started without a FORGE send: a message from the Claude app, or one it had queued. */
  cliTurnStarted(id: string, live: LiveSession, fromRemote: boolean) {
    if (fromRemote) {
      live.remoteTurn = { sawMessage: false };
      const rec = this.core.db.getSession(id);
      if (rec) void this.automation.captureBaseline(id, rec.cwd);
    }
    this.markRunning(id, live);
  }

  /** Builds the outgoing turn (text + attachment blocks + id); a turn that starts now gets a fresh baseline. */
  async build(sessionId: string, text: string, attachments: Attachment[], newTurn: boolean): Promise<BuiltTurn> {
    const rec = this.core.db.getSession(sessionId);
    // A message sent mid-turn joins the running turn; its baseline must stay the one from the turn start.
    if (rec && newTurn) await this.automation.captureBaseline(sessionId, rec.cwd);
    const { blocks, meta } = attachments.length ? await buildAttachmentBlocks(attachments) : { blocks: [], meta: [] };
    return { msg: { text, blocks, uuid: randomUUID() }, meta };
  }

  record(sessionId: string, t: BuiltTurn) {
    this.core.live.get(sessionId)?.seenUuids.add(t.msg.uuid);
    this.core.record(sessionId, { type: "user.message", text: t.msg.text, uuid: t.msg.uuid, ...(t.meta.length ? { attachments: t.meta } : {}) });
    this.titleFromFirstMessage(sessionId, t.msg.text);
  }

  async send(sessionId: string, text: string, attachments: Attachment[] = []): Promise<Session> {
    let live = this.core.live.get(sessionId);
    if (live?.closing) {
      // close() was called but the process has not ended yet: its input queue no longer takes messages.
      await Promise.race([live.ended, new Promise((r) => setTimeout(r, CLOSE_WAIT_MS))]);
      live = this.core.live.get(sessionId);
      if (live?.closing) throw new ForgeError("SESSION_BUSY", "Die Session wird gerade beendet. Bitte gleich erneut senden.");
    }
    if (!live) return this.host.resume(sessionId, text, attachments);
    if (live.pending.size > 0) throw new ForgeError("SESSION_BUSY", "Erst die offene Freigabeanfrage beantworten.");
    const status = this.core.db.getSession(sessionId)?.status;
    const turn = await this.build(sessionId, text, attachments, !this.automation.isBusy(sessionId) && !(status && BUSY.includes(status)));
    // Re-checked after the await: nothing is recorded for a message that cannot be delivered.
    if (this.core.live.get(sessionId) !== live || live.closing) throw new ForgeError("SESSION_BUSY", "Die Session wurde beendet, bevor die Nachricht gesendet werden konnte. Bitte erneut senden.");
    if (live.pending.size > 0) throw new ForgeError("SESSION_BUSY", "Erst die offene Freigabeanfrage beantworten.");
    this.record(sessionId, turn);
    if (this.automation.isBusy(sessionId)) {
      this.hold(sessionId, live, turn.msg);
    } else {
      // While a turn runs the CLI queues the message and folds it in after the current tool step.
      live.rt.sendMessage(turn.msg);
      this.markRunning(sessionId, live);
    }
    return this.core.get(sessionId);
  }

  /** Holds a message until the previous turn's tests and auto-commit are done, so they see only that turn. */
  hold(id: string, live: LiveSession, msg: OutgoingMessage) {
    this.core.setStatus(id, "running", "Wartet auf Tests und Auto-Commit des letzten Durchlaufs");
    this.automation.hold(id, {
      deliver: () => this.automation.track(this.deliverHeld(id, live, msg)),
      drop: (reason) => this.core.record(id, { type: "error", message: `Nachricht nicht gesendet: ${reason}.`, retryable: true }),
    });
  }

  private async deliverHeld(id: string, live: LiveSession, msg: OutgoingMessage) {
    const rec = this.core.db.getSession(id);
    if (rec) await this.automation.captureBaseline(id, rec.cwd);
    if (this.core.live.get(id) !== live || live.closing) {
      this.core.record(id, { type: "error", message: "Nachricht nicht gesendet: Session beendet.", retryable: true });
      return;
    }
    live.rt.sendMessage(msg);
    this.markRunning(id, live);
    // clears the "waiting for tests" detail
    this.core.setStatus(id, "running");
  }

  /** An empty session opened for the Claude app takes its title from the first message, from either side. */
  titleFromFirstMessage(id: string, text: string) {
    const rec = this.core.db.getSession(id);
    if (rec?.title !== REMOTE_PLACEHOLDER_TITLE || !text.trim()) return;
    this.core.publish(this.core.db.updateSession(id, { title: titleFrom(text) }));
    this.remote.update(id, {});
  }
}
