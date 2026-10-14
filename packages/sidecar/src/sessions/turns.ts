import { randomUUID } from "node:crypto";
import { ForgeError, type Attachment, type Session } from "@forge/protocol";
import { buildAttachmentBlocks, fitMessageText, type Spill } from "../claude/attachments.js";
import type { OutgoingMessage } from "../claude/runtime.js";
import { BUSY, endLive, REMOTE_PLACEHOLDER_TITLE, titleFrom, type LiveSession } from "./live-session.js";
import type { RemoteBridge } from "./remote-bridge.js";
import type { SessionCore } from "./session-core.js";
import type { TurnAutomation } from "./turn-automation.js";

export interface TurnHost {
  /** no process runs for the session: start one with the message */
  resume(sessionId: string, text: string, attachments: Attachment[], source?: MessageSource): Promise<Session>;
  /** a message from FORGE (composer, phone) or an automatic one reached the timeline */
  userMessage(sessionId: string, text: string, source?: MessageSource): void;
  /** stores what is too large for a message (long texts, big attachments) for Claude to read */
  spill: Spill;
}

/** "auto": sent by FORGE itself; "claude": sent by Claude from another session. The timeline marks both as not typed by the user. */
export type MessageSource = "auto" | "claude";

/** A user turn built for sending; recorded in the timeline only right before it is handed to the CLI. */
export interface BuiltTurn {
  msg: OutgoingMessage;
  meta: Array<{ name: string; mediaType: string; size: number }>;
  source?: MessageSource;
}

/**
 * User messages on their way to the CLI: a message starts a turn, joins the running one, or waits
 * until the previous turn's tests and auto-commit are done.
 */
export class TurnDispatch {
  /** messages recorded since the session's last turn result: what a failed turn was asked to do */
  private readonly sinceResult = new Map<string, BuiltTurn[]>();

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
  async build(sessionId: string, text: string, attachments: Attachment[], newTurn: boolean, source?: MessageSource): Promise<BuiltTurn> {
    const rec = this.core.db.getSession(sessionId);
    // A message sent mid-turn joins the running turn; its baseline must stay the one from the turn start.
    if (rec && newTurn) await this.automation.captureBaseline(sessionId, rec.cwd);
    const { blocks, meta } = attachments.length ? await buildAttachmentBlocks(attachments, this.host.spill) : { blocks: [], meta: [] };
    // The timeline shows what Claude got: a shortened text names the file with the full one.
    const fitted = await fitMessageText(text, this.host.spill);
    return { msg: { text: fitted, blocks, uuid: randomUUID() }, meta, ...(source ? { source } : {}) };
  }

  /**
   * Adds what auto-commit and auto-push did since Claude's last message, as a block before the text.
   * Taken at delivery, after the post-turn work is done; the timeline keeps showing only the user's text.
   */
  withNote(sessionId: string, msg: OutgoingMessage): OutgoingMessage {
    const note = this.automation.takeNote(sessionId);
    return note ? { ...msg, blocks: [{ type: "text", text: note }, ...msg.blocks] } : msg;
  }

  record(sessionId: string, t: BuiltTurn) {
    this.core.live.get(sessionId)?.seenUuids.add(t.msg.uuid);
    this.core.record(sessionId, { type: "user.message", text: t.msg.text, uuid: t.msg.uuid, ...(t.meta.length ? { attachments: t.meta } : {}), ...(t.source ? { source: t.source } : {}) });
    this.sinceResult.set(sessionId, [...(this.sinceResult.get(sessionId) ?? []), t]);
    this.titleFromFirstMessage(sessionId, t.msg.text);
    this.host.userMessage(sessionId, t.msg.text, t.source);
  }

  /** The messages of the turn that just ended; forgotten with it, so their attachments are not kept. */
  takeTurnMessages(sessionId: string): BuiltTurn[] {
    const sent = this.sinceResult.get(sessionId) ?? [];
    this.sinceResult.delete(sessionId);
    return sent;
  }

  async send(sessionId: string, text: string, attachments: Attachment[] = [], source?: MessageSource): Promise<Session> {
    let live = this.core.live.get(sessionId);
    if (live?.closing) {
      // close() was called but the process has not ended yet: its input queue no longer takes messages.
      await endLive(live);
      live = this.core.live.get(sessionId);
      if (live?.closing) throw new ForgeError("SESSION_BUSY", "Die Session wird gerade beendet. Bitte gleich erneut senden.");
    }
    if (!live) return this.host.resume(sessionId, text, attachments, source);
    if (live.pending.size > 0) throw new ForgeError("SESSION_BUSY", "Erst die offene Freigabeanfrage beantworten.");
    const status = this.core.db.getSession(sessionId)?.status;
    const turn = await this.build(sessionId, text, attachments, !this.automation.isBusy(sessionId) && !(status && BUSY.includes(status)), source);
    return this.deliver(sessionId, live, turn);
  }

  /** Sends an already built turn again (after compacting a full context) into the running process. */
  async resend(sessionId: string, turn: BuiltTurn): Promise<Session> {
    const live = this.core.live.get(sessionId);
    if (!live || live.closing) throw new ForgeError("SESSION_BUSY", "Die Session wurde beendet, bevor die Nachricht erneut gesendet werden konnte.");
    const rec = this.core.db.getSession(sessionId);
    if (rec && !this.automation.isBusy(sessionId) && !BUSY.includes(rec.status)) await this.automation.captureBaseline(sessionId, rec.cwd);
    return this.deliver(sessionId, live, turn);
  }

  private deliver(sessionId: string, live: LiveSession, turn: BuiltTurn): Session {
    // Re-checked after the await: nothing is recorded for a message that cannot be delivered.
    if (this.core.live.get(sessionId) !== live || live.closing) throw new ForgeError("SESSION_BUSY", "Die Session wurde beendet, bevor die Nachricht gesendet werden konnte. Bitte erneut senden.");
    if (live.pending.size > 0) throw new ForgeError("SESSION_BUSY", "Erst die offene Freigabeanfrage beantworten.");
    this.record(sessionId, turn);
    if (this.automation.isBusy(sessionId)) {
      this.hold(sessionId, live, turn.msg);
    } else {
      // While a turn runs the CLI queues the message and folds it in after the current tool step.
      live.rt.sendMessage(this.withNote(sessionId, turn.msg));
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
    live.rt.sendMessage(this.withNote(id, msg));
    this.markRunning(id, live);
    // clears the "waiting for tests" detail
    this.core.setStatus(id, "running");
  }

  /** A session started without a prompt takes its title from the first message, from either side. */
  titleFromFirstMessage(id: string, text: string) {
    const rec = this.core.db.getSession(id);
    if (rec?.title !== REMOTE_PLACEHOLDER_TITLE || !text.trim()) return;
    this.core.publish(this.core.db.updateSession(id, { title: titleFrom(text) }));
    this.remote.retitle(id);
  }
}
