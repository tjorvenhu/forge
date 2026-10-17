import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { QueryClient } from "@tanstack/react-query";
import type { AppInstallState, AppUpdateState, Session } from "@forge/protocol";
import { toast } from "@/stores/toast";
import { openChatWindow, useChatWindows } from "./chat-windows";
import { pickInstallerFile } from "./native";
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
export function installUpdate(qc: QueryClient) {
  return runInstaller(
    async () => {
      let s = qc.getQueryData<AppUpdateState>(keys.appUpdate);
      if (s?.phase !== "ready") {
        s = await call("app.downloadUpdate", {});
        qc.setQueryData(keys.appUpdate, s);
      }
      if (s.phase !== "ready" || !s.installerPath) throw new Error(s.message ?? "Der Installer ist nicht bereit.");
      return s.installerPath;
    },
    { busy: "Update wird installiert", failed: "Update nicht installiert" },
  );
}

/**
 * Installs FORGE fully with the full installer for the runtime this version needs (an incomplete
 * installation). Same way as an update: download, note the sessions, the shell runs the installer.
 */
export function installFull(qc: QueryClient) {
  return runInstaller(
    async () => {
      let s = qc.getQueryData<AppInstallState>(keys.appInstall);
      if (s?.phase !== "ready") {
        if (!s?.installer) {
          s = await call("app.checkInstall", {});
          qc.setQueryData(keys.appInstall, s);
          if (s.complete) throw new Error("FORGE ist bereits vollständig installiert.");
          if (!s.installer) throw new Error(s.message ?? "Es gibt keinen passenden Installer.");
        }
        if (s.phase !== "ready") {
          s = await call("app.downloadFullInstaller", {});
          qc.setQueryData(keys.appInstall, s);
        }
      }
      if (s.phase !== "ready" || !s.installerPath) throw new Error(s.message ?? "Der Installer ist nicht bereit.");
      return s.installerPath;
    },
    { busy: "FORGE wird vollständig installiert", failed: "Installation nicht gestartet" },
  );
}

/** "Git fehlt, GitHub CLI fehlt." */
export function problemText(s: AppInstallState): string {
  return `${s.problems.map((p) => p.label).join(", ")}.`;
}

/** Checks the installation again (and looks for the installer), with a toast for the outcome. */
export async function checkInstall(qc: QueryClient) {
  try {
    const next = await call("app.checkInstall", {});
    qc.setQueryData(keys.appInstall, next);
    if (!next.checkable) toast.info("Nichts zu prüfen", "Im Entwicklungsmodus gibt es keine Installation.");
    else if (next.complete) toast.success("FORGE ist vollständig installiert", "Alle mitgelieferten Programme passen zu dieser Version.");
    else toast.info("Installation unvollständig", problemText(next));
  } catch (e) {
    toast.error("Prüfung fehlgeschlagen", errorMessage(e));
  }
}

/** A setup.exe the user downloaded by hand: checked by the sidecar, then installed like the found one. */
export async function installFromFile(qc: QueryClient) {
  const path = await pickInstallerFile();
  if (!path) return;
  try {
    qc.setQueryData(keys.appInstall, await call("app.useLocalInstaller", { path }));
  } catch (e) {
    toast.error("Installer nicht übernommen", errorMessage(e));
    return;
  }
  await installFull(qc);
}

async function runInstaller(fetchInstaller: () => Promise<string>, text: { busy: string; failed: string }) {
  if (useInstall.getState().installing) return;
  useInstall.setState({ installing: true });
  let prepared = false;
  try {
    const path = await fetchInstaller();
    const { sessions, working } = await call("app.prepareInstall", { cancel: false });
    prepared = true;
    rememberChatWindows();
    toast.info(text.busy, ["FORGE schließt sich kurz und startet danach von selbst neu.", sessionsNote(sessions, working)].filter(Boolean).join(" "));
    await invoke("install_update", { path });
  } catch (e) {
    if (prepared) {
      localStorage.removeItem(REOPEN_KEY);
      void call("app.prepareInstall", { cancel: true }).catch(() => {});
    }
    toast.error(text.failed, errorMessage(e));
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
