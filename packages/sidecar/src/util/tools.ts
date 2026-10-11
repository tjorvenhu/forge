import { existsSync } from "node:fs";
import path from "node:path";
import { which } from "./proc.js";

export type ToolName = "git" | "gh" | "bash";

export interface ResolvedTool {
  path: string;
  bundled: boolean;
}

/** Set by the desktop shell to the folder with the shipped node/git/gh. */
export function runtimeDir(): string | null {
  const d = process.env.FORGE_RUNTIME_DIR;
  return d && existsSync(d) ? d : null;
}

function bundledPath(tool: ToolName): string | null {
  const dir = runtimeDir();
  if (!dir) return null;
  const rel: Record<ToolName, string> = {
    git: path.join("git", "cmd", "git.exe"),
    gh: path.join("gh", "bin", "gh.exe"),
    bash: path.join("git", "bin", "bash.exe"),
  };
  const p = path.join(dir, rel[tool]);
  return existsSync(p) ? p : null;
}

/**
 * Shipped tools win so every install behaves the same; the system copy is the fallback
 * (development).
 */
export function resolveTool(tool: ToolName): ResolvedTool | null {
  const b = bundledPath(tool);
  if (b) return { path: b, bundled: true };
  const sys = which(tool) ?? (tool === "gh" ? which("gh", "C:\\Program Files\\GitHub CLI") : null);
  return sys ? { path: sys, bundled: false } : null;
}

/** PATH additions so Claude's own Bash/PowerShell tools find the shipped git and gh. */
export function bundledPathEntries(): string[] {
  const dir = runtimeDir();
  if (!dir) return [];
  return [path.join(dir, "git", "cmd"), path.join(dir, "gh", "bin")].filter((p) => existsSync(p));
}

/**
 * Claude Code on Windows needs Git Bash for its Bash tool. If the user has no Git for Windows,
 * point it at the shipped bash.
 */
export function gitBashForClaude(): string | null {
  const systemGit = which("git");
  if (systemGit) {
    const candidate = path.join(path.dirname(path.dirname(systemGit)), "bin", "bash.exe");
    if (existsSync(candidate)) return null;
  }
  return bundledPath("bash");
}
