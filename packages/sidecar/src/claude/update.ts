import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tr } from "../i18n/index.js";

/** Same release endpoint the official installer uses (https://claude.ai/install.sh). */
const RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";

export type UpdateChannel = "latest" | "stable";

/** "2.1.296 (Claude Code)" -> "2.1.296" */
export function parseVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

/** Numeric comparison of x.y.z versions; prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The channel `claude update` follows: autoUpdatesChannel in the user's Claude settings, default latest. */
export async function readUpdateChannel(configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")): Promise<UpdateChannel> {
  try {
    const settings = JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8")) as { autoUpdatesChannel?: unknown };
    return settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

export async function fetchLatestVersion(channel: UpdateChannel, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${RELEASES_URL}/${channel}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(tr().core.claude.versionQueryFailed(res.status));
  const version = parseVersion(await res.text());
  if (!version) throw new Error(tr().core.claude.versionQueryEmpty);
  return version;
}
