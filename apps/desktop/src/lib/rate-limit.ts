import type { PlanUsage, RateLimitState } from "@forge/protocol";

const LABELS: Record<string, string> = {
  five_hour: "5-Stunden-Limit",
  seven_day: "Wochenlimit",
  seven_day_opus: "Wochenlimit Opus",
  seven_day_sonnet: "Wochenlimit Sonnet",
  seven_day_overage_included: "Wochenlimit",
  overage: "Extra-Nutzung",
};

/** German name of a plan limit as Claude Code reports it; unknown types get a neutral name. */
export function limitLabel(limitType: string | null | undefined): string {
  return (limitType && LABELS[limitType]) || "Nutzungslimit";
}

/** "14:05", or "Mo., 14:05" when the time is not today. */
export function limitTime(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString("de-DE", { weekday: "short" })}, ${time}`;
}

export function limitDateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * The limit state while it applies; null once it is fine again or its reset time has passed.
 * Claude Code does not always send a reset time with the limit; then the matching window of the
 * plan usage fills it in (for an unnamed limit, the fullest window, since that is the one running out).
 */
export function activeRateLimit(state: RateLimitState | undefined, now = Date.now(), usage?: PlanUsage): RateLimitState | null {
  if (!state || state.status === "ok") return null;
  if (state.resetsAt) return Date.parse(state.resetsAt) <= now ? null : state;
  const future = (usage?.windows ?? []).filter((w) => w.resetsAt && Date.parse(w.resetsAt) > now);
  const window = state.limitType ? future.find((w) => w.key === state.limitType) : future.sort((a, b) => b.utilization - a.utilization)[0];
  return window ? { ...state, resetsAt: window.resetsAt } : state;
}

/** How often the plan usage is read without a reason. */
export const USAGE_INTERVAL_MS = 5 * 60_000;
/** Read this long after a window's reset, so Claude Code already reports the new window. */
const RESET_MARGIN_MS = 10_000;

/** Wait until the next read of the plan usage: the regular interval, or shortly after the next reset. */
export function usageRefetchIn(usage: PlanUsage | undefined, now = Date.now()): number {
  const resets = (usage?.windows ?? []).flatMap((w) => (w.resetsAt ? [Date.parse(w.resetsAt)] : [])).filter((t) => t > now);
  if (!resets.length) return USAGE_INTERVAL_MS;
  return Math.min(USAGE_INTERVAL_MS, Math.min(...resets) - now + RESET_MARGIN_MS);
}

/**
 * True when the shown usage is out of date: a window reset after it was read, or the regular read was
 * missed while the window was hidden (the interval only runs while FORGE is visible).
 */
export function usageOutdated(usage: PlanUsage | undefined, now = Date.now()): boolean {
  if (!usage) return false;
  const fetchedAt = Date.parse(usage.fetchedAt);
  if (now - fetchedAt >= USAGE_INTERVAL_MS) return true;
  return usage.windows.some((w) => w.resetsAt !== null && Date.parse(w.resetsAt) > fetchedAt && Date.parse(w.resetsAt) <= now);
}
