import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/stores/toast";
import { call, keys, useSettings } from "./queries";
import { errorMessage, isTauri } from "./rpc";

/**
 * Main window: hands "Im Vordergrund bleiben" to the shell, which applies it to every FORGE window
 * and to chat windows opened later (chat_windows.rs). Changes from the phone arrive as settings.updated.
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
    toast.success(on ? "FORGE bleibt im Vordergrund" : "FORGE bleibt nicht mehr im Vordergrund");
  } catch (e) {
    toast.error("Einstellung nicht gespeichert", errorMessage(e));
  }
}
