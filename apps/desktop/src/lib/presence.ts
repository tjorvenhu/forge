import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, rpc } from "./rpc";

/** Input is reported at most this often; the sidecar only needs to know it was within the last minutes. */
const ACTIVITY_EVERY_MS = 30_000;

/**
 * Tells the sidecar whether the user works in this FORGE window (active and recently used), so the
 * phone does not call about something they see on screen anyway. Every window reports under its own
 * label; when a chat window closes, the shell reports it unfocused (it cannot do that itself anymore).
 */
export function startPresenceReporting() {
  if (!isTauri()) return;
  const label = getCurrentWindow().label;
  let lastReport = 0;
  const report = (active: boolean) => {
    if (active) lastReport = Date.now();
    void rpc.call("app.presence", { focused: document.hasFocus(), active, window: label }).catch(() => {});
  };
  const onInput = () => {
    if (document.hasFocus() && Date.now() - lastReport > ACTIVITY_EVERY_MS) report(true);
  };
  window.addEventListener("focus", () => report(true));
  window.addEventListener("blur", () => report(false));
  for (const type of ["pointerdown", "keydown", "wheel", "pointermove"] as const) window.addEventListener(type, onInput, { passive: true, capture: true });
  // After a (re)start the sidecar knows nothing yet.
  rpc.onStatus((up) => {
    if (up) report(document.hasFocus());
  });
}
