import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { activeDraftKey, useDrafts } from "@/stores/drafts";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { MAX_ATTACHMENTS, uploadPasted } from "@/components/workspace/useAttachments";
import { useSettings } from "./queries";
import { errorMessage, isTauri } from "./rpc";

/**
 * FORGE's snipping tool on the Print key (screenshot.rs, components/screenshot). The picture always
 * goes to the clipboard; the shell hands it also to the FORGE window used last, which attaches it to
 * the composer the user typed in last. The X on the attachment takes it out again.
 */

/** Shell to a FORGE window: a picture was taken for it. */
const TAKEN = "screenshot://taken";

/** Set by the shell in the overlay window before the page loads. */
export function isScreenshotWindow(): boolean {
  return (window as { __FORGE_SCREENSHOT__?: boolean }).__FORGE_SCREENSHOT__ === true;
}

/** Main window: hands the setting to the shell, which only then takes the Print key away from Windows. */
export function useScreenshotKey() {
  const on = useSettings().data?.screenshotKey;
  useEffect(() => {
    if (on === undefined || !isTauri()) return;
    void invoke("screenshot_set_enabled", { on }).catch(() => {});
  }, [on]);
}

/** Opens the snipping overlay like the Print key (command palette). */
export function takeScreenshot() {
  void invoke("screenshot_start").catch((e: unknown) => toast.error("Screenshot nicht gestartet", errorMessage(e)));
}

interface ComposerEntry {
  /** the composer of the main chat (not a split pane) */
  main: boolean;
  focusedAt: number;
}

/** Composers mounted in this window, by draft key. */
const composers = new Map<string, ComposerEntry>();

export function registerComposer(key: string, main: boolean): () => void {
  const entry: ComposerEntry = { main, focusedAt: 0 };
  composers.set(key, entry);
  return () => {
    if (composers.get(key) === entry) composers.delete(key);
  };
}

export function composerFocused(key: string) {
  const entry = composers.get(key);
  if (entry) entry.focusedAt = Date.now();
}

/**
 * The draft a screenshot goes to: the composer typed in last, else the main chat, else whatever chat
 * the open project shows (it waits in that draft until the chat is opened).
 */
export function screenshotTarget(): string | null {
  let best: [string, ComposerEntry] | null = null;
  for (const e of composers) if (e[1].focusedAt && (!best || e[1].focusedAt > best[1].focusedAt)) best = e;
  if (best) return best[0];
  for (const [key, e] of composers) if (e.main) return key;
  const first = composers.keys().next();
  if (!first.done) return first.value;
  const ui = useUi.getState();
  return ui.activeProjectId ? activeDraftKey(ui.activeProjectId, ui.activeSession[ui.activeProjectId]) : null;
}

function stamp(): string {
  return new Date().toTimeString().slice(0, 8).replace(/:/g, "");
}

/** Every FORGE window (main and chat windows): attaches pictures the shell hands over. */
export function startScreenshotReceiver() {
  if (!isTauri()) return;
  void listen<{ id: number }>(TAKEN, async (e) => {
    const key = screenshotTarget();
    if (!key) {
      toast.info("Screenshot in der Zwischenablage", "Es ist kein Chat offen. Mit Strg+V fügst du ihn später ein.");
      return;
    }
    if ((useDrafts.getState().drafts[key]?.files.length ?? 0) >= MAX_ATTACHMENTS) {
      toast.info("Screenshot in der Zwischenablage", `Der Chat hat schon ${MAX_ATTACHMENTS} Anhänge.`);
      return;
    }
    try {
      const bytes = await invoke<ArrayBuffer>("screenshot_taken", { id: e.payload.id });
      const name = `screenshot-${stamp()}.bmp`;
      const file = await uploadPasted(new File([bytes], name, { type: "image/bmp" }), name);
      useDrafts.getState().updateFiles(key, (cur) => (cur.length >= MAX_ATTACHMENTS ? cur : [...cur, file]));
      toast.success("Screenshot angehängt", "Liegt auch in der Zwischenablage. Mit dem X am Anhang entfernst du ihn wieder.");
    } catch (err) {
      toast.error("Screenshot nicht angehängt", `Er liegt in der Zwischenablage. ${errorMessage(err)}`);
    }
  });
}
