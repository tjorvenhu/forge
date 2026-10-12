import { mkdirSync, realpath } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

export function dataDir(): string {
  const base = process.env.FORGE_DATA_DIR || path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "forge");
  mkdirSync(base, { recursive: true });
  return base;
}

/** ~/.claude.json, or .claude.json inside CLAUDE_CONFIG_DIR when that is set. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

/** Key used for duplicate detection: Windows paths are case-insensitive. */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  // A root keeps its separator: "C:" alone would mean the current directory on drive C.
  const n = path.parse(resolved).root === resolved ? resolved : resolved.replace(/[\\/]+$/, "");
  return n.toLowerCase();
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
export function sensitivePaths(home = os.homedir()): string[] {
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  return [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    // gh uses this instead of AppData when XDG_CONFIG_HOME is ~/.config (e.g. shared dotfiles).
    path.join(home, ".config", "gh"),
    path.join(home, ".docker", "config.json"),
    path.join(home, ".kube"),
    path.join(home, ".npmrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".claude", ".credentials.json"),
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
  const t = name.trim();
  if (!t) return "Name darf nicht leer sein.";
  if (t === "." || t === "..") return "Ungültiger Name.";
  // eslint-disable-next-line no-control-regex -- control characters are invalid in file names
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(t)) return 'Name darf keine der Zeichen < > : " / \\ | ? * enthalten.';
  if (WIN_RESERVED.test(t)) return "Dieser Name ist unter Windows reserviert.";
  if (/[. ]$/.test(t)) return "Name darf nicht mit Punkt oder Leerzeichen enden.";
  return null;
}
