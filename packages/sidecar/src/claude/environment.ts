import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { which } from "../util/proc.js";
import { bundledPathEntries, extraUnixBinDirs, gitBashForClaude, resolveTool } from "../util/tools.js";

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
  const extra = bundledPathEntries();
  const key = Object.keys(out).find((k) => k.toLowerCase() === "path") ?? "PATH";
  if (extra.length) out[key] = [...extra, out[key] ?? ""].filter(Boolean).join(path.delimiter);
  if (process.platform !== "win32") {
    // Started from the Finder or a desktop launcher, FORGE gets a short PATH without Homebrew and co.
    const have = new Set((out[key] ?? "").split(path.delimiter));
    const more = extraUnixBinDirs().filter((d) => !have.has(d) && existsSync(d));
    if (more.length) out[key] = [out[key] ?? "", ...more].filter(Boolean).join(path.delimiter);
  }
  // Without UTF-8 mode Python writes piped output in the ANSI code page and a single non-Latin-1
  // character (a check mark, an emoji) ends the script with UnicodeEncodeError. Python 3.15 makes this the default.
  if (resolveTool("python")?.bundled && out.PYTHONUTF8 === undefined) out.PYTHONUTF8 = "1";
  const bash = gitBashForClaude();
  if (bash && !out.CLAUDE_CODE_GIT_BASH_PATH) out.CLAUDE_CODE_GIT_BASH_PATH = bash;
  return out;
}

/** Where the official installers put the CLI when it is not on PATH. */
export function claudeCandidates(home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [path.join(home, ".local", "bin", "claude.exe"), path.join(home, ".claude", "local", "claude.exe")];
  return [path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

/** Finds the installed Claude Code CLI. A configured path wins if it exists. */
export function locateClaude(configured: string | null): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const fromPath = which("claude");
  if (fromPath) return fromPath;
  return claudeCandidates().find((c) => existsSync(c)) ?? null;
}
