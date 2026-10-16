import { describe, expect, it } from "vitest";
import { formatDuration, formatTokens } from "@forge/protocol";
import type { ClaudeUsageRow } from "../src/persistence/db.js";
import { usageStats } from "../src/reports/usage-stats.js";

const day = (d: number) => ({ date: `2026-10-${String(d).padStart(2, "0")}`, from: new Date(2026, 9, d), to: new Date(2026, 9, d + 1) });
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const MIN = 60_000;

function row(end: string, minutes: number, o: Partial<ClaudeUsageRow> = {}): ClaudeUsageRow {
  return { ts: end, kind: "session", projectId: "app", rootId: "app", rootName: "app", durationMs: minutes * MIN, apiCalls: 2, inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0, ...o };
}

describe("usageStats", () => {
  const today = day(16);
  const trend = [day(15), day(16)];

  it("sums working time and tokens, tells clock time and parallel calls apart", () => {
    const rows = [
      row(at(16, 10, 30), 30),
      // an agent in parallel, 10:15 to 10:45
      row(at(16, 10, 45), 30, { projectId: "wt", rootId: "app" }),
      row(at(16, 14), 60, { rootId: "web", projectId: "web", rootName: "web" }),
      row(at(16, 15), 1, { kind: "assist", projectId: null, rootId: null, rootName: null }),
    ];
    const u = usageStats(rows, today.from, today.to, trend, true);
    expect(u).toMatchObject({ turns: 3, apiCalls: 6, workMs: 120 * MIN, agentWorkMs: 30 * MIN, activeMs: 105 * MIN, peakParallel: 2, outputTokens: 300, cacheReadTokens: 3000 });
    expect(u.other).toMatchObject({ calls: 1, outputTokens: 100 });
    expect(u.hours[10]).toMatchObject({ workMs: 60 * MIN, turns: 2, tokens: 220 });
    expect(u.hours[13]!.workMs).toBe(60 * MIN);
    expect(u.projects.map((p) => [p.name, p.workMs / MIN, p.turns])).toEqual([
      ["app", 60, 2],
      ["web", 60, 1],
    ]);
  });

  it("splits a turn over midnight between both days, its tokens count when it ended", () => {
    const rows = [row(at(16, 0, 20), 40)];
    const u = usageStats(rows, today.from, today.to, trend, true);
    expect(u.workMs).toBe(20 * MIN);
    expect(u.turns).toBe(1);
    expect(u.days).toEqual([
      { date: "2026-10-15", workMs: 20 * MIN, tokens: 0 },
      { date: "2026-10-16", workMs: 20 * MIN, tokens: 110 },
    ]);
    // A turn without a duration still counts with its tokens.
    expect(usageStats([row(at(16, 9), 0)], today.from, today.to, trend, false)).toMatchObject({ turns: 1, workMs: 0, outputTokens: 100, other: null });
  });

  it("formats durations and token counts for people", () => {
    expect([formatDuration(45_000), formatDuration(12 * MIN), formatDuration(320 * MIN), formatDuration(120 * MIN)]).toEqual(["45 s", "12 min", "5 h 20 min", "2 h"]);
    expect([formatTokens(850), formatTokens(12_400), formatTokens(3_240_000)]).toEqual(["850", "12 Tsd.", "3,2 Mio."]);
  });
});
