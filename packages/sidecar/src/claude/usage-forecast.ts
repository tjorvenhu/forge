import type { PlanUsage, UsageForecast, UsageWindow } from "@forge/protocol";

/** One reading of a usage window. resetsAt identifies the window: a new window has a new reset time. */
export interface UsageSample {
  key: string;
  resetsAt: number;
  at: number;
  utilization: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Tuning {
  /** how long the window runs; readings from before its start belong to the previous one */
  length: number;
  /** a reading this much older counts half: the pace follows recent use, an earlier pause fades out */
  halfLife: number;
  /** readings must span at least this long before a pace is given */
  minSpan: number;
}

const FIVE_HOURS: Tuning = { length: 5 * HOUR, halfLife: 30 * MINUTE, minSpan: 10 * MINUTE };
// Weekly windows: a day's half-life evens out nights and working hours.
const WEEK: Tuning = { length: 7 * 24 * HOUR, halfLife: 24 * HOUR, minSpan: 2 * HOUR };

export function forecastTuning(key: string): Tuning {
  return key === "five_hour" ? FIVE_HOURS : WEEK;
}

/** Readings older than this are not needed by any window. */
export const SAMPLE_MAX_AGE_MS = WEEK.length + HOUR;
/** Reset times can differ by a moment between readings of the same window. */
export const SAME_WINDOW_MS = 2 * MINUTE;
const MIN_SAMPLES = 3;

/**
 * Where a window is heading at the recent pace. The pace is the rise between readings, weighted by
 * how recent each stretch is. Null without a reset time, after the reset, with too few readings of
 * this window, without any rise or when the window is full already (the limit itself says that).
 */
export function forecastWindow(w: UsageWindow, samples: UsageSample[], now: number): UsageForecast | null {
  if (!w.resetsAt) return null;
  const reset = Date.parse(w.resetsAt);
  if (!(reset > now)) return null;
  const t = forecastTuning(w.key);
  let points = samples
    .filter((s) => s.key === w.key && Math.abs(s.resetsAt - reset) <= SAME_WINDOW_MS && s.at >= reset - t.length && s.at <= now)
    .sort((a, b) => a.at - b.at);
  // A drop means the window started over (or the numbers were corrected): only what came after counts.
  for (let i = points.length - 1; i > 0; i--) {
    if (points[i]!.utilization < points[i - 1]!.utilization) {
      points = points.slice(i);
      break;
    }
  }
  if (points.length < MIN_SAMPLES) return null;
  const last = points[points.length - 1]!;
  if (last.at - points[0]!.at < t.minSpan || last.utilization >= 100) return null;
  let rise = 0;
  let time = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const weight = 0.5 ** ((now - (a.at + b.at) / 2) / t.halfLife);
    rise += weight * (b.utilization - a.utilization);
    time += weight * (b.at - a.at);
  }
  if (!(rise > 0) || !(time > 0)) return null;
  const perMs = rise / time;
  const perHour = Math.round(perMs * HOUR * 10) / 10;
  const limitAt = Math.round((last.at + (100 - last.utilization) / perMs) / 1000) * 1000;
  if (limitAt < reset) return { outcome: "limit", limitAt: new Date(limitAt).toISOString(), perHour };
  return { outcome: "enough", limitAt: null, perHour };
}

/** The usage with a forecast on every window that has one. */
export function withForecasts(usage: PlanUsage, samples: UsageSample[], now: number): PlanUsage {
  if (!usage.windows.length) return usage;
  return {
    ...usage,
    windows: usage.windows.map((w) => {
      const next = { ...w };
      delete next.forecast;
      const forecast = forecastWindow(next, samples, now);
      return forecast ? { ...next, forecast } : next;
    }),
  };
}

/** The readings of a usage as fetched; windows without a reset time have no identity to track. */
export function samplesOf(usage: PlanUsage, at: number): UsageSample[] {
  return usage.windows.flatMap((w) => {
    const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    return Number.isFinite(resetsAt) ? [{ key: w.key, resetsAt, at, utilization: w.utilization }] : [];
  });
}
