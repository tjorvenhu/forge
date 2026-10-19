import { spawn } from "node:child_process";
import { GROUP_SPAWN, killTree, onFinished } from "./proc.js";

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
    let settled = false;
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...GROUP_SPAWN });
    const append = (d: string) => {
      out = (out + d).slice(-MAX_OUTPUT * 2);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output: out.slice(-MAX_OUTPUT), durationMs: Date.now() - started, timedOut });
    };
    child.on("error", (e) => {
      out += `\n${e.message}`;
      done(null);
    });
    onFinished(child, done);
  });
}
