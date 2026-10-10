import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { which } from "../util/proc.js";

/**
 * Variables a parent Claude Code process sets for its children. If FORGE itself
 * was launched from inside a Claude session they must not leak into new sessions.
 */
const INHERITED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

export const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export function apiKeyEnvPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return API_KEY_VARS.some((k) => !!env[k]);
}

export function sessionEnv(stripApiKey: boolean, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (INHERITED_SESSION_VARS.includes(k)) continue;
    if (stripApiKey && API_KEY_VARS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Finds the installed Claude Code CLI. A configured path wins if it exists. */
export function locateClaude(configured: string | null): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const fromPath = which("claude");
  if (fromPath) return fromPath;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [path.join(os.homedir(), ".local", "bin", exe), path.join(os.homedir(), ".claude", "local", exe)];
  return candidates.find((c) => existsSync(c)) ?? null;
}
