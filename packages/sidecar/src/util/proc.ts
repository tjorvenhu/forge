import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** cap for captured stdout/stderr each; extra output is dropped */
  maxBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** set when the process could not be started at all (e.g. ENOENT) */
  spawnError: NodeJS.ErrnoException | null;
}

/**
 * How long to wait for the output pipes after the process itself exited. Grandchildren (git's
 * cmd wrapper, a shell's children) inherit the pipes and may keep them open long after.
 */
export const PIPE_GRACE_MS = 500;

function taskkill(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const abs = path.join(root, "System32", "taskkill.exe");
  return existsSync(abs) ? abs : "taskkill";
}

/**
 * Ends a process and everything it started. child.kill() only ends the direct process (e.g. the
 * cmd.exe of a shell command or git's wrapper exe), so this goes through taskkill /T.
 */
export function killTree(child: ChildProcess, opts: { sync?: boolean } = {}) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const args = ["/pid", String(child.pid), "/T", "/F"];
  if (opts.sync) {
    const r = spawnSync(taskkill(), args, { windowsHide: true, stdio: "ignore" });
    if (r.error || r.status !== 0) child.kill();
  } else {
    const k = spawn(taskkill(), args, { windowsHide: true, stdio: "ignore" });
    k.on("error", () => child.kill());
    k.on("exit", (code) => {
      if (code !== 0) child.kill();
    });
  }
}

/**
 * Resolves once the process has exited and its output is read. Waits for `close` (all pipes
 * drained) but at most PIPE_GRACE_MS after `exit`, then drops the pipes held by leftover children.
 */
export function onFinished(child: ChildProcess, done: (code: number | null) => void) {
  let settled = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(grace);
    done(code);
  };
  child.on("exit", (code) => {
    grace = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code);
    }, PIPE_GRACE_MS);
  });
  child.on("close", (code) => finish(code));
}

/**
 * Spawns without a shell. Arguments are passed as an array and never interpolated.
 */
export function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (stdout.length < maxBytes) stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      if (stderr.length < maxBytes) stderr += d;
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    onFinished(child, (code) => finish({ code, stdout, stderr, timedOut, spawnError: null }));
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Resolves an executable on PATH without invoking a shell. Only real binaries (.exe, .com). */
export function which(name: string, envPath = process.env.PATH ?? process.env.Path ?? ""): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of [".exe", ".com"]) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
