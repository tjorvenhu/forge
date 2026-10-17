import { Pool } from "pg";
import { COUNTER_KEYS, type Counters, type Report } from "./report";

/** Minimum time between two accepted reports of one installation; the app reports every 5 minutes. */
export const REPORT_INTERVAL_MINUTES = 4;
const TOTALS_MAX_AGE_MS = 5 * 60 * 1000;

export interface Totals {
  installs: number;
  activeInstalls30d: number;
  counters: Counters;
  updatedAt: string;
}

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
    // An idle client losing its connection must not crash the process.
    pool.on("error", (err) => console.error("postgres pool error:", err.message));
  }
  return pool;
}

async function db(): Promise<Pool> {
  const p = getPool();
  schemaReady ??= p
    .query(
      `CREATE TABLE IF NOT EXISTS installs (
        install_id uuid PRIMARY KEY,
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_seen timestamptz NOT NULL DEFAULT now(),
        app_version text NOT NULL,
        os text NOT NULL,
        counters jsonb NOT NULL
      )`,
    )
    .then(() => undefined)
    .catch((err: unknown) => {
      schemaReady = null;
      throw err;
    });
  await schemaReady;
  return p;
}

export async function installExists(installId: string): Promise<boolean> {
  const p = await db();
  const res = await p.query("SELECT 1 FROM installs WHERE install_id = $1", [installId]);
  return (res.rowCount ?? 0) > 0;
}

/** Stores the report as the installation's latest state; false when the previous one is younger than the interval. */
export async function upsertReport(r: Report): Promise<boolean> {
  const p = await db();
  const res = await p.query(
    `INSERT INTO installs (install_id, first_seen, last_seen, app_version, os, counters)
     VALUES ($1, now(), now(), $2, $3, $4)
     ON CONFLICT (install_id) DO UPDATE
       SET last_seen = now(), app_version = EXCLUDED.app_version, os = EXCLUDED.os, counters = EXCLUDED.counters
       WHERE installs.last_seen <= now() - make_interval(mins => $5)
     RETURNING 1`,
    [r.installId, r.appVersion, r.os, JSON.stringify(r.counters), REPORT_INTERVAL_MINUTES],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteInstall(installId: string): Promise<void> {
  const p = await db();
  await p.query("DELETE FROM installs WHERE install_id = $1", [installId]);
}

export async function ping(): Promise<void> {
  await (await db()).query("SELECT 1");
}

async function queryTotals(): Promise<Totals> {
  const p = await db();
  // The keys come from COUNTER_KEYS, not from input, so interpolating them is safe.
  const sums = COUNTER_KEYS.map((k) => `COALESCE(SUM((counters->>'${k}')::numeric), 0)::text AS "${k}"`).join(",\n");
  const res = await p.query<Record<string, string>>(
    `SELECT COUNT(*)::text AS installs,
       COUNT(*) FILTER (WHERE last_seen > now() - interval '30 days')::text AS active,
       ${sums}
     FROM installs`,
  );
  const row = res.rows[0] ?? {};
  const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, Number(row[k] ?? 0)])) as Counters;
  return {
    installs: Number(row.installs ?? 0),
    activeInstalls30d: Number(row.active ?? 0),
    counters,
    updatedAt: new Date().toISOString(),
  };
}

let cached: { at: number; totals: Totals } | null = null;
let inflight: Promise<Totals> | null = null;

/** Totals at most five minutes old; a failed query is not cached. */
export async function getTotals(): Promise<Totals> {
  if (cached && Date.now() - cached.at < TOTALS_MAX_AGE_MS) return cached.totals;
  inflight ??= queryTotals()
    .then((totals) => {
      cached = { at: Date.now(), totals };
      return totals;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
