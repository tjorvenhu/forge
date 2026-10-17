import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { constants, copyFile, cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type Project, type WorktreeSetupState, type WorktreeSetupStep } from "@forge/protocol";
import type { DevServerService } from "../devserver/dev-server.js";
import { withPortFlag } from "../devserver/port-args.js";
import type { SeedResult } from "../devtools/test-db.js";
import type { GitEngine } from "../git/git.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { pathKey } from "../util/paths.js";
import { findFreePort, isPortFree } from "../util/ports.js";
import { killTree, onFinished } from "../util/proc.js";
import { worktreeRoot } from "./worktrees.js";

/** Agents' dev servers start here, away from the usual 3000 and 5173 of the main project. */
export const FIRST_AGENT_DEV_PORT = 4100;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const COPY_TIMEOUT_MS = 10 * 60_000;
const MAX_CONFIG_FILE = 1_000_000;
/** Build output beyond this is cheaper to rebuild than to copy for every agent. */
const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
const MAX_OUTPUT_FILES = 20_000;
const OUTPUT_TAIL = 4000;

/**
 * Local configuration git ignores: .env files, *.local files (.env.local, settings.local.json,
 * docker-compose.local.yml), wrangler's .dev.vars and registry settings an install may need.
 */
export const LOCAL_CONFIG = /(^|\/)(\.env(\.[^/]+)?|[^/]+\.local(\.[^/]+)?|\.dev\.vars|\.npmrc|\.yarnrc)$/i;
const BUILD_OUTPUT = /(^|\/)(dist|build)\/$/;
const CARGO_TARGET = /(^|\/)target\/$/;
/**
 * Compiled dependencies of a debug build. Not `incremental` (bound to the crate's path, so useless
 * in another folder) and not the copies of Tauri's resources (rebuilt on every build).
 */
const CARGO_CACHE = [".fingerprint", "build", "deps"];
const NODE_LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"];

const STEPS: ReadonlyArray<[WorktreeSetupStep["id"], string]> = [
  ["files", "Lokale Konfiguration"],
  ["deps", "Abhängigkeiten"],
  ["build", "Build-Ausgaben"],
  ["database", "Test-Datenbank"],
  ["devserver", "Dev-Server"],
];

type StepResult = { status: "done" | "skipped" | "failed"; detail: string | null };

export interface ShellResult {
  code: number | null;
  output: string;
}

/** Runs a command; `onKill` receives a function that ends it (worktree removed meanwhile). */
export type ShellRunner = (command: string, cwd: string, env: Record<string, string>, onKill: (kill: () => void) => void, opts?: { shell?: boolean; args?: string[] }) => Promise<ShellResult>;

export interface WorktreeSetupDeps {
  git: GitEngine;
  projects: ProjectManager;
  env: () => Record<string, string>;
  emit: (state: WorktreeSetupState) => void;
  testDb?: { seed(projectId: string): Promise<SeedResult>; forget(projectId: string): Promise<void> } | null;
  devServers?: () => Pick<DevServerService, "state" | "start" | "forget">;
  log?: (m: string) => void;
  /** test hooks */
  portFree?: (port: number) => Promise<boolean>;
  shell?: ShellRunner;
}

interface Job {
  state: WorktreeSetupState;
  kills: Set<() => void>;
  cancelled: boolean;
  done: Promise<void>;
}

export interface InstallStep {
  command: string;
  cwd: string;
}

function nearest(from: string, top: string, has: (dir: string) => boolean): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (has(dir)) return dir;
    if (pathKey(dir) === pathKey(top) || path.dirname(dir) === dir) return null;
  }
}

function nodeInstall(dir: string): string {
  const has = (f: string) => existsSync(path.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile --prefer-offline";
  if (has("bun.lock") || has("bun.lockb")) return "bun install --frozen-lockfile";
  if (has("yarn.lock")) return has(".yarnrc.yml") ? "yarn install --immutable" : "yarn install --frozen-lockfile --prefer-offline";
  return "npm ci --prefer-offline --no-audit --no-fund";
}

/**
 * What installs the worktree's dependencies like the main folder has them: the lockfile next to
 * the project or further up in the checkout, exactly as locked; Python only where the main folder
 * has a virtual environment (or uv manages one).
 */
export function installPlan(projectDir: string, top: string, mainTop: string | null): InstallStep[] {
  const steps: InstallStep[] = [];
  const inMain = (dir: string) => (mainTop ? path.join(mainTop, path.relative(top, dir)) : null);
  const nodeDir = nearest(projectDir, top, (d) => NODE_LOCKS.some((f) => existsSync(path.join(d, f))));
  if (nodeDir) steps.push({ command: nodeInstall(nodeDir), cwd: nodeDir });
  else if (existsSync(path.join(projectDir, "package.json")) && existsSync(path.join(inMain(projectDir) ?? "", "node_modules"))) {
    steps.push({ command: "npm install --no-audit --no-fund", cwd: projectDir });
  }
  if (existsSync(path.join(projectDir, "uv.lock"))) steps.push({ command: "uv sync --frozen", cwd: projectDir });
  else if (existsSync(path.join(projectDir, "requirements.txt"))) {
    const main = inMain(projectDir);
    const venv = main ? [".venv", "venv"].find((v) => existsSync(path.join(main, v, "pyvenv.cfg"))) : undefined;
    if (venv) {
      const python = path.join(venv, process.platform === "win32" ? "Scripts" : "bin", "python");
      steps.push({ command: `python -m venv ${venv} && ${python} -m pip install -r requirements.txt`, cwd: projectDir });
    }
  }
  return steps;
}

/** Size of a folder, or null once it passes the limits. Symlinks and junctions count as nothing. */
async function sizeWithin(dir: string, maxBytes: number, maxFiles: number): Promise<number | null> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<boolean> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!(await walk(full))) return false;
      } else if (e.isFile()) {
        bytes += (await stat(full)).size;
        if (++files > maxFiles || bytes > maxBytes) return false;
      }
    }
    return true;
  };
  return (await walk(dir).catch(() => false)) ? bytes : null;
}

function lastLines(text: string, n: number, max = 400): string {
  const t = text.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(" | ");
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

export const runShell: ShellRunner = (command, cwd, env, onKill, opts) =>
  new Promise((resolve) => {
    // Like the dev server: the command comes from the project (its lockfile), run by the user's shell.
    const child = opts?.shell === false ? spawn(command, opts.args ?? [], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (d: Buffer) => {
      output = (output + d.toString("utf8")).slice(-OUTPUT_TAIL);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => killTree(child), opts?.shell === false ? COPY_TIMEOUT_MS : INSTALL_TIMEOUT_MS);
    onKill(() => killTree(child));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: e.message });
    });
    onFinished(child, (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

/**
 * Makes an agent's worktree ready to work in like the main folder: git only brings the tracked
 * files, so FORGE adds what the main folder has besides them. Local configuration copied (only
 * files git ignores in the worktree too, so nothing of it can be committed), dependencies
 * installed from the lockfile, build output and the Rust dependency cache taken over, a test
 * database of its own and a dev server with its own port.
 *
 * Runs beside the agent's session: its start context says what is still going on, and
 * dev_environment can wait for it. Failures never block the agent; it reads them there.
 */
export class WorktreeSetup {
  private readonly jobs = new Map<string, Job>();
  private readonly ports = new Map<string, number>();
  private portQueue: Promise<unknown> = Promise.resolve();
  private readonly shell: ShellRunner;

  constructor(private readonly d: WorktreeSetupDeps) {
    this.shell = d.shell ?? runShell;
  }

  state(projectId: string): WorktreeSetupState | null {
    const job = this.jobs.get(projectId);
    return job ? snapshot(job.state) : null;
  }

  /** Starts preparing a new worktree; a preparation already running is kept. */
  start(parent: Project, worktree: Project): WorktreeSetupState {
    const running = this.jobs.get(worktree.id);
    if (running && running.state.status === "running") return snapshot(running.state);
    const job: Job = {
      state: {
        projectId: worktree.id,
        status: "running",
        steps: STEPS.map(([id, label]) => ({ id, label, status: "pending", detail: null, durationMs: null })),
        devPort: this.ports.get(worktree.id) ?? null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
      kills: new Set(),
      cancelled: false,
      done: Promise.resolve(),
    };
    this.jobs.set(worktree.id, job);
    this.emit(job);
    job.done = this.run(job, parent, worktree).catch((e: unknown) => {
      this.d.log?.(`Worktree-Vorbereitung abgebrochen: ${e instanceof Error ? e.message : String(e)}`);
      this.finish(job, Date.now());
    });
    return snapshot(job.state);
  }

  /** Runs the preparation of a worktree again, e.g. after a failed install. */
  rerun(projectId: string): WorktreeSetupState {
    const worktree = this.d.projects.requireExisting(projectId);
    if (!worktree.parentId) throw new ForgeError("VALIDATION", "Das ist kein Worktree-Projekt.");
    return this.start(this.d.projects.requireExisting(worktree.parentId), worktree);
  }

  /** Waits up to `ms` for a running preparation. */
  async wait(projectId: string, ms: number): Promise<WorktreeSetupState | null> {
    const job = this.jobs.get(projectId);
    if (job?.state.status === "running") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
    }
    return this.state(projectId);
  }

  /**
   * Before the worktree folder goes: ends what still runs in it (an install would hold the folder
   * open on Windows), its dev server and its test database with their data.
   */
  async release(projectId: string) {
    const job = this.jobs.get(projectId);
    if (job) {
      job.cancelled = true;
      for (const kill of job.kills) kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, 10_000)))]);
      clearTimeout(timer);
      this.jobs.delete(projectId);
    }
    this.ports.delete(projectId);
    await this.d.devServers?.().forget(projectId).catch(() => undefined);
    await this.d.testDb?.forget(projectId).catch(() => undefined);
  }

  /** On exit: installs and copies still running end with FORGE. The next start of the agent's session goes on without them. */
  shutdown() {
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      for (const kill of job.kills) kill();
    }
  }

  /**
   * Port of a worktree's own dev server, null for main projects. Stays the same for the worktree,
   * so its address does not change between restarts of the server.
   */
  devPort(projectId: string): Promise<number | null> {
    const project = this.d.projects.all().find((p) => p.id === projectId);
    if (!project?.parentId) return Promise.resolve(null);
    const known = this.ports.get(projectId);
    if (known !== undefined) return Promise.resolve(known);
    // One after the other: two agents starting together must not get the same free port.
    const next = this.portQueue.then(async () => {
      const again = this.ports.get(projectId);
      if (again !== undefined) return again;
      const port = await findFreePort(FIRST_AGENT_DEV_PORT, this.ports.values(), this.d.portFree ?? isPortFree);
      this.ports.set(projectId, port);
      const job = this.jobs.get(projectId);
      if (job) job.state.devPort = port;
      return port;
    });
    this.portQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * The dev server of a worktree on its own port: PORT for servers that read it, `--port` for those
   * that need the flag (Vite, Next.js and others). Null for main projects, which keep theirs.
   */
  async devServerPort(projectId: string, command: string): Promise<{ env: Record<string, string>; command: string; note: string } | null> {
    const port = await this.devPort(projectId);
    if (port === null) return null;
    const dir = this.d.projects.get(projectId).path;
    const flagged = await withPortFlag(command, port, dir);
    return {
      env: { PORT: String(port) },
      command: flagged ?? command,
      note: flagged ? `Eigener Port dieses Agenten: ${port}` : `Eigener Port dieses Agenten: ${port} (als PORT übergeben; liest der Server ihn nicht, nutzt er seinen eigenen)`,
    };
  }

  /** For dev_environment: what FORGE prepared and what is still running. Null outside agents' worktrees. */
  describe(projectId: string): string | null {
    const s = this.jobs.get(projectId)?.state;
    if (!s) return null;
    const head =
      s.status === "running"
        ? `läuft seit ${seconds(Date.now() - Date.parse(s.startedAt))}`
        : `${s.status === "failed" ? "mit Fehlern beendet" : "fertig"} nach ${seconds(Date.parse(s.finishedAt ?? s.startedAt) - Date.parse(s.startedAt))}`;
    const status: Record<WorktreeSetupStep["status"], string> = { pending: "wartet", running: "läuft", done: "fertig", skipped: "übersprungen", failed: "fehlgeschlagen" };
    return [
      `Vorbereitung des Worktrees (FORGE, ${head}):`,
      ...s.steps.map((step) => `  ${step.label}: ${status[step.status]}${step.detail ? `, ${step.detail}` : ""}`),
      s.status === "failed" ? "  Was fehlgeschlagen ist, kannst du selbst nachholen, z. B. die Installation mit dem gleichen Befehl." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** Lines for the start context of the agent's session. */
  context(projectId: string): string {
    const s = this.jobs.get(projectId)?.state;
    if (!s) return "";
    const port = s.devPort ? ` Dein Dev-Server hat einen eigenen Port (${s.devPort}), getrennt vom Hauptprojekt; dev_control startet ihn.` : "";
    if (s.status !== "running") {
      return `Dein Worktree ist vorbereitet wie der Hauptordner (Abhängigkeiten, lokale Konfiguration, Build-Ausgaben, eigene Test-Datenbank).${port} Stand und Fehler zeigt dev_environment.`;
    }
    const running = s.steps.filter((x) => x.status === "running" || x.status === "pending").map((x) => x.label);
    return [
      `FORGE bereitet deinen Worktree gerade vor wie den Hauptordner (${running.join(", ")}). Installiere Abhängigkeiten nicht selbst, das läuft schon; bis dahin kannst du lesen und planen.`,
      "Vor dem ersten Build, Test oder Dev-Server-Start: mcp__forge__dev_environment mit wait=true wartet, bis die Vorbereitung fertig ist, und zeigt, was fehlgeschlagen ist.",
      port.trim(),
    ]
      .filter(Boolean)
      .join(" ");
  }

  private emit(job: Job) {
    this.d.emit(snapshot(job.state));
  }

  private async run(job: Job, parent: Project, worktree: Project) {
    const t0 = Date.now();
    const top = worktreeRoot(worktree.path);
    const loc = await this.d.git.exec(parent.path, ["rev-parse", "--show-toplevel"]).catch(() => null);
    const mainTop = loc?.code === 0 && loc.stdout.trim() ? path.resolve(loc.stdout.trim()) : null;
    await this.devPort(worktree.id);
    const ignored = mainTop ? await this.ignored(mainTop) : [];

    // Local configuration first: an install may need its registry settings (.npmrc).
    await this.step(job, "files", () => this.copyConfig(job, ignored, mainTop, top));
    const deps = this.step(job, "deps", () => this.install(job, worktree.path, top, mainTop));
    // After the install: both write lots of files, one after the other is faster than both at once.
    const build = deps.then(() => this.step(job, "build", () => this.provideBuild(job, ignored, mainTop, top)));
    const database = this.step(job, "database", () => this.seedDatabase(worktree.id));
    await Promise.all([deps, database]);
    const dev = this.step(job, "devserver", () => this.startDevServer(job, parent, worktree));
    await Promise.all([build, dev]);
    this.finish(job, t0);
  }

  private finish(job: Job, t0: number) {
    if (job.state.status !== "running") return;
    for (const step of job.state.steps) if (step.status === "pending" || step.status === "running") Object.assign(step, { status: "skipped", detail: "abgebrochen" });
    job.state.status = job.state.steps.some((s) => s.status === "failed") ? "failed" : "done";
    job.state.finishedAt = new Date().toISOString();
    if (!job.cancelled) this.emit(job);
    const parts = job.state.steps.map((s) => `${s.id} ${s.status}${s.durationMs !== null ? ` ${seconds(s.durationMs)}` : ""}`).join(", ");
    this.d.log?.(`Worktree vorbereitet in ${seconds(Date.now() - t0)}: ${parts}`);
  }

  private async step(job: Job, id: WorktreeSetupStep["id"], work: () => Promise<StepResult>) {
    const step = job.state.steps.find((s) => s.id === id)!;
    if (job.cancelled) {
      Object.assign(step, { status: "skipped", detail: "abgebrochen" });
      return;
    }
    const t = Date.now();
    Object.assign(step, { status: "running" });
    this.emit(job);
    let result: StepResult;
    try {
      result = await work();
    } catch (e) {
      result = { status: "failed", detail: e instanceof Error ? e.message : String(e) };
    }
    if (job.cancelled) result = { status: "skipped", detail: "abgebrochen" };
    Object.assign(step, { ...result, durationMs: Date.now() - t });
    if (!job.cancelled) this.emit(job);
  }

  /** Paths in the main folder git ignores, relative to its top, folders with a trailing slash. */
  private async ignored(mainTop: string): Promise<string[]> {
    const r = await this.d.git.exec(mainTop, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], undefined, 60_000).catch(() => null);
    return r?.code === 0 ? r.stdout.split("\0").filter(Boolean) : [];
  }

  private async copyConfig(job: Job, ignored: string[], mainTop: string | null, top: string): Promise<StepResult> {
    if (!mainTop) return { status: "skipped", detail: "Hauptordner nicht gefunden." };
    const candidates = ignored.filter((f) => !f.endsWith("/") && LOCAL_CONFIG.test(f));
    if (!candidates.length) return { status: "skipped", detail: "Keine lokalen Konfigurationsdateien im Hauptordner." };
    // Only what git ignores in the worktree too: a copy then never shows up as a change to commit.
    // check-ignore refuses literal pathspecs ("pathspec magic not supported"), which GitEngine sets.
    const r = await this.d.git.exec(top, ["check-ignore", "-z", "--stdin"], candidates.join("\0"), undefined, { GIT_LITERAL_PATHSPECS: "0" });
    const safe = new Set(r.code === 0 ? r.stdout.split("\0").filter(Boolean) : []);
    const copied: string[] = [];
    for (const rel of candidates) {
      if (job.cancelled) break;
      if (!safe.has(rel)) continue;
      const from = path.join(mainTop, rel);
      const to = path.join(top, rel);
      const s = await stat(from).catch(() => null);
      if (!s?.isFile() || s.size > MAX_CONFIG_FILE || existsSync(to)) continue;
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to, constants.COPYFILE_EXCL).then(
        () => copied.push(rel),
        () => undefined,
      );
    }
    if (!copied.length) return { status: "skipped", detail: "Nichts zu kopieren." };
    const names = copied.length > 6 ? `${copied.slice(0, 6).join(", ")} und ${copied.length - 6} weitere` : copied.join(", ");
    return { status: "done", detail: `${copied.length} ${copied.length === 1 ? "Datei" : "Dateien"} kopiert: ${names}` };
  }

  private async install(job: Job, projectDir: string, top: string, mainTop: string | null): Promise<StepResult> {
    const plan = installPlan(projectDir, top, mainTop);
    if (!plan.length) return { status: "skipped", detail: "Kein Lockfile gefunden." };
    const done: string[] = [];
    // CI: no questions (pnpm asks before replacing node_modules), no colors in the output.
    const env = { ...this.d.env(), CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" };
    for (const s of plan) {
      if (job.cancelled) break;
      const t = Date.now();
      const r = await this.shell(s.command, s.cwd, env, (kill) => job.kills.add(kill));
      const where = pathKey(s.cwd) === pathKey(projectDir) ? "" : ` in ${path.relative(top, s.cwd) || "."}`;
      if (r.code !== 0) {
        return { status: "failed", detail: [...done, `${s.command}${where} fehlgeschlagen (Exit-Code ${r.code ?? "?"}): ${lastLines(r.output, 3)}`].join("; ") };
      }
      done.push(`${s.command}${where} in ${seconds(Date.now() - t)}`);
    }
    return { status: "done", detail: done.join("; ") };
  }

  private async provideBuild(job: Job, ignored: string[], mainTop: string | null, top: string): Promise<StepResult> {
    if (!mainTop) return { status: "skipped", detail: "Hauptordner nicht gefunden." };
    const ignoredDirs = new Set(ignored.filter((f) => f.endsWith("/")));
    const done: string[] = [];
    const failed: string[] = [];

    for (const rel of ignoredDirs) {
      if (job.cancelled) break;
      const parentRel = path.dirname(rel.slice(0, -1));
      const mainParent = path.join(mainTop, parentRel);
      if (CARGO_TARGET.test(rel) && existsSync(path.join(mainParent, "Cargo.toml"))) {
        const r = await this.copyCargoCache(job, path.join(mainTop, rel), path.join(top, rel));
        if (r) (r.ok ? done : failed).push(`${r.ok ? "Rust-Abhängigkeiten" : "Rust-Abhängigkeiten nicht kopiert"} (${rel.slice(0, -1)}${r.ok ? "" : `: ${r.detail}`})`);
        for (const res of await tauriResources(mainParent)) {
          const resRel = path.posix.join(parentRel === "." ? "" : parentRel.replace(/\\/g, "/"), res);
          const from = path.join(mainTop, resRel);
          const to = path.join(top, resRel);
          if (!ignoredDirs.has(`${resRel}/`) || !existsSync(from) || existsSync(to)) continue;
          // Copied, never linked: git worktree remove on Windows follows a junction and empties its target.
          const err = await this.copyTree(job, from, to);
          if (err === null) done.push(`${resRel} kopiert`);
          else failed.push(`${resRel} nicht kopiert: ${err}`);
        }
      } else if (BUILD_OUTPUT.test(rel) && existsSync(path.join(mainParent, "package.json"))) {
        const from = path.join(mainTop, rel);
        const to = path.join(top, rel);
        if (existsSync(to) || (await sizeWithin(from, MAX_OUTPUT_BYTES, MAX_OUTPUT_FILES)) === null) continue;
        const err = await this.copyTree(job, from, to);
        if (err === null) done.push(`${rel.slice(0, -1)} kopiert`);
        else failed.push(`${rel.slice(0, -1)} nicht kopiert: ${err}`);
      }
    }
    if (failed.length) return { status: "failed", detail: [...done, ...failed].join("; ") };
    if (!done.length) return { status: "skipped", detail: "Nichts zu übernehmen." };
    return { status: "done", detail: done.join("; ") };
  }

  /**
   * A copy, not a shared target folder: cargo locks its target folder for every build, and the
   * final binaries of both builds would land on the same path, one overwriting the other.
   */
  private async copyCargoCache(job: Job, from: string, to: string): Promise<{ ok: boolean; detail: string } | null> {
    const profile = path.join(from, "debug");
    if (existsSync(to) || !existsSync(profile)) return null;
    for (const part of CARGO_CACHE) {
      if (job.cancelled) return null;
      const src = path.join(profile, part);
      if (!existsSync(src)) continue;
      const err = await this.copyTree(job, src, path.join(to, "debug", part));
      if (err !== null) return { ok: false, detail: err };
    }
    for (const f of ["CACHEDIR.TAG", ".rustc_info.json"]) {
      if (existsSync(path.join(from, f))) await copyFile(path.join(from, f), path.join(to, f)).catch(() => undefined);
    }
    return { ok: true, detail: "" };
  }

  /**
   * Copies a folder with its timestamps (cargo compares them), without links: a link in the
   * worktree would make git's removal of it delete what it points to. Null on success, else why not.
   */
  private async copyTree(job: Job, from: string, to: string): Promise<string | null> {
    if (process.platform === "win32") {
      // robocopy: many threads; /XJ leaves junctions out; exit codes below 8 are success.
      const r = await this.shell("robocopy", path.dirname(from), this.d.env(), (kill) => job.kills.add(kill), {
        shell: false,
        args: [from, to, "/E", "/XJ", "/MT:16", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
      });
      return r.code !== null && r.code < 8 ? null : lastLines(r.output, 2) || `robocopy Code ${r.code ?? "?"}`;
    }
    try {
      await cp(from, to, { recursive: true, preserveTimestamps: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  private async seedDatabase(projectId: string): Promise<StepResult> {
    if (!this.d.testDb) return { status: "skipped", detail: null };
    const r = await this.d.testDb.seed(projectId);
    if (r === "none") return { status: "skipped", detail: "Das Projekt hat keine Test-Datenbank." };
    if (r === "exists") return { status: "done", detail: "Eigene Test-Datenbank vorhanden." };
    if (r === "parent-running") {
      return { status: "done", detail: "Die Datenbank des Projekts läuft gerade und lässt sich so nicht kopieren. Der erste Start legt eine eigene, leere an (Migrationen danach ausführen)." };
    }
    return { status: "done", detail: "Eigene Kopie der Datenbank des Projekts, eigener Port beim Start." };
  }

  /**
   * Starts the agent's dev server right away only if the project's runs: then the user works with
   * it and previews and before/after pictures need one. Otherwise only its port is reserved.
   */
  private async startDevServer(job: Job, parent: Project, worktree: Project): Promise<StepResult> {
    const dev = this.d.devServers?.();
    if (!dev) return { status: "skipped", detail: null };
    const own = await dev.state(worktree.id);
    if (!own.effectiveCommand) return { status: "skipped", detail: "Kein Dev-Server-Befehl bekannt." };
    const port = job.state.devPort ? `Port ${job.state.devPort}` : "eigener Port";
    if (own.status === "running") return { status: "done", detail: `läuft (${port})` };
    const main = await dev.state(parent.id).catch(() => null);
    if (main?.status !== "running" || job.cancelled) return { status: "skipped", detail: `startet bei Bedarf (${port})` };
    const s = await dev.start(worktree.id);
    if (s.status !== "running") return { status: "failed", detail: s.error ?? `beendet${s.exitCode !== null ? ` mit Exit-Code ${s.exitCode}` : ""}` };
    return { status: "done", detail: `gestartet, weil der des Projekts läuft (${port})` };
  }
}

/** Resource folders a Tauri app bundles (tauri.conf.json bundle.resources), first path part only. */
async function tauriResources(cargoDir: string): Promise<string[]> {
  let conf: { bundle?: { resources?: unknown } };
  try {
    conf = JSON.parse(await readFile(path.join(cargoDir, "tauri.conf.json"), "utf8")) as typeof conf;
  } catch {
    return [];
  }
  const res = conf.bundle?.resources;
  const list = Array.isArray(res) ? res : res && typeof res === "object" ? Object.keys(res) : [];
  const dirs = list
    .filter((r): r is string => typeof r === "string")
    .map((r) => r.replace(/\\/g, "/").split("/")[0] ?? "")
    .filter((d) => d && d !== "." && d !== ".." && !/[*?[\]{}]/.test(d));
  return [...new Set(dirs)];
}

function snapshot(s: WorktreeSetupState): WorktreeSetupState {
  return { ...s, steps: s.steps.map((x) => ({ ...x })) };
}
