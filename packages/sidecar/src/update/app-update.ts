import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppUpdateState } from "@forge/protocol";
import { run } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";

/** Repository whose GitHub releases carry the FORGE installer (built by .github/workflows/release.yml). */
export const UPDATE_REPO = "tjorvenhu/forge";
const FIRST_CHECK_MS = 20_000;
const CHECK_INTERVAL_MS = 30 * 60_000;
const INSTALLER = /-setup\.exe$/i;

/** Where installers are downloaded; the desktop shell runs installers from this folder only. */
export function updateDir(): string {
  return path.join(os.tmpdir(), "forge-update");
}

/** Numeric comparison of versions like 0.1.12; a pre-release suffix sorts below the plain version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.replace(/^v/i, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

interface Release {
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name?: string; size?: number; digest?: string | null }>;
}

export interface UpdateDeps {
  emit(state: AppUpdateState): void;
  enabled(): boolean;
  log(message: string): void;
  /** runs gh; tests pass a fake */
  gh?: (args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  currentVersion?: string;
  installable?: boolean;
}

/**
 * Looks for a newer FORGE release on GitHub and fetches its installer. Uses the gh login of the user
 * (FORGE ships gh), so the releases of a private repository work for everyone with access. The
 * installer is checked against the SHA-256 GitHub reports for the asset before it can be run.
 */
export class AppUpdateService {
  private state: AppUpdateState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private asset: { name: string; digest: string | null } | null = null;
  private busy: Promise<AppUpdateState> | null = null;

  constructor(private readonly d: UpdateDeps) {
    this.state = {
      currentVersion: d.currentVersion ?? process.env.FORGE_APP_VERSION ?? "0.0.0-dev",
      phase: "idle",
      latest: null,
      installerPath: null,
      // The installed app runs with its bundled runtime; a development build has none.
      installable: d.installable ?? !!process.env.FORGE_RUNTIME_DIR,
      checkedAt: null,
      message: null,
    };
  }

  /** First check shortly after the start, then every 30 minutes (when enabled in the settings). */
  start() {
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        if (this.d.enabled() && this.state.phase !== "downloading" && this.state.phase !== "ready") void this.check().catch(() => {});
        tick(CHECK_INTERVAL_MS);
      }, delay);
      this.timer.unref?.();
    };
    tick(FIRST_CHECK_MS);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get(): AppUpdateState {
    return this.state;
  }

  private set(patch: Partial<AppUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.d.emit(this.state);
  }

  private async gh(args: string[], timeoutMs: number) {
    if (this.d.gh) return this.d.gh(args, timeoutMs);
    const tool = resolveTool("gh");
    if (!tool) throw new Error("GitHub CLI fehlt in dieser Installation.");
    const r = await run(tool.path, args, { env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "", GH_NO_UPDATE_NOTIFIER: "1" }, timeoutMs });
    if (r.spawnError) throw r.spawnError;
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  }

  /** One check or download at a time; a second call gets the running one. */
  private once(job: () => Promise<AppUpdateState>): Promise<AppUpdateState> {
    this.busy ??= job().finally(() => (this.busy = null));
    return this.busy;
  }

  check(): Promise<AppUpdateState> {
    return this.once(async () => {
      // A downloaded installer of the same release stays usable.
      const keep = this.state.phase === "ready" ? this.state.installerPath : null;
      this.set({ phase: "checking", message: null });
      try {
        const r = await this.gh(["api", `repos/${UPDATE_REPO}/releases/latest`], 30_000);
        if (r.code !== 0) {
          const err = `${r.stderr}${r.stdout}`;
          if (/auth login|not logged|401/i.test(err)) throw new Error("Für Updates bitte in FORGE bei GitHub anmelden (Ansicht GitHub).");
          if (/404|Not Found/i.test(err)) {
            this.set({ phase: "uptodate", latest: null, checkedAt: new Date().toISOString(), message: "Noch kein Release veröffentlicht." });
            return this.state;
          }
          throw new Error(err.trim().split("\n").at(-1) || "GitHub hat die Anfrage abgelehnt.");
        }
        const rel = JSON.parse(r.stdout) as Release;
        const tag = rel.tag_name ?? "";
        const asset = (rel.assets ?? []).find((a) => a.name && INSTALLER.test(a.name));
        const checkedAt = new Date().toISOString();
        if (!tag || rel.draft || !asset?.name || compareVersions(tag, this.state.currentVersion) <= 0) {
          this.asset = null;
          this.set({ phase: "uptodate", latest: null, installerPath: null, checkedAt });
          return this.state;
        }
        const sameRelease = this.state.latest?.tag === tag;
        this.asset = { name: asset.name, digest: asset.digest ?? null };
        this.set({
          phase: sameRelease && keep ? "ready" : "available",
          installerPath: sameRelease ? keep : null,
          latest: { version: tag.replace(/^v/i, ""), tag, notes: (rel.body ?? "").trim(), publishedAt: rel.published_at ?? null, size: asset.size ?? null },
          checkedAt,
        });
        if (!sameRelease) this.d.log(`Update: FORGE ${tag} ist verfügbar`);
        return this.state;
      } catch (e) {
        this.set({ phase: "error", message: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() });
        return this.state;
      }
    });
  }

  /** Fetches the installer of the newest release into the update folder and checks its SHA-256. */
  download(): Promise<AppUpdateState> {
    return this.once(async () => {
      const latest = this.state.latest;
      const asset = this.asset;
      if (!latest || !asset) {
        this.set({ phase: "error", message: "Kein Update zum Herunterladen. Erst nach Updates suchen." });
        return this.state;
      }
      this.set({ phase: "downloading", message: null });
      const dir = path.join(updateDir(), latest.tag.replace(/[^\w.-]/g, "_"));
      try {
        await rm(updateDir(), { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        const r = await this.gh(["release", "download", latest.tag, "--repo", UPDATE_REPO, "--pattern", asset.name, "--dir", dir, "--clobber"], 15 * 60_000);
        if (r.code !== 0) throw new Error(`Download fehlgeschlagen: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`);
        const file = (await readdir(dir)).find((f) => f === asset.name);
        if (!file) throw new Error("Der Installer fehlt nach dem Download.");
        const full = path.join(dir, file);
        if (asset.digest?.startsWith("sha256:")) {
          const actual = await sha256(full);
          if (actual !== asset.digest.slice(7).toLowerCase()) {
            await rm(dir, { recursive: true, force: true });
            throw new Error("Prüfsumme des Installers stimmt nicht. Download verworfen.");
          }
        }
        this.set({ phase: "ready", installerPath: full });
        this.d.log(`Update: Installer für ${latest.tag} bereit`);
        return this.state;
      } catch (e) {
        this.set({ phase: "error", message: e instanceof Error ? e.message : String(e) });
        return this.state;
      }
    });
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}
