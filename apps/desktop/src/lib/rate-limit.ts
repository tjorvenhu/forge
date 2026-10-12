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
