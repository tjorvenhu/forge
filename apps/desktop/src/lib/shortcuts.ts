import { useEffect } from "react";
import type { ResultOf } from "@forge/protocol";
import { useUi, workspaceTabsFor } from "@/stores/ui";
import { keys, queryClient } from "@/lib/queries";
import { flatTabs, groupTabs, openSessionId, openSessionTab, shownSessionIds } from "@/lib/session-tabs";
import { openChat } from "@/components/workspace/chat-slot";

/** An open dialog owns the keyboard: switching sessions behind it would change what it acts on. */
function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * App-wide shortcuts. Ctrl+K command palette, Ctrl+1..7 workspace tabs, Ctrl+J bottom panel,
 * Ctrl+Shift+E right panel, Ctrl+N new session, Ctrl+O add project,
 * Ctrl+Tab / Ctrl+Shift+Tab next / previous open session, in the order of the sidebar tree.
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
    const openId = openSessionId(ui);
    const projects = queryClient.getQueryData<ResultOf<"projects.list">>(keys.projects);
    // Like the sidebar: also the sessions of the split view's further areas without a running process.
    const open = shownSessionIds(ui).map((id) => openSessionTab(queryClient.getQueryData<ResultOf<"sessions.get">>(keys.session(id)), projects));
    const tabs = flatTabs(groupTabs(queryClient.getQueryData<ResultOf<"sessions.listLive">>(keys.liveSessions) ?? [], open, projects));
    // In the split view the area with the cursor counts as the current one; the walk moves the cursor between areas.
    const paneId = document.activeElement?.closest<HTMLElement>("[data-split-pane]")?.dataset.splitPane;
    const focusedId = (paneId && ui.splitPanes.find((p) => p.id === paneId)?.active) || openId;
    const current = tabs.findIndex((s) => s.id === focusedId);
    if (!tabs.length || (tabs.length === 1 && current === 0)) return;
    e.preventDefault();
    const from = current < 0 ? (e.shiftKey ? 0 : -1) : current;
    const next = tabs[(from + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]!;
    openChat(next.projectId, next.id);
  } else if (!e.shiftKey && k >= "1" && k <= "9" && ui.view === "workspace") {
    // Numbered like the visible tab bar: without git, Agenten and Git are missing.
    const project = ui.activeProjectId ? queryClient.getQueryData<ResultOf<"projects.get">>(keys.project(ui.activeProjectId)) : null;
    const tab = workspaceTabsFor(project)[Number(k) - 1];
    if (!tab) return;
    ui.setWorkspaceTab(tab);
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
