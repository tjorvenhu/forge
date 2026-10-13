import { useEffect } from "react";
import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "@forge/protocol";
import { useSettings } from "./queries";
import { isTauri } from "./rpc";

type WindowEffect = Settings["windowEffect"];

interface UaData {
  getHighEntropyValues(hints: string[]): Promise<{ platformVersion?: string }>;
}

let win11: Promise<boolean> | null = null;

/**
 * Mica and Acrylic need Windows 11. WebView2 reports the Windows version only through client hints:
 * platformVersion 13 and up is Windows 11 (Microsoft's documented check).
 */
function isWindows11(): Promise<boolean> {
  win11 ??= (async () => {
    const ua = (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
    if (!ua) return false;
    const v = await ua.getHighEntropyValues(["platformVersion"]);
    return Number(v.platformVersion?.split(".")[0] ?? 0) >= 13;
  })().catch(() => false);
  return win11;
}

/**
 * Applies the backdrop to this window. Without support (Windows 10, a failed call) the window stays
 * opaque: the translucent colors only switch on once Windows draws the backdrop behind them.
 */
export async function applyWindowEffect(effect: WindowEffect) {
  const root = document.documentElement;
  let active = effect !== "none" && isTauri() && (await isWindows11());
  try {
    if (active) await getCurrentWindow().setEffects({ effects: [effect === "acrylic" ? Effect.Acrylic : Effect.Mica] });
    else if (isTauri()) await getCurrentWindow().clearEffects();
  } catch {
    active = false;
  }
  if (active) root.dataset.windowEffect = effect;
  else delete root.dataset.windowEffect;
}

/** Keeps the window's backdrop in line with the setting. */
export function useWindowEffect() {
  const effect = useSettings().data?.windowEffect;
  useEffect(() => {
    if (effect) void applyWindowEffect(effect);
  }, [effect]);
}
