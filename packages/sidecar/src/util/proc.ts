import { spawn } from "node:child_process";
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
          child.kill();
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
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, spawnError: null }));
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Resolves an executable on PATH without invoking a shell. Only real binaries (.exe on Windows). */
export function which(name: string, envPath = process.env.PATH ?? process.env.Path ?? ""): string | null {
  const exts = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
