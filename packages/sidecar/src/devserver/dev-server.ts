import { spawn, type ChildProcess } from "node:child_process";
import { ForgeError, type DevServerState } from "@forge/protocol";
import type { ProjectManager } from "../projects/project-manager.js";
import { detectDevCommand } from "../projects/tech.js";
import { killTree, onFinished } from "../util/proc.js";

/** Kept per project; older output is dropped. */
const MAX_LOG_CHARS = 200_000;
/** Output is batched so a chatty dev server does not flood the UI with events. */
const FLUSH_MS = 120;

export interface DevServerPrep {
  env: Record<string, string>;
  notes: string[];
}

interface Running {
  child: ChildProcess | null;
  state: DevServerState;
  log: string;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  /** waiting for prepare (test database, possibly its first download); no process yet */
  preparing: boolean;
  /** resolves once the process has exited and its output is read */
  finished: Promise<void>;
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

/**
 * Runs the dev server of a project (e.g. "pnpm dev"). Like the test command this intentionally uses
 * a shell: the command comes from the user's project settings or the project's own package.json.
 * If the sidecar crashes, the desktop shell's job object ends the servers it left behind.
 */
export class DevServerService {
  private servers = new Map<string, Running>();
  private starting = new Map<string, Promise<DevServerState>>();

  constructor(
    private readonly projects: ProjectManager,
    private readonly env: () => Record<string, string>,
    private readonly emit: (e: { event: "devserver.updated"; payload: DevServerState } | { event: "devserver.output"; payload: { projectId: string; text: string } }) => void,
    /** test environment and test database for the start; `notes` go into the output */
    private readonly prepare?: (projectId: string) => Promise<DevServerPrep>,
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

  /** Concurrent calls (a double click) share one start instead of launching two processes. */
  start(projectId: string): Promise<DevServerState> {
    const pending = this.starting.get(projectId);
    if (pending) return pending;
    const p: Promise<DevServerState> = this.doStart(projectId).finally(() => {
      if (this.starting.get(projectId) === p) this.starting.delete(projectId);
    });
    this.starting.set(projectId, p);
    return p;
  }

  private async doStart(projectId: string): Promise<DevServerState> {
    const project = this.projects.requireExisting(projectId);
    const running = this.servers.get(projectId);
    if (running?.state.status === "running") return this.state(projectId);
    const command = await this.effectiveCommand(projectId);
    if (!command) {
      throw new ForgeError("VALIDATION", "Kein Dev-Server-Befehl bekannt. Trage ihn in den Projekt-Einstellungen ein, z. B. pnpm dev.");
    }
    let markFinished = () => {};
    const r: Running = {
      child: null,
      state: { projectId, status: "running", command, url: null, startedAt: new Date().toISOString(), exitCode: null, error: null, effectiveCommand: command },
      log: "",
      pending: "",
      flushTimer: null,
      stopping: false,
      preparing: false,
      finished: new Promise<void>((resolve) => (markFinished = resolve)),
    };
    this.servers.set(projectId, r);
    let prep: DevServerPrep = { env: {}, notes: [] };
    if (this.prepare) {
      // Shown as starting while the test database comes up (its first start downloads PostgreSQL).
      this.emitState(r);
      r.preparing = true;
      try {
        prep = await this.prepare(projectId);
      } catch (e) {
        prep = { env: {}, notes: [`Test-Umgebung nicht gesetzt: ${e instanceof Error ? e.message : String(e)}`] };
      } finally {
        r.preparing = false;
      }
      // Stopped while waiting: the test database keeps starting on its own, the dev server does not.
      if (r.stopping || this.servers.get(projectId) !== r) {
        markFinished();
        return this.state(projectId);
      }
    }
    for (const note of prep.notes) this.append(r, `[FORGE] ${note}\n`);
    this.append(r, `$ ${command}\n`);
    // BROWSER=none: dev servers like Create React App would otherwise open a browser on their own.
    const child = spawn(command, {
      cwd: project.path,
      env: { ...this.env(), ...prep.env, BROWSER: "none" },
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    r.child = child;
    const onData = (d: string) => {
      this.append(r, stripAnsi(d));
      if (!r.state.url) {
        const url = findLocalUrl(r.log.slice(-4000) + r.pending);
        if (url) this.update(r, { url });
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      this.append(r, `\n${e.message}\n`);
      this.update(r, { status: "failed", error: e.message });
      markFinished();
    });
    onFinished(child, (code) => {
      markFinished();
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
    const preparing = this.servers.get(projectId);
    if (preparing?.preparing && !preparing.stopping) {
      // Not waiting for prepare: a first PostgreSQL download can take minutes.
      preparing.stopping = true;
      this.starting.delete(projectId);
      this.update(preparing, { status: "stopped" });
      return this.state(projectId);
    }
    await this.starting.get(projectId)?.catch(() => null);
    const r = this.servers.get(projectId);
    if (r?.child && r.state.status === "running") {
      r.stopping = true;
      killTree(r.child);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([r.finished, new Promise<void>((resolve) => (timer = setTimeout(resolve, 5000)))]);
      clearTimeout(timer);
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
        killTree(r.child, { sync: true });
      } else if (r.preparing) r.stopping = true;
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
