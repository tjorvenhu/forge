import { t } from "@/i18n";

/** WKWebView on macOS; there Cmd takes the place of Ctrl, and the snipping tool opens with Cmd+Shift+2. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** Label of Ctrl+key, or Cmd+key on macOS. */
export function modKey(key: string, shift = false): string {
  if (IS_MAC) return `⌘${shift ? "⇧" : ""}${key}`;
  return t.screenshot.ctrl(shift ? `${t.screenshot.shift}+${key}` : key);
}
