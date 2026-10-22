import type { ModelTokens, PlanUsage, SessionUsage, SessionUsageWindow, UsageWindow } from "@forge/protocol";
import { forecastTuning, SAME_WINDOW_MS, type UsageSample } from "./usage-forecast.js";

/** One Claude call FORGE counted (a session turn or a call outside a session), from claude_usage. */
export interface UsageCall {
  /** end of the call, epoch ms */
  at: number;
  sessionId: string | null;
  /** how long the call ran; it started at `at - durationMs` */
  durationMs: number;
  /** per model, with cost; null on rows from before FORGE read modelUsage */
  models: Record<string, ModelTokens> | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

/**
 * Claude Code only reports how full a window is, in whole percent, for the whole account. What a session
 * took is therefore an estimate: each rise between two readings goes to the calls FORGE counted since the
 * previous rise, in proportion to their cost (the limits follow cost far closer than raw tokens, where
 * cache reads dominate). A call's cost is spread over its run time: a turn is only written when it ends, and
 * a long one spans many readings. A rise without any FORGE call came from elsewhere (terminal, claude.ai).
 * Calls after the last reading are not in it yet; they count at the window's average rate so far.
 */
export function sessionShare(w: UsageWindow, samples: UsageSample[], calls: UsageCall[], sessionId: string, now: number): { share: number; tokens: number } {
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!Number.isFinite(reset)) return { share: 0, tokens: 0 };
  const start = reset - forecastTuning(w.key).length;
  const family = modelFamily(w.key);
  const points = [
    { at: start, utilization: 0 },
    ...samples.filter((s) => s.key === w.key && Math.abs(s.resetsAt - reset) <= SAME_WINDOW_MS && s.at > start && s.at <= now).sort((a, b) => a.at - b.at),
  ];
  // Cost per stretch: slot i is (points[i-1], points[i]], slot n what came after the last reading.
  const n = points.length;
  const upper = (i: number) => (i < n ? points[i]!.at : Infinity);
  const all = new Array<number>(n + 1).fill(0);
  const own = new Array<number>(n + 1).fill(0);
  let tokens = 0;
  for (const c of calls) {
    if (c.at <= start || c.at > now) continue;
    const mine = c.sessionId === sessionId;
    if (mine) tokens += callTokens(c, family);
    const cost = callCost(c, family);
    if (!(cost > 0)) continue;
    // The part of a call that ran before the window started belongs to the previous window.
    const from = c.at - Math.max(0, c.durationMs);
    for (let i = slotOf(points, Math.max(start, from)); i <= n; i++) {
      const part = c.at > from ? (cost * (Math.min(c.at, upper(i)) - Math.max(from, points[i - 1]!.at))) / (c.at - from) : cost;
      all[i]! += part;
      if (mine) own[i]! += part;
      if (c.at <= upper(i)) break;
    }
  }
  let share = 0;
  let pendingAll = 0;
  let pendingOwn = 0;
  let attributedRise = 0;
  let attributedCost = 0;
  for (let i = 1; i < n; i++) {
    pendingAll += all[i]!;
    pendingOwn += own[i]!;
    const rise = points[i]!.utilization - points[i - 1]!.utilization;
    if (rise > 0 && pendingAll > 0) {
      share += (rise * pendingOwn) / pendingAll;
      attributedRise += rise;
      attributedCost += pendingAll;
      pendingAll = 0;
      pendingOwn = 0;
    }
  }
  const unread = pendingOwn + own[n]!;
  if (unread > 0 && attributedCost > 0) share += (unread * attributedRise) / attributedCost;
  return { share: Math.min(100, Math.round(share * 10) / 10), tokens };
}

/** The slot (see sessionShare) that holds `at`: the first i with at <= points[i].at, else n. */
function slotOf(points: Array<{ at: number }>, at: number): number {
  let lo = 1;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sessionUsage(totals: SessionTotals, plan: PlanUsage, samples: UsageSample[], calls: UsageCall[], sessionId: string, now: number): SessionUsage {
  const windows: SessionUsageWindow[] = plan.available
    ? plan.windows
        .filter((w) => w.resetsAt)
        .map((w) => ({ key: w.key, label: w.label, utilization: w.utilization, resetsAt: w.resetsAt, ...sessionShare(w, samples, calls, sessionId, now) }))
    : [];
  return {
    ...totals,
    totalTokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    windows,
    planError: plan.available ? null : plan.error,
  };
}

/** The model family a window counts (seven_day_opus, model:Fable ...), lower case; null for all models. */
function modelFamily(key: string): string | null {
  if (key.startsWith("model:")) return key.slice(6).trim().split(/\s+/)[0]!.toLowerCase() || null;
  const m = /^seven_day_(\w+)$/.exec(key);
  return m ? m[1]!.toLowerCase() : null;
}

// Rows without modelUsage only have token counts: weighted like API prices (output 5x input, cache
// writes 1.25x, reads 0.1x), scaled to roughly dollars so they mix with rows that have a cost.
const PER_TOKEN = { input: 5e-6, output: 25e-6, cacheWrite: 6.25e-6, cacheRead: 0.5e-6 };

function callCost(c: UsageCall, family: string | null): number {
  if (c.models) {
    let cost = 0;
    for (const [id, m] of Object.entries(c.models)) if (!family || id.toLowerCase().includes(family)) cost += m.costUsd;
    return cost;
  }
  if (family) return 0;
  return c.inputTokens * PER_TOKEN.input + c.outputTokens * PER_TOKEN.output + c.cacheWriteTokens * PER_TOKEN.cacheWrite + c.cacheReadTokens * PER_TOKEN.cacheRead;
}

function callTokens(c: UsageCall, family: string | null): number {
  if (c.models) {
    let n = 0;
    for (const [id, m] of Object.entries(c.models)) if (!family || id.toLowerCase().includes(family)) n += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
    return n;
  }
  if (family) return 0;
  return c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens;
}
