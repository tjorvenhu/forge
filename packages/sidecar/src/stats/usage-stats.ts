import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { USAGE_STATS_URL } from "@forge/protocol";
import type { UsageTotals } from "../persistence/db.js";

const FIRST_TICK_MS = 60_000;
const TICK_MS = 60_000;
/** The service takes at most one report per installation every 4 minutes. */
const SEND_EVERY_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;

/** Kept in the data folder, not in the settings: backups and the sync copy settings to other PCs. */
interface StatsFile {
  installId: string;
  /** last report the service took; null: none since the statistics were (re)enabled */
  lastSentAt: string | null;
}

export interface UsageStatsDeps {
  /** whether the statistics are on (settings.usageStats) */
  enabled(): boolean;
  totals(): UsageTotals;
  /** Claude plan of the account, e.g. "max_20x"; null when unknown */
  plan?(): Promise<string | null>;
  log(message: string): void;
  /** file with the installation ID */
  file: string;
  /** false in a development build: its numbers would mix with real ones */
  active?: boolean;
  appVersion?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * Sends anonymous totals of this installation to the statistics service every 5 minutes: a random ID, the
 * version, Windows and counters (tokens, projects, agents ...), never contents, names or paths.
 * Switched off, it asks the service once to delete the installation's row.
 */
export class UsageStatsService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private failedAt = 0;

  constructor(private readonly d: UsageStatsDeps) {}

  start() {
    if (!(this.d.active ?? !!process.env.FORGE_RUNTIME_DIR)) return;
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => tick(TICK_MS));
      }, delay);
      this.timer.unref?.();
    };
    tick(FIRST_TICK_MS);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Sends when it is due, or deletes after switching off. Exposed for tests. */
  async tick(): Promise<"sent" | "deleted" | "idle" | "failed"> {
    if (this.busy) return "idle";
    const now = (this.d.now ?? Date.now)();
    if (now - this.failedAt < RETRY_MS) return "idle";
    this.busy = true;
    try {
      const state = this.read();
      if (!this.d.enabled()) {
        if (!state.lastSentAt) return "idle";
        await this.request("DELETE", `/api/v1/report/${state.installId}`);
        this.write({ ...state, lastSentAt: null });
        this.d.log("Statistik: abgeschaltet, Daten beim Statistik-Dienst gelöscht");
        return "deleted";
      }
      if (state.lastSentAt && now - Date.parse(state.lastSentAt) < SEND_EVERY_MS) return "idle";
      const { models, ...counters } = this.d.totals();
      await this.request("POST", "/api/v1/report", {
        schema: 1,
        installId: state.installId,
        appVersion: (this.d.appVersion ?? process.env.FORGE_APP_VERSION ?? "0.0.0-dev").slice(0, 32),
        os: `${os.type()} ${os.release()}`.slice(0, 64),
        counters,
        // Model ids only (e.g. claude-opus-4-7), at most 20; the service checks them again.
        models: Object.fromEntries(Object.entries(models).slice(0, 20)),
        plan: (await this.d.plan?.()) ?? null,
      });
      this.write({ ...state, lastSentAt: new Date(now).toISOString() });
      return "sent";
    } catch (e) {
      this.failedAt = now;
      this.d.log(`Statistik: nicht gesendet: ${e instanceof Error ? e.message : String(e)}`);
      return "failed";
    } finally {
      this.busy = false;
    }
  }

  private async request(method: "POST" | "DELETE", route: string, body?: unknown) {
    const res = await (this.d.fetchFn ?? fetch)(`${USAGE_STATS_URL}${route}`, {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": "FORGE" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    // 429: the service already has a recent report; that counts as sent.
    if (!res.ok && res.status !== 429) throw new Error(`HTTP ${res.status}`);
  }

  private read(): StatsFile {
    try {
      const f = JSON.parse(readFileSync(this.d.file, "utf8")) as Partial<StatsFile>;
      if (typeof f.installId === "string" && /^[0-9a-f-]{36}$/.test(f.installId)) return { installId: f.installId, lastSentAt: f.lastSentAt ?? null };
    } catch {
      // first start or a broken file: a new ID
    }
    const fresh = { installId: randomUUID(), lastSentAt: null };
    this.write(fresh);
    return fresh;
  }

  private write(f: StatsFile) {
    writeFileSync(this.d.file, JSON.stringify(f));
  }
}

export function usageStatsFile(dataDir: string): string {
  return path.join(dataDir, "usage-stats.json");
}
