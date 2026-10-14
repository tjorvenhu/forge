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
 * resolved against it. Throws a German message for anything that is not local http(s).
 */
export function previewUrl(opts: { url?: string | null; path?: string | null; base?: string | null }): string {
  const start = opts.url?.trim() || opts.base?.trim();
  if (!start) throw new Error("Keine Adresse für die Vorschau.");
  let u: URL;
  try {
    u = new URL(start);
  } catch {
    throw new Error(`„${start}“ ist keine gültige Adresse. Erwartet wird z. B. http://localhost:3000.`);
  }
  const p = opts.path?.trim();
  if (p) {
    try {
      u = new URL(p, u);
    } catch {
      throw new Error(`Ungültiger Pfad „${p}“.`);
    }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Die Vorschau öffnet nur http- und https-Adressen, nicht ${u.protocol.replace(/:$/, "")}.`);
  if (!LOCAL_HOSTS.has(u.hostname.toLowerCase()))
    throw new Error(`Die Vorschau öffnet nur Adressen auf diesem Rechner (localhost, 127.0.0.1, ::1), nicht ${u.hostname}.`);
  return u.href;
}
