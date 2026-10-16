import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanUsage, RateLimitState, UsageWindow } from "@forge/protocol";
import { forecastWindow, samplesOf, withForecasts, type UsageSample } from "../src/claude/usage-forecast.js";
import { describeUsage, limitWarning } from "../src/claude/usage.js";
import { Db } from "../src/persistence/db.js";
import { spokenForecast } from "../src/phone/phone-service.js";
import { tempDir } from "./helpers.js";

const T0 = Date.parse("2026-10-16T10:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

function fiveHour(utilization: number, resetsAt = T0 + 3 * HOUR): UsageWindow {
  return { key: "five_hour", label: "5 Stunden", utilization, resetsAt: iso(resetsAt) };
}

/** Readings of one window: [minutes relative to T0, percent]. */
function readings(key: string, resetsAt: number, points: Array<[minutes: number, percent: number]>): UsageSample[] {
  return points.map(([m, utilization]) => ({ key, resetsAt, at: T0 + m * MIN, utilization }));
}

describe("forecastWindow", () => {
  const reset = T0 + 3 * HOUR;

  it("says when the window runs full at a steady pace", () => {
    const samples = readings("five_hour", reset, [[-60, 20], [-50, 25], [-40, 30], [-30, 35], [-20, 40], [-10, 45], [0, 50]]);
    expect(forecastWindow(fiveHour(50), samples, T0)).toEqual({ outcome: "limit", limitAt: iso(T0 + 100 * MIN), perHour: 30 });
  });

  it("says the window lasts when the limit would come after the reset", () => {
    const samples = readings("five_hour", reset, [[-60, 44], [-30, 47], [0, 50]]);
    expect(forecastWindow(fiveHour(50), samples, T0)).toEqual({ outcome: "enough", limitAt: null, perHour: 6 });
  });

  it("gives no forecast without enough readings, time or rise", () => {
    expect(forecastWindow(fiveHour(50), [], T0)).toBeNull();
    expect(forecastWindow(fiveHour(50), readings("five_hour", reset, [[-30, 40], [0, 50]]), T0)).toBeNull();
    // Three readings within a few minutes say nothing about the pace.
    expect(forecastWindow(fiveHour(50), readings("five_hour", reset, [[-6, 40], [-3, 45], [0, 50]]), T0)).toBeNull();
    expect(forecastWindow(fiveHour(50), readings("five_hour", reset, [[-60, 50], [-30, 50], [0, 50]]), T0)).toBeNull();
  });

  it("gives none without a reset time, after the reset or when the window is full", () => {
    const samples = readings("five_hour", reset, [[-60, 70], [-30, 85], [0, 100]]);
    expect(forecastWindow({ ...fiveHour(100), resetsAt: null }, samples, T0)).toBeNull();
    expect(forecastWindow(fiveHour(100), samples, reset + MIN)).toBeNull();
    expect(forecastWindow(fiveHour(100), samples, T0)).toBeNull();
  });

  it("follows the recent pace, so an earlier pause does not stretch the forecast", () => {
    // The window started two hours ago (reset in three); an hour and a quarter of it nothing happened.
    const flat: Array<[number, number]> = [-120, -105, -90, -75, -60, -45].map((m) => [m, 10]);
    const samples = readings("five_hour", reset, [...flat, [-30, 25], [-15, 40], [0, 55]]);
    const f = forecastWindow(fiveHour(55), samples, T0)!;
    // The plain average since the start would be 22.5 % per hour and the limit after two hours.
    expect(f.outcome).toBe("limit");
    expect(f.perHour).toBeGreaterThan(40);
    expect(Date.parse(f.limitAt!)).toBeLessThan(T0 + 70 * MIN);
  });

  it("only counts readings of the current window, and after a drop only what came after it", () => {
    const previous = readings("five_hour", T0 - 30 * MIN, [[-90, 60], [-60, 80], [-40, 95]]);
    const other = readings("seven_day", reset, [[-60, 0], [-30, 50], [0, 99]]);
    const current = readings("five_hour", reset, [[-60, 80], [-50, 85], [-40, 5], [-30, 10], [-20, 15], [-10, 20]]);
    expect(forecastWindow(fiveHour(20), [...previous, ...other, ...current], T0)).toEqual({ outcome: "limit", limitAt: iso(T0 - 10 * MIN + 160 * MIN), perHour: 30 });
    // Reset times of the same window may differ by a moment between readings.
    const shifted = current.map((s, i) => ({ ...s, resetsAt: s.resetsAt + (i % 2 ? 1500 : -800) }));
    expect(forecastWindow(fiveHour(20), shifted, T0)?.perHour).toBe(30);
  });

  it("uses days, not minutes, for weekly windows", () => {
    const weekReset = T0 + 3 * 24 * HOUR;
    const week: UsageWindow = { key: "model:Opus", label: "Woche Opus", utilization: 60, resetsAt: iso(weekReset) };
    const fast = readings("model:Opus", weekReset, [[-48 * 60, 20], [-24 * 60, 40], [0, 60]]);
    expect(forecastWindow(week, fast, T0)).toEqual({ outcome: "limit", limitAt: iso(T0 + 48 * HOUR), perHour: 0.8 });
    const slow = readings("model:Opus", weekReset, [[-48 * 60, 50], [-24 * 60, 55], [0, 60]]);
    expect(forecastWindow(week, slow, T0)?.outcome).toBe("enough");
    // Two hours of readings are too little for a week.
    expect(forecastWindow(week, readings("model:Opus", weekReset, [[-60, 50], [-30, 55], [0, 60]]), T0)).toBeNull();
  });
});

describe("withForecasts", () => {
  it("puts a forecast on the windows that have one and drops stale ones", () => {
    const usage: PlanUsage = {
      available: true,
      subscriptionType: "max",
      windows: [fiveHour(50), { key: "seven_day", label: "Woche", utilization: 10, resetsAt: iso(T0 + 2 * 24 * HOUR), forecast: { outcome: "limit", limitAt: iso(T0), perHour: 9 } }],
      fetchedAt: iso(T0),
      error: null,
    };
    const samples = readings("five_hour", T0 + 3 * HOUR, [[-60, 20], [-30, 35], [0, 50]]);
    const out = withForecasts(usage, samples, T0);
    expect(out.windows[0]?.forecast).toEqual({ outcome: "limit", limitAt: iso(T0 + 100 * MIN), perHour: 30 });
    expect(out.windows[1]).not.toHaveProperty("forecast");
    expect(samplesOf(usage, T0)).toEqual([
      { key: "five_hour", resetsAt: T0 + 3 * HOUR, at: T0, utilization: 50 },
      { key: "seven_day", resetsAt: T0 + 2 * 24 * HOUR, at: T0, utilization: 10 },
    ]);
    expect(samplesOf({ ...usage, windows: [{ ...fiveHour(0), resetsAt: null }] }, T0)).toEqual([]);
  });
});

describe("usage readings in the database", () => {
  it("survive a restart and are cleaned up once their window is over or too old", () => {
    const t = tempDir();
    mkdirSync(t.dir, { recursive: true });
    const file = path.join(t.dir, "forge.db");
    try {
      let db = new Db(file);
      const old = readings("five_hour", T0 + HOUR, [[-20, 10]]);
      const over = readings("five_hour", T0 - MIN, [[-30, 90]]);
      db.addUsageSamples([...old, ...over], T0 - 8 * 24 * HOUR, T0 - 40 * MIN);
      db.addUsageSamples(readings("five_hour", T0 + HOUR, [[0, 20]]), T0 - 8 * 24 * HOUR, T0);
      db.close();
      db = new Db(file);
      expect(db.listUsageSamples(0).map((s) => s.utilization)).toEqual([10, 20]);
      expect(db.listUsageSamples(T0 - MIN).map((s) => s.utilization)).toEqual([20]);
      db.addUsageSamples([], T0 - 10 * MIN, T0);
      expect(db.listUsageSamples(0)).toEqual([{ key: "five_hour", resetsAt: T0 + HOUR, at: T0, utilization: 20 }]);
      db.close();
    } finally {
      t.cleanup();
    }
  });
});

describe("forecast texts", () => {
  const usage = (forecast: UsageWindow["forecast"]): PlanUsage => ({
    available: true,
    subscriptionType: "max",
    windows: [{ ...fiveHour(50), ...(forecast ? { forecast } : {}) }],
    fetchedAt: iso(T0),
    error: null,
  });
  const ok: RateLimitState = { status: "ok", limitType: null, resetsAt: null, utilization: null, updatedAt: null };

  it("names the forecast in usage_status and warns before more agents", () => {
    const limit = usage({ outcome: "limit", limitAt: iso(T0 + 100 * MIN), perHour: 30 });
    expect(describeUsage(limit, ok, T0)).toMatch(/^5 Stunden: 50 % genutzt, Reset .+\. Prognose: bei diesem Tempo ist das Limit gegen .+\d\d:\d\d erreicht, vor dem Reset\nAbo: max$/);
    expect(limitWarning(limit, T0)).toMatch(/^Bei diesem Tempo ist das Nutzungslimit vor dem Reset erreicht: 5 Stunden gegen .+ \(Reset .+\)\. Weitere Agenten verbrauchen es schneller\.$/);
    expect(spokenForecast(limit.windows[0]!)).toMatch(/^Bei diesem Tempo ist das Limit .+ um \d\d:\d\d erreicht, vor dem Reset\.$/);

    const enough = usage({ outcome: "enough", limitAt: null, perHour: 5 });
    expect(describeUsage(enough, ok, T0)).toMatch(/Prognose: reicht bis zum Reset\nAbo: max$/);
    expect(limitWarning(enough, T0)).toBeNull();
    expect(spokenForecast(enough.windows[0]!)).toBe("Bei diesem Tempo reicht es bis zum Reset.");

    const none = usage(undefined);
    expect(describeUsage(none, ok, T0)).toMatch(/\nPrognose: noch zu wenig Messwerte oder kein Anstieg\.\nAbo: max$/);
    expect(limitWarning(none, T0)).toBeNull();
  });
});
