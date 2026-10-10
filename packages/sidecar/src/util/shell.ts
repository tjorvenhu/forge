import { spawn } from "node:child_process";

export interface ShellResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_OUTPUT = 20_000;

/**
 * Runs a command the user configured for the project (e.g. "pnpm test"). This is the one place
 * that intentionally uses a shell: the string comes from the user's own project settings, never
 * from Claude or the repository.
 */
export function runUserCommand(command: string, cwd: string, env: Record<string, string>, timeoutMs = 10 * 60_000): Promise<ShellResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const append = (d: Buffer) => {
      out = (out + d.toString()).slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode, output: out.slice(-MAX_OUTPUT), durationMs: Date.now() - started, timedOut });
    };
    child.on("error", (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    child.on("close", done);
  });
}
