import { mkdirSync, realpath } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";

export function dataDir(): string {
  const override = process.env.FORGE_DATA_DIR;
  const base = override
    ? override
    : isWin
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "forge")
      : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "forge");
  mkdirSync(base, { recursive: true });
  return base;
}

/** Key used for duplicate detection: Windows paths are case-insensitive. */
export function pathKey(p: string): string {
  const n = path.resolve(p).replace(/[\\/]+$/, "");
  return isWin ? n.toLowerCase() : n;
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
  const list = [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gh"),
    path.join(home, ".docker", "config.json"),
    path.join(home, ".kube"),
    path.join(home, ".npmrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".mozilla", "firefox"),
    path.join(home, ".config", "google-chrome"),
    path.join(home, ".config", "chromium"),
  ];
  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    list.push(
      path.join(local, "Google", "Chrome", "User Data"),
      path.join(local, "Microsoft", "Edge", "User Data"),
      path.join(local, "BraveSoftware"),
      path.join(roaming, "Mozilla", "Firefox", "Profiles"),
      path.join(local, "Microsoft", "Credentials"),
      path.join(roaming, "Microsoft", "Credentials"),
      path.join(roaming, "Microsoft", "Protect"),
      path.join(roaming, "GitHub CLI"),
    );
  }
  return list;
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
