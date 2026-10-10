import { useEffect } from "react";
import { useUi, type WorkspaceTab } from "@/stores/ui";

const TABS: WorkspaceTab[] = ["chat", "git", "files", "settings"];

/**
 * App-wide shortcuts. Ctrl+1..4 workspace tabs, Ctrl+J bottom panel,
 * Ctrl+Shift+E right panel, Ctrl+N new session, Ctrl+O add project.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const ui = useUi.getState();
      const k = e.key.toLowerCase();
      if (!e.shiftKey && k >= "1" && k <= "4" && ui.view === "workspace") {
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
