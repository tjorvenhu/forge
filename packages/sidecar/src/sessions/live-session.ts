import type { BackgroundTask, ContextUsage, SessionStatus, SubagentProgress } from "@forge/protocol";
import type { ApprovalDecision, ApprovalRequest, RuntimeSession } from "../claude/runtime.js";
import type { Normalizer } from "../claude/normalize.js";
import type { ProfileConfig } from "../policy/profiles.js";
import { REPLAY_FLAG } from "../claude/runtime.js";
import { de } from "../i18n/de/index.js";
import { en } from "../i18n/en/index.js";
import { tr } from "../i18n/index.js";

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
  /** status detail recorded when the process has ended (why it was closed) */
  endDetail?: string;
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
  /** subagents of the current turn with their latest progress, keyed by task id */
  subagents: Map<string, SubagentProgress>;
  /** task id -> the tool call that started it, from task_started (background_tasks_changed does not name it) */
  taskToolUse: Map<string, string>;
  /** context window usage after the last turn */
  context: ContextUsage | null;
}

/** Statuses in which the CLI may be touching files. */
export const BUSY: SessionStatus[] = ["starting", "running", "waiting_approval"];

/** Title of a session started without a prompt (older versions opened one for the Claude app); replaced by the first message. */
export function remotePlaceholderTitle(): string {
  return tr().core.sessions.remotePlaceholderTitle;
}

/** The placeholder title in either language: the language may have changed since the session started. */
export function isRemotePlaceholderTitle(title: string | null | undefined): boolean {
  return title === de.core.sessions.remotePlaceholderTitle || title === en.core.sessions.remotePlaceholderTitle;
}

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

/** On Windows the SDK ends a closed CLI only after about 7 s (stdin end, 2 s grace, 5 s until SIGKILL). */
export const CLOSE_WAIT_MS = 10_000;
/** After the tree was killed its end is reported within moments. */
const KILL_WAIT_MS = 2_000;

/** True once the process has ended, false if that took longer than `ms`. */
export async function endedWithin(live: LiveSession, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([live.ended.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Closes the process and waits for its end; one that does not end within `graceMs` is killed with its tree. True when it ended. */
export async function endLive(live: LiveSession, graceMs = CLOSE_WAIT_MS): Promise<boolean> {
  if (!live.closing) closeLive(live);
  if (await endedWithin(live, graceMs)) return true;
  try {
    live.rt.kill();
  } catch {
    /* already gone */
  }
  return endedWithin(live, KILL_WAIT_MS);
}

export function titleFrom(prompt: string): string {
  const first = prompt.trim().split(/\r?\n/)[0] ?? "";
  return first.length > 80 ? first.slice(0, 77) + "…" : first;
}

/** Claude Code rejected the sign-in (never signed in, expired or revoked). */
export function isAuthFailure(msg: string): boolean {
  return /not logged in|please run \/login|invalid api key|authenticat|oauth token has expired|token has been revoked/i.test(msg);
}

export function describeRuntimeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (isAuthFailure(msg)) {
    return tr().core.sessions.authFailed;
  }
  if (new RegExp(`unknown option.*${REPLAY_FLAG}`, "i").test(msg)) {
    return tr().core.sessions.cliTooOld;
  }
  if (/ENOENT|failed to launch/i.test(msg)) return tr().core.sessions.cliNotStarted;
  return msg.slice(0, 2000);
}
