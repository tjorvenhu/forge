import type { RateLimitState, ServerEvent, SessionEventBody } from "@forge/protocol";

type RateLimitBody = Extract<SessionEventBody, { type: "rate_limit" }>;

const OK: RateLimitState = { status: "ok", limitType: null, resetsAt: null, utilization: null, updatedAt: null };

/**
 * The latest plan rate limit for the whole account. Claude Code reports it per session, but the limit
 * belongs to the account, so the newest report from any session wins.
 */
export class RateLimitTracker {
  private last: RateLimitState = OK;

  constructor(
    private readonly emit: (e: ServerEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  note(body: RateLimitBody) {
    const at = new Date(this.now()).toISOString();
    // Served from extra usage: the plan limit is full, but sessions keep working.
    const status = body.status === "rejected" ? (body.overageInUse ? "ok" : "reached") : body.status === "allowed_warning" ? "warning" : body.status === "allowed" ? "ok" : null;
    if (!status) return;
    const resetsAt = body.resetsAt ? new Date(body.resetsAt * 1000).toISOString() : null;
    const next: RateLimitState =
      status === "ok" || (resetsAt && Date.parse(resetsAt) <= this.now())
        ? { ...OK, updatedAt: at }
        : { status, limitType: body.limitType, resetsAt, utilization: body.utilization ?? null, updatedAt: at };
    this.set(next);
  }

  /** Current state; a warning or stop whose reset time has passed is over. */
  state(): RateLimitState {
    this.tick();
    return this.last;
  }

  /** Called periodically so the UI hears about a passed reset time without a new report. */
  tick() {
    if (this.last.status !== "ok" && this.last.resetsAt && Date.parse(this.last.resetsAt) <= this.now()) {
      this.set({ ...OK, updatedAt: new Date(this.now()).toISOString() });
    }
  }

  private set(next: RateLimitState) {
    const prev = this.last;
    this.last = next;
    const same = prev.status === next.status && prev.limitType === next.limitType && prev.resetsAt === next.resetsAt && prev.utilization === next.utilization;
    if (!same) this.emit({ event: "ratelimit.updated", payload: next });
  }
}
