import { randomUUID } from "node:crypto";
import type { SessionEventBody } from "@forge/protocol";
import type { SessionCore } from "./session-core.js";
import type { BuiltTurn, TurnDispatch } from "./turns.js";
import { tr } from "../i18n/index.js";

type TurnResult = Extract<SessionEventBody, { type: "turn.result" }>;

/** Claude Code ends a turn with this when the request no longer fits into the context window. */
export function isPromptTooLong(body: TurnResult): boolean {
  return body.isError && /prompt is too long/i.test(body.text ?? "");
}

/**
 * A turn that failed because the context is full: FORGE runs /compact and then sends the turn's
 * messages again, once. Claude Code compacts on its own as the context fills up; this covers the
 * case where a single turn still overflows it.
 */
export class ContextRecovery {
  /** session -> messages to send again once /compact is through */
  private readonly waiting = new Map<string, BuiltTurn[]>();
  /** ids of messages FORGE already sent again; when one fails as well, FORGE reports it instead of looping */
  private readonly resent = new Set<string>();

  constructor(
    private readonly core: SessionCore,
    private readonly turns: TurnDispatch,
    private readonly track: (p: Promise<unknown>) => void,
  ) {}

  onTurnResult(id: string, body: TurnResult, interrupted: boolean) {
    let sent = this.turns.takeTurnMessages(id);
    const waiting = this.waiting.get(id);
    if (waiting) {
      this.waiting.delete(id);
      if (interrupted) return;
      if (body.isError) return this.fail(id, tr().core.sessions.compactFailed);
      this.track(this.resend(id, waiting));
      return;
    }
    if (interrupted || !isPromptTooLong(body)) return;
    // A slash command that overflowed is not repeated; a turn without a FORGE message came from the CLI or the Claude app.
    sent = sent.filter((t) => !t.msg.text.startsWith("/"));
    if (!sent.length) return this.fail(id, tr().core.sessions.contextFull);
    if (sent.some((t) => this.resent.has(t.msg.uuid))) {
      return this.fail(id, tr().core.sessions.stillTooLong);
    }
    this.waiting.set(id, sent);
    this.core.setStatus(id, "running", tr().core.sessions.compacting);
    this.track(
      this.turns.send(id, "/compact", [], "auto").catch((e: unknown) => {
        this.waiting.delete(id);
        this.core.setStatus(id, "idle");
        this.fail(id, tr().core.sessions.compactNotStarted(e instanceof Error ? e.message : String(e)));
      }),
    );
  }

  private async resend(id: string, sent: BuiltTurn[]) {
    const turn: BuiltTurn = {
      msg: {
        text: sent.map((t) => t.msg.text).join("\n\n"),
        // Goes to Claude in front of the message sent again; the timeline shows only the message.
        blocks: [{ type: "text", text: tr().core.sessions.resendNote }, ...sent.flatMap((t) => t.msg.blocks)],
        uuid: randomUUID(),
      },
      meta: sent.flatMap((t) => t.meta),
      source: "auto",
    };
    this.resent.add(turn.msg.uuid);
    try {
      await this.turns.resend(id, turn);
    } catch (e) {
      this.fail(id, tr().core.sessions.notResent(e instanceof Error ? e.message : String(e)));
    }
  }

  private fail(id: string, message: string) {
    this.core.record(id, { type: "error", message, retryable: false });
  }
}
