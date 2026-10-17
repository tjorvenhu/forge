import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { which } from "./proc.js";

export type ToolName = "git" | "gh" | "bash" | "python";

export interface ResolvedTool {
  path: string;
  bundled: boolean;
}

/** Set by the desktop shell to the folder with the shipped node/git/gh/python. */
export function runtimeDir(): string | null {
  const d = process.env.FORGE_RUNTIME_DIR;
  return d && existsSync(d) ? d : null;
}

/** Versions in runtime/VERSIONS.json, as written by scripts/prepare-runtime.mjs. */
export function runtimeVersions(dir: string | null | undefined = runtimeDir()): Record<string, string> {
  if (!dir) return {};
  try {
    const v = JSON.parse(readFileSync(path.join(dir, "VERSIONS.json"), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

function bundledPath(tool: ToolName): string | null {
  const dir = runtimeDir();
  if (!dir) return null;
  const rel: Record<ToolName, string> = {
    git: path.join("git", "cmd", "git.exe"),
    gh: path.join("gh", "bin", "gh.exe"),
    bash: path.join("git", "bin", "bash.exe"),
    python: path.join("python", "python.exe"),
  };
  const p = path.join(dir, rel[tool]);
  return existsSync(p) ? p : null;
}

/**
 * Windows puts a python.exe into WindowsApps that only opens the Microsoft Store. It is a real Python
 * only when a Store Python is installed, which leaves its package folder next to the alias.
 */
export function isStorePythonStub(p: string): boolean {
  const dir = path.dirname(p);
  if (path.basename(dir).toLowerCase() !== "windowsapps") return false;
  try {
    return !readdirSync(dir).some((n) => n.startsWith("PythonSoftwareFoundation.Python."));
  } catch {
    return true;
  }
}

/**
 * Shipped tools win so every install behaves the same; the system copy is the fallback
 * (development).
 */
export function resolveTool(tool: ToolName): ResolvedTool | null {
  const b = bundledPath(tool);
  if (b) return { path: b, bundled: true };
  if (tool === "python") {
    const sys = which("python");
    return sys && !isStorePythonStub(sys) ? { path: sys, bundled: false } : null;
  }
  const sys = which(tool) ?? (tool === "gh" ? which("gh", "C:\\Program Files\\GitHub CLI") : null);
  return sys ? { path: sys, bundled: false } : null;
}

/**
 * Where `pip install --user` of the shipped Python puts console scripts (site.py's user scheme on
 * Windows): %APPDATA%\Python\Python314\Scripts, or below PYTHONUSERBASE.
 */
export function pythonUserScripts(version: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  const base = env.PYTHONUSERBASE || (env.APPDATA ? path.join(env.APPDATA, "Python") : null);
  return m && base ? path.join(base, `Python${m[1]}${m[2]}`, "Scripts") : null;
}

/**
 * PATH additions so Claude's own Bash/PowerShell tools find the shipped git, gh and python. They go in
 * front: the Store placeholder python.exe in WindowsApps must not win. The user script folder is added
 * even before it exists, so a tool installed with pip works in the same session.
 */
export function bundledPathEntries(): string[] {
  const dir = runtimeDir();
  if (!dir) return [];
  const entries = [path.join(dir, "git", "cmd"), path.join(dir, "gh", "bin"), path.join(dir, "python")].filter((p) => existsSync(p));
  if (entries.includes(path.join(dir, "python"))) {
    const scripts = pythonUserScripts(runtimeVersions(dir).python);
    if (scripts) entries.push(scripts);
  }
  return entries;
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
