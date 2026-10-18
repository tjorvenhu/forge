import { useEffect } from "react";
import { create } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/stores/toast";
import { call, keys, useSettings } from "./queries";
import { errorMessage, isTauri } from "./rpc";
import { t } from "@/i18n";

/**
 * Main window: hands "Im Vordergrund bleiben" to the shell, which applies it to the main window only;
 * chat windows are pinned one by one (useChatWindowPin). Changes from the phone arrive as settings.updated.
 */
export function useAlwaysOnTop() {
  const on = useSettings().data?.alwaysOnTop;
  useEffect(() => {
    if (on === undefined || !isTauri()) return;
    void invoke("set_always_on_top", { on }).catch(() => {});
  }, [on]);
}

export async function setAlwaysOnTop(qc: QueryClient, on: boolean) {
  try {
    qc.setQueryData(keys.settings, await call("settings.update", { alwaysOnTop: on }));
    toast.success(on ? t.lib.windowOptions.mainOnTop : t.lib.windowOptions.mainNotOnTop);
  } catch (e) {
    toast.error(t.lib.windowOptions.settingNotSaved, errorMessage(e));
  }
}

/** Chat window: whether this window stays above other apps; null until the shell answered (or outside the app). */
export const useChatWindowPin = create<{ on: boolean | null }>(() => ({ on: null }));

/** Chat window: reads its own state from the shell; a window reloaded while pinned stays pinned. */
export async function loadChatWindowPin() {
  if (!isTauri()) return;
  try {
    useChatWindowPin.setState({ on: await invoke<boolean>("chat_window_on_top", { on: null }) });
  } catch {
    // Without an answer the pin stays hidden.
  }
}

export async function setChatWindowPin(on: boolean) {
  try {
    useChatWindowPin.setState({ on: await invoke<boolean>("chat_window_on_top", { on }) });
  } catch (e) {
    toast.error(on ? t.lib.chatWindows.notPinned : t.lib.chatWindows.notUnpinned, errorMessage(e));
  }
}
