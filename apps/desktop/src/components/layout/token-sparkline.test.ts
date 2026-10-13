import { describe, expect, it } from "vitest";
import { BASELINE_POINTS, HISTORY_MS, createSparkline, sparklineActive, sparklineIdle, sparklinePoints, stepSparkline } from "./token-sparkline";

const FRAME = 1000 / 60;

/** Runs frames from `from` for `ms` with the given rate; returns the time after the last frame. */
function run(s: ReturnType<typeof createSparkline>, target: number, from: number, ms: number, reduced = false): number {
  let now = from;
  for (const end = from + ms; now < end; ) {
    now += FRAME;
    stepSparkline(s, target, now, reduced);
  }
  return now;
}

const parse = (points: string) => points.split(" ").map((p) => p.split(",").map(Number) as [number, number]);

describe("token sparkline", () => {
  it("starts flat and idle", () => {
    const s = createSparkline(0);
    stepSparkline(s, 0, FRAME);
    expect(sparklineIdle(s, 0)).toBe(true);
    expect(sparklineActive(s, 0)).toBe(false);
    const pts = parse(sparklinePoints(s, FRAME));
    expect(pts[0]).toEqual([0, 19]);
    expect(pts.at(-1)).toEqual([100, 19]);
    expect(BASELINE_POINTS).toBe("0,19 100,19");
  });

  it("ramps towards a new rate instead of jumping", () => {
    const s = createSparkline(0);
    let now = run(s, 0, 0, 100);
    const values: number[] = [];
    for (let i = 0; i < 60; i++) {
      now = run(s, 100, now, FRAME);
      values.push(s.value);
    }
    expect(values[0]).toBeGreaterThan(0);
    expect(values[0]).toBeLessThan(10);
    for (const [i, v] of values.entries()) if (i > 0) expect(v).toBeGreaterThanOrEqual(values[i - 1] ?? 0);
    expect(values.at(-1)).toBeGreaterThan(90);
  });

  it("moves the line left continuously with the time", () => {
    const s = createSparkline(0);
    let now = run(s, 50, 0, 2000);
    now = run(s, 0, now, 2000);
    const peakX = (at: number) => {
      const pts = parse(sparklinePoints(s, at));
      return pts.reduce((best, p) => (p[1] < best[1] ? p : best))[0];
    };
    const before = peakX(now);
    const after = peakX(now + FRAME);
    const shift = before - after;
    expect(shift).toBeGreaterThan(0);
    // points are rounded to 0.01
    expect(shift).toBeCloseTo((FRAME / HISTORY_MS) * 100, 1);
  });

  it("keeps the line inside the box and reaching the left edge", () => {
    const s = createSparkline(0);
    const now = run(s, 40, 0, HISTORY_MS + 5000);
    const pts = parse(sparklinePoints(s, now));
    expect(pts[0]?.[0]).toBe(0);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(1);
      expect(y).toBeLessThanOrEqual(19);
    }
  });

  it("lowers the scale gradually once a peak scrolled out", () => {
    const s = createSparkline(0);
    let now = run(s, 200, 0, 3000);
    now = run(s, 20, now, HISTORY_MS - 500);
    const high = s.max;
    expect(high).toBeGreaterThan(150);
    now = run(s, 20, now, 1000);
    const next = s.max;
    expect(next).toBeLessThan(high);
    expect(high - next).toBeLessThan(high - 20);
    run(s, 20, now, 10_000);
    expect(s.max).toBe(20);
  });

  it("goes idle once the output has scrolled out", () => {
    const s = createSparkline(0);
    let now = run(s, 30, 0, 1000);
    now = run(s, 0, now, 5000);
    expect(sparklineActive(s, 0)).toBe(true);
    expect(sparklineIdle(s, 0)).toBe(false);
    run(s, 0, now, HISTORY_MS + 2000);
    expect(sparklineIdle(s, 0)).toBe(true);
  });

  it("ramps after waking from idle even after a long pause", () => {
    const s = createSparkline(0);
    stepSparkline(s, 0, 100);
    stepSparkline(s, 80, 60_000);
    expect(s.value).toBeGreaterThan(0);
    expect(s.value).toBeLessThan(80);
  });

  it("follows the rate right away with reduced motion", () => {
    const s = createSparkline(0);
    stepSparkline(s, 80, 1000, true);
    expect(s.value).toBe(80);
    stepSparkline(s, 0, 2000, true);
    expect(s.value).toBe(0);
  });
});
