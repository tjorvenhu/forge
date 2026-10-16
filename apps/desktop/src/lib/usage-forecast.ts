import type { PlanUsage, UsageWindow } from "@forge/protocol";
import { limitTime } from "./rate-limit";

/** Short forecast of a window ("Limit gegen 14:10", "Reicht bis zum Reset"); null without one or after the reset. */
export function forecastLabel(w: UsageWindow, now = Date.now()): { text: string; limit: boolean } | null {
  const f = w.forecast;
  if (!f || (w.resetsAt && Date.parse(w.resetsAt) <= now)) return null;
  if (f.outcome === "limit" && f.limitAt) return { text: `Limit gegen ${limitTime(f.limitAt, now)}`, limit: true };
  return { text: "Reicht bis zum Reset", limit: false };
}

/** The forecast as a sentence, for tooltips and details. */
export function forecastSentence(w: UsageWindow, now = Date.now()): string {
  const label = forecastLabel(w, now);
  if (!label) return "Keine Prognose: zu wenig Messwerte oder kein Anstieg.";
  if (!label.limit) return "Bei diesem Tempo reicht es bis zum Reset.";
  return `Bei diesem Tempo ist das Limit gegen ${limitTime(w.forecast!.limitAt!, now)} erreicht, vor dem Reset.`;
}

/** Windows that run full before their reset at the current pace. */
export function windowsRunningOut(usage: PlanUsage | undefined, now = Date.now()): UsageWindow[] {
  if (!usage?.available) return [];
  return usage.windows.filter((w) => forecastLabel(w, now)?.limit);
}
