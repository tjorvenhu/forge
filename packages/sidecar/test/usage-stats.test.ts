import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE_STATS_URL } from "@forge/protocol";
import { Db, type UsageTotals } from "../src/persistence/db.js";
import { UsageStatsService } from "../src/stats/usage-stats.js";

const TOTALS: UsageTotals = {
  tokensInput: 10,
  tokensOutput: 20,
  tokensCacheRead: 30,
  tokensCacheWrite: 40,
  claudeTurns: 3,
  claudeWorkMs: 5000,
  sessions: 2,
  projectsCreated: 1,
  agentsStarted: 4,
  agentsMerged: 3,
  phoneCalls: 0,
  userTurns: 2,
  costUsdCents: 1234,
  models: { "claude-opus-4-7": { tokens: 100, costUsdCents: 1234 } },
};

const { models: _models, ...COUNTERS } = TOTALS;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(status = 204) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "forge-stats-"));
  dirs.push(dir);
  const file = path.join(dir, "usage-stats.json");
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  let enabled = true;
  let now = Date.parse("2026-10-17T12:00:00Z");
  const svc = new UsageStatsService({
    enabled: () => enabled,
    totals: () => TOTALS,
    log: () => {},
    file,
    active: true,
    appVersion: "0.1.80",
    now: () => now,
    fetchFn: (async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method!, body: init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null });
      return new Response(null, { status });
    }) as unknown as typeof fetch,
  });
  return {
    svc,
    file,
    requests,
    setEnabled: (v: boolean) => (enabled = v),
    advance: (ms: number) => (now += ms),
  };
}

describe("usage statistics", () => {
  it("sends the totals with a random ID every 5 minutes, nothing else", async () => {
    const t = setup();
    expect(await t.svc.tick()).toBe("sent");
    const id = (JSON.parse(readFileSync(t.file, "utf8")) as { installId: string }).installId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.requests[0]).toEqual({
      url: `${USAGE_STATS_URL}/api/v1/report`,
      method: "POST",
      body: { schema: 1, installId: id, appVersion: "0.1.80", os: expect.any(String), counters: COUNTERS, models: TOTALS.models },
    });
    expect(Object.keys(t.requests[0]!.body!).sort()).toEqual(["appVersion", "counters", "installId", "models", "os", "schema"]);
    t.advance(4 * 60_000);
    expect(await t.svc.tick()).toBe("idle");
    t.advance(60_000);
    expect(await t.svc.tick()).toBe("sent");
    // The same ID every time.
    expect(t.requests[1]!.body!.installId).toBe(id);
  });

  it("asks the service to delete the data once after switching off, and sends again when switched on", async () => {
    const t = setup();
    await t.svc.tick();
    t.setEnabled(false);
    expect(await t.svc.tick()).toBe("deleted");
    expect(t.requests[1]).toMatchObject({ method: "DELETE", url: expect.stringMatching(/\/api\/v1\/report\/[0-9a-f-]{36}$/) });
    expect(await t.svc.tick()).toBe("idle");
    t.setEnabled(true);
    expect(await t.svc.tick()).toBe("sent");
  });

  it("waits a while after a failure instead of retrying every tick", async () => {
    const t = setup(502);
    expect(await t.svc.tick()).toBe("failed");
    expect(await t.svc.tick()).toBe("idle");
    t.advance(5 * 60_000);
    expect(await t.svc.tick()).toBe("failed");
    expect(t.requests).toHaveLength(2);
  });

  it("counts projects created, not agent worktrees or restored ones", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-stats-db-"));
    dirs.push(dir);
    const db = new Db(path.join(dir, "forge.db"));
    try {
      const rec = (id: string, parentId: string | null) => ({
        id,
        name: id,
        path: path.join(dir, id),
        favorite: false,
        tags: [],
        technologies: [],
        profile: "balanced" as const,
        defaultModel: null,
        defaultEffort: null,
        createdAt: "2026-10-17T10:00:00.000Z",
        lastOpenedAt: null,
        testCommand: null,
        devCommand: null,
        parentId,
        gitEnabled: true,
      });
      db.insertProject(rec("a", null), "a");
      db.insertProject(rec("b", "a"), "b");
      db.insertProject(rec("c", null), "c", true);
      // The worktree of a running agent counts as a started agent before it finishes.
      expect(db.usageTotals()).toMatchObject({ projectsCreated: 1, tokensInput: 0, sessions: 0, agentsStarted: 1, agentsMerged: 0, phoneCalls: 0 });

      // Session turns: modelUsage counts subagents too and adds up over the turns of one process.
      const now = "2026-10-18T10:00:00.000Z";
      db.insertSession({ id: "s1", projectId: "a", claudeSessionId: null, cwd: dir, title: null, model: null, effort: null, profile: "balanced", permissionMode: "default", status: "idle", apiKeySource: null, createdAt: now, updatedAt: now, lastError: null });
      const m = (i: number, o: number, cr: number, cost: number) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: 0, costUsd: cost });
      const result = (models: Record<string, ReturnType<typeof m>>, isError = false) =>
        db.appendEvent("s1", { type: "turn.result", subtype: "success", isError, durationMs: 1000, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, models, text: null });
      result({ "claude-opus-4-7": m(10, 20, 100, 0.5), "claude-haiku-4-5": m(5, 5, 0, 0.01) });
      result({ "claude-opus-4-7": m(15, 30, 300, 0.8), "claude-haiku-4-5": m(5, 5, 0, 0.01) });
      // A crashed run reports zeros and must not reset the baseline.
      result({ "claude-opus-4-7": m(0, 0, 0, 0) }, true);
      result({ "claude-opus-4-7": m(16, 31, 310, 0.81), "claude-haiku-4-5": m(5, 5, 0, 0.01) });
      // A new process without saved totals starts at zero again: its value counts in full.
      result({ "claude-opus-4-7": m(2, 3, 0, 0.02) });
      const t = db.usageTotals();
      expect(t).toMatchObject({ tokensInput: 10 + 5 + 5 + 1 + 2, tokensOutput: 20 + 5 + 10 + 1 + 3, tokensCacheRead: 100 + 200 + 10, claudeTurns: 5, sessions: 1, userTurns: 5 });
      expect(t.costUsdCents).toBe(Math.round((0.5 + 0.01 + 0.3 + 0.01 + 0.02) * 100));
      expect(t.models["claude-opus-4-7"]!.tokens).toBe(130 + 215 + 12 + 5);
      expect(t.models["claude-haiku-4-5"]!.tokens).toBe(10);
    } finally {
      db.close();
    }
  });

  it("sends nothing from a development build", () => {
    const svc = new UsageStatsService({ enabled: () => true, totals: () => TOTALS, log: () => {}, file: "x", active: false });
    svc.start();
    svc.stop();
  });
});
