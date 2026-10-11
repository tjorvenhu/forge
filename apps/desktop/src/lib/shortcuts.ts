import { useEffect } from "react";
import type { ResultOf } from "@forge/protocol";
import { useUi, type WorkspaceTab } from "@/stores/ui";
import { keys, queryClient } from "@/lib/queries";
import { sortTabs } from "@/components/workspace/SessionTabs";

const TABS: WorkspaceTab[] = ["chat", "git", "files", "settings"];

/** An open dialog owns the keyboard: switching sessions behind it would change what it acts on. */
function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * App-wide shortcuts. Ctrl+K command palette, Ctrl+1..4 workspace tabs, Ctrl+J bottom panel,
 * Ctrl+Shift+E right panel, Ctrl+N new session, Ctrl+O add project,
 * Ctrl+Tab / Ctrl+Shift+Tab next / previous active session.
 */
export function handleGlobalShortcut(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return;
  const ui = useUi.getState();
  const k = e.key.toLowerCase();
  if (!e.shiftKey && k === "k") {
    // Inside a terminal Ctrl+K belongs to the shell (kill line).
    if (e.target instanceof Element && e.target.closest(".xterm")) return;
    // The palette itself is a dialog; Ctrl+K closes it again, but does not open it over another dialog.
    if (!ui.paletteOpen && dialogOpen()) return;
    ui.setPaletteOpen(!ui.paletteOpen);
    e.preventDefault();
    return;
  }
  if (dialogOpen()) return;
  if (k === "tab") {
    const tabs = sortTabs(queryClient.getQueryData<ResultOf<"sessions.listLive">>(keys.liveSessions) ?? []);
    if (tabs.length < 2) return;
    e.preventDefault();
    const current = tabs.findIndex((s) => s.projectId === ui.activeProjectId && s.id === ui.activeSession[s.projectId]);
    const from = current < 0 ? (e.shiftKey ? 0 : -1) : current;
    const next = tabs[(from + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]!;
    ui.openProject(next.projectId, next.id);
  } else if (!e.shiftKey && k >= "1" && k <= "4" && ui.view === "workspace") {
    ui.setWorkspaceTab(TABS[Number(k) - 1]!);
    e.preventDefault();
  } else if (!e.shiftKey && k === "j") {
    ui.toggleBottomPanel();
    e.preventDefault();
  } else if (e.shiftKey && k === "e") {
    ui.toggleRightPanel();
    e.preventDefault();
  } else if (!e.shiftKey && k === "n" && ui.view === "workspace" && ui.activeProjectId) {
    ui.setActiveSession(ui.activeProjectId, null);
    ui.setWorkspaceTab("chat");
    e.preventDefault();
    requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
  } else if (!e.shiftKey && k === "o") {
    ui.setNewProject("import");
    e.preventDefault();
  }
}

export function useGlobalShortcuts() {
  useEffect(() => {
    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, []);
}
