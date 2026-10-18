import type { PlanUsage, SessionEventBody } from "@forge/protocol";
import type { AutoContinueRecord, Db } from "../persistence/db.js";
import { describeRuntimeError } from "./live-session.js";
import { de } from "../i18n/de/index.js";
import { tr } from "../i18n/index.js";

/** German wording, as older events and the tests have it; what is sent comes from autoContinuePrompt(). */
export const AUTO_CONTINUE_PROMPT = de.core.sessions.autoContinuePrompt;

/** The automatic message after a limit reset, in the current language. */
export function autoContinuePrompt(): string {
  return tr().core.sessions.autoContinuePrompt;
}
/** Waited after the reset: the limit server's clock and the local one may differ a little. */
export const RESET_BUFFER_MS = 2 * 60_000;
/**
 * Plans are compared with the wall clock on every check instead of one long timer: a timer does not
 * count while Windows sleeps, a check right after waking sees the plan as overdue.
 */
export const CHECK_INTERVAL_MS = 30_000;
/** Overdue plans run soon after a start, but not while the app is still coming up. */
export const STARTUP_CHECK_MS = 10_000;
/** Automatic continuations without user input; after that the user has to continue. */
export const MAX_AUTO_CONTINUES = 3;
/** Without a known reset time FORGE asks the plan usage this often. */
export const PROBE_INTERVAL_MS = 15 * 60_000;
/** One five-hour window of probing; then one attempt, which counts against MAX_AUTO_CONTINUES. */
export const MAX_PROBES = 20;
/** Reset times further out than the weekly limit are not believed. */
const MAX_WAIT_MS = 8 * 24 * 60 * 60_000;

type TurnResult = Extract<SessionEventBody, { type: "turn.result" }>;
type RateLimitBody = Extract<SessionEventBody, { type: "rate_limit" }>;

export interface AutoContinueHost {
  record(sessionId: string, body: SessionEventBody): void;
  publish(sessionId: string): void;
  enabled(): boolean;
  planUsage(): Promise<PlanUsage>;
  /** a turn runs or starts; a plan is stale then */
  isBusy(sessionId: string): boolean;
  /** sends the prompt as an automatic message; starts the CLI again when no process runs */
  send(sessionId: string, text: string): Promise<unknown>;
  /** lets drain() wait for planning that needs the plan usage */
  track(p: Promise<unknown>): void;
}

/**
 * The text Claude Code ends a turn with when a plan limit stops it ("You've hit your limit · resets 3pm",
 * older CLIs "Claude AI usage limit reached|<unix time>"). Credit and admin limits do not reset by
 * waiting and are left out on purpose.
 */
export function isUsageLimitText(text: string | null): boolean {
  if (!text) return false;
  return /you['’]ve (hit|reached) your|usage limit reached|claude ai usage limit|(5-hour|five.hour|weekly|session|opus|sonnet) limit (reached|hit)/i.test(text);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Reset time (ms) from a limit message; null when it names none. Times are read in local time like the CLI writes them. */
export function resetFromText(text: string | null, now: number): number | null {
  if (!text) return null;
  const unix = /\|(\d{10})\b/.exec(text);
  if (unix) return Number(unix[1]) * 1000;
  const m = /resets?\s+(?:at\s+)?(?:([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!m) return null;
  const ap = m[5]?.toLowerCase();
  if (!ap && m[4] === undefined) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ap === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const d = new Date(now);
  if (m[1] && m[2]) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (month < 0) return null;
    d.setMonth(month, Number(m[2]));
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() < now - 24 * 60 * 60_000) d.setFullYear(d.getFullYear() + 1);
    return d.getTime();
  }
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Reset time (ms) of the limit from the plan usage: the reported window, else the latest full one. */
export function resetFromUsage(usage: PlanUsage, limitType: string | null, now: number): number | null {
  if (!usage.available) return null;
  const future = (resetsAt: string | null) => {
    const t = resetsAt ? Date.parse(resetsAt) : NaN;
    return Number.isFinite(t) && t > now ? t : null;
  };
  const typed = limitType ? usage.windows.find((w) => w.key === limitType) : undefined;
  const typedReset = typed ? future(typed.resetsAt) : null;
  if (typedReset) return typedReset;
  const full = usage.windows.filter((w) => w.utilization >= 100).flatMap((w) => future(w.resetsAt) ?? []);
  return full.length ? Math.max(...full) : null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Continues a session on its own once the usage limit that stopped it has reset. The plan lives in the
 * database, so it survives a restart. Any user message, a later turn, a stop or the setting cancel it.
 */
export class AutoContinue {
  /** rejected rate limits reported during the running turn */
  private rejected = new Map<string, { resetsAt: number | null; limitType: string | null }>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private checking: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly host: AutoContinueHost,
    private readonly now: () => number = Date.now,
  ) {}

  start(onTick: () => void = () => {}) {
    this.stop();
    const tick = () => {
      onTick();
      void this.check();
    };
    const first = setTimeout(tick, STARTUP_CHECK_MS);
    const every = setInterval(tick, CHECK_INTERVAL_MS);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  noteRateLimit(sessionId: string, body: RateLimitBody) {
    if (body.status === "rejected" && !body.overageInUse) this.rejected.set(sessionId, { resetsAt: body.resetsAt, limitType: body.limitType });
    else if (body.status === "allowed") this.rejected.delete(sessionId);
  }

  /** A message from the user (FORGE, phone, Claude app): the plan is cancelled and the count starts over. */
  userInput(sessionId: string) {
    const plan = this.db.getAutoContinue(sessionId);
    if (!plan) return;
    this.db.clearAutoContinue(sessionId);
    if (plan.dueAt) this.host.publish(sessionId);
  }

  forget(sessionId: string) {
    this.rejected.delete(sessionId);
  }

  /** End of a turn: plans a continuation when the usage limit stopped it, else a pending plan is stale. */
  onTurnResult(sessionId: string, body: TurnResult, interrupted: boolean) {
    const rejected = this.rejected.get(sessionId);
    this.rejected.delete(sessionId);
    const limitHit = !interrupted && body.isError && (!!rejected || isUsageLimitText(body.text));
    if (!limitHit) {
      const plan = this.db.getAutoContinue(sessionId);
      if (plan?.dueAt) {
        this.db.setAutoContinue({ ...plan, dueAt: null });
        this.host.publish(sessionId);
      }
      return;
    }
    this.host.track(this.plan(sessionId, rejected?.resetsAt ?? null, rejected?.limitType ?? null, body.text));
  }

  /** The user does not want the automatic continuation; true when one was planned. */
  cancel(sessionId: string, message: string): boolean {
    const plan = this.db.getAutoContinue(sessionId);
    if (!plan?.dueAt) return false;
    this.db.clearAutoContinue(sessionId);
    this.host.record(sessionId, { type: "auto_continue", state: "cancelled", scheduledFor: plan.dueAt, message });
    this.host.publish(sessionId);
    return true;
  }

  cancelAll(message: string) {
    for (const p of this.db.listPendingAutoContinue()) this.cancel(p.sessionId, message);
  }

  /** Runs due plans. Called every CHECK_INTERVAL_MS; overlapping calls share one run. */
  check(): Promise<void> {
    this.checking ??= this.runDue().finally(() => (this.checking = null));
    return this.checking;
  }

  private async runDue() {
    if (!this.host.enabled()) {
      this.cancelAll(tr().core.sessions.autoContinueOff);
      return;
    }
    for (const plan of this.db.listDueAutoContinue(iso(this.now()))) {
      try {
        await this.due(plan);
      } catch (e) {
        this.host.record(plan.sessionId, { type: "auto_continue", state: "failed", scheduledFor: plan.dueAt, message: describeRuntimeError(e) });
      }
    }
  }

  private validReset(ms: number | null, now: number): number | null {
    if (ms === null || !Number.isFinite(ms) || ms > now + MAX_WAIT_MS) return null;
    return Math.max(ms, now);
  }

  private async plan(sessionId: string, resetsAtSec: number | null, limitType: string | null, text: string | null) {
    if (!this.host.enabled()) return;
    const prev = this.db.getAutoContinue(sessionId);
    const attempts = prev?.attempts ?? 0;
    const afterSeq = this.db.lastEventSeq(sessionId);
    if (attempts >= MAX_AUTO_CONTINUES) {
      this.db.setAutoContinue({ sessionId, dueAt: null, resetsAt: null, afterSeq, attempts, probes: 0 });
      this.host.record(sessionId, {
        type: "auto_continue",
        state: "exhausted",
        scheduledFor: null,
        attempt: attempts,
        message: tr().core.sessions.autoContinueExhausted(attempts),
      });
      this.host.publish(sessionId);
      return;
    }
    let reset = this.validReset(resetsAtSec === null ? null : resetsAtSec * 1000, this.now());
    if (reset === null) {
      const usage = await this.host.planUsage().catch(() => null);
      reset = usage ? this.validReset(resetFromUsage(usage, limitType, this.now()), this.now()) : null;
    }
    reset ??= this.validReset(resetFromText(text, this.now()), this.now());
    // The plan usage takes a moment: the user may have written or deleted the session meanwhile.
    if (!this.db.getSession(sessionId) || this.db.hasEventsAfter(sessionId, afterSeq, ["user.message", "turn.result"]) || !this.host.enabled()) return;
    const dueAt = reset !== null ? reset + RESET_BUFFER_MS : this.now() + PROBE_INTERVAL_MS;
    this.db.setAutoContinue({ sessionId, dueAt: iso(dueAt), resetsAt: reset !== null ? iso(reset) : null, afterSeq, attempts, probes: 0 });
    this.host.record(sessionId, { type: "auto_continue", state: "scheduled", scheduledFor: iso(dueAt), resetKnown: reset !== null, attempt: attempts + 1, message: null });
    this.host.publish(sessionId);
  }

  private async due(plan: AutoContinueRecord) {
    const id = plan.sessionId;
    if (!this.db.getSession(id)) {
      this.db.clearAutoContinue(id);
      return;
    }
    // Something happened since the limit (a message from the Claude app, a turn of its own): not needed any more.
    if (this.db.hasEventsAfter(id, plan.afterSeq, ["user.message", "turn.result"]) || this.host.isBusy(id)) {
      this.db.setAutoContinue({ ...plan, dueAt: null });
      this.host.publish(id);
      return;
    }
    if (!plan.resetsAt) {
      const usage = await this.host.planUsage().catch(() => null);
      const now = this.now();
      const reset = usage ? this.validReset(resetFromUsage(usage, null, now), now) : null;
      if (this.db.getAutoContinue(id)?.dueAt !== plan.dueAt) return;
      if (reset !== null) {
        const dueAt = iso(reset + RESET_BUFFER_MS);
        this.db.setAutoContinue({ ...plan, dueAt, resetsAt: iso(reset), probes: 0 });
        this.host.record(id, { type: "auto_continue", state: "scheduled", scheduledFor: dueAt, resetKnown: true, attempt: plan.attempts + 1, message: null });
        this.host.publish(id);
        return;
      }
      const looksOver = !!usage?.available && !usage.windows.some((w) => w.utilization >= 100);
      if (!looksOver && plan.probes + 1 < MAX_PROBES) {
        this.db.setAutoContinue({ ...plan, dueAt: iso(now + PROBE_INTERVAL_MS), probes: plan.probes + 1 });
        this.host.publish(id);
        return;
      }
    }
    if (this.db.getAutoContinue(id)?.dueAt !== plan.dueAt) return;
    const attempt = plan.attempts + 1;
    this.db.setAutoContinue({ ...plan, dueAt: null, resetsAt: null, probes: 0, attempts: attempt });
    this.host.record(id, { type: "auto_continue", state: "resumed", scheduledFor: plan.dueAt, attempt, message: null });
    this.host.publish(id);
    try {
      await this.host.send(id, autoContinuePrompt());
    } catch (e) {
      this.host.record(id, { type: "auto_continue", state: "failed", scheduledFor: plan.dueAt, attempt, message: describeRuntimeError(e) });
    }
  }
}
