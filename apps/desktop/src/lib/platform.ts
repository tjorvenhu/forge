/**
 * The operating system the window runs on, read from the WebView: WebView2 on Windows, WKWebView on
 * macOS, WebKitGTK on Linux. Fixed per page load like the language; Windows is the default (and what
 * jsdom in the tests reports), so everything that was there before stays as it was.
 */
export type Platform = "windows" | "macos" | "linux";

export function detectPlatform(nav: { userAgent?: string; platform?: string } | undefined): Platform {
  const s = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  // iPhone and iPad say "like Mac OS X", Android says "Linux": neither runs FORGE.
  if (/Mac/.test(s) && !/like Mac/.test(s)) return "macos";
  if (/Linux|X11/.test(s) && !/Android/.test(s)) return "linux";
  return "windows";
}

export const platform: Platform = detectPlatform(typeof navigator === "undefined" ? undefined : navigator);
export const isWindows = platform === "windows";
export const isMac = platform === "macos";
export const isLinux = platform === "linux";

/** The value for this platform, e.g. "Explorer", "Finder" or "Dateimanager". */
export function byPlatform<T>(values: Record<Platform, T>, p: Platform = platform): T {
  return values[p];
}

/**
 * The modifier of app shortcuts is held: Cmd on macOS (Ctrl there belongs to text editing and the
 * terminal), Ctrl elsewhere. On Windows the Windows key counts too, as it always did; on Linux it is the
 * desktop's own key.
 */
export function hasPrimaryModifier(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey">, p: Platform = platform): boolean {
  if (p === "macos") return e.metaKey;
  if (p === "linux") return e.ctrlKey;
  return e.ctrlKey || e.metaKey;
}

const MAC_MODIFIERS: Record<string, string> = { ctrl: "⌘", strg: "⌘", control: "⌃", alt: "⌥", option: "⌥", shift: "⇧", umschalt: "⇧" };
/** Apple's order for several modifiers: ⌃⌥⇧⌘. */
const MAC_ORDER = "⌃⌥⇧⌘";
/** "Strg+Umschalt+E", also "Strg K" as on the search field; a space only after Ctrl, "Alt 2" is prose. */
const SHORTCUT = /\b((?:(?:Ctrl|Strg|Control|Alt|Option|Shift|Umschalt)\+|(?:Ctrl|Strg) )+)([A-Z0-9]|F\d{1,2}|Enter|Tab|Esc|Space|Leertaste|Backspace|Delete|Entf)\b/g;

/**
 * Shortcut labels in a text for this platform. Windows and Linux keep "Strg+Umschalt+E"; macOS gets
 * Apple's symbols without separators: "⇧⌘E", "⌘K", "⌘Enter". Ctrl means the app modifier (Cmd on the
 * Mac) except before Tab: Ctrl+Tab stays Control there, Cmd+Tab switches apps. A literal Control key
 * is written "⌃" in the text itself.
 */
export function formatShortcuts(text: string, p: Platform = platform): string {
  if (p !== "macos" || !text) return text;
  return text.replace(SHORTCUT, (_, mods: string, key: string) => {
    const symbols = mods
      .split(/[+ ]/)
      .filter(Boolean)
      .map((m) => (key === "Tab" && /^(ctrl|strg)$/i.test(m) ? "⌃" : MAC_MODIFIERS[m.toLowerCase()]!));
    const ordered = [...new Set(symbols)].sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)).join("");
    return ordered + key;
  });
}

/**
 * All texts of a message tree with their shortcut labels for this platform (see formatShortcuts):
 * strings directly, functions on their result. Off macOS the tree comes back unchanged.
 */
export function withPlatformShortcuts<T>(messages: T, p: Platform = platform): T {
  if (p !== "macos") return messages;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return formatShortcuts(v, p);
    if (typeof v === "function") {
      const fn = v as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const r = fn(...args);
        return typeof r === "string" ? formatShortcuts(r, p) : r;
      };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(messages) as T;
}

/** Windows and macOS file systems ignore case by default, Linux does not. */
export function pathsIgnoreCase(p: Platform = platform): boolean {
  return p !== "linux";
}

/** Forward slashes, no trailing slash. Backslashes are separators only on Windows. */
function slashes(path: string, p: Platform): string {
  return (p === "windows" ? path.replace(/\\/g, "/") : path).replace(/\/+$/, "");
}

/**
 * The part of `path` inside the folder `dir`, with forward slashes; "" for the folder itself and null
 * outside of it. Compared without case where the file system does so.
 */
export function pathInside(path: string, dir: string, p: Platform = platform): string | null {
  const file = slashes(path, p);
  const root = slashes(dir, p);
  const fold = (x: string) => (pathsIgnoreCase(p) ? x.toLowerCase() : x);
  if (fold(file) === fold(root)) return "";
  return fold(file).startsWith(fold(root) + "/") ? file.slice(root.length + 1) : null;
}

/** A path as the system's file manager expects it: backslashes on Windows, unchanged elsewhere. */
export function nativePath(path: string, p: Platform = platform): string {
  return p === "windows" ? path.replace(/\//g, "\\") : path;
}
