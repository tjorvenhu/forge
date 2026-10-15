import { spawn, type ChildProcess } from "node:child_process";
import { ForgeError, type ClaudeSetupState, type ClaudeUpdateInfo } from "@forge/protocol";
import { run } from "../util/proc.js";
import { locateClaude, sessionEnv } from "./environment.js";
import { compareVersions, fetchLatestVersion, parseVersion, readUpdateChannel } from "./update.js";

// Official installer (https://docs.claude.com/en/docs/claude-code/setup).
const INSTALL_ARGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"];

/** Strips OSC 8 hyperlinks and other escape sequences from CLI output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex -- escape sequences are control characters by definition
  return s.replace(/\u001b\]8;;[^\u0007\u001b]*(\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Extracts the sign-in URL printed by `claude auth login`. */
export function findLoginUrl(output: string): string | null {
  // eslint-disable-next-line no-control-regex -- BEL/ESC terminate the URL inside OSC 8 sequences
  return /(https:\/\/claude\.(?:com|ai)\/[^\s\u0007\u001b]*oauth[^\s\u0007\u001b]*)/.exec(stripAnsi(output))?.[1] ?? null;
}

/**
 * Installs Claude Code and signs in through the CLI itself. FORGE only relays the URL and the
 * code the user pastes; the CLI stores the credentials.
 */
export class ClaudeSetupService {
  private proc: ChildProcess | null = null;
  private state: ClaudeSetupState = { task: null, phase: "idle", url: null, log: [], message: null };

  constructor(
    private readonly emit: (s: ClaudeSetupState) => void,
    private readonly settings: () => { claudePath: string | null; stripApiKey: boolean },
  ) {}

  current(): ClaudeSetupState {
    return this.state;
  }

  private set(s: Partial<ClaudeSetupState>) {
    this.state = { ...this.state, ...s };
    // An install or update changes the version.
    if (s.phase === "done") this.version = null;
    this.emit(this.state);
  }

  private version: Promise<string | null> | null = null;

  /** Version of the installed CLI, asked once and kept until the next install or update. */
  installedVersion(): Promise<string | null> {
    this.version ??= (async () => {
      const s = this.settings();
      const claude = locateClaude(s.claudePath);
      if (!claude) return null;
      return parseVersion((await run(claude, ["--version"], { env: sessionEnv(s.stripApiKey), timeoutMs: 20_000 })).stdout);
    })().catch(() => null);
    return this.version;
  }

  private appendLog(chunk: string) {
    const lines = stripAnsi(chunk).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length) this.set({ log: [...this.state.log, ...lines].slice(-80) });
  }

  /**
   * The child ended: true if it is still the current step. cancel() lets the next step start before the
   * cancelled child has closed, so its late events must not overwrite the new step's state.
   */
  private release(child: ChildProcess): boolean {
    if (this.proc !== child) return false;
    this.proc = null;
    return true;
  }

  private ensureIdle() {
    if (this.proc) throw new ForgeError("CONFLICT", "Es läuft bereits ein Einrichtungsschritt.");
  }

  install(): ClaudeSetupState {
    this.ensureIdle();
    this.set({ task: "install", phase: "running", url: null, log: [], message: null });
    const child = spawn("powershell.exe", INSTALL_ARGS, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = child;
    child.stdout?.on("data", (d: Buffer) => this.appendLog(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.appendLog(d.toString()));
    child.on("error", (e) => {
      if (!this.release(child)) return;
      this.set({ phase: "error", message: e.message });
    });
    child.on("close", (code) => {
      if (!this.release(child)) return;
      const found = locateClaude(this.settings().claudePath);
      if (code === 0 && found) this.set({ phase: "done", message: `Installiert: ${found}` });
      else this.set({ phase: "error", message: code === 0 ? "Installer beendet, aber Claude Code wurde nicht gefunden." : `Installer beendet mit Code ${code}` });
    });
    return this.state;
  }

  /** Compares the installed CLI with the release channel it updates from. Never throws. */
  async checkUpdate(): Promise<ClaudeUpdateInfo> {
    const channel = await readUpdateChannel();
    const base = { channel, checkedAt: new Date().toISOString() };
    const s = this.settings();
    const claude = locateClaude(s.claudePath);
    const installed = claude ? parseVersion((await run(claude, ["--version"], { env: sessionEnv(s.stripApiKey), timeoutMs: 20_000 })).stdout) : null;
    try {
      const latest = await fetchLatestVersion(channel);
      return { ...base, installed, latest, available: !!installed && compareVersions(latest, installed) > 0, error: null };
    } catch (e) {
      return { ...base, installed, latest: null, available: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Runs the CLI's own updater. Open sessions keep the old version until they are restarted. */
  update(): ClaudeSetupState {
    this.ensureIdle();
    const s = this.settings();
    const claude = locateClaude(s.claudePath);
    if (!claude) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code ist nicht installiert.");
    this.set({ task: "update", phase: "running", url: null, log: [], message: null });
    const child = spawn(claude, ["update"], { env: sessionEnv(s.stripApiKey), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = child;
    child.stdout?.on("data", (d: Buffer) => this.appendLog(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.appendLog(d.toString()));
    child.on("error", (e) => {
      if (!this.release(child)) return;
      this.set({ phase: "error", message: e.message });
    });
    child.on("close", (code) => {
      if (!this.release(child)) return;
      if (code !== 0) {
        this.set({ phase: "error", message: this.state.log.at(-1) ?? `Update beendet mit Code ${code}` });
        return;
      }
      void run(claude, ["--version"], { env: sessionEnv(s.stripApiKey), timeoutMs: 20_000 }).then((r) => {
        // another step started meanwhile and owns the state now
        if (this.proc) return;
        const v = parseVersion(r.stdout);
        this.set({ phase: "done", message: v ? `Claude Code ${v} ist installiert.` : "Update abgeschlossen." });
      });
    });
    return this.state;
  }

  login(): ClaudeSetupState {
    this.ensureIdle();
    const s = this.settings();
    const claude = locateClaude(s.claudePath);
    if (!claude) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code ist nicht installiert.");
    this.set({ task: "login", phase: "running", url: null, log: [], message: null });
    const env = { ...sessionEnv(s.stripApiKey), BROWSER: "none" };
    const child = spawn(claude, ["auth", "login", "--claudeai"], { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = child;
    let output = "";
    const onData = (d: Buffer) => {
      output += d.toString();
      this.appendLog(d.toString());
      const url = findLoginUrl(output);
      if (url && !this.state.url) this.set({ phase: "waiting_code", url });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {});
    child.on("error", (e) => {
      if (!this.release(child)) return;
      this.set({ phase: "error", message: e.message });
    });
    child.on("close", (code) => {
      if (!this.release(child)) return;
      if (this.state.phase === "cancelled") return;
      this.set(code === 0 ? { phase: "done", url: null, message: "Angemeldet" } : { phase: "error", message: `Anmeldung beendet mit Code ${code}` });
    });
    return this.state;
  }

  /** Signs Claude Code out on this computer (`claude auth logout` removes the stored credentials). */
  async logout(): Promise<void> {
    this.ensureIdle();
    const s = this.settings();
    const claude = locateClaude(s.claudePath);
    if (!claude) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code ist nicht installiert.");
    const r = await run(claude, ["auth", "logout"], { env: sessionEnv(s.stripApiKey), timeoutMs: 20_000 });
    if (r.spawnError || r.code !== 0) {
      const why = r.spawnError?.message ?? stripAnsi(r.stderr || r.stdout).trim().slice(0, 300);
      throw new ForgeError("INTERNAL", `Abmelden fehlgeschlagen${why ? `: ${why}` : "."}`);
    }
    // A finished login of the old account must not read as the current state.
    this.set({ task: null, phase: "idle", url: null, log: [], message: null });
  }

  submitCode(code: string): ClaudeSetupState {
    if (!this.proc || this.state.task !== "login") throw new ForgeError("NOT_FOUND", "Keine laufende Anmeldung.");
    this.proc.stdin?.write(code.trim() + "\n");
    this.set({ phase: "running" });
    return this.state;
  }

  cancel(): ClaudeSetupState {
    if (this.proc) {
      this.set({ phase: "cancelled" });
      this.proc.kill();
      this.proc = null;
    }
    return this.state;
  }

  shutdown() {
    this.proc?.kill();
  }
}
