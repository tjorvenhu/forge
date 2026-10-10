import { spawn, type ChildProcess } from "node:child_process";
import { ForgeError, type ClaudeSetupState } from "@forge/protocol";
import { locateClaude, sessionEnv } from "./environment.js";

// Official installers (https://docs.claude.com/en/docs/claude-code/setup).
const INSTALL_WINDOWS = ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]] as const;
const INSTALL_UNIX = ["bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]] as const;

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
    this.emit(this.state);
  }

  private appendLog(chunk: string) {
    const lines = stripAnsi(chunk).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length) this.set({ log: [...this.state.log, ...lines].slice(-80) });
  }

  private ensureIdle() {
    if (this.proc) throw new ForgeError("CONFLICT", "Es läuft bereits ein Einrichtungsschritt.");
  }

  install(): ClaudeSetupState {
    this.ensureIdle();
    const [cmd, args] = process.platform === "win32" ? INSTALL_WINDOWS : INSTALL_UNIX;
    this.set({ task: "install", phase: "running", url: null, log: [], message: null });
    const child = spawn(cmd, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = child;
    child.stdout?.on("data", (d: Buffer) => this.appendLog(d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.appendLog(d.toString()));
    child.on("error", (e) => {
      this.proc = null;
      this.set({ phase: "error", message: e.message });
    });
    child.on("close", (code) => {
      this.proc = null;
      const found = locateClaude(this.settings().claudePath);
      if (code === 0 && found) this.set({ phase: "done", message: `Installiert: ${found}` });
      else this.set({ phase: "error", message: code === 0 ? "Installer beendet, aber Claude Code wurde nicht gefunden." : `Installer beendet mit Code ${code}` });
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
      this.proc = null;
      this.set({ phase: "error", message: e.message });
    });
    child.on("close", (code) => {
      this.proc = null;
      if (this.state.phase === "cancelled") return;
      this.set(code === 0 ? { phase: "done", url: null, message: "Angemeldet" } : { phase: "error", message: `Anmeldung beendet mit Code ${code}` });
    });
    return this.state;
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
