import { create } from "zustand";

export type View = "home" | "projects" | "sessions" | "github" | "agents" | "mcp" | "settings" | "workspace";
export type WorkspaceTab = "chat" | "git" | "files" | "settings";
export type NewProjectMode = "import" | "create" | "clone";
export type BottomTab = "output" | "dev";

interface UiState {
  view: View;
  activeProjectId: string | null;
  /** selected session per project; null means "new session" */
  activeSession: Record<string, string | null>;
  workspaceTab: WorkspaceTab;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  newProject: NewProjectMode | null;
  /** prefilled URL for the clone dialog (e.g. from the GitHub repo list) */
  cloneUrl: string | null;
  /** asks the bottom panel of a project to open a terminal tab */
  terminalRequest: { projectId: string; program: "shell" | "claude"; label?: string } | null;
  openTerminal: (projectId: string, program: "shell" | "claude", label?: string) => void;
  clearTerminalRequest: () => void;
  /** asks the bottom panel of a project to show one of its fixed tabs */
  panelRequest: { projectId: string; tab: BottomTab } | null;
  openPanelTab: (projectId: string, tab: BottomTab) => void;
  clearPanelRequest: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** message to scroll to once its session is shown (from search) */
  focusEvent: { sessionId: string; seq: number } | null;
  setFocusEvent: (f: { sessionId: string; seq: number } | null) => void;
  setView: (v: View) => void;
  openProject: (projectId: string, sessionId?: string | null) => void;
  closeProject: () => void;
  setActiveSession: (projectId: string, sessionId: string | null) => void;
  setWorkspaceTab: (t: WorkspaceTab) => void;
  toggleRightPanel: (open?: boolean) => void;
  toggleBottomPanel: (open?: boolean) => void;
  setNewProject: (m: NewProjectMode | null, cloneUrl?: string) => void;
}

const PREFS_KEY = "forge.ui";

type Prefs = Pick<UiState, "rightPanelOpen" | "bottomPanelOpen" | "activeProjectId">;

/** Restores panel layout and reopens the last project on start. */
function loadPrefs(): Partial<UiState> {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      ...(typeof p.rightPanelOpen === "boolean" ? { rightPanelOpen: p.rightPanelOpen } : {}),
      ...(typeof p.bottomPanelOpen === "boolean" ? { bottomPanelOpen: p.bottomPanelOpen } : {}),
      ...(typeof p.activeProjectId === "string" ? { activeProjectId: p.activeProjectId, view: "workspace" as const } : {}),
    };
  } catch {
    return {};
  }
}

function savePrefs(s: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ rightPanelOpen: s.rightPanelOpen, bottomPanelOpen: s.bottomPanelOpen, activeProjectId: s.activeProjectId }));
  } catch {
    /* preferences are optional */
  }
}

export const useUi = create<UiState>((set, get) => ({
  view: "home",
  activeProjectId: null,
  activeSession: {},
  workspaceTab: "chat",
  rightPanelOpen: true,
  bottomPanelOpen: false,
  newProject: null,
  cloneUrl: null,
  terminalRequest: null,
  panelRequest: null,
  paletteOpen: false,
  focusEvent: null,
  ...loadPrefs(),
  openTerminal: (projectId, program, label) => set({ terminalRequest: { projectId, program, label }, bottomPanelOpen: true }),
  clearTerminalRequest: () => set({ terminalRequest: null }),
  openPanelTab: (projectId, tab) => {
    set({ panelRequest: { projectId, tab }, bottomPanelOpen: true });
    savePrefs(get());
  },
  clearPanelRequest: () => set({ panelRequest: null }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setFocusEvent: (focusEvent) => set({ focusEvent }),
  setView: (view) => set({ view }),
  openProject: (projectId, sessionId) => {
    set((s) => ({
      view: "workspace",
      activeProjectId: projectId,
      workspaceTab: "chat",
      activeSession: sessionId !== undefined ? { ...s.activeSession, [projectId]: sessionId } : s.activeSession,
    }));
    savePrefs(get());
  },
  closeProject: () => {
    set({ view: "home", activeProjectId: null });
    savePrefs(get());
  },
  setActiveSession: (projectId, sessionId) => set((s) => ({ activeSession: { ...s.activeSession, [projectId]: sessionId } })),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
  toggleRightPanel: (open) => {
    set((s) => ({ rightPanelOpen: open ?? !s.rightPanelOpen }));
    savePrefs(get());
  },
  toggleBottomPanel: (open) => {
    set((s) => ({ bottomPanelOpen: open ?? !s.bottomPanelOpen }));
    savePrefs(get());
  },
  setNewProject: (newProject, cloneUrl) => set({ newProject, cloneUrl: cloneUrl ?? null }),
}));
