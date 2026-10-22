import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnpushedProject } from "@forge/protocol";
import { toast } from "@/stores/toast";
import { call } from "./queries";
import { errorMessage, isTauri } from "./rpc";
import { isChatWindow } from "./chat-windows";
import { t } from "@/i18n";

/**
 * The dialog that commits and pushes the open work of all projects. "close": the main window was
 * closed and waits for the answer; "manual": opened from the command palette, FORGE stays open.
 * projects is null while the list loads.
 */
export type PushAllState = { open: false } | { open: true; mode: "close" | "manual"; projects: UnpushedProject[] | null };

export const usePushAll = create<PushAllState>(() => ({ open: false }));

/** Closing must not wait long for the question: a slow answer closes FORGE without asking. */
const CHECK_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function unpushedOnClose(): Promise<UnpushedProject[]> {
  try {
    const settings = await withTimeout(call("settings.get", {}), CHECK_MS);
    if (!settings.askPushOnClose) return [];
    return await withTimeout(call("git.unpushed", {}), CHECK_MS);
  } catch {
    return [];
  }
}

/** Main window: closing asks first when projects have work that is not on GitHub yet. */
export async function startPushOnClose() {
  if (!isTauri() || isChatWindow()) return;
  await getCurrentWindow().onCloseRequested(async (e) => {
    // Closed again while the dialog is open: the dialog answers, not the X.
    if (usePushAll.getState().open) {
      e.preventDefault();
      return;
    }
    const projects = await unpushedOnClose();
    if (!projects.length) return;
    e.preventDefault();
    usePushAll.setState({ open: true, mode: "close", projects });
  });
}

/** Ends FORGE: destroying the main window quits the app in the shell, without asking again. */
export function closeMainWindow() {
  void getCurrentWindow().destroy();
}

export function openPushAll() {
  usePushAll.setState({ open: true, mode: "manual", projects: null });
  call("git.unpushed", {})
    .then((projects) => {
      const s = usePushAll.getState();
      if (s.open && s.mode === "manual") usePushAll.setState({ ...s, projects });
    })
    .catch((e: unknown) => {
      usePushAll.setState({ open: false });
      toast.error(t.git.pushAll.checkFailed, errorMessage(e));
    });
}
