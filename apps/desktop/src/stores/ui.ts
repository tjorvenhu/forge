import { create } from "zustand";
import { isChatWindow } from "@/lib/chat-windows";

export type View = "home" | "projects" | "sessions" | "report" | "mcp" | "settings" | "workspace";
export type NewProjectMode = "import" | "create" | "clone";
export type BottomTab = "output" | "dev";
export type ClaudeLoginReason = "expired" | "manual" | "switch";

// Lists rather than plain unions: the command palette needs an entry for every value (palette-actions.test.tsx).
/** In the order of the tab bar. */
export const WORKSPACE_TABS = ["chat", "agents", "git", "files", "devtools", "knowledge", "crew", "settings"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
/** knowledgeRequest that opens the merge dialog instead of an entry; entry ids never contain a colon */
export const KNOWLEDGE_MERGE_REQUEST = ":merge";
/** knowledgeRequest that shows only entries whose references go nowhere */
export const KNOWLEDGE_STALE_REQUEST = ":stale";
/** knowledgeRequest that opens an entry and lets Claude correct its missing references */
export const knowledgeFixRequest = (id: string) => `:fix:${id}`;
/** Tabs that need git; a project set up without git does not show them. */
const GIT_WORKSPACE_TABS: ReadonlySet<WorkspaceTab> = new Set(["agents", "git", "crew"]);
/** The tabs a project shows, in the order of the tab bar. */
export function workspaceTabsFor(project: { gitEnabled: boolean } | null | undefined): WorkspaceTab[] {
  return WORKSPACE_TABS.filter((t) => project?.gitEnabled !== false || !GIT_WORKSPACE_TABS.has(t));
}
export const SETTINGS_SECTIONS = ["general", "templates", "claude", "policy", "phone", "github", "backup", "rules", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export const DEV_TOOLS_SECTIONS = ["server", "database", "env"] as const;
export type DevToolsSection = (typeof DEV_TOOLS_SECTIONS)[number];
export const PROJECT_SETTINGS_SECTIONS = ["general", "permissions", "automation", "rules", "remove"] as const;
export type ProjectSettingsSection = (typeof PROJECT_SETTINGS_SECTIONS)[number];
export const EXTENSIONS_TABS = ["mcp", "skills", "hooks"] as const;
export type ExtensionsTab = (typeof EXTENSIONS_TABS)[number];
export const SKILLS_TABS = ["marketplace", "own"] as const;
export type SkillsTab = (typeof SKILLS_TABS)[number];

/** What the Crew tab should open once it is shown (from the palette, a toast or the header). */
export type CrewRequest = "invite" | "create" | "join" | "message" | "task" | "leave" | "profile" | null;

/** activeSession values starting with this prefix point at a terminal session not yet adopted by FORGE */
export const EXTERNAL_PREFIX = "ext:";

/** Splits an activeSession value into a FORGE session id or the Claude session id of a terminal session. */
export function splitActive(active: string | null | undefined): { sessionId: string | null; externalId: string | null } {
  if (!active) return { sessionId: null, externalId: null };
  if (active.startsWith(EXTERNAL_PREFIX)) return { sessionId: null, externalId: active.slice(EXTERNAL_PREFIX.length) };
  return { sessionId: active, externalId: null };
}

/**
 * A further area of the split view, next to the main workspace: a project of its own with one of its
 * chats. Without a project it shows a picker; `active` is an activeSession value of that project.
 */
export interface SplitPane {
  id: string;
  projectId: string | null;
  active: string | null;
  /** the project was opened without a session: the pane picks its latest one not on screen yet */
  pick?: boolean;
}

export interface SplitStash {
  main: { projectId: string; active: string | null } | null;
  panes: SplitPane[];
}

/** Id of the main area in drag and drop between areas; split panes go by their own id. */
export const MAIN_AREA = "main";

/** Whether two areas can swap places: the main area needs a project, so a picker cannot take its place. */
export function canSwapAreas(panes: readonly SplitPane[], a: string, b: string): boolean {
  if (a === b) return false;
  const pane = (id: string) => panes.find((p) => p.id === id);
  if (a === MAIN_AREA) return !!pane(b)?.projectId;
  if (b === MAIN_AREA) return !!pane(a)?.projectId;
  return !!pane(a) && !!pane(b);
}

/** Whether a chat the sidebar (or a notification, the palette ...) opens is already on screen in the split view. */
function onScreen(s: UiState, projectId: string, sessionId: string | null | undefined): boolean {
  const main = mainChat(s);
  if (sessionId === undefined) return main?.projectId === projectId || s.splitPanes.some((p) => p.projectId === projectId);
  if (sessionId === null) return (main?.projectId === projectId && main.active === null) || s.splitPanes.some((p) => p.projectId === projectId && !p.active && !p.pick);
  return (main?.projectId === projectId && main.active === sessionId) || s.splitPanes.some((p) => p.projectId === projectId && p.active === sessionId);
}

/** The chat each pane shows, main chat first; a session is shown in one pane at most. */
function mainChat(s: Pick<UiState, "activeProjectId" | "activeSession">): { projectId: string; active: string | null } | null {
  return s.activeProjectId ? { projectId: s.activeProjectId, active: s.activeSession[s.activeProjectId] ?? null } : null;
}

/**
 * The main chat switches to a session a split pane already shows (sidebar, Strg+Tab, a notification):
 * the two swap places, so the session is not shown twice and the former main chat stays on screen.
 */
function swapIntoMain(s: UiState, next: Pick<UiState, "activeProjectId" | "activeSession">): SplitPane[] {
  const main = mainChat(next);
  if (!main?.active) return s.splitPanes;
  const i = s.splitPanes.findIndex((p) => p.projectId === main.projectId && p.active === main.active);
  if (i < 0) return s.splitPanes;
  const before = mainChat(s);
  if (!before || (before.projectId === main.projectId && before.active === main.active)) return s.splitPanes.filter((_, n) => n !== i);
  return s.splitPanes.map((p, n) => (n === i ? { id: p.id, ...before } : p));
}

/** Sessions on screen in the workspace: the main chat's and those of the split panes. */
export function shownSessions(s: Pick<UiState, "activeProjectId" | "activeSession" | "splitPanes">): Set<string> {
  const shown = new Set<string>();
  const main = mainChat(s);
  if (main?.active) shown.add(main.active);
  for (const p of s.splitPanes) if (p.active) shown.add(p.active);
  return shown;
}

function isShown(s: UiState, projectId: string, active: string | null, except?: string): boolean {
  if (!active) return false;
  const main = mainChat(s);
  if (main?.projectId === projectId && main.active === active) return true;
  return s.splitPanes.some((p) => p.id !== except && p.projectId === projectId && p.active === active);
}

function paneFor(id: string, projectId: string | null, active: string | null | undefined): SplitPane {
  if (!projectId) return { id, projectId: null, active: null };
  return active === undefined ? { id, projectId, active: null, pick: true } : { id, projectId, active };
}

function parsePanes(raw: unknown): SplitPane[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p: unknown) => {
    if (!p || typeof p !== "object") return [];
    const r = p as Record<string, unknown>;
    if (typeof r.id !== "string") return [];
    const projectId = typeof r.projectId === "string" ? r.projectId : null;
    const active = projectId && typeof r.active === "string" ? r.active : null;
    return [{ id: r.id, projectId, active, ...(projectId && !active && r.pick === true ? { pick: true } : {}) }];
  });
}

function parseStash(raw: unknown): SplitStash | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const panes = parsePanes(r.panes);
  if (!panes.length) return null;
  const m = r.main as Record<string, unknown> | null | undefined;
  const main = m && typeof m.projectId === "string" ? { projectId: m.projectId, active: typeof m.active === "string" ? m.active : null } : null;
  return { main, panes };
}

/**
 * A task with its own history: a subagent (its events carry the Agent call as parentToolUseId) or a
 * background command (its output is read from the CLI by task id).
 */
/** `compose`: opened to write to the task, its input field takes the focus */
export type TaskView =
  | { kind: "agent"; sessionId: string; toolUseId: string; title: string; compose?: boolean }
  | { kind: "shell"; sessionId: string; taskId: string; toolUseId: string | null; title: string; compose?: boolean };

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
  /** the setup assistant, opened again by hand (it opens on its own until the first setup is done) */
  setupWizard: boolean;
  setSetupWizard: (open: boolean) => void;
  /** dialog behind the red heart: donate, suggestions, public statistics */
  supportOpen: boolean;
  setSupportOpen: (open: boolean) => void;
  /** dialog to sign in to Claude; `expired`: a session was refused for the sign-in, `switch`: another account */
  claudeLogin: { id: number; reason: ClaudeLoginReason } | null;
  /** keeps a dialog that is already open, so several failing sessions do not restart it */
  openClaudeLogin: (reason: ClaudeLoginReason) => void;
  closeClaudeLogin: () => void;
  /** asks before signing Claude Code out */
  claudeLogout: boolean;
  setClaudeLogout: (open: boolean) => void;
  /** asks the bottom panel of a project to open a terminal tab */
  terminalRequest: { projectId: string; program: "shell" | "claude"; label?: string; team?: boolean; prompt?: string | null } | null;
  /** team: Claude as the lead of an agent team; prompt: its first message */
  openTerminal: (projectId: string, program: "shell" | "claude", label?: string, opts?: { team?: boolean; prompt?: string | null }) => void;
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
  /** shows a file in the Dateien tab (file explorer, palette, a path in the chat), at a line if given */
  openFile: (projectId: string, path: string, line?: number | null) => void;
  /** the line the Dateien tab scrolls to; `n` counts requests, so the same line twice scrolls again */
  fileJump: { projectId: string; path: string; line: number; n: number } | null;
  /** knowledge entry the Wissen tab should select once it is shown (from a card in the chat) */
  knowledgeRequest: string | null;
  /** switches to the Wissen tab, with one entry selected */
  openKnowledge: (id: string | null) => void;
  clearKnowledgeRequest: () => void;
  /** dialog the Crew tab opens once it is shown; n counts requests, so the same one twice opens again */
  crewRequest: { kind: CrewRequest; n: number } | null;
  /** switches to the Crew tab, optionally with a dialog open */
  openCrew: (kind?: CrewRequest) => void;
  clearCrewRequest: () => void;
  /** commit the Git tab should select once it is shown (from search) */
  commitRequest: { projectId: string; hash: string } | null;
  /** switches to the Git tab, with one commit selected */
  openCommit: (projectId: string, hash: string) => void;
  clearCommitRequest: () => void;
  devToolsSection: DevToolsSection;
  setDevToolsSection: (section: DevToolsSection) => void;
  /** switches to the Dev-Tools tab at one section */
  openDevTools: (section: DevToolsSection) => void;
  projectSettingsSection: ProjectSettingsSection;
  setProjectSettingsSection: (section: ProjectSettingsSection) => void;
  /** switches to the project's Einstellungen tab at one section */
  openProjectSettings: (section: ProjectSettingsSection) => void;
  setView: (v: View) => void;
  /** project the daily report shows (with its agents); null: all projects */
  reportProjectId: string | null;
  /** opens the daily report, for one project or all */
  openReport: (projectId: string | null) => void;
  settingsSection: SettingsSection;
  /** opens the settings at one section */
  openSettings: (section: SettingsSection) => void;
  extensionsTab: ExtensionsTab;
  setExtensionsTab: (tab: ExtensionsTab) => void;
  skillsTab: SkillsTab;
  setSkillsTab: (tab: SkillsTab) => void;
  /** opens the Erweiterungen view at one tab (for Skills also at one sub-tab) */
  openExtensions: (tab: ExtensionsTab, skillsTab?: SkillsTab) => void;
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
  /** project groups (lower case; "" = without group) the projects page shows closed */
  collapsedProjectGroups: string[];
  toggleProjectGroup: (group: string, collapsed?: boolean) => void;
  /** the projects page shows only this group (lower case; "" = projects without group); null: all */
  projectGroupFilter: string | null;
  /** opens the projects page with only this group, or all of them again with null */
  showProjectGroup: (group: string | null) => void;
  /** further areas of the split view, in their order on screen after the main area */
  splitPanes: SplitPane[];
  /**
   * Adds an area to the split view; without a project it starts with a picker, without `active` it picks the
   * project's latest session. A session already shown is not added twice.
   */
  addSplitPane: (projectId?: string | null, active?: string | null) => void;
  /** shows another project or session in a split pane (the picker without a project, the latest session without `active`) */
  setSplitPane: (id: string, projectId: string | null, active?: string | null) => void;
  closeSplitPane: (id: string) => void;
  closeSplitPanes: () => void;
  /** swaps a split pane with the main chat, so header, side panel and tabs belong to its session */
  promoteSplitPane: (id: string) => void;
  /**
   * The split view closed by opening a chat that was not on screen: kept, so the sidebar can bring it
   * back. Opening a chat already on screen leaves the split view as it is.
   */
  splitStash: SplitStash | null;
  /** brings the split view back as it was when another chat closed it */
  restoreSplit: () => void;
  /** swaps two areas of the split view by drag and drop; "main" is the main area */
  swapSplitAreas: (a: string, b: string) => void;
  /** deleted sessions leave every chat that shows them */
  forgetSessions: (ids: Iterable<string>) => void;
  /** further areas the split view has room for right now; 0 while it is not shown */
  splitRoom: number;
  setSplitRoom: (room: number) => void;
}

const PREFS_KEY = "forge.ui";

type Prefs = Pick<UiState, "activeProjectId" | "toolbarOpen" | "collapsedGroups" | "collapsedProjectGroups" | "splitPanes" | "splitStash">;

/** Reopens the last project on start. Side and bottom panel always start closed and open only on request. */
function loadPrefs(): Partial<UiState> {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      ...(typeof p.toolbarOpen === "boolean" ? { toolbarOpen: p.toolbarOpen } : {}),
      ...(Array.isArray(p.collapsedGroups) ? { collapsedGroups: p.collapsedGroups.filter((g): g is string => typeof g === "string") } : {}),
      ...(Array.isArray(p.collapsedProjectGroups) ? { collapsedProjectGroups: p.collapsedProjectGroups.filter((g): g is string => typeof g === "string") } : {}),
      ...(typeof p.activeProjectId === "string" ? { activeProjectId: p.activeProjectId, view: "workspace" as const } : {}),
      splitPanes: parsePanes(p.splitPanes),
      splitStash: parseStash(p.splitStash),
    };
  } catch {
    return {};
  }
}

/** Only the main window saves: a chat window shows one chat and would overwrite the main window's layout. */
function savePrefs(s: Prefs) {
  if (isChatWindow()) return;
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ activeProjectId: s.activeProjectId, toolbarOpen: s.toolbarOpen, collapsedGroups: s.collapsedGroups, collapsedProjectGroups: s.collapsedProjectGroups, splitPanes: s.splitPanes, splitStash: s.splitStash }),
    );
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
  setupWizard: false,
  supportOpen: false,
  claudeLogin: null,
  claudeLogout: false,
  terminalRequest: null,
  panelRequest: null,
  paletteOpen: false,
  focusEvent: null,
  taskView: null,
  selectedFile: {},
  fileJump: null,
  knowledgeRequest: null,
  crewRequest: null,
  commitRequest: null,
  devToolsSection: "server",
  projectSettingsSection: "general",
  collapsedGroups: [],
  collapsedProjectGroups: [],
  projectGroupFilter: null,
  splitPanes: [],
  splitStash: null,
  splitRoom: 0,
  ...loadPrefs(),
  toggleGroup: (projectId, collapsed) => {
    set((s) => {
      const next = collapsed ?? !s.collapsedGroups.includes(projectId);
      return { collapsedGroups: next ? [...new Set([...s.collapsedGroups, projectId])] : s.collapsedGroups.filter((g) => g !== projectId) };
    });
    savePrefs(get());
  },
  toggleProjectGroup: (group, collapsed) => {
    set((s) => {
      const next = collapsed ?? !s.collapsedProjectGroups.includes(group);
      return { collapsedProjectGroups: next ? [...new Set([...s.collapsedProjectGroups, group])] : s.collapsedProjectGroups.filter((g) => g !== group) };
    });
    savePrefs(get());
  },
  showProjectGroup: (group) =>
    set((s) => ({
      view: "projects",
      projectGroupFilter: group,
      // A group picked on purpose is shown open.
      collapsedProjectGroups: group === null ? s.collapsedProjectGroups : s.collapsedProjectGroups.filter((g) => g !== group),
    })),
  openTerminal: (projectId, program, label, opts) => set({ terminalRequest: { projectId, program, label, ...opts }, bottomPanelOpen: true }),
  clearTerminalRequest: () => set({ terminalRequest: null }),
  openPanelTab: (projectId, tab) => {
    set({ panelRequest: { projectId, tab }, bottomPanelOpen: true });
  },
  clearPanelRequest: () => set({ panelRequest: null }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setFocusEvent: (focusEvent) => set({ focusEvent }),
  openTask: (taskView) => set({ taskView }),
  selectFile: (projectId, path) => set((s) => ({ selectedFile: { ...s.selectedFile, [projectId]: path } })),
  openFile: (projectId, path, line) => {
    set((s) => ({
      selectedFile: { ...s.selectedFile, [projectId]: path },
      workspaceTab: "files",
      toolbarOpen: true,
      fileJump: line ? { projectId, path, line, n: (s.fileJump?.n ?? 0) + 1 } : null,
    }));
    savePrefs(get());
  },
  openKnowledge: (id) => {
    set({ knowledgeRequest: id, workspaceTab: "knowledge", toolbarOpen: true });
    savePrefs(get());
  },
  clearKnowledgeRequest: () => set({ knowledgeRequest: null }),
  openCrew: (kind = null) => {
    set((s) => ({ crewRequest: kind ? { kind, n: (s.crewRequest?.n ?? 0) + 1 } : null, workspaceTab: "crew", toolbarOpen: true }));
    savePrefs(get());
  },
  clearCrewRequest: () => set({ crewRequest: null }),
  openCommit: (projectId, hash) => {
    set({ commitRequest: { projectId, hash }, workspaceTab: "git", toolbarOpen: true });
    savePrefs(get());
  },
  clearCommitRequest: () => set({ commitRequest: null }),
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
  reportProjectId: null,
  openReport: (reportProjectId) => set({ view: "report", reportProjectId }),
  settingsSection: "general",
  openSettings: (settingsSection) => set({ view: "settings", settingsSection }),
  extensionsTab: "mcp",
  setExtensionsTab: (extensionsTab) => set({ extensionsTab }),
  skillsTab: "marketplace",
  setSkillsTab: (skillsTab) => set({ skillsTab }),
  openExtensions: (extensionsTab, skillsTab) => set((s) => ({ view: "mcp", extensionsTab, skillsTab: skillsTab ?? s.skillsTab })),
  openProject: (projectId, sessionId) => {
    set((s) => {
      const activeSession = sessionId !== undefined ? { ...s.activeSession, [projectId]: sessionId } : s.activeSession;
      const open = { view: "workspace" as const, activeProjectId: projectId, workspaceTab: "chat" as const, activeSession };
      if (!s.splitPanes.length) return open;
      // Already in one of the areas: the split view stays as it is.
      if (onScreen(s, projectId, sessionId)) return { view: "workspace" };
      // Another chat opens alone; the split view is kept for the sidebar to bring back.
      return { ...open, splitPanes: [], splitStash: { main: mainChat(s), panes: s.splitPanes } };
    });
    savePrefs(get());
  },
  closeProject: () => {
    set({ view: "home", activeProjectId: null });
    savePrefs(get());
  },
  setActiveSession: (projectId, sessionId) => {
    const before = get().splitPanes;
    set((s) => {
      const activeSession = { ...s.activeSession, [projectId]: sessionId };
      return { activeSession, splitPanes: swapIntoMain(s, { activeProjectId: s.activeProjectId, activeSession }) };
    });
    if (get().splitPanes !== before) savePrefs(get());
  },
  addSplitPane: (projectId = null, active) => {
    const s = get();
    if (projectId && isShown(s, projectId, active ?? null)) return;
    // A new split view replaces one closed earlier.
    set({ splitPanes: [...s.splitPanes, paneFor(crypto.randomUUID(), projectId, active)], splitStash: null });
    savePrefs(get());
  },
  setSplitPane: (id, projectId, active) => {
    const s = get();
    if (projectId && isShown(s, projectId, active ?? null, id)) return;
    set({ splitPanes: s.splitPanes.map((p) => (p.id === id ? paneFor(id, projectId, active) : p)) });
    savePrefs(get());
  },
  closeSplitPane: (id) => {
    set((s) => ({ splitPanes: s.splitPanes.filter((p) => p.id !== id) }));
    savePrefs(get());
  },
  closeSplitPanes: () => {
    set({ splitPanes: [], splitStash: null });
    savePrefs(get());
  },
  restoreSplit: () => {
    set((s) => {
      if (s.splitPanes.length) return { view: "workspace" };
      if (!s.splitStash) return {};
      const main = s.splitStash.main;
      return {
        view: "workspace",
        workspaceTab: "chat",
        splitPanes: s.splitStash.panes,
        splitStash: null,
        ...(main ? { activeProjectId: main.projectId, activeSession: { ...s.activeSession, [main.projectId]: main.active } } : {}),
      };
    });
    savePrefs(get());
  },
  swapSplitAreas: (a, b) => {
    const s = get();
    if (!canSwapAreas(s.splitPanes, a, b)) return;
    if (a === MAIN_AREA || b === MAIN_AREA) return get().promoteSplitPane(a === MAIN_AREA ? b : a);
    const i = s.splitPanes.findIndex((p) => p.id === a);
    const j = s.splitPanes.findIndex((p) => p.id === b);
    const panes = [...s.splitPanes];
    [panes[i], panes[j]] = [panes[j]!, panes[i]!];
    set({ splitPanes: panes });
    savePrefs(get());
  },
  promoteSplitPane: (id) => {
    set((s) => {
      const pane = s.splitPanes.find((p) => p.id === id);
      if (!pane?.projectId) return {};
      const before = mainChat(s);
      return {
        view: "workspace",
        activeProjectId: pane.projectId,
        workspaceTab: "chat",
        activeSession: { ...s.activeSession, [pane.projectId]: pane.active },
        splitPanes: before ? s.splitPanes.map((p) => (p.id === id ? { id, ...before } : p)) : s.splitPanes.filter((p) => p.id !== id),
      };
    });
    savePrefs(get());
  },
  setSplitRoom: (splitRoom) => set({ splitRoom }),
  forgetSessions: (ids) => {
    const gone = new Set(ids);
    set((s) => ({
      activeSession: Object.fromEntries(Object.entries(s.activeSession).map(([p, a]) => [p, a && gone.has(a) ? null : a])),
      splitPanes: s.splitPanes.map((p) => (p.active && gone.has(p.active) ? { ...p, active: null } : p)),
      splitStash: s.splitStash && {
        main: s.splitStash.main && { ...s.splitStash.main, active: s.splitStash.main.active && gone.has(s.splitStash.main.active) ? null : s.splitStash.main.active },
        panes: s.splitStash.panes.map((p) => (p.active && gone.has(p.active) ? { ...p, active: null } : p)),
      },
    }));
    savePrefs(get());
  },
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
  setSetupWizard: (setupWizard) => set({ setupWizard }),
  setSupportOpen: (supportOpen) => set({ supportOpen }),
  openClaudeLogin: (reason) => set((s) => (s.claudeLogin ? {} : { claudeLogin: { id: Date.now(), reason } })),
  closeClaudeLogin: () => set({ claudeLogin: null }),
  setClaudeLogout: (claudeLogout) => set({ claudeLogout }),
}));
