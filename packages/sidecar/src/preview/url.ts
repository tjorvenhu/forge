import { tr } from "../i18n/index.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** http(s) on this machine only: the preview must not reach out to the internet. */
export function isLocalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The address the preview opens: `url` (absolute) or else `base` (the dev server), with `path`
 * resolved against it. Throws a message in the current language for anything that is not local http(s).
 */
export function previewUrl(opts: { url?: string | null; path?: string | null; base?: string | null }): string {
  const start = opts.url?.trim() || opts.base?.trim();
  if (!start) throw new Error(tr().core.preview.noAddress);
  let u: URL;
  try {
    u = new URL(start);
  } catch {
    throw new Error(tr().core.preview.invalidAddress(start));
  }
  const p = opts.path?.trim();
  if (p) {
    try {
      u = new URL(p, u);
    } catch {
      throw new Error(tr().core.preview.invalidPath(p));
    }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(tr().core.preview.onlyHttp(u.protocol.replace(/:$/, "")));
  if (!LOCAL_HOSTS.has(u.hostname.toLowerCase()))
    throw new Error(tr().core.preview.onlyLocal(u.hostname));
  return u.href;
}
