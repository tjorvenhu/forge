import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { QueryClient } from "@tanstack/react-query";
import type { AppUpdateState, Session } from "@forge/protocol";
import { toast } from "@/stores/toast";
import { openChatWindow, useChatWindows } from "./chat-windows";
import { call, keys } from "./queries";
import { errorMessage } from "./rpc";
import { isBusy } from "./working";

/** Chat windows open at the restart for an update; the main window of the new FORGE opens them again. */
const REOPEN_KEY = "forge.reopenChatWindows";
/** Same bound as the sidecar's marks: a FORGE started much later by hand opens nothing. */
const REOPEN_MAX_AGE_MS = 30 * 60_000;

/** One installation at a time, whether started by a click, the palette or the phone. */
export const useInstall = create<{ installing: boolean }>(() => ({ installing: false }));

/** A session keeps working through a restart: in a turn, waiting for the user, or with background work. */
export function isWorkingSession(s: Pick<Session, "status" | "background" | "subagents">): boolean {
  return isBusy(s.status) || s.status === "stopping" || s.background.length > 0 || s.subagents.length > 0;
}

/** What happens to the sessions on the restart, for the update dialog and the toast. */
export function sessionsNote(sessions: number, working: number): string | null {
  if (working === 1) return "Eine Session arbeitet gerade. Sie hält für den Neustart kurz an und macht danach von selbst weiter.";
  if (working > 1) return `${working} Sessions arbeiten gerade. Sie halten für den Neustart kurz an und machen danach von selbst weiter.`;
  if (sessions > 0) return `${sessions === 1 ? "Die offene Session bleibt" : "Offene Sessions bleiben"} nach dem Neustart offen.`;
  return null;
}

/**
 * Downloads the update if needed, tells the sidecar to note the open sessions, and lets the desktop
 * shell install it. FORGE ends and starts again on its own; the sessions continue after that.
 */
export async function installUpdate(qc: QueryClient) {
  if (useInstall.getState().installing) return;
  useInstall.setState({ installing: true });
  let prepared = false;
  try {
    let s = qc.getQueryData<AppUpdateState>(keys.appUpdate);
    if (s?.phase !== "ready") {
      s = await call("app.downloadUpdate", {});
      qc.setQueryData(keys.appUpdate, s);
    }
    if (s.phase !== "ready" || !s.installerPath) throw new Error(s.message ?? "Der Installer ist nicht bereit.");
    const { sessions, working } = await call("app.prepareInstall", { cancel: false });
    prepared = true;
    rememberChatWindows();
    toast.info("Update wird installiert", ["FORGE schließt sich kurz und startet danach von selbst neu.", sessionsNote(sessions, working)].filter(Boolean).join(" "));
    await invoke("install_update", { path: s.installerPath });
  } catch (e) {
    if (prepared) {
      localStorage.removeItem(REOPEN_KEY);
      void call("app.prepareInstall", { cancel: true }).catch(() => {});
    }
    toast.error("Update nicht installiert", errorMessage(e));
    useInstall.setState({ installing: false });
  }
}

function rememberChatWindows() {
  const sessions = useChatWindows.getState().sessions;
  if (sessions.length) localStorage.setItem(REOPEN_KEY, JSON.stringify({ at: Date.now(), sessions }));
  else localStorage.removeItem(REOPEN_KEY);
}

/** Main window after the start: the chat windows of the last restart for an update come back. */
export async function reopenChatWindows() {
  const raw = localStorage.getItem(REOPEN_KEY);
  if (!raw) return;
  localStorage.removeItem(REOPEN_KEY);
  let saved: { at?: unknown; sessions?: unknown };
  try {
    saved = JSON.parse(raw) as typeof saved;
  } catch {
    return;
  }
  if (typeof saved.at !== "number" || Date.now() - saved.at > REOPEN_MAX_AGE_MS || !Array.isArray(saved.sessions)) return;
  for (const id of saved.sessions) {
    if (typeof id !== "string") continue;
    try {
      const s = await call("sessions.get", { sessionId: id });
      await openChatWindow(s.projectId, s.id, s.title);
    } catch {
      // Deleted meanwhile: nothing to show.
    }
  }
}
