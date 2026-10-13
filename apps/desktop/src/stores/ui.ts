import { create } from "zustand";

export type View = "home" | "projects" | "sessions" | "mcp" | "settings" | "workspace";
export type WorkspaceTab = "chat" | "agents" | "git" | "files" | "devtools" | "knowledge" | "settings";
export type NewProjectMode = "import" | "create" | "clone";
export type BottomTab = "output" | "dev";
export type SettingsSection = "general" | "claude" | "policy" | "phone" | "backup" | "rules" | "about";
export type DevToolsSection = "server" | "database" | "env";
export type ProjectSettingsSection = "general" | "permissions" | "automation" | "rules" | "remove";

/** activeSession values starting with this prefix point at a terminal session not yet adopted by FORGE */
export const EXTERNAL_PREFIX = "ext:";

/** Splits an activeSession value into a FORGE session id or the Claude session id of a terminal session. */
export function splitActive(active: string | null | undefined): { sessionId: string | null; externalId: string | null } {
  if (!active) return { sessionId: null, externalId: null };
  if (active.startsWith(EXTERNAL_PREFIX)) return { sessionId: null, externalId: active.slice(EXTERNAL_PREFIX.length) };
  return { sessionId: active, externalId: null };
}

/**
 * A task with its own history: a subagent (its events carry the Agent call as parentToolUseId) or a
 * background command (its output is read from the CLI by task id).
 */
export type TaskView =
  | { kind: "agent"; sessionId: string; toolUseId: string; title: string }
  | { kind: "shell"; sessionId: string; taskId: string; toolUseId: string | null; title: string };

interface UiState {
  view: View;
  activeProjectId: string | null;
  /** selected session per project; null means "new session" */
  activeSession: Record<string, string | null>;
  workspaceTab: WorkspaceTab;
  /** tab row of the workspace (Chat, Agenten, Git ...); hidden by default, the chat fills the view */
  toolbarOpen: boolean;
  toggleToolbar: (open?: boolean) => void;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  newProject: NewProjectMode | null;
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
  /** subagent or background command whose own history is shown over the chat */
  taskView: TaskView | null;
  openTask: (t: TaskView | null) => void;
  /** file shown in the Dateien tab, per project */
  selectedFile: Record<string, string | null>;
  selectFile: (projectId: string, path: string | null) => void;
  /** shows a file in the Dateien tab (from the file explorer) */
  openFile: (projectId: string, path: string) => void;
  /** knowledge entry the Wissen tab should select once it is shown (from a card in the chat) */
  knowledgeRequest: string | null;
  /** switches to the Wissen tab, with one entry selected */
  openKnowledge: (id: string | null) => void;
  clearKnowledgeRequest: () => void;
  devToolsSection: DevToolsSection;
  setDevToolsSection: (section: DevToolsSection) => void;
  /** switches to the Dev-Tools tab at one section */
  openDevTools: (section: DevToolsSection) => void;
  projectSettingsSection: ProjectSettingsSection;
  setProjectSettingsSection: (section: ProjectSettingsSection) => void;
  /** switches to the project's Einstellungen tab at one section */
  openProjectSettings: (section: ProjectSettingsSection) => void;
  setView: (v: View) => void;
  settingsSection: SettingsSection;
  /** opens the settings at one section */
  openSettings: (section: SettingsSection) => void;
  openProject: (projectId: string, sessionId?: string | null) => void;
  closeProject: () => void;
  setActiveSession: (projectId: string, sessionId: string | null) => void;
  setWorkspaceTab: (t: WorkspaceTab) => void;
  toggleRightPanel: (open?: boolean) => void;
  toggleBottomPanel: (open?: boolean) => void;
  setNewProject: (m: NewProjectMode | null) => void;
  /** projects whose sessions the sidebar tree hides */
  collapsedGroups: string[];
  toggleGroup: (projectId: string, collapsed?: boolean) => void;
}

const PREFS_KEY = "forge.ui";

type Prefs = Pick<UiState, "activeProjectId" | "toolbarOpen" | "collapsedGroups">;

/** Reopens the last project on start. Side and bottom panel always start closed and open only on request. */
function loadPrefs(): Partial<UiState> {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      ...(typeof p.toolbarOpen === "boolean" ? { toolbarOpen: p.toolbarOpen } : {}),
      ...(Array.isArray(p.collapsedGroups) ? { collapsedGroups: p.collapsedGroups.filter((g): g is string => typeof g === "string") } : {}),
      ...(typeof p.activeProjectId === "string" ? { activeProjectId: p.activeProjectId, view: "workspace" as const } : {}),
    };
  } catch {
    return {};
  }
}

function savePrefs(s: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ activeProjectId: s.activeProjectId, toolbarOpen: s.toolbarOpen, collapsedGroups: s.collapsedGroups }));
  } catch {
    /* preferences are optional */
  }
}

export const useUi = create<UiState>((set, get) => ({
  view: "home",
  activeProjectId: null,
  activeSession: {},
  workspaceTab: "chat",
  toolbarOpen: false,
  rightPanelOpen: false,
  bottomPanelOpen: false,
  newProject: null,
  terminalRequest: null,
  panelRequest: null,
  paletteOpen: false,
  focusEvent: null,
  taskView: null,
  selectedFile: {},
  knowledgeRequest: null,
  devToolsSection: "server",
  projectSettingsSection: "general",
  collapsedGroups: [],
  ...loadPrefs(),
  toggleGroup: (projectId, collapsed) => {
    set((s) => {
      const next = collapsed ?? !s.collapsedGroups.includes(projectId);
      return { collapsedGroups: next ? [...new Set([...s.collapsedGroups, projectId])] : s.collapsedGroups.filter((g) => g !== projectId) };
    });
    savePrefs(get());
  },
  openTerminal: (projectId, program, label) => set({ terminalRequest: { projectId, program, label }, bottomPanelOpen: true }),
  clearTerminalRequest: () => set({ terminalRequest: null }),
  openPanelTab: (projectId, tab) => {
    set({ panelRequest: { projectId, tab }, bottomPanelOpen: true });
  },
  clearPanelRequest: () => set({ panelRequest: null }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setFocusEvent: (focusEvent) => set({ focusEvent }),
  openTask: (taskView) => set({ taskView }),
  selectFile: (projectId, path) => set((s) => ({ selectedFile: { ...s.selectedFile, [projectId]: path } })),
  openFile: (projectId, path) => {
    set((s) => ({ selectedFile: { ...s.selectedFile, [projectId]: path }, workspaceTab: "files", toolbarOpen: true }));
    savePrefs(get());
  },
  openKnowledge: (id) => {
    set({ knowledgeRequest: id, workspaceTab: "knowledge", toolbarOpen: true });
    savePrefs(get());
  },
  clearKnowledgeRequest: () => set({ knowledgeRequest: null }),
  setDevToolsSection: (devToolsSection) => set({ devToolsSection }),
  setProjectSettingsSection: (projectSettingsSection) => set({ projectSettingsSection }),
  openProjectSettings: (projectSettingsSection) => {
    set({ projectSettingsSection, workspaceTab: "settings", toolbarOpen: true });
    savePrefs(get());
  },
  openDevTools: (devToolsSection) => {
    set({ devToolsSection, workspaceTab: "devtools", toolbarOpen: true });
    savePrefs(get());
  },
  setView: (view) => set({ view }),
  settingsSection: "general",
  openSettings: (settingsSection) => set({ view: "settings", settingsSection }),
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
  // Another area than the chat shows the tab row, so it is clear where one is and how to get back.
  setWorkspaceTab: (workspaceTab) => {
    set((s) => ({ workspaceTab, toolbarOpen: s.toolbarOpen || workspaceTab !== "chat" }));
    savePrefs(get());
  },
  toggleToolbar: (open) => {
    set((s) => {
      const toolbarOpen = open ?? !s.toolbarOpen;
      return toolbarOpen ? { toolbarOpen } : { toolbarOpen, workspaceTab: "chat" };
    });
    savePrefs(get());
  },
  toggleRightPanel: (open) => {
    set((s) => ({ rightPanelOpen: open ?? !s.rightPanelOpen }));
  },
  toggleBottomPanel: (open) => {
    set((s) => ({ bottomPanelOpen: open ?? !s.bottomPanelOpen }));
  },
  setNewProject: (newProject) => set({ newProject }),
}));
