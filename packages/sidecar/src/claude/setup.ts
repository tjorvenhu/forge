import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ForgeError, type ClaudeSetupState, type ClaudeUpdateInfo } from "@forge/protocol";
import { run } from "../util/proc.js";
import { tr } from "../i18n/index.js";
import { hasOwnClaude, locateClaude, sessionEnv } from "./environment.js";
import { compareVersions, fetchLatestVersion, parseVersion, readUpdateChannel } from "./update.js";

// Official installers (https://docs.claude.com/en/docs/claude-code/setup).
const INSTALL_ARGS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"];
const INSTALL_SH = "curl -fsSL https://claude.ai/install.sh | bash";

/** Program and arguments of the official installer on this platform. */
export function installCommand(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === "win32" ? { command: "powershell.exe", args: INSTALL_ARGS } : { command: "/bin/bash", args: ["-c", INSTALL_SH] };
}

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

/** How long to wait for Claude Code to call BROWSER before offering the page with the code. */
export const BROWSER_WAIT_MS = 3_000;
const BROWSER_POLL_MS = 150;

/**
 * A BROWSER program for `claude auth login` that writes the page Claude Code wants to open into a
 * file instead of opening it. That page returns to the CLI's local callback (like in a terminal), so
 * nobody has to paste a code; FORGE opens it itself. With BROWSER=none the CLI only prints the page
 * that shows a code to paste.
 */
export function browserRelay(platform: NodeJS.Platform = process.platform): { program: string; read: () => string | null; dispose: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "forge-login-"));
  const file = path.join(dir, "url.txt");
  let program: string;
  if (platform === "win32") {
    program = path.join(dir, "open.cmd");
    writeFileSync(program, `@echo off\r\n>"${file}" echo %*\r\n`);
  } else {
    program = path.join(dir, "open.sh");
    const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
    writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "$*" > ${quoted}\n`, { mode: 0o755 });
  }
  return {
    program,
    read: () => {
      try {
        const raw = readFileSync(file, "utf8");
        // echo ends with a line break: without it the file is still being written
        if (!raw.endsWith("\n")) return null;
        return findLoginUrl(raw.trim().replace(/^"|"$/g, ""));
      } catch {
        return null;
      }
    },
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* left in the temp folder */
      }
    },
  };
}

/**
 * Installs Claude Code and signs in through the CLI itself. FORGE only relays the sign-in page (and,
 * as a fallback, the code the user pastes); the CLI stores the credentials.
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
    if (this.proc) throw new ForgeError("CONFLICT", tr().core.claude.setupBusy);
  }

  install(): ClaudeSetupState {
    this.ensureIdle();
    this.set({ task: "install", phase: "running", url: null, log: [], message: null });
    const { command, args } = installCommand();
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      if (code === 0 && found) this.set({ phase: "done", message: tr().core.claude.installed(found) });
      else this.set({ phase: "error", message: code === 0 ? tr().core.claude.installerNotFound : tr().core.claude.installerExit(code) });
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
    if (!claude) throw new ForgeError("CLAUDE_NOT_INSTALLED", tr().core.claude.notInstalled);
    // `claude update` self-updates only FORGE's own install. A Homebrew/npm one just prints "managed by …"
    // and exits 0 without changing anything, so with no pinned path fetch our own, self-updating copy instead.
    if (!s.claudePath && !hasOwnClaude()) return this.install();
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
        this.set({ phase: "error", message: this.state.log.at(-1) ?? tr().core.claude.updateExit(code) });
        return;
      }
      // A pinned path to a Homebrew/npm install: `claude update` printed "managed by …" and did nothing.
      if (this.state.log.some((l) => /managed by/i.test(l))) {
        this.set({ phase: "error", message: tr().core.claude.updateExternallyManaged });
        return;
      }
      void run(claude, ["--version"], { env: sessionEnv(s.stripApiKey), timeoutMs: 20_000 }).then((r) => {
        // another step started meanwhile and owns the state now
        if (this.proc) return;
        const v = parseVersion(r.stdout);
        this.set({ phase: "done", message: tr().core.claude.updateDone(v) });
      });
    });
    return this.state;
  }

  login(): ClaudeSetupState {
    this.ensureIdle();
    const s = this.settings();
    const claude = locateClaude(s.claudePath);
    if (!claude) throw new ForgeError("CLAUDE_NOT_INSTALLED", tr().core.claude.notInstalled);
    const relay = browserRelay();
    this.set({ task: "login", phase: "running", url: null, codeUrl: null, log: [], message: null });
    const env = { ...sessionEnv(s.stripApiKey), BROWSER: relay.program };
    const child = spawn(claude, ["auth", "login", "--claudeai"], { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = child;
    let output = "";
    let codeUrl: string | null = null;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const current = () => this.proc === child && this.state.task === "login";
    const show = (url: string, withCode: string | null) => {
      if (!current() || this.state.url) return;
      clearInterval(poll);
      clearTimeout(fallback);
      this.set({ phase: "waiting_code", url, codeUrl: withCode });
    };
    // Claude Code hands the page that returns to its local callback to BROWSER; with it no code is needed.
    const poll = setInterval(() => {
      const url = relay.read();
      if (url) show(url, codeUrl);
    }, BROWSER_POLL_MS);
    const onData = (d: Buffer) => {
      output += d.toString();
      this.appendLog(d.toString());
      if (codeUrl) return;
      codeUrl = findLoginUrl(output);
      if (!codeUrl) return;
      if (this.state.url) this.set({ codeUrl });
      // BROWSER was not called (or failed): the page with the code to paste is all there is.
      else fallback = setTimeout(() => codeUrl && show(codeUrl, null), BROWSER_WAIT_MS);
    };
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(fallback);
      relay.dispose();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {});
    child.on("error", (e) => {
      cleanup();
      if (!this.release(child)) return;
      this.set({ phase: "error", message: e.message });
    });
    child.on("close", (code) => {
      cleanup();
      if (!this.release(child)) return;
      if (this.state.phase === "cancelled") return;
      this.set(code === 0 ? { phase: "done", url: null, codeUrl: null, message: tr().core.claude.loggedIn } : { phase: "error", message: tr().core.claude.loginExit(code) });
    });
    return this.state;
  }

  /** Signs Claude Code out on this computer (`claude auth logout` removes the stored credentials). */
  async logout(): Promise<void> {
    this.ensureIdle();
    const s = this.settings();
    const claude = locateClaude(s.claudePath);
    if (!claude) throw new ForgeError("CLAUDE_NOT_INSTALLED", tr().core.claude.notInstalled);
    const r = await run(claude, ["auth", "logout"], { env: sessionEnv(s.stripApiKey), timeoutMs: 20_000 });
    if (r.spawnError || r.code !== 0) {
      const why = r.spawnError?.message ?? stripAnsi(r.stderr || r.stdout).trim().slice(0, 300);
      throw new ForgeError("INTERNAL", tr().core.claude.logoutFailed(why));
    }
    // A finished login of the old account must not read as the current state.
    this.set({ task: null, phase: "idle", url: null, log: [], message: null });
  }

  submitCode(code: string): ClaudeSetupState {
    if (!this.proc || this.state.task !== "login") throw new ForgeError("NOT_FOUND", tr().core.claude.noLogin);
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
