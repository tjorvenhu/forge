import { afterAll, describe, expect, it } from "vitest";
import { fillHistory, historyDays, historySql, toHistory } from "./history";
import { COUNTER_KEYS } from "./report";

describe("historyDays", () => {
  it("lists the window oldest first, across month and year ends", () => {
    expect(historyDays("2026-03-02", 4)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(historyDays("2027-01-01", 2)).toEqual(["2026-12-31", "2027-01-01"]);
    expect(historyDays("2026-10-18")).toHaveLength(30);
  });
});

describe("fillHistory and toHistory", () => {
  it("fills days without reports with zeros", () => {
    const h = fillHistory([{ day: "2026-10-17", active: "2", sessions: "3" }], "2026-10-18", 3);
    expect(h.map((d) => d.day)).toEqual(["2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(h[0]!.activeInstalls).toBe(0);
    expect(h[1]!.activeInstalls).toBe(2);
    expect(h[1]!.increments.sessions).toBe(3);
    expect(h[1]!.increments.tokensInput).toBe(0);
    expect(Object.keys(h[2]!.increments).sort()).toEqual([...COUNTER_KEYS].sort());
  });

  it("sums all four token kinds", () => {
    const h = toHistory([{ day: "2026-10-18", active: "1", tokensInput: "1", tokensOutput: "20", tokensCacheRead: "300", tokensCacheWrite: "4000", claudeTurns: "7", sessions: "2", claudeWorkMs: "9000", costUsdCents: "55" }], "2026-10-18", 1);
    expect(h).toEqual([{ day: "2026-10-18", tokens: 4321, claudeTurns: 7, sessions: 2, claudeWorkMs: 9000, costUsdCents: 55, activeInstalls: 1 }]);
  });

  it("builds one increment column per counter", () => {
    const sql = historySql();
    for (const k of COUNTER_KEYS) expect(sql).toContain(`AS "${k}"`);
  });
});

// The increments are computed in SQL. Runs against a real Postgres when STATS_TEST_DATABASE_URL is set,
// for example the FORGE test database; uses days in 2001, so other data does not interfere.
const url = process.env.STATS_TEST_DATABASE_URL;

describe.skipIf(!url)("queryHistory against Postgres", () => {
  const ids = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000a3"];

  afterAll(async () => {
    const { Pool } = await import("pg");
    const p = new Pool({ connectionString: url });
    await p.query("DELETE FROM installs WHERE install_id = ANY($1::uuid[])", [ids]);
    await p.end();
  });

  it("counts increments against the latest earlier state, not the first state and not decreases", async () => {
    process.env.DATABASE_URL = url;
    const { ping, queryHistory } = await import("./db");
    await ping();
    const { Pool } = await import("pg");
    const p = new Pool({ connectionString: url });
    await p.query("DELETE FROM installs WHERE install_id = ANY($1::uuid[])", [ids]);
    for (const id of ids) {
      await p.query("INSERT INTO installs (install_id, app_version, os, counters) VALUES ($1, '0.1.80', 'Windows', '{}')", [id]);
    }
    const day = (id: string, d: string, c: Record<string, number>) => p.query("INSERT INTO install_days (install_id, day, counters) VALUES ($1, $2, $3)", [id, d, JSON.stringify(c)]);
    // a1: state before the window, then two days in it with a gap between them
    await day(ids[0]!, "2001-01-01", { tokensInput: 100, tokensOutput: 0, claudeTurns: 1 });
    await day(ids[0]!, "2001-01-28", { tokensInput: 150, tokensOutput: 10, claudeTurns: 3 });
    await day(ids[0]!, "2001-01-30", { tokensInput: 160, tokensOutput: 10, claudeTurns: 4 });
    // a2: first state in the window (no increment), then a reset to lower numbers
    await day(ids[1]!, "2001-01-29", { tokensInput: 1000, claudeTurns: 10 });
    await day(ids[1]!, "2001-01-30", { tokensInput: 5, claudeTurns: 1 });
    // a3: an older app without claudeTurns, then with it; a counter that appears is no increment
    // (the app sends its total since installation)
    await day(ids[2]!, "2001-01-29", { tokensInput: 1 });
    await day(ids[2]!, "2001-01-30", { tokensInput: 2, claudeTurns: 9 });

    const h = await queryHistory("2001-01-30", 3);
    await p.end();
    // The other counters of the history are 0 here; only these were reported.
    expect(h).toMatchObject([
      { day: "2001-01-28", tokens: 60, claudeTurns: 2, activeInstalls: 1 },
      { day: "2001-01-29", tokens: 0, claudeTurns: 0, activeInstalls: 2 },
      { day: "2001-01-30", tokens: 10 + 0 + 1, claudeTurns: 1 + 0 + 0, activeInstalls: 3 },
    ]);
  });

  it("deletes the daily states with the installation", async () => {
    const { deleteInstall } = await import("./db");
    const { Pool } = await import("pg");
    const p = new Pool({ connectionString: url });
    await deleteInstall(ids[0]!);
    const res = await p.query("SELECT COUNT(*)::int AS n FROM install_days WHERE install_id = $1", [ids[0]]);
    await p.end();
    expect(res.rows[0].n).toBe(0);
  });
});
