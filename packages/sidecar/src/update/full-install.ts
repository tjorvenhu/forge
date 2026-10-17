import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, type AppInstallState, type InstallProblem } from "@forge/protocol";
import {
  compareVersions,
  defaultChainFile,
  defaultReleaseSource,
  fetchSigned,
  FULL_DIR,
  installedRuntimeKey,
  installerRuntimeKey,
  pickInstaller,
  signedOnly,
  UPDATE_REPO,
  updateDir,
  type Asset,
  type Release,
} from "./app-update.js";
import type { ReleaseSource } from "./github-releases.js";

/** Release page for a manual download. */
export const RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

const FIRST_CHECK_MS = 2_000;
const PROGRESS_MS = 500;
/** A FORGE installer has tens of MB; a much smaller file is a broken download or something else. */
const MIN_INSTALLER_BYTES = 1_000_000;
const INSTALLER_FILE = /^FORGE_([^_]+)_.*-setup\.exe$/i;

/** Program of each bundled tool in the runtime folder (scripts/prepare-runtime.mjs); other tools: their folder. */
const TOOL_FILES: Record<string, string> = {
  node: path.join("node", "node.exe"),
  git: path.join("git", "cmd", "git.exe"),
  gh: path.join("gh", "bin", "gh.exe"),
  python: path.join("python", "python.exe"),
};
const TOOL_LABELS: Record<string, string> = { node: "Node.js", git: "Git", gh: "GitHub CLI", python: "Python" };
/** Checked when the build does not know its runtime key. */
const DEFAULT_TOOLS = ["node", "git", "gh"];

const toolLabel = (tool: string) => TOOL_LABELS[tool] ?? tool;

/** Tools and versions of a runtime key like node-24.21.0_git-2.56.0.2_gh-2.102.0; null for another format. */
export function parseRuntimeKey(key: string): Array<{ tool: string; version: string }> | null {
  const parts = key.split("_").map((p) => /^([a-z][a-z0-9]*)-(.+)$/i.exec(p));
  if (!parts.length || parts.some((m) => !m)) return null;
  return parts.map((m) => ({ tool: m![1]!.toLowerCase(), version: m![2]! }));
}

/**
 * What is missing or outdated in the runtime folder compared to the key this app version was built
 * for. Every tool named in the key needs its program and its version in VERSIONS.json, so a tool
 * added to the runtime later (python) counts without a change here.
 */
export function checkRuntime(dir: string | null, expected: string | null): InstallProblem[] {
  if (!dir || !existsSync(dir)) return [{ part: "runtime", kind: "missing", label: "Ordner mit den mitgelieferten Programmen fehlt" }];
  const wanted = expected ? parseRuntimeKey(expected) : null;
  const problems: InstallProblem[] = [];
  for (const tool of wanted?.map((w) => w.tool) ?? DEFAULT_TOOLS) {
    if (!existsSync(path.join(dir, TOOL_FILES[tool] ?? tool))) problems.push({ part: tool, kind: "missing", label: `${toolLabel(tool)} fehlt` });
  }
  let versions: Record<string, unknown>;
  try {
    versions = JSON.parse(readFileSync(path.join(dir, "VERSIONS.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return [...problems, { part: "versions", kind: "missing", label: "Versionsliste der mitgelieferten Programme fehlt" }];
  }
  if (wanted) {
    for (const w of wanted) {
      if (problems.some((p) => p.part === w.tool)) continue;
      const have = typeof versions[w.tool] === "string" ? (versions[w.tool] as string) : null;
      if (have !== w.version) problems.push({ part: w.tool, kind: "outdated", label: have ? `${toolLabel(w.tool)} ${have} statt ${w.version}` : `${toolLabel(w.tool)} ${w.version} fehlt` });
    }
  } else if (expected && installedRuntimeKey(dir) !== expected) {
    problems.push({ part: "runtime", kind: "outdated", label: "Mitgelieferte Programme passen nicht zu dieser Version" });
  }
  return problems;
}

export interface LocalInstaller {
  path: string;
  name: string;
  version: string;
  size: number;
}

/**
 * Installers up to 0.1.7 had short names and an older runtime; from 0.1.8 to 0.1.8x the runtime key was
 * in the name, since then the names are short again (FORGE_<v>_x64-setup.exe, key in a marker asset).
 */
const SHORT_NAMES_SINCE = "0.1.8";

/**
 * Whether a downloaded setup.exe can bring the runtime `key`: a long name says it, a short one from
 * SHORT_NAMES_SINCE on does not (it is accepted; the check after the installation finds a mismatch).
 */
function localInstallerFits(name: string, version: string, key: string | null): boolean {
  if (!key) return true;
  const named = installerRuntimeKey(name);
  if (named) return named === key;
  return compareVersions(version, SHORT_NAMES_SINCE) >= 0;
}

/** The newest FORGE setup.exe in the folders (Downloads), only one that can bring `key` when given. */
export async function findLocalInstaller(dirs: string[], key: string | null): Promise<LocalInstaller | null> {
  let best: LocalInstaller | null = null;
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const version = INSTALLER_FILE.exec(name)?.[1];
      if (!version || !localInstallerFits(name, version, key)) continue;
      const full = path.join(dir, name);
      const st = await stat(full).catch(() => null);
      if (!st?.isFile() || st.size < MIN_INSTALLER_BYTES) continue;
      if (!best || compareVersions(version, best.version) > 0) best = { path: full, name, version, size: st.size };
    }
  }
  return best;
}

/** A Windows program starts with "MZ"; a saved error page or a broken download does not. */
async function looksLikeExe(file: string): Promise<boolean> {
  const h = await open(file, "r");
  try {
    const buf = Buffer.alloc(2);
    await h.read(buf, 0, 2, 0);
    return buf.toString("latin1") === "MZ";
  } finally {
    await h.close();
  }
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) total += (await stat(path.join(dir, name)).catch(() => null))?.size ?? 0;
  return total;
}

export interface FullInstallDeps {
  emit(state: AppInstallState): void;
  log(message: string): void;
  /** false in a development build (default: whether the shell passed FORGE_RUNTIME_EXPECTED) */
  checkable?: boolean;
  /** runtime key the app was built for (default: FORGE_RUNTIME_EXPECTED, empty when the build does not know it) */
  expectedRuntime?: string | null;
  runtimeDir?: () => string | null;
  /** releases and downloads; tests pass a fake */
  source?: ReleaseSource;
  /** key the signatures are checked with; tests pass their own */
  publicKey?: string;
  /** false: only look in the Downloads folder (tests) */
  canDownload?: () => boolean;
  /** folders searched for a setup.exe the user downloaded */
  localDirs?: () => string[];
  /** where the installer goes; the desktop shell runs installers only from updateDir() */
  downloadDir?: string;
  /** the small update after an older installer installs itself after the restart (AppUpdateService) */
  chainFile?: string;
  /** asks the main window to run the installation (the desktop shell runs installers) */
  requestInstall?: () => void;
}

/**
 * Notices an incomplete installation (an update zip unpacked instead of the installer, or a runtime
 * older than this version needs) and fetches the full installer for the runtime this version was
 * built for: signed from the GitHub releases, or from the Downloads folder when GitHub has none or is
 * not reachable. Installing is the same path as an update (app-install.ts in the desktop app).
 */
export class FullInstallService {
  private state: AppInstallState;
  private readonly expected: string | null;
  private readonly chainFile: string;
  private readonly downloadDir: string;
  private readonly releases: ReleaseSource;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<AppInstallState> | null = null;
  /** what download() fetches */
  private source: { kind: "github"; tag: string; asset: Asset; then: string | null } | { kind: "local"; path: string } | null = null;

  constructor(private readonly d: FullInstallDeps) {
    const env = process.env.FORGE_RUNTIME_EXPECTED;
    this.expected = d.expectedRuntime !== undefined ? d.expectedRuntime : env || null;
    this.chainFile = d.chainFile ?? defaultChainFile();
    this.downloadDir = d.downloadDir ?? path.join(updateDir(), FULL_DIR);
    this.releases = d.source ?? defaultReleaseSource();
    this.state = {
      checkable: d.checkable ?? env !== undefined,
      complete: null,
      problems: [],
      expectedRuntime: this.expected,
      phase: "idle",
      installer: null,
      received: null,
      installerPath: null,
      canDownload: false,
      checkedAt: null,
      message: null,
    };
  }

  /** Checks shortly after the start, so the hint is there right away. */
  start() {
    if (!this.state.checkable) return;
    this.timer = setTimeout(() => void this.check().catch(() => {}), FIRST_CHECK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get(): AppInstallState {
    return this.state;
  }

  private set(patch: Partial<AppInstallState>) {
    this.state = { ...this.state, ...patch };
    this.d.emit(this.state);
  }

  private canDownload(): boolean {
    return this.d.canDownload?.() ?? true;
  }

  private once(job: () => Promise<AppInstallState>): Promise<AppInstallState> {
    this.busy ??= job().finally(() => (this.busy = null));
    return this.busy;
  }

  /** Checks the runtime again and, when something is missing, looks for the matching full installer. */
  check(): Promise<AppInstallState> {
    return this.once(async () => {
      if (!this.state.checkable) return this.state;
      const runtimeDir = this.d.runtimeDir ? this.d.runtimeDir() : process.env.FORGE_RUNTIME_DIR || null;
      const problems = checkRuntime(runtimeDir, this.expected);
      const checkedAt = new Date().toISOString();
      const canDownload = this.canDownload();
      if (!problems.length) {
        this.source = null;
        this.set({ complete: true, problems, phase: "idle", installer: null, installerPath: null, received: null, canDownload, checkedAt, message: null });
        return this.state;
      }
      if (this.state.complete !== false) this.d.log(`Installation unvollständig: ${problems.map((p) => p.label).join(", ")}`);
      // A checked installer stays usable.
      if (this.state.phase === "ready" && this.state.installerPath && existsSync(this.state.installerPath)) {
        this.set({ complete: false, problems, canDownload, checkedAt });
        return this.state;
      }
      this.set({ complete: false, problems, phase: "searching", canDownload, checkedAt, message: null, received: null });
      await this.search(canDownload);
      return this.state;
    });
  }

  private async search(canDownload: boolean) {
    let failure: string | null = null;
    if (canDownload) {
      try {
        const found = await this.releases.releases();
        const pick = found ? pickInstaller(signedOnly(found as Release[]), this.expected) : null;
        if (pick) {
          const tag = pick.release.tag_name!;
          const then = pick.then?.tag_name ?? null;
          this.source = { kind: "github", tag, asset: pick.asset, then };
          this.set({
            phase: "found",
            installer: { version: tag.replace(/^v/i, ""), tag, name: pick.asset.name, size: pick.asset.size ?? null, source: "github", then: then?.replace(/^v/i, "") ?? null },
            installerPath: null,
          });
          return;
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
    }
    const local = await findLocalInstaller(this.d.localDirs?.() ?? [path.join(os.homedir(), "Downloads")], this.expected);
    if (local) {
      this.offerLocal(local);
      return;
    }
    this.source = null;
    this.set({ phase: failure ? "error" : "none", installer: null, installerPath: null, message: failure ?? this.noneMessage(canDownload) });
  }

  private noneMessage(canDownload: boolean): string {
    if (!canDownload) return "FORGE kann den Installer gerade nicht selbst laden. Lade die setup.exe von der Release-Seite herunter und wähle sie hier aus.";
    return `Auf GitHub gibt es noch keinen Installer für diese Laufzeit${this.expected ? ` (${this.expected})` : ""}. Er entsteht mit dem nächsten Release, das die Laufzeit ändert, oder in GitHub Actions über Release, Run workflow mit full.`;
  }

  private offerLocal(local: LocalInstaller) {
    this.source = { kind: "local", path: local.path };
    this.set({ phase: "found", installer: { version: local.version, tag: null, name: local.name, size: local.size, source: "local", then: null }, installerPath: null, message: null });
  }

  /** A setup.exe the user picked; refused when it brings another runtime than this version needs. */
  useLocal(file: string): Promise<AppInstallState> {
    return this.once(async () => {
      const name = path.basename(file);
      const version = INSTALLER_FILE.exec(name)?.[1];
      if (!version) throw new ForgeError("VALIDATION", "Das ist kein FORGE-Installer. Gesucht ist eine Datei wie FORGE_0.1.90_x64-setup.exe.");
      const key = installerRuntimeKey(name);
      if (!localInstallerFits(name, version, this.expected)) {
        throw new ForgeError("VALIDATION", `Dieser Installer bringt ${key ? `die Laufzeit ${key}` : "eine ältere Laufzeit"} mit. Diese FORGE-Version braucht ${this.expected}.`);
      }
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) throw new ForgeError("VALIDATION", "Die Datei gibt es nicht.");
      this.offerLocal({ path: file, name, version, size: st.size });
      return this.fetch();
    });
  }

  /** Downloads and checks the installer that was found, or copies the local one; ready to run afterwards. */
  download(): Promise<AppInstallState> {
    return this.once(() => this.fetch());
  }

  private async fetch(): Promise<AppInstallState> {
    if (this.state.phase === "ready" && this.state.installerPath && existsSync(this.state.installerPath)) return this.state;
    const src = this.source;
    if (!src) {
      this.set({ phase: "error", message: "Kein Installer gefunden. Erst die Installation prüfen." });
      return this.state;
    }
    this.set({ phase: "downloading", received: 0, message: null, installerPath: null });
    let poll: ReturnType<typeof setInterval> | null = null;
    try {
      await rm(this.downloadDir, { recursive: true, force: true });
      const dir = path.join(this.downloadDir, src.kind === "github" ? src.tag.replace(/[^\w.-]/g, "_") : "local");
      await mkdir(dir, { recursive: true });
      let file: string;
      if (src.kind === "local") {
        file = path.join(dir, path.basename(src.path));
        await copyFile(src.path, file);
      } else {
        poll = setInterval(() => {
          void folderBytes(dir).then((received) => {
            if (this.state.phase === "downloading" && received !== this.state.received) this.set({ received });
          });
        }, PROGRESS_MS);
        poll.unref?.();
        try {
          file = await fetchSigned(this.releases, src.asset, dir, 30 * 60_000, this.d.publicKey);
        } finally {
          clearInterval(poll);
          poll = null;
        }
      }
      const size = (await stat(file)).size;
      if (src.kind === "github" && src.asset.size && size !== src.asset.size) throw new Error(`Der Installer ist unvollständig (${size} von ${src.asset.size} Bytes). Download verworfen.`);
      if (size < MIN_INSTALLER_BYTES || !(await looksLikeExe(file))) throw new Error("Die Datei ist kein vollständiger Installer.");
      // An older installer: the newest small update for its runtime follows by itself after the restart.
      if (src.kind === "github" && src.then) writeFileSync(this.chainFile, JSON.stringify({ target: src.then }));
      this.set({ phase: "ready", installerPath: file, received: size });
      this.d.log(`Vollständige Installation: ${path.basename(file)} bereit${src.kind === "github" && src.then ? `, danach ${src.then}` : ""}`);
      return this.state;
    } catch (e) {
      if (poll) clearInterval(poll);
      await rm(this.downloadDir, { recursive: true, force: true }).catch(() => {});
      this.set({ phase: "error", installerPath: null, received: null, message: e instanceof Error ? e.message : String(e) });
      return this.state;
    }
  }

  /** Asks the main window to run the full installation; the phone has no other way to. */
  requestInstall(): AppInstallState {
    if (!this.state.checkable) throw new ForgeError("VALIDATION", "Das geht nur in der installierten App, nicht im Entwicklungsmodus.");
    if (this.state.complete) throw new ForgeError("VALIDATION", "FORGE ist vollständig installiert.");
    if (!this.source) throw new ForgeError("VALIDATION", this.state.message ?? "Es gibt keinen passenden Installer. Erst die Installation prüfen.");
    if (!this.d.requestInstall) throw new ForgeError("VALIDATION", "Installieren geht hier nicht.");
    this.d.requestInstall();
    return this.state;
  }
}
