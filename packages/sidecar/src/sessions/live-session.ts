import type { BackgroundTask, ContextUsage, SessionStatus } from "@forge/protocol";
import type { ApprovalDecision, ApprovalRequest, RuntimeSession } from "../claude/runtime.js";
import type { Normalizer } from "../claude/normalize.js";
import type { ProfileConfig } from "../policy/profiles.js";
import { REPLAY_FLAG } from "../claude/runtime.js";

export interface PendingApproval {
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

/** A session with a running CLI process in this app instance. */
export interface LiveSession {
  rt: RuntimeSession;
  normalizer: Normalizer;
  pending: Map<string, PendingApproval>;
  profile: ProfileConfig;
  projectDir: string;
  /** set by stop(); a result after an interrupt is not an error */
  interrupting: boolean;
  /** set by close()/shutdown(); the process is ending, new messages must not go to it */
  closing: boolean;
  /** a CLI turn runs (started by a message, the Claude app or a finished background task) */
  turnActive: boolean;
  /** resolves when the process has ended (onEnd ran) */
  ended: Promise<void>;
  markEnded: () => void;
  /** user message ids already in the timeline (own sends, imports, echoes) */
  seenUuids: Set<string>;
  /** a turn started by a message from the Claude app (Remote Control) */
  remoteTurn: { sawMessage: boolean } | null;
  /** still running background tasks, keyed by task id; ends with the process */
  background: Map<string, BackgroundTask>;
  /** context window usage after the last turn */
  context: ContextUsage | null;
}

/** Statuses in which the CLI may be touching files. */
export const BUSY: SessionStatus[] = ["starting", "running", "waiting_approval"];

/** Title of a session that was opened empty for the Claude app; replaced by the first message. */
export const REMOTE_PLACEHOLDER_TITLE = "Remote-Session";

/** Enough to recognise echoes and find the last known message in a transcript; older ids are not needed. */
const SEEN_UUIDS_KEEP = 500;

export function pruneSeenUuids(seen: Set<string>) {
  if (seen.size <= SEEN_UUIDS_KEEP * 2) return;
  const drop = seen.size - SEEN_UUIDS_KEEP;
  let i = 0;
  for (const id of seen) {
    if (i++ >= drop) break;
    seen.delete(id);
  }
}

/** Ends the process. It stays in the live map until onEnd runs, but must not take new messages. */
export function closeLive(live: LiveSession) {
  live.closing = true;
  live.rt.close();
}

export function titleFrom(prompt: string): string {
  const first = prompt.trim().split(/\r?\n/)[0] ?? "";
  return first.length > 80 ? first.slice(0, 77) + "…" : first;
}

export function describeRuntimeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not logged in|please run \/login|invalid api key|authentication/i.test(msg)) {
    return "Claude Code ist nicht angemeldet oder die Anmeldung ist ungültig. In den Einstellungen unter Claude Code mit „Mit Claude-Konto anmelden“ neu anmelden.";
  }
  if (new RegExp(`unknown option.*${REPLAY_FLAG}`, "i").test(msg)) {
    return "Diese Claude-Code-Version ist zu alt für FORGE. Bitte Claude Code aktualisieren (Update-Knopf in der Seitenleiste).";
  }
  if (/ENOENT|failed to launch/i.test(msg)) return "Claude Code CLI konnte nicht gestartet werden. Pfad in den Einstellungen prüfen.";
  return msg.slice(0, 2000);
}
