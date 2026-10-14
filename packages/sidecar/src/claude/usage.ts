import type { PlanUsage, UsageWindow } from "@forge/protocol";

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** Only documented windows are shown; codenamed or undocumented keys are ignored on purpose. */
const KNOWN: Array<[key: string, label: string]> = [
  ["five_hour", "5 Stunden"],
  ["seven_day", "Woche"],
  ["seven_day_opus", "Woche Opus"],
  ["seven_day_sonnet", "Woche Sonnet"],
];

/** Converts the SDK's /usage payload into FORGE's stable shape. Tolerates missing fields. */
export function toPlanUsage(raw: unknown): PlanUsage {
  const r = (raw ?? {}) as { subscription_type?: unknown; rate_limits_available?: unknown; rate_limits?: unknown };
  const limits = (r.rate_limits ?? null) as Record<string, unknown> | null;
  const windows: UsageWindow[] = [];
  if (limits) {
    for (const [key, label] of KNOWN) {
      const w = limits[key] as RawWindow | null | undefined;
      if (w && typeof w.utilization === "number") windows.push({ key, label, utilization: clamp(w.utilization), resetsAt: w.resets_at ?? null });
    }
    const scoped = Array.isArray(limits.model_scoped) ? (limits.model_scoped as Array<RawWindow & { display_name?: unknown }>) : [];
    for (const m of scoped) {
      if (typeof m.utilization !== "number" || typeof m.display_name !== "string") continue;
      windows.push({ key: `model:${m.display_name}`, label: `Woche ${m.display_name}`, utilization: clamp(m.utilization), resetsAt: m.resets_at ?? null });
    }
  }
  return {
    available: r.rate_limits_available === true && windows.length > 0,
    subscriptionType: typeof r.subscription_type === "string" ? r.subscription_type : null,
    windows,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

function clamp(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * A window whose reset time has passed starts again at 0 %. Cached numbers are from before the reset,
 * and Claude Code may still report the old window for a moment after it.
 */
export function settleUsage(usage: PlanUsage, now = Date.now()): PlanUsage {
  if (!usage.windows.some((w) => isOver(w, now) && w.utilization > 0)) return usage;
  return { ...usage, windows: usage.windows.map((w) => (isOver(w, now) ? { ...w, utilization: 0 } : w)) };
}

/** True when a window of this usage reset after `since` and by `now`: the numbers are from before it. */
export function resetSince(usage: PlanUsage, since: number, now = Date.now()): boolean {
  return usage.windows.some((w) => w.resetsAt !== null && Date.parse(w.resetsAt) > since && isOver(w, now));
}

function isOver(w: UsageWindow, now: number) {
  return w.resetsAt !== null && Date.parse(w.resetsAt) <= now;
}
