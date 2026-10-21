import type { SessionEvent, SessionStatus } from "@forge/protocol";

type TurnResult = Extract<SessionEvent["body"], { type: "turn.result" }>;

/**
 * Claude is inside a turn. Stopping counts as working: the turn has not ended yet, so retry, model
 * and effort changes stay disabled and the working indicator stays visible until it really ends.
 */
const WORKING: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["starting", "running", "stopping"]);

export function isWorking(status: SessionStatus | null | undefined): boolean {
  return !!status && WORKING.has(status);
}

/** Working or waiting for the user: sessions in this state show an active dot and cannot be closed from a tab. */
export function isBusy(status: SessionStatus | null | undefined): boolean {
  return isWorking(status) || status === "waiting_approval";
}

/** A failed turn that the user (or FORGE) stopped on purpose; shown as "Gestoppt" and not announced as an error. */
export function isInterrupted(body: Pick<TurnResult, "isError" | "subtype" | "text" | "interrupted">): boolean {
  // The text covers results recorded before `interrupted`; "result_type=user" is a stop in newer CLIs.
  return body.isError && (body.interrupted === true || /interrupt|abort|abgebrochen|result_type=user/i.test(`${body.subtype} ${body.text ?? ""}`));
}
