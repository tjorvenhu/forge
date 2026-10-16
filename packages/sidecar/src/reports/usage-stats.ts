import type { DailyReportUsage, ForgeUsagePurpose } from "@forge/protocol";
import type { ClaudeUsageRow } from "../persistence/db.js";

/** Days in the trend of the report, the report's day included. */
export const TREND_DAYS = 14;

/**
 * Tokens Claude wrote or read for the first time. The context read from the cache again on every request
 * is left out: it is most of the sum and says how long the context was, not how much work was done.
 */
const tokensOf = (r: ClaudeUsageRow) => r.inputTokens + r.outputTokens + r.cacheWriteTokens;
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** A call runs from ts - duration to ts. */
const span = (r: ClaudeUsageRow) => {
  const end = Date.parse(r.ts);
  return [end - r.durationMs, end] as const;
};

/**
 * Statistics of the day [from, to) from the calls that ended in the trend window. Working time is cut to
 * the day (a turn over midnight counts on both days); tokens count on the day the call ended.
 * `days` are the local day starts of the trend, oldest first, the last one is `from`.
 */
export function usageStats(rows: ClaudeUsageRow[], from: Date, to: Date, days: Array<{ date: string; from: Date; to: Date }>, withHelpers: boolean): DailyReportUsage {
  const f = from.getTime();
  const t = to.getTime();
  const ended = (r: ClaudeUsageRow) => {
    const end = Date.parse(r.ts);
    return end >= f && end < t;
  };
  const sessions = rows.filter((r) => r.kind === "session");
  // FORGE's one-shot calls and the phone belong to no project: only in the report over all projects.
  const helpers = withHelpers ? rows.filter((r) => r.kind !== "session" && ended(r)) : [];
  // A turn that started the evening before and ended today still worked today, and the other way round.
  const today = sessions.filter((r) => ended(r) || overlap(...span(r), f, t) > 0);
  const own = today.filter(ended);

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, workMs: 0, tokens: 0, turns: 0 }));
  const hourStart = (h: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate(), h).getTime();
  let workMs = 0;
  let agentWorkMs = 0;
  const projects = new Map<string, DailyReportUsage["projects"][number]>();
  for (const r of today) {
    const [s, e] = span(r);
    const ms = overlap(s, e, f, t);
    workMs += ms;
    if (r.projectId && r.rootId && r.projectId !== r.rootId) agentWorkMs += ms;
    for (const h of hours) h.workMs += overlap(s, e, hourStart(h.hour), h.hour === 23 ? t : hourStart(h.hour + 1));
    if (ended(r)) {
      const h = hours[new Date(e).getHours()]!;
      h.tokens += tokensOf(r);
      h.turns++;
    }
    const key = r.rootId ?? "";
    const p = projects.get(key) ?? { rootId: key, name: r.rootName ?? "Ohne Projekt", workMs: 0, tokens: 0, turns: 0 };
    p.workMs += ms;
    if (ended(r)) {
      p.tokens += tokensOf(r);
      p.turns++;
    }
    projects.set(key, p);
  }

  // Clock time with at least one turn running, and the most at once: sweep over start and end points.
  const points = today.flatMap((r) => {
    const [s, e] = span(r);
    return [
      [Math.max(s, f), 1],
      [Math.min(e, t), -1],
    ] as Array<[number, number]>;
  });
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0;
  let peakParallel = 0;
  let activeMs = 0;
  let since = 0;
  for (const [at, d] of points) {
    if (running > 0) activeMs += at - since;
    running += d;
    since = at;
    peakParallel = Math.max(peakParallel, running);
  }

  const sum = (list: ClaudeUsageRow[], k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") => list.reduce((n, r) => n + r[k], 0);
  const counted = [...own, ...helpers];
  const byForge = [...own.filter((r) => r.purpose), ...helpers];
  const parts = new Map<ForgeUsagePurpose, DailyReportUsage["forge"]["parts"][number]>();
  for (const r of byForge) {
    const purpose = r.purpose ?? "other";
    const p = parts.get(purpose) ?? { purpose, calls: 0, workMs: 0, tokens: 0 };
    p.calls++;
    p.workMs += r.durationMs;
    p.tokens += tokensOf(r);
    parts.set(purpose, p);
  }
  return {
    turns: own.length,
    apiCalls: [...own, ...helpers].reduce((n, r) => n + r.apiCalls, 0),
    workMs,
    agentWorkMs,
    activeMs,
    peakParallel,
    inputTokens: sum(counted, "inputTokens"),
    outputTokens: sum(counted, "outputTokens"),
    cacheReadTokens: sum(counted, "cacheReadTokens"),
    cacheWriteTokens: sum(counted, "cacheWriteTokens"),
    forge: {
      calls: byForge.length,
      workMs: byForge.reduce((n, r) => n + r.durationMs, 0),
      tokens: byForge.reduce((n, r) => n + tokensOf(r), 0),
      cacheReadTokens: sum(byForge, "cacheReadTokens"),
      parts: [...parts.values()].sort((a, b) => b.tokens - a.tokens || b.workMs - a.workMs),
    },
    hours,
    projects: [...projects.values()].filter((p) => p.workMs > 0 || p.tokens > 0).sort((a, b) => b.workMs - a.workMs || b.tokens - a.tokens),
    days: days.map((d) => {
      const d0 = d.from.getTime();
      const d1 = d.to.getTime();
      let ms = 0;
      let tokens = 0;
      for (const r of sessions) {
        const [s, e] = span(r);
        ms += overlap(s, e, d0, d1);
        if (e >= d0 && e < d1) tokens += tokensOf(r);
      }
      return { date: d.date, workMs: ms, tokens };
    }),
  };
}
