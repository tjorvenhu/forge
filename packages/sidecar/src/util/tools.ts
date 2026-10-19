import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
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

/**
 * Program of a shipped tool inside the runtime folder. Windows ships node, git (with Git Bash), gh and
 * python; macOS and Linux only node and gh, git and python come from the system there.
 */
export function bundledRelPath(tool: ToolName | "node", platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") {
    const rel: Record<ToolName | "node", string> = {
      node: path.join("node", "node.exe"),
      git: path.join("git", "cmd", "git.exe"),
      gh: path.join("gh", "bin", "gh.exe"),
      bash: path.join("git", "bin", "bash.exe"),
      python: path.join("python", "python.exe"),
    };
    return rel[tool];
  }
  if (tool === "node") return path.join("node", "bin", "node");
  if (tool === "gh") return path.join("gh", "bin", "gh");
  return null;
}

function bundledPath(tool: ToolName, platform: NodeJS.Platform = process.platform): string | null {
  const dir = runtimeDir();
  const rel = bundledRelPath(tool, platform);
  if (!dir || !rel) return null;
  const p = path.join(dir, rel);
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

let developerTools: boolean | undefined;

/**
 * macOS has /usr/bin/git and /usr/bin/python3 even without the Command Line Tools; then they only
 * open the dialog that offers to install them. They are real once `xcode-select -p` names a folder.
 */
export function isXcodeShim(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin" || path.dirname(p) !== "/usr/bin") return false;
  if (developerTools === undefined) {
    const r = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 5_000 });
    developerTools = r.status === 0 && !!r.stdout.trim() && existsSync(r.stdout.trim());
  }
  return !developerTools;
}

/**
 * Folders where package managers put programs on macOS and Linux. An app started from the Finder or
 * a desktop launcher gets a short PATH without them.
 */
export function extraUnixBinDirs(home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [];
  const dirs = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];
  return [...dirs, path.join(home, ".local", "bin")];
}

function systemTool(name: string): string | null {
  return which(name) ?? which(name, extraUnixBinDirs().join(path.delimiter));
}

/**
 * Shipped tools win so every install behaves the same; the system copy is the fallback
 * (development, and git and python on macOS and Linux).
 */
export function resolveTool(tool: ToolName): ResolvedTool | null {
  const b = bundledPath(tool);
  if (b) return { path: b, bundled: true };
  if (process.platform !== "win32") {
    if (tool === "bash") return null;
    const names = tool === "python" ? ["python3", "python"] : [tool];
    for (const name of names) {
      const sys = systemTool(name);
      if (sys && !isXcodeShim(sys)) return { path: sys, bundled: false };
    }
    return null;
  }
  if (tool === "python") {
    const sys = which("python");
    return sys && !isStorePythonStub(sys) ? { path: sys, bundled: false } : null;
  }
  const sys = which(tool) ?? (tool === "gh" ? which("gh", "C:\\Program Files\\GitHub CLI") : null);
  return sys ? { path: sys, bundled: false } : null;
}

/**
 * Where `pip install --user` puts console scripts (site.py's user scheme): on Windows
 * %APPDATA%\Python\Python314\Scripts, on macOS ~/Library/Python/3.14/bin, on Linux ~/.local/bin;
 * or below PYTHONUSERBASE.
 */
export function pythonUserScripts(version: string | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string | null {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return null;
  if (platform === "win32") {
    const base = env.PYTHONUSERBASE || (env.APPDATA ? path.join(env.APPDATA, "Python") : null);
    return base ? path.join(base, `Python${m[1]}${m[2]}`, "Scripts") : null;
  }
  if (env.PYTHONUSERBASE) return path.join(env.PYTHONUSERBASE, "bin");
  return platform === "darwin" ? path.join(home, "Library", "Python", `${m[1]}.${m[2]}`, "bin") : path.join(home, ".local", "bin");
}

/**
 * PATH additions so Claude's own Bash/PowerShell tools find the shipped git, gh and python. They go in
 * front: the Store placeholder python.exe in WindowsApps must not win. The user script folder is added
 * even before it exists, so a tool installed with pip works in the same session. macOS and Linux ship
 * only gh for Claude's tools.
 */
export function bundledPathEntries(platform: NodeJS.Platform = process.platform): string[] {
  const dir = runtimeDir();
  if (!dir) return [];
  if (platform !== "win32") return [path.join(dir, "gh", "bin")].filter((p) => existsSync(p));
  const entries = [path.join(dir, "git", "cmd"), path.join(dir, "gh", "bin"), path.join(dir, "python")].filter((p) => existsSync(p));
  if (entries.includes(path.join(dir, "python"))) {
    const scripts = pythonUserScripts(runtimeVersions(dir).python, process.env, platform);
    if (scripts) entries.push(scripts);
  }
  return entries;
}

/**
 * Claude Code on Windows needs Git Bash for its Bash tool. If the user has no Git for Windows,
 * point it at the shipped bash. Other platforms have a bash of their own.
 */
export function gitBashForClaude(): string | null {
  if (process.platform !== "win32") return null;
  const systemGit = which("git");
  if (systemGit) {
    const candidate = path.join(path.dirname(path.dirname(systemGit)), "bin", "bash.exe");
    if (existsSync(candidate)) return null;
  }
  return bundledPath("bash");
}
