import { spawn, type ChildProcess } from "node:child_process";
import { ForgeError, type PermissionMode, type RemoteState } from "@forge/protocol";
import { stripAnsi } from "../claude/setup.js";

/**
 * Remote Control: runs the official `claude remote-control` in a project folder so the folder can be
 * driven from the Claude mobile app or claude.ai/code. Sessions started that way are owned by the
 * Claude CLI (not by FORGE); FORGE only starts, observes and stops the bridge.
 */
export class RemoteService {
  private procs = new Map<string, ChildProcess>();
  private states = new Map<string, RemoteState>();

  constructor(
    private readonly emit: (projectId: string, s: RemoteState) => void,
    private readonly claude: () => string | null,
    private readonly env: () => Record<string, string>,
  ) {}

  state(projectId: string): RemoteState {
    return this.states.get(projectId) ?? { phase: "off", url: null, message: null, detail: null };
  }

  private set(projectId: string, s: Partial<RemoteState>) {
    const next = { ...this.state(projectId), ...s };
    this.states.set(projectId, next);
    this.emit(projectId, next);
  }

  start(projectId: string, cwd: string, name: string, permissionMode: PermissionMode): RemoteState {
    if (this.procs.has(projectId)) return this.state(projectId);
    const bin = this.claude();
    if (!bin) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code ist nicht installiert.");
    this.set(projectId, { phase: "starting", url: null, message: null, detail: null });
    const child = spawn(bin, ["remote-control", "--name", name, "--permission-mode", permissionMode], {
      cwd,
      env: this.env(),
      shell: false,
      windowsHide: true,
      // stdin stays open: the CLI treats EOF as "quit".
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.procs.set(projectId, child);
    let buf = "";
    const onData = (d: Buffer) => {
      buf = (buf + stripAnsi(d.toString())).slice(-8000);
      const parsed = parseRemoteOutput(buf);
      if (parsed.untrusted) this.set(projectId, { phase: "untrusted", message: "Claude Code vertraut diesem Ordner noch nicht." });
      else if (parsed.connected) this.set(projectId, { phase: "connected", url: parsed.url, detail: parsed.detail, message: null });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {});
    child.on("error", (e) => {
      this.procs.delete(projectId);
      this.set(projectId, { phase: "error", message: e.message });
    });
    child.on("close", (code) => {
      this.procs.delete(projectId);
      const cur = this.state(projectId);
      if (cur.phase === "untrusted" || cur.phase === "off") return;
      this.set(projectId, code === 0 || code === null ? { phase: "off", url: null, detail: null } : { phase: "error", message: lastLine(buf) || `beendet mit Code ${code}` });
    });
    return this.state(projectId);
  }

  stop(projectId: string): RemoteState {
    const p = this.procs.get(projectId);
    this.set(projectId, { phase: "off", url: null, detail: null, message: null });
    if (p) {
      this.procs.delete(projectId);
      p.kill();
    }
    return this.state(projectId);
  }

  shutdown() {
    for (const p of this.procs.values()) p.kill();
    this.procs.clear();
  }
}

function lastLine(s: string): string {
  return s.trim().split(/\r?\n/).filter(Boolean).pop()?.trim() ?? "";
}

/** Reads the status screen of `claude remote-control` (recorded with CLI 2.1.296). */
export function parseRemoteOutput(out: string): { connected: boolean; untrusted: boolean; url: string | null; detail: string | null } {
  const untrusted = /workspace not trusted/i.test(out);
  const connected = /Connected/.test(out) && !/Connecting\s*·[^\n]*$/.test(out.trim().split("\n").pop() ?? "");
  const urls = out.match(/https:\/\/claude\.ai\/code\?environment=[A-Za-z0-9_-]+/g);
  const capacity = out.match(/Capacity:\s*\d+\/\d+/g);
  return { connected, untrusted, url: urls?.at(-1) ?? null, detail: capacity?.at(-1) ?? null };
}
