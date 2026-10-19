import { mkdirSync, realpath } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { tr } from "../i18n/index.js";

export function dataDir(): string {
  const base = process.env.FORGE_DATA_DIR || defaultDataDir();
  mkdirSync(base, { recursive: true });
  return base;
}

/**
 * FORGE's data folder without FORGE_DATA_DIR: %APPDATA%\forge on Windows, ~/Library/Application
 * Support/forge on macOS, $XDG_CONFIG_HOME/forge (default ~/.config/forge) on Linux.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "forge");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "forge");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "forge");
}

/** ~/.claude.json, or .claude.json inside CLAUDE_CONFIG_DIR when that is set. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/** Key used for duplicate detection: paths on Windows and (by default) macOS are case-insensitive. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(p);
  // A root keeps its separator: "C:" alone would mean the current directory on drive C.
  const n = path.parse(resolved).root === resolved ? resolved : resolved.replace(/[\\/]+$/, "");
  return platform === "win32" || platform === "darwin" ? n.toLowerCase() : n;
}

export async function canonicalize(p: string): Promise<string> {
  // realpath.native resolves the on-disk casing on Windows, unlike the JS implementation.
  return promisify(realpath.native)(path.resolve(p));
}

export function isInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Directories that must never be touched by agent tools without an explicit
 * user decision. Used by the policy guard.
 */
export function sensitivePaths(home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const common = [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    // gh keeps its login here on macOS and Linux, on Windows when XDG_CONFIG_HOME is ~/.config (e.g. shared dotfiles).
    path.join(home, ".config", "gh"),
    path.join(home, ".docker", "config.json"),
    path.join(home, ".kube"),
    path.join(home, ".npmrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".claude", ".credentials.json"),
  ];
  if (platform === "darwin") {
    const lib = path.join(home, "Library");
    const support = path.join(lib, "Application Support");
    return [
      ...common,
      path.join(lib, "Keychains"),
      path.join(lib, "Cookies"),
      path.join(lib, "Safari"),
      path.join(lib, "Mail"),
      path.join(lib, "Messages"),
      path.join(support, "Google", "Chrome"),
      path.join(support, "Microsoft Edge"),
      path.join(support, "BraveSoftware"),
      path.join(support, "Chromium"),
      path.join(support, "Firefox", "Profiles"),
    ];
  }
  if (platform !== "win32") {
    const config = path.join(home, ".config");
    return [
      ...common,
      path.join(config, "google-chrome"),
      path.join(config, "chromium"),
      path.join(config, "microsoft-edge"),
      path.join(config, "BraveSoftware"),
      path.join(home, ".mozilla"),
      path.join(home, ".local", "share", "keyrings"),
      path.join(home, ".pki"),
    ];
  }
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  return [
    ...common,
    path.join(local, "Google", "Chrome", "User Data"),
    path.join(local, "Microsoft", "Edge", "User Data"),
    path.join(local, "BraveSoftware"),
    path.join(roaming, "Mozilla", "Firefox", "Profiles"),
    path.join(local, "Microsoft", "Credentials"),
    path.join(roaming, "Microsoft", "Credentials"),
    path.join(roaming, "Microsoft", "Protect"),
    path.join(roaming, "GitHub CLI"),
  ];
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Validates a single directory name (no separators, no traversal, no reserved names). */
export function validateDirName(name: string): string | null {
  const p = tr().system.paths;
  const t = name.trim();
  if (!t) return p.nameEmpty;
  if (t === "." || t === "..") return p.nameInvalid;
  // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(t)) return p.nameChars;
  if (WIN_RESERVED.test(t)) return p.nameReserved;
  if (/[. ]$/.test(t)) return p.nameTrailing;
  return null;
}
