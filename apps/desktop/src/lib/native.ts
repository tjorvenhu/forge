import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

export async function pickFolder(title: string, defaultPath?: string | null): Promise<string | null> {
  const r = await open({ directory: true, multiple: false, title, defaultPath: defaultPath ?? undefined });
  return typeof r === "string" ? r : null;
}

/** Opens only http(s) links in the system browser. */
export async function openExternal(url: string) {
  if (!/^https:\/\//.test(url)) return;
  await openUrl(url);
}

/** Converts git remote URLs (https or scp-like) to a browsable https URL, if possible. */
export function remoteToWebUrl(remote: string | null): string | null {
  if (!remote) return null;
  const scp = /^git@([^:]+):(.+?)(\.git)?$/.exec(remote);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const https = /^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?$/.exec(remote);
  if (https) return `https://${https[1]}/${https[2]}`;
  return null;
}
