import { Pool } from "pg";
import { ONLINE_MINUTES } from "./constants";
import { HISTORY_DAYS, historyDays, historySql, toHistory, type HistoryDay, type HistoryRow } from "./history";
import { COUNTER_KEYS, type Counters, type ModelUsage, type Report } from "./report";
import type { VersionCount } from "./versions";

export interface PlanCount {
  plan: string | null;
  installs: number;
  /** of them online now */
  online: number;
}

export interface LanguageCount {
  /** null: app versions before the language was sent */
  language: string | null;
  installs: number;
}

export type Platform = "windows" | "macos" | "linux" | "other";

export interface PlatformCount {
  platform: Platform;
  installs: number;
}

/** Minimum time between two accepted reports of one installation; the app reports every 5 minutes. */
export const REPORT_INTERVAL_MINUTES = 4;
const TOTALS_MAX_AGE_MS = 5 * 60 * 1000;
/** The online count is one cheap query; the page asks for it every 30 seconds. */
const ONLINE_MAX_AGE_MS = 15 * 1000;
/** Models in /api/v1/totals; every installation can send 20 IDs of its own, so the list is capped. */
const MAX_TOTAL_MODELS = 50;

export interface Totals {
  installs: number;
  activeInstalls30d: number;
  /** installations whose first report was in the last 30 days */
  newInstalls30d: number;
  /** installations with a report in the last ONLINE_MINUTES */
  onlineInstalls: number;
  counters: Counters;
  updatedAt: string;
  /** summed over all installations, most tokens first */
  models: Record<string, ModelUsage>;
  /** installations active in the last 30 days per app version, most first */
  versions: VersionCount[];
  /** installations active in the last 30 days per Claude plan, most first; plan null: unknown */
  plans: PlanCount[];
  /** installations active in the last 30 days per operating system, most first */
  platforms: PlatformCount[];
  /** installations active in the last 30 days per interface language, most first */
  languages: LanguageCount[];
  /** the last 30 days (UTC), oldest first */
  history: HistoryDay[];
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
      );
      ALTER TABLE installs ADD COLUMN IF NOT EXISTS models jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE installs ADD COLUMN IF NOT EXISTS plan text;
      ALTER TABLE installs ADD COLUMN IF NOT EXISTS language text;
      CREATE TABLE IF NOT EXISTS install_days (
        install_id uuid NOT NULL REFERENCES installs(install_id) ON DELETE CASCADE,
        day date NOT NULL,
        counters jsonb NOT NULL,
        PRIMARY KEY (install_id, day)
      );
      CREATE INDEX IF NOT EXISTS install_days_day ON install_days (day)`,
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

/**
 * Stores the report as the installation's latest state and as its state of the current UTC day; false
 * when the previous report is younger than the interval (then neither is written).
 */
export async function upsertReport(r: Report): Promise<boolean> {
  const p = await db();
  const res = await p.query(
    `WITH up AS (
       INSERT INTO installs (install_id, first_seen, last_seen, app_version, os, counters, models, plan, language)
       VALUES ($1, now(), now(), $2, $3, $4, $5, $7, $8)
       ON CONFLICT (install_id) DO UPDATE
         SET last_seen = now(), app_version = EXCLUDED.app_version, os = EXCLUDED.os,
             counters = EXCLUDED.counters, models = EXCLUDED.models, plan = EXCLUDED.plan,
             language = EXCLUDED.language
         WHERE installs.last_seen <= now() - make_interval(mins => $6)
       RETURNING install_id
     )
     INSERT INTO install_days (install_id, day, counters)
     SELECT install_id, (now() AT TIME ZONE 'UTC')::date, $4 FROM up
     ON CONFLICT (install_id, day) DO UPDATE SET counters = EXCLUDED.counters
     RETURNING 1`,
    [r.installId, r.appVersion, r.os, JSON.stringify(r.counters), JSON.stringify(r.models), REPORT_INTERVAL_MINUTES, r.plan, r.language],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteInstall(installId: string): Promise<void> {
  const p = await db();
  // install_days goes with it (ON DELETE CASCADE).
  await p.query("DELETE FROM installs WHERE install_id = $1", [installId]);
}

export async function ping(): Promise<void> {
  await (await db()).query("SELECT 1");
}

async function queryModels(p: Pool): Promise<Record<string, ModelUsage>> {
  const res = await p.query<{ id: string; tokens: string; cost: string }>(
    `SELECT m.key AS id,
       SUM((m.value->>'tokens')::numeric)::text AS tokens,
       SUM((m.value->>'costUsdCents')::numeric)::text AS cost
     FROM installs, jsonb_each(installs.models) AS m
     GROUP BY m.key
     ORDER BY SUM((m.value->>'tokens')::numeric) DESC, m.key
     LIMIT $1`,
    [MAX_TOTAL_MODELS],
  );
  return Object.fromEntries(res.rows.map((r) => [r.id, { tokens: Number(r.tokens), costUsdCents: Number(r.cost) }]));
}

async function queryVersions(p: Pool): Promise<VersionCount[]> {
  const res = await p.query<{ version: string; installs: string }>(
    `SELECT app_version AS version, COUNT(*)::text AS installs
     FROM installs
     WHERE last_seen > now() - interval '30 days'
     GROUP BY app_version
     ORDER BY COUNT(*) DESC, app_version DESC`,
  );
  return res.rows.map((r) => ({ version: r.version, installs: Number(r.installs) }));
}

async function queryPlans(p: Pool): Promise<PlanCount[]> {
  const res = await p.query<{ plan: string | null; installs: string; online: string }>(
    `SELECT plan, COUNT(*)::text AS installs,
       COUNT(*) FILTER (WHERE last_seen > now() - make_interval(mins => $1))::text AS online
     FROM installs
     WHERE last_seen > now() - interval '30 days'
     GROUP BY plan
     ORDER BY COUNT(*) DESC, plan NULLS LAST`,
    [ONLINE_MINUTES],
  );
  return res.rows.map((r) => ({ plan: r.plan, installs: Number(r.installs), online: Number(r.online) }));
}

async function queryLanguages(p: Pool): Promise<LanguageCount[]> {
  const res = await p.query<{ language: string | null; installs: string }>(
    `SELECT language, COUNT(*)::text AS installs
     FROM installs
     WHERE last_seen > now() - interval '30 days'
     GROUP BY language
     ORDER BY COUNT(*) DESC, language NULLS LAST`,
  );
  return res.rows.map((r) => ({ language: r.language, installs: Number(r.installs) }));
}

/** The app sends `os.type() os.release()`: "Windows_NT 10.0.26200", "Darwin 24.1.0", "Linux 6.8.0". */
async function queryPlatforms(p: Pool): Promise<PlatformCount[]> {
  const res = await p.query<{ platform: Platform; installs: string }>(
    `SELECT CASE
         WHEN os ILIKE 'windows%' THEN 'windows'
         WHEN os ILIKE 'darwin%' THEN 'macos'
         WHEN os ILIKE 'linux%' THEN 'linux'
         ELSE 'other'
       END AS platform, COUNT(*)::text AS installs
     FROM installs
     WHERE last_seen > now() - interval '30 days'
     GROUP BY 1
     ORDER BY COUNT(*) DESC, 1`,
  );
  return res.rows.map((r) => ({ platform: r.platform, installs: Number(r.installs) }));
}

/** The history of the `days` UTC days up to `endDay` (today when left out). */
export async function queryHistory(endDay?: string, days = HISTORY_DAYS): Promise<HistoryDay[]> {
  const p = await db();
  const end = endDay ?? new Date().toISOString().slice(0, 10);
  const res = await p.query<HistoryRow>(historySql(), [historyDays(end, days)[0], end]);
  return toHistory(res.rows, end, days);
}

async function queryTotals(): Promise<Totals> {
  const p = await db();
  const [models, versions, plans, platforms, languages, history] = await Promise.all([
    queryModels(p),
    queryVersions(p),
    queryPlans(p),
    queryPlatforms(p),
    queryLanguages(p),
    queryHistory(),
  ]);
  // The keys come from COUNTER_KEYS, not from input, so interpolating them is safe.
  const sums = COUNTER_KEYS.map((k) => `COALESCE(SUM((counters->>'${k}')::numeric), 0)::text AS "${k}"`).join(",\n");
  const res = await p.query<Record<string, string>>(
    `SELECT COUNT(*)::text AS installs,
       COUNT(*) FILTER (WHERE last_seen > now() - interval '30 days')::text AS active,
       COUNT(*) FILTER (WHERE first_seen > now() - interval '30 days')::text AS new,
       COUNT(*) FILTER (WHERE last_seen > now() - make_interval(mins => $1))::text AS online,
       ${sums}
     FROM installs`,
    [ONLINE_MINUTES],
  );
  const row = res.rows[0] ?? {};
  const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, Number(row[k] ?? 0)])) as Counters;
  return {
    installs: Number(row.installs ?? 0),
    activeInstalls30d: Number(row.active ?? 0),
    newInstalls30d: Number(row.new ?? 0),
    onlineInstalls: Number(row.online ?? 0),
    counters,
    updatedAt: new Date().toISOString(),
    models,
    versions,
    plans,
    platforms,
    languages,
    history,
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

export interface Online {
  onlineInstalls: number;
  /** online installations per plan; plans without any are left out */
  plans: Array<{ plan: string | null; online: number }>;
}

let onlineCached: { at: number; online: Online } | null = null;

/** Installations online now, at most 15 seconds old; between two totals the page updates only this. */
export async function getOnline(): Promise<Online> {
  if (onlineCached && Date.now() - onlineCached.at < ONLINE_MAX_AGE_MS) return onlineCached.online;
  const p = await db();
  const res = await p.query<{ plan: string | null; online: string }>(
    `SELECT plan, COUNT(*)::text AS online FROM installs
     WHERE last_seen > now() - make_interval(mins => $1)
     GROUP BY plan`,
    [ONLINE_MINUTES],
  );
  const plans = res.rows.map((r) => ({ plan: r.plan, online: Number(r.online) }));
  const online = { onlineInstalls: plans.reduce((n, r) => n + r.online, 0), plans };
  onlineCached = { at: Date.now(), online };
  return online;
}
