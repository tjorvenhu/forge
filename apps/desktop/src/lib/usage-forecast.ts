import type { PlanUsage, UsageWindow } from "@forge/protocol";
import { limitTime } from "./rate-limit";
import { t } from "@/i18n";

/** Short forecast of a window ("Limit gegen 14:10", "Reicht bis zum Reset"); null without one or after the reset. */
export function forecastLabel(w: UsageWindow, now = Date.now()): { text: string; limit: boolean } | null {
  const f = w.forecast;
  if (!f || (w.resetsAt && Date.parse(w.resetsAt) <= now)) return null;
  if (f.outcome === "limit" && f.limitAt) return { text: t.lib.forecast.limitAt(limitTime(f.limitAt, now)), limit: true };
  return { text: t.lib.forecast.lastsUntilReset, limit: false };
}

/** The forecast as a sentence, for tooltips and details. */
export function forecastSentence(w: UsageWindow, now = Date.now()): string {
  const label = forecastLabel(w, now);
  if (!label) return t.lib.forecast.none;
  if (!label.limit) return t.lib.forecast.lastsSentence;
  return t.lib.forecast.limitSentence(limitTime(w.forecast!.limitAt!, now));
}

/** Windows that run full before their reset at the current pace. */
export function windowsRunningOut(usage: PlanUsage | undefined, now = Date.now()): UsageWindow[] {
  if (!usage?.available) return [];
  return usage.windows.filter((w) => forecastLabel(w, now)?.limit);
}
