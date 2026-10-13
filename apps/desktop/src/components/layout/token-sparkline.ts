/** Time the sparkline shows, right edge is now. */
export const HISTORY_MS = 30_000;
/** One point of history per this many ms; the head between them follows every frame. */
export const SAMPLE_MS = 250;
/**
 * The rate arrives about once per second as a step. Easing the head towards it over roughly that
 * time turns the steps into a curve instead of a jump.
 */
const VALUE_TAU_MS = 350;
/** The scale shrinks slowly when a peak leaves the window, so the line does not jump up. */
const MAX_TAU_MS = 800;
/** Longer gaps (window hidden, loop woken from idle) count as one frame, so a wake-up still ramps. */
const MAX_STEP_MS = 100;
const SETTLED = 0.01;

/** viewBox of the sparkline: 0 0 100 20, one unit margin at top and bottom */
const WIDTH = 100;
const BOTTOM = 19;
const SPAN = 18;

/** The flat line of an idle sparkline, also the first paint before the loop draws. */
export const BASELINE_POINTS = `0,${BOTTOM} ${WIDTH},${BOTTOM}`;

export interface SparklineState {
  /** oldest first; the first may lie just left of the window so the line reaches the edge */
  samples: Array<{ at: number; value: number }>;
  /** eased current rate, drawn at the right edge */
  value: number;
  /** eased top of the scale, at least 1 */
  max: number;
  at: number;
}

export function createSparkline(now: number): SparklineState {
  return { samples: [{ at: now - HISTORY_MS - SAMPLE_MS, value: 0 }], value: 0, max: 1, at: now };
}

function ease(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  const next = target + (current - target) * Math.exp(-dt / tau);
  return Math.abs(next - target) < SETTLED ? target : next;
}

/** Advances the sparkline to `now` with the latest rate. `reduced`: no easing (prefers-reduced-motion). */
export function stepSparkline(s: SparklineState, target: number, now: number, reduced = false): void {
  const dt = Math.min(Math.max(0, now - s.at), MAX_STEP_MS);
  s.at = now;
  s.value = ease(s.value, target, dt, reduced ? 0 : VALUE_TAU_MS);

  const last = s.samples[s.samples.length - 1];
  if (!last || now - last.at >= SAMPLE_MS) s.samples.push({ at: now, value: s.value });
  const start = now - HISTORY_MS;
  while ((s.samples[1]?.at ?? Infinity) <= start) s.samples.shift();

  let peak = Math.max(1, s.value);
  for (const p of s.samples) if (p.value > peak) peak = p.value;
  s.max = peak >= s.max ? peak : ease(s.max, peak, dt, reduced ? 0 : MAX_TAU_MS);
}

/** Something above zero is on screen or about to be. */
export function sparklineActive(s: SparklineState, target: number): boolean {
  return target > 0 || s.value > 0 || s.samples.some((p) => p.value > 0);
}

/** Nothing moves any more: the loop may sleep until the next rate arrives. */
export function sparklineIdle(s: SparklineState, target: number): boolean {
  return !sparklineActive(s, target) && s.max === 1;
}

/** `points` of the polyline at `now`: positions follow the time, so the line glides left. */
export function sparklinePoints(s: SparklineState, now: number): string {
  const x = (at: number) => WIDTH - ((now - at) / HISTORY_MS) * WIDTH;
  const y = (value: number) => BOTTOM - Math.min(Math.max(value / s.max, 0), 1) * SPAN;
  const out: string[] = [];
  for (const [i, p] of s.samples.entries()) {
    const px = x(p.at);
    if (px < 0) {
      const next = s.samples[i + 1] ?? { at: now, value: s.value };
      const nx = x(next.at);
      if (nx <= 0) continue;
      const t = -px / (nx - px);
      out.push(`0,${y(p.value + (next.value - p.value) * t).toFixed(2)}`);
      continue;
    }
    out.push(`${px.toFixed(2)},${y(p.value).toFixed(2)}`);
  }
  out.push(`${WIDTH},${y(s.value).toFixed(2)}`);
  return out.join(" ");
}
