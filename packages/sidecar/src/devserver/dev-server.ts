import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { ForgeError, type DevServerState } from "@forge/protocol";
import type { ProjectManager } from "../projects/project-manager.js";
import { detectDevCommand } from "../projects/tech.js";

/** Kept per project; older output is dropped. */
const MAX_LOG_CHARS = 200_000;
/** Output is batched so a chatty dev server does not flood the UI with events. */
const FLUSH_MS = 120;

interface Running {
  child: ChildProcess | null;
  state: DevServerState;
  log: string;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Z0-9]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*):\d{2,5}(?:\/[^\s"'<>`]*)?/gi;

/**
 * First local address in dev server output ("Local: http://localhost:5173/"). Addresses on this
 * machine win over network ones; wildcard hosts are shown as localhost.
 */
export function findLocalUrl(text: string): string | null {
  const found = [...stripAnsi(text).matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:)\]]+$/, ""));
  if (!found.length) return null;
  const local = found.find((u) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])[:/]/i.test(u)) ?? found[0]!;
  return local.replace(/\/\/(0\.0\.0\.0|\[::1?\])(?=:)/, "//localhost");
}

/** Ends the process and everything it started (the shell, the package manager, the dev server). */
function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

/**
 * Runs the dev server of a project (e.g. "pnpm dev"). Like the test command this intentionally uses
 * a shell: the command comes from the user's project settings or the project's own package.json.
 */
export class DevServerService {
  private servers = new Map<string, Running>();

  constructor(
    private readonly projects: ProjectManager,
    private readonly env: () => Record<string, string>,
    private readonly emit: (e: { event: "devserver.updated"; payload: DevServerState } | { event: "devserver.output"; payload: { projectId: string; text: string } }) => void,
  ) {}

  private async effectiveCommand(projectId: string): Promise<string | null> {
    const p = this.projects.get(projectId);
    return p.devCommand ?? (p.exists ? await detectDevCommand(p.path) : null);
  }

  async state(projectId: string): Promise<DevServerState> {
    const r = this.servers.get(projectId);
    const effectiveCommand = await this.effectiveCommand(projectId);
    if (r) return { ...r.state, effectiveCommand };
    return { projectId, status: "stopped", command: null, url: null, startedAt: null, exitCode: null, error: null, effectiveCommand };
  }

  output(projectId: string): string {
    const r = this.servers.get(projectId);
    return r ? r.log + r.pending : "";
  }

  async start(projectId: string): Promise<DevServerState> {
    const project = this.projects.requireExisting(projectId);
    const running = this.servers.get(projectId);
    if (running?.state.status === "running") return this.state(projectId);
    const command = await this.effectiveCommand(projectId);
    if (!command) {
      throw new ForgeError("VALIDATION", "Kein Dev-Server-Befehl bekannt. Trage ihn in den Projekt-Einstellungen ein, z. B. pnpm dev.");
    }
    const r: Running = {
      child: null,
      state: { projectId, status: "running", command, url: null, startedAt: new Date().toISOString(), exitCode: null, error: null, effectiveCommand: command },
      log: "",
      pending: "",
      flushTimer: null,
      stopping: false,
    };
    this.servers.set(projectId, r);
    this.append(r, `$ ${command}\n`);
    // BROWSER=none: dev servers like Create React App would otherwise open a browser on their own.
    const child = spawn(command, {
      cwd: project.path,
      env: { ...this.env(), BROWSER: "none" },
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    r.child = child;
    const onData = (d: Buffer) => {
      const text = stripAnsi(d.toString());
      this.append(r, text);
      if (!r.state.url) {
        const url = findLocalUrl(r.log.slice(-4000) + r.pending);
        if (url) this.update(r, { url });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      this.append(r, `\n${e.message}\n`);
      this.update(r, { status: "failed", error: e.message });
    });
    child.on("close", (code) => {
      if (this.servers.get(projectId) !== r) return;
      this.flush(r);
      if (r.stopping) this.update(r, { status: "stopped", exitCode: code });
      else if (r.state.status !== "failed") {
        this.append(r, `\n[Prozess beendet, Exit-Code ${code ?? "?"}]\n`);
        this.update(r, { status: "exited", exitCode: code });
      }
    });
    this.emitState(r);
    return this.state(projectId);
  }

  async stop(projectId: string): Promise<DevServerState> {
    const r = this.servers.get(projectId);
    if (r?.child && r.state.status === "running") {
      r.stopping = true;
      killTree(r.child);
      await new Promise<void>((resolve) => {
        if (r.child!.exitCode !== null || r.child!.signalCode !== null) return resolve();
        const t = setTimeout(resolve, 5000);
        r.child!.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (r.state.status === "running") this.update(r, { status: "stopped" });
    }
    return this.state(projectId);
  }

  /** Forgets a project (removed from FORGE): stops its server and drops the log. */
  async forget(projectId: string) {
    await this.stop(projectId);
    this.servers.delete(projectId);
  }

  shutdown() {
    for (const r of this.servers.values()) {
      if (r.child && r.state.status === "running") {
        r.stopping = true;
        killTree(r.child);
      }
    }
  }

  private update(r: Running, patch: Partial<DevServerState>) {
    r.state = { ...r.state, ...patch };
    this.emitState(r);
  }

  private emitState(r: Running) {
    this.emit({ event: "devserver.updated", payload: r.state });
  }

  private append(r: Running, text: string) {
    r.pending += text;
    r.flushTimer ??= setTimeout(() => this.flush(r), FLUSH_MS);
  }

  private flush(r: Running) {
    if (r.flushTimer) clearTimeout(r.flushTimer);
    r.flushTimer = null;
    if (!r.pending) return;
    const text = r.pending;
    r.pending = "";
    r.log = (r.log + text).slice(-MAX_LOG_CHARS);
    this.emit({ event: "devserver.output", payload: { projectId: r.state.projectId, text } });
  }
}
