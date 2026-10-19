import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { Archive, ArrowDown, ArrowLeftRight, ArrowUp, ArrowUpCircle, BookOpen, Bot, CalendarDays, Camera, CloudDownload, Columns2, Combine, Cpu, Database, Download, FilePlus2, FileStack, FileText, FileUp, FlaskConical, FolderDown, FolderOpen, FolderPlus, Gauge, GitBranch, GitBranchPlus, GitCommitHorizontal, GitCompareArrows, GitFork, GitPullRequest, Globe, HandHeart, Languages, Lightbulb, Link2Off, ListChecks, LogIn, LogOut, MessageSquare, MessageSquarePlus, MessageSquareText, MonitorSmartphone, NotebookText, PackageCheck, PanelBottom, PanelRight, Pencil, Phone, PhoneOff, PhoneOutgoing, Pin, PinOff, Play, Power, RefreshCcw, RefreshCw, RotateCcw, Search, Settings2, Shield, ShieldBan, Shrink, Sparkles, Square, SquareArrowOutDownLeft, SquareArrowOutUpRight, SquareTerminal, Timer, ToggleLeft, ToggleRight, Trash2, type LucideIcon, Wand2 } from "lucide-react";
import type {
  AppInstallState,
  AppUpdateState,
  ClaudeUpdateInfo,
  DevServerState,
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PhoneSetupIncomplete,
  PhoneState,
  ProfileId,
  ProjectWithStatus,
  PromptTemplate,
  RemoteState,
  SearchHit,
  Session,
  Settings,
  TestDbState,
} from "@forge/protocol";
import { IDLE_CLOSE_CHOICES, LANGUAGE_NAMES, LANGUAGES, LONG_SESSION_CHOICES, SUPPORT_LINKS, STATS_PAGE_URL } from "@forge/protocol";
import { t } from "@/i18n";
import { openExternal } from "@/lib/native";
import { checkInstall, installFromFile, installFull, installUpdate, supportsFullInstall } from "@/lib/app-install";
import { call, keys, refreshUsage } from "@/lib/queries";
import { openDevServer, prepareWorktree } from "@/lib/dev-server-actions";
import { EFFORT_LEVELS, modelLabel } from "@/lib/models";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { openChatWindow, pinChatWindow, recallChatWindow, type ChatWindowList } from "@/lib/chat-windows";
import { setAlwaysOnTop } from "@/lib/window-options";
import { takeScreenshot } from "@/lib/screenshot";
import { openChatFindSoon } from "@/lib/chat-find";
import { useActivity } from "@/stores/activity";
import { draftKey, useDrafts } from "@/stores/drafts";
import { lastEditablePrompt, useMessageEdit } from "@/stores/message-edit";
import { toast } from "@/stores/toast";
import { useTemplateDialogs } from "@/stores/templates";
import { learnTemplatesNow } from "@/lib/template-learning";
import { DEV_TOOLS_SECTIONS, KNOWLEDGE_MERGE_REQUEST, KNOWLEDGE_STALE_REQUEST, PROJECT_SETTINGS_SECTIONS, SETTINGS_SECTIONS, SKILLS_TABS, EXTENSIONS_TABS, workspaceTabsFor, useUi, type SettingsSection, type WorkspaceTab } from "@/stores/ui";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { RULE_GROUPS } from "@/components/settings/PolicySettings";
import { idleCloseLabel } from "@/components/settings/idle-close";
import { handoffSession, longSessionLabel } from "@/components/workspace/handoff";
import { CHAT_VIEWS, chatView, setChatView } from "@/components/workspace/chat-view";
import { formatTokens } from "@/lib/utils";
import { SECTIONS as DEV_TOOLS_SECTION_DEFS } from "@/components/devtools/DevToolsTab";
import { integratedText } from "@/components/git/Sync";
import { SECTIONS as PROJECT_SECTION_DEFS, TAG_INFO } from "@/components/workspace/ProjectSettingsTab";
import { compactSession, PROFILE_MODE, stopSession } from "@/components/workspace/useSendMessage";
import { revealInProject } from "@/components/workspace/file-links";
import { taskViewOf } from "@/components/workspace/WorkingIndicator";
import { recheckKnowledgeRefs } from "@/components/knowledge/knowledge-actions";
import { SECTIONS as SETTINGS_SECTION_DEFS } from "@/views/SettingsView";
import { EXTENSION_TAB_DEFS, SKILLS_TAB_DEFS } from "@/views/ExtensionsView";
import { NAV } from "./nav";

export type PaletteGroup = "Aktionen" | "Einstellungen" | "Projekte" | "Sessions" | "Erweiterungen" | "Wissen" | "Dateien" | "Commits" | "In Verläufen";

export interface PaletteEntry {
  id: string;
  group: PaletteGroup;
  label: string;
  /** extra words the filter matches on */
  keywords?: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
  /** full-text hits are already filtered by the sidecar */
  hit?: SearchHit;
}

/** Dialogs an entry opens; they outlive the palette, so CommandPalette renders them. */
export type PaletteDialog =
  | { kind: "delete-session"; session: Session }
  | { kind: "summary"; session: Session }
  | { kind: "new-agent"; root: ProjectWithStatus }
  | { kind: "new-branch"; projectId: string }
  | { kind: "create-pr"; project: ProjectWithStatus }
  /** the newest before/after comparison of the session, else of the project */
  | { kind: "ui-compare"; sessionId: string | null; projectId: string };

export interface ActionContext {
  qc: QueryClient;
  /** the project open in the workspace */
  project: ProjectWithStatus | null;
  /** main project of a worktree, otherwise the project itself */
  root: ProjectWithStatus | null;
  /** the agents' worktrees of that main project */
  agents?: ProjectWithStatus[];
  /** the session shown in the project's chat */
  session: Session | null;
  settings: Settings | undefined;
  models: ModelInfo[];
  devServer: DevServerState | undefined;
  testDb: TestDbState | undefined;
  phone: PhoneState | undefined;
  remote: RemoteState | undefined;
  githubConnected: boolean;
  /** prompt templates: the global ones plus those of the open project */
  templates: PromptTemplate[];
  /** sessions in their own chat windows, and those of them kept on top */
  chatWindows?: ChatWindowList;
  openDialog: (dialog: PaletteDialog) => void;
}

type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/** Boolean settings the palette leaves out on purpose, with the reason. */
export const UNLISTED_SETTINGS = {
  debugLogs: "hat keinen Schalter in den Einstellungen und wird nirgends ausgewertet",
  setupDone: "merkt sich, dass der Einrichtungsassistent durch ist; den Assistenten öffnet die Aktion „Einrichtungsassistent öffnen“",
  syncAsked: "merkt sich, dass die Frage nach der Synchronisierung beantwortet ist",
  usageStatsAsked: "merkt sich, dass die Frage nach der Nutzungsstatistik beantwortet ist",
} as const satisfies Partial<Record<BooleanSetting, string>>;

const SETTING_TOGGLES: Record<Exclude<BooleanSetting, keyof typeof UNLISTED_SETTINGS>, { label: string; section: SettingsSection; keywords?: string }> = {
  enterToSend: { label: t.layout.actions.toggles.enterToSend, section: "general", keywords: "enter sendet senden zeilenumbruch tastatur send newline keyboard" },
  desktopNotifications: { label: t.layout.actions.toggles.desktopNotifications, section: "general", keywords: "windows desktop benachrichtigung meldung notification" },
  alwaysOnTop: { label: t.layout.actions.toggles.alwaysOnTop, section: "general", keywords: "vordergrund hauptfenster fenster immer oben anheften anpinnen always on top main window pin" },
  screenshotKey: { label: t.layout.actions.toggles.screenshotKey, section: "general", keywords: "screenshot bildschirmfoto snipping druck print taste key screen capture" },
  sounds: { label: t.layout.actions.toggles.sounds, section: "general", keywords: "töne ton sound sounds signal klang audio" },
  autoContinueAfterLimit: { label: t.layout.actions.toggles.autoContinueAfterLimit, section: "claude", keywords: "auto weitermachen nutzungslimit limit reset continue usage" },
  learnTemplates: { label: t.layout.actions.toggles.learnTemplates, section: "templates", keywords: "prompt vorlagen templates wiederkehrende nachrichten shortcuts textvorschläge selbst anlegen lernen learn automatic recurring messages suggestions" },
  uiCompare: { label: t.layout.actions.toggles.uiCompare, section: "claude", keywords: "screenshot vergleich vorschau dev-server ui oberfläche bild vorher nachher before after compare preview image" },
  stripApiKey: { label: t.layout.actions.toggles.stripApiKey, section: "claude", keywords: "api key abo ausblenden hide subscription" },
  updateChecks: { label: t.layout.actions.toggles.updateChecks, section: "about", keywords: "update updates release version automatisch suchen check automatic" },
  usageStats: { label: t.layout.actions.toggles.usageStats, section: "about", keywords: "nutzungsstatistik statistik telemetrie datenschutz zahlen tokens anonym senden usage statistics telemetry privacy anonymous" },
  syncEnabled: { label: t.layout.actions.toggles.syncEnabled, section: "github", keywords: "synchronisierung sync abgleich andere pc rechner repository forge-data cloud github other computers" },
};

/** Single options of the settings that are no switch; the entry opens their section. */
const SETTING_OPTIONS: ReadonlyArray<{ id: string; label: string; section: SettingsSection; keywords?: string }> = [
  { id: "language", label: t.layout.paletteLanguageOption, section: "general", keywords: "sprache language english englisch deutsch german flagge" },
  { id: "default-model", label: t.layout.actions.options.defaultModel, section: "general", keywords: "standardmodell modell model default opus sonnet haiku" },
  { id: "default-effort", label: t.layout.actions.options.defaultEffort, section: "general", keywords: "denkaufwand aufwand effort thinking nachdenken default" },
  { id: "default-profile", label: t.layout.actions.options.defaultProfile, section: "general", keywords: "profil rechte profile permission safe balanced autonomous" },
  { id: "project-dir", label: t.layout.actions.options.projectDir, section: "general", keywords: "ordner pfad verzeichnis folder path directory projects" },
  { id: "github", label: t.layout.actions.options.github, section: "github", keywords: "github anmeldung konto login account sign in" },
  { id: "claude-setup", label: t.layout.actions.options.claudeSetup, section: "claude", keywords: "claude code installieren anmelden login abo update version install subscription" },
  { id: "claude-path", label: t.layout.actions.options.claudePath, section: "claude", keywords: "pfad claude cli executable programm path program" },
  { id: "idle-close", label: t.layout.actions.options.idleClose, section: "claude", keywords: "untätige sessions claude-prozess beenden inaktiv leerlauf timeout automatisch schließen minuten stunden idle close process minutes hours" },
  { id: "long-session", label: t.layout.actions.options.longSession, section: "claude", keywords: "lange sessions melden kontext tokens verbrauch limit warnung neue session übergabe fortsetzen long session context usage limit warning new session handoff continue" },
  { id: "phone-setup", label: t.layout.actions.options.phoneSetup, section: "phone", keywords: "telefon einrichten anruf sip gemini openai stimme tischtelefon phone call voice desk phone set up" },
  { id: "phone-numbers", label: t.layout.actions.options.phoneNumbers, section: "phone", keywords: "telefonnummern nummer handy rufnummer erlaubte anrufer benachrichtigung einschalten ausschalten phone numbers mobile allowed callers notification" },
  { id: "sync-projects", label: t.layout.actions.options.syncProjects, section: "github", keywords: "projekte holen sync klonen abgleich rechner pc fetch projects clone other computers" },
  { id: "sync-passphrase", label: t.layout.actions.options.syncPassphrase, section: "github", keywords: "sync-passwort verschlüsselung schlüssel passwort vergessen github password passphrase encryption key forgot" },
  { id: "sync-local-only", label: t.layout.actions.options.syncLocalOnly, section: "github", keywords: "nur lokal out of sync nicht synchronisiert gelöscht anderer pc local only deleted removed other computer" },
  { id: "sync-force", label: t.layout.actions.options.syncForce, section: "github", keywords: "sync zurücksetzen überschreiben neuester stand github reset overwrite latest hard" },
  { id: "sync-versions", label: t.layout.actions.options.syncVersions, section: "github", keywords: "versionen sync verlauf commit wiederherstellen backup versions history restore" },
  { id: "backup-restore", label: t.layout.actions.options.backupRestore, section: "backup", keywords: "backup herunterladen zurücksetzen sichern wiederherstellen export download restore" },
  { id: "global-rules", label: t.layout.actions.options.globalRules, section: "rules", keywords: "globale regeln claude.md memory anweisungen global rules instructions edit" },
  { id: "publisher", label: t.layout.actions.options.publisher, section: "about", keywords: "herausgeber vanturis firma impressum lizenz agpl open source quellcode datenschutz publisher company legal notice license source code privacy" },
  { id: "updates", label: t.layout.actions.options.updates, section: "about", keywords: "updates version release" },
  { id: "privacy", label: t.layout.actions.options.privacy, section: "about", keywords: "datenschutz telemetrie nutzungsstatistik anonym privacy telemetry usage statistics anonymous" },
  { id: "diagnostics", label: t.layout.actions.options.diagnostics, section: "about", keywords: "diagnose system node git gh api key fehler diagnostics error" },
];

const TAB_ENTRIES: Record<WorkspaceTab, { label: string; Icon: LucideIcon; keywords?: string }> = {
  chat: { label: t.layout.actions.tabs.chat, Icon: MessageSquare, keywords: "chat verlauf unterhaltung conversation history" },
  agents: { label: t.layout.actions.tabs.agents, Icon: Bot, keywords: "agenten parallel worktree subagenten agents subagents" },
  git: { label: t.layout.actions.tabs.git, Icon: GitBranch, keywords: "git commit diff änderungen changes" },
  files: { label: t.layout.actions.tabs.files, Icon: FileText, keywords: "dateien explorer files" },
  devtools: { label: t.layout.actions.tabs.devtools, Icon: FlaskConical, keywords: "dev-tools testdatenbank umgebung env dev tools test database environment" },
  knowledge: { label: t.layout.actions.tabs.knowledge, Icon: BookOpen, keywords: "wissen notizen wissensbasis knowledge notes project knowledge" },
  settings: { label: t.layout.actions.tabs.settings, Icon: Settings2, keywords: "projekt-einstellungen claude.md tags testbefehl project settings test command" },
};

const MODE_LABEL: Record<PermissionMode, string> = {
  default: t.layout.actions.modes.default,
  acceptEdits: t.layout.actions.modes.acceptEdits,
  plan: t.layout.actions.modes.plan,
  bypassPermissions: t.layout.actions.modes.bypassPermissions,
};

const icon = (Icon: LucideIcon) => <Icon className="h-4 w-4" />;

/** Both languages, so "Gehe zu" finds a view whichever language is on screen. */
const NAV_KEYWORDS: Record<(typeof NAV)[number]["view"], string> = {
  home: "start home startseite",
  projects: "projekte projects",
  sessions: "sessions verlauf history",
  report: "tagesbericht daily report",
  mcp: "erweiterungen extensions mcp plugins skills",
  settings: "einstellungen settings",
  workspace: "arbeitsbereich workspace",
};

function byId<T extends { id: string }>(defs: ReadonlyArray<T>, id: string): T {
  const def = defs.find((d) => d.id === id);
  if (!def) throw new Error(`Palette: no definition for ${id}`);
  return def;
}

async function saveSetting(qc: QueryClient, patch: Partial<Settings>, success: string) {
  try {
    qc.setQueryData(keys.settings, await call("settings.update", patch));
    void qc.invalidateQueries({ queryKey: keys.diagnostics });
    toast.success(success);
  } catch (e) {
    toast.error(t.layout.actions.settingNotSaved, errorMessage(e));
  }
}

async function updateProject(qc: QueryClient, projectId: string, patch: { profile?: ProfileId; tags?: string[]; gitEnabled?: boolean }, success: string, body?: string) {
  try {
    await call("projects.update", { projectId, ...patch });
    await qc.invalidateQueries({ queryKey: keys.project(projectId) });
    void qc.invalidateQueries({ queryKey: keys.projects });
    toast.success(success, body);
  } catch (e) {
    toast.error(t.layout.actions.notSaved, errorMessage(e));
  }
}

/** Like the buttons in the Git tab: conflicts with origin open the Claude session that resolves them. */
async function gitSync(qc: QueryClient, projectId: string, label: string, fn: () => Promise<unknown>, success: string) {
  try {
    const r = (await useActivity.getState().track(projectId, label, fn)) as { integrated?: Parameters<typeof integratedText>[0]; session?: Session | null } | undefined;
    void qc.invalidateQueries({ queryKey: keys.git(projectId) });
    void qc.invalidateQueries({ queryKey: ["pr", projectId] });
    void qc.invalidateQueries({ queryKey: keys.log(projectId) });
    if (r?.session) {
      qc.setQueryData(keys.session(r.session.id), r.session);
      void qc.invalidateQueries({ queryKey: keys.sessions(projectId) });
      useUi.getState().openProject(projectId, r.session.id);
      toast.info(t.layout.actions.conflicts, t.layout.actions.conflictsBody);
    } else {
      toast.success(success, integratedText(r?.integrated ?? null));
    }
  } catch (e) {
    toast.error(t.layout.actions.failed(label), errorMessage(e));
  }
}

/** Shows the change at once and goes back if the session refused it, like the composer. */
async function updateSession(qc: QueryClient, session: Session, optimistic: Partial<Session>, run: () => Promise<Session>, errorTitle: string) {
  const key = keys.session(session.id);
  const before = qc.getQueryData<Session>(key);
  if (before) qc.setQueryData(key, { ...before, ...optimistic });
  try {
    qc.setQueryData(key, await run());
  } catch (e) {
    if (before) qc.setQueryData(key, before);
    toast.error(errorTitle, errorMessage(e));
  }
}

/** A branch with the whole history; the original session stays. */
async function forkSession(qc: QueryClient, session: Session) {
  try {
    const r = await call("sessions.fork", { sessionId: session.id });
    const target = r.session?.id ?? null;
    if (r.session) qc.setQueryData(keys.session(r.session.id), r.session);
    void qc.invalidateQueries({ queryKey: keys.sessions(session.projectId) });
    if (r.prompt) useDrafts.getState().setText(draftKey(session.projectId, target), r.prompt);
    useUi.getState().setActiveSession(session.projectId, target);
    toast.success(r.session ? t.layout.actions.forked : t.layout.actions.restarted, r.session ? t.layout.actions.forkedBody : t.layout.actions.emptyBody);
  } catch (e) {
    toast.error(t.layout.actions.notForked, errorMessage(e));
  }
}

async function setPhone(qc: QueryClient, enabled: boolean) {
  try {
    qc.setQueryData(keys.phoneState, await call("phone.setEnabled", { enabled }));
  } catch (e) {
    toast.error(enabled ? t.layout.actions.phoneNotEnabled : t.layout.actions.phoneNotDisabled, errorMessage(e));
    if (e instanceof RpcCallError && (e.details as Partial<PhoneSetupIncomplete> | undefined)?.phoneSetupIncomplete) useUi.getState().openSettings("phone");
  }
}

async function checkForUpdate(qc: QueryClient) {
  try {
    const next = await call("app.checkUpdate", {});
    qc.setQueryData(keys.appUpdate, next);
    if (next.phase === "uptodate") toast.success(t.layout.actions.upToDate, next.message ?? t.layout.actions.version(next.currentVersion));
    else if (next.phase === "error") toast.error(t.layout.actions.checkFailed, next.message ?? "");
    else if (next.phase === "available" || next.phase === "ready") toast.info(t.layout.actions.updateAvailable, t.layout.actions.version(next.latest?.version ?? ""));
  } catch (e) {
    toast.error(t.layout.actions.checkFailed, errorMessage(e));
  }
}

async function syncNow(qc: QueryClient) {
  try {
    qc.setQueryData(keys.sync, await call("sync.now", {}));
    toast.success(t.layout.actions.synced);
  } catch (e) {
    toast.error(t.layout.actions.syncFailed, errorMessage(e));
  }
}

async function createBackup(qc: QueryClient) {
  try {
    await call("backup.create", {});
    void qc.invalidateQueries({ queryKey: keys.backups });
    toast.success(t.layout.actions.backupCreated);
  } catch (e) {
    toast.error(t.layout.actions.backupNotCreated, errorMessage(e));
  }
}

const SESSION_BUSY: ReadonlySet<Session["status"]> = new Set(["starting", "running", "waiting_approval"]);

/**
 * Every action and setting the palette offers, for the current state. Pure, so a test can check that
 * each area of FORGE has an entry (palette-actions.test.tsx). Entries read the UI store when they run.
 */
export function buildActions(ctx: ActionContext): PaletteEntry[] {
  const { qc, project, root, session, settings } = ctx;
  const ui = useUi.getState();
  const list: PaletteEntry[] = [];
  const add = (group: PaletteGroup, id: string, label: string, ic: ReactNode, run: () => void, extra: Partial<PaletteEntry> = {}) => list.push({ id, group, label, icon: ic, run, ...extra });
  const act = (id: string, label: string, ic: ReactNode, run: () => void, extra: Partial<PaletteEntry> = {}) => add("Aktionen", id, label, ic, run, extra);
  const setting = (id: string, label: string, ic: ReactNode, run: () => void, extra: Partial<PaletteEntry> = {}) => add("Einstellungen", id, label, ic, run, extra);

  if (project) {
    act("new-session", t.layout.actions.newSession(project.name), icon(MessageSquarePlus), () => {
      ui.setActiveSession(project.id, null);
      ui.setWorkspaceTab("chat");
      requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
    }, { hint: t.layout.actions.ctrl("N"), keywords: "neue session chat starten new session start" });
    act("chat-find", t.layout.actions.chatFind, icon(Search), () => {
      ui.setWorkspaceTab("chat");
      openChatFindSoon();
    }, { hint: t.layout.actions.ctrl("F"), keywords: "im chat suchen finden suche verlauf nachrichten durchsuchen session projekt befehle find search history messages project commands" });
    if (session) {
      const s = session;
      const current = chatView(s.id);
      const labels = { all: t.chat.view.paletteAll, prompts: t.chat.view.palettePrompts, answers: t.chat.view.paletteAnswers };
      for (const v of CHAT_VIEWS) {
        if (v.id === current) continue;
        act(`chat-view-${v.id}`, labels[v.id], icon(v.Icon), () => {
          ui.setWorkspaceTab("chat");
          setChatView(s.id, v.id);
        }, { keywords: t.chat.view.keywords });
      }
    }
    act("ui-compare-latest", t.layout.actions.uiCompareLatest, icon(GitCompareArrows), () => ctx.openDialog({ kind: "ui-compare", sessionId: session?.id ?? null, projectId: project.id }), {
      keywords: "screenshot vergleich vorschau bild ui oberfläche dev-server vorher nachher before after compare preview image",
    });

    if (session) {
      const s = session;
      if (SESSION_BUSY.has(s.status)) act("session-stop", t.layout.actions.sessionStop, icon(Square), () => void stopSession(s.id), { keywords: "stoppen abbrechen anhalten stop cancel abort" });
      if (s.live && s.status === "idle") act("compact", t.layout.actions.compact, icon(Shrink), () => void compactSession(s.id), { keywords: "kontext komprimieren compact zusammenfassen context summarize" });
    }

    const dev = ctx.devServer;
    if (dev?.status === "running") {
      act("dev-stop", t.layout.actions.devStop, icon(Square), () => {
        call("devserver.stop", { projectId: project.id }).then((st) => qc.setQueryData(keys.devServer(project.id), st)).catch((e: unknown) => toast.error(t.layout.actions.devNotStopped, errorMessage(e)));
      }, { keywords: "dev-server stoppen stop dev server" });
    } else if (dev?.effectiveCommand) {
      act("dev-start", t.layout.actions.devStart, icon(Play), () => {
        call("devserver.start", { projectId: project.id }).then((st) => qc.setQueryData(keys.devServer(project.id), st)).catch((e: unknown) => toast.error(t.layout.actions.devNotStarted, errorMessage(e)));
      }, { hint: dev.effectiveCommand, keywords: "dev-server starten start dev server" });
    }

    // Without a query only the first entries show: tabs before the rarer session actions.
    workspaceTabsFor(project).forEach((tab, i) => {
      const def = TAB_ENTRIES[tab];
      act(`tab-${tab}`, def.label, icon(def.Icon), () => ui.setWorkspaceTab(tab), { hint: t.layout.actions.ctrl(String(i + 1)), keywords: def.keywords });
    });

    if (session) {
      const s = session;
      if (s.live && !SESSION_BUSY.has(s.status)) {
        act("session-close", t.layout.actions.sessionClose, icon(Power), () => {
          call("sessions.close", { sessionId: s.id }).catch((e: unknown) => toast.error(t.layout.actions.stopFailed, errorMessage(e)));
        }, { keywords: "session schließen prozess schließen stoppen bleibt fortsetzbar claude-prozess beenden close stop process resumable" });
      }
      // Background tasks and subagents of the session: write to one (its window opens with the input focused).
      const tasks = [
        ...s.background.map((b) => taskViewOf(b, s.id)),
        ...s.subagents.map((a) => (a.toolUseId ? ({ kind: "agent", sessionId: s.id, toolUseId: a.toolUseId, title: a.description } as const) : null)),
      ];
      for (const task of tasks) {
        if (!task) continue;
        act(`task-message-${task.kind === "agent" ? task.toolUseId : task.taskId}`, t.layout.actions.taskMessage(task.title), icon(MessageSquareText), () => {
          ui.setWorkspaceTab("chat");
          ui.openTask({ ...task, compose: true });
        }, { keywords: "nachricht schreiben subagent befehl hintergrund aufgabe sendmessage message write background task" });
      }
      const inWindow = ctx.chatWindows?.sessions.includes(s.id) ?? false;
      const pinned = ctx.chatWindows?.pinned.includes(s.id) ?? false;
      if (!inWindow) {
        act("chat-window-open", t.layout.actions.chatWindowOpen, icon(SquareArrowOutUpRight), () => void openChatWindow(s.projectId, s.id, s.title), { keywords: "eigenem fenster auskoppeln chat-fenster abdocken own window chat window undock pop out" });
      } else {
        act("chat-window-recall", t.layout.actions.chatWindowRecall, icon(SquareArrowOutDownLeft), () => recallChatWindow(s.id), { keywords: "chat-fenster zurückholen hauptfenster einkoppeln andocken schließen chat window main window dock back close" });
      }
      act(
        "chat-window-pin",
        pinned ? t.layout.actions.chatWindowUnpin : t.layout.actions.chatWindowPin,
        icon(pinned ? PinOff : Pin),
        () => void (pinned ? pinChatWindow(s.id, false) : inWindow ? pinChatWindow(s.id, true) : openChatWindow(s.projectId, s.id, s.title, { pinned: true })),
        { keywords: "chat-fenster vordergrund anheften anpinnen immer oben always on top eigenes fenster chat window pin own window", hint: inWindow ? undefined : t.layout.actions.opensWindow },
      );
      act("session-summary", t.layout.actions.sessionSummary, icon(NotebookText), () => ctx.openDialog({ kind: "summary", session: s }), { keywords: "session zusammenfassen wo war ich wiedereinstieg summary summarize where was i" });
      act("session-fork", t.layout.actions.sessionFork, icon(GitFork), () => void forkSession(qc, s), { keywords: "session verzweigen fork kopie zweig copy branch" });
      if (s.claudeSessionId && !SESSION_BUSY.has(s.status)) {
        act("session-handoff", t.layout.actions.sessionHandoff, icon(MessageSquarePlus), () => void handoffSession(s), {
          hint: s.context ? t.layout.actions.handoffHint(formatTokens(s.context.totalTokens)) : undefined,
          keywords: "in neuer session weitermachen übergabe fortsetzen lange session kontext tokens sparen zusammenfassen wissen mitnehmen continue new session handoff long context save summarize carry over knowledge",
        });
      }
      const lastPrompt = lastEditablePrompt(s.id);
      if (lastPrompt !== null) {
        act("session-edit-last", t.layout.actions.editLast, icon(Pencil), () => useMessageEdit.getState().start(s.id, lastPrompt), {
          keywords: "letzte nachricht bearbeiten ändern korrigieren neu senden prompt edit last message change correct resend",
        });
      }
      act("session-delete", t.layout.actions.sessionDelete, icon(Trash2), () => ctx.openDialog({ kind: "delete-session", session: s }), { keywords: "session löschen entfernen delete remove" });
      for (const m of ctx.models) {
        if (m.value === "default" || m.value === s.model) continue;
        act(`session-model-${m.value}`, t.layout.actions.switchModel(m.displayName || m.value), icon(Cpu), () => {
          void updateSession(qc, s, { model: m.value }, () => call("sessions.setModel", { sessionId: s.id, model: m.value }), t.layout.actions.modelNotSwitched);
        }, { keywords: "modell wechseln model switch", hint: s.model ? t.layout.actions.now(modelLabel(s.model, ctx.models)) : undefined });
      }
      for (const level of EFFORT_LEVELS) {
        if (level === s.effort) continue;
        act(`session-effort-${level}`, t.layout.actions.effort(level), icon(Gauge), () => {
          void updateSession(qc, s, { effort: level }, () => call("sessions.setEffort", { sessionId: s.id, effort: level as EffortLevel }), t.layout.actions.effortNotSwitched);
        }, { keywords: "denkaufwand effort aufwand thinking nachdenken", hint: s.effort ? t.layout.actions.now(s.effort) : undefined });
      }
      const mode: PermissionMode = s.permissionMode === "plan" ? PROFILE_MODE[s.profile] : "plan";
      act("session-mode", s.permissionMode === "plan" ? t.layout.actions.planOff : t.layout.actions.planOn, icon(ListChecks), () => {
        void updateSession(qc, s, { permissionMode: mode }, () => call("sessions.setPermissionMode", { sessionId: s.id, mode }), t.layout.actions.modeNotSwitched);
      }, { keywords: "plan-modus modus planen permission plan mode", hint: t.layout.actions.then(MODE_LABEL[mode]) });
    }

    const owner = root?.id ?? project.id;
    const db = ctx.testDb;
    if (db) {
      const running = db.status === "running";
      const method = running ? "testdb.stop" : "testdb.start";
      // An agent's worktree has its own test database.
      act(running ? "testdb-stop" : "testdb-start", running ? t.layout.actions.testDbStop : t.layout.actions.testDbStart, icon(Database), () => {
        call(method, { projectId: project.id })
          .then((st) => qc.setQueryData(keys.testDb(project.id), st))
          .catch((e: unknown) => toast.error(running ? t.layout.actions.testDbNotStopped : t.layout.actions.testDbNotStarted, errorMessage(e)));
      }, { keywords: "test-datenbank postgres postgresql db test database" });
    }

    for (const id of DEV_TOOLS_SECTIONS) {
      const def = byId(DEV_TOOLS_SECTION_DEFS, id);
      act(`devtools-${id}`, t.layout.actions.devTools(def.label), icon(def.Icon), () => ui.openDevTools(id), { hint: def.hint, keywords: "dev-tools dev tools" });
    }

    const git = project.git;
    if (git?.isRepo) {
      act("git-commit", t.layout.actions.gitCommit, icon(GitCommitHorizontal), () => ui.setWorkspaceTab("git"), { keywords: "commit erstellen git änderungen stage create changes", hint: git.changedCount ? t.layout.actions.changed(git.changedCount) : undefined });
      if (git.remoteUrl) {
        act("git-fetch", t.layout.actions.gitFetch, icon(CloudDownload), () => void gitSync(qc, project.id, t.layout.actions.fetch, () => call("git.fetch", { projectId: project.id }), t.layout.actions.fetched), { keywords: "git abrufen fetch" });
        act("git-pull", t.layout.actions.gitPull, icon(ArrowDown), () => void gitSync(qc, project.id, t.layout.actions.pull, () => call("git.pull", { projectId: project.id }), t.layout.actions.pulled), {
          hint: git.behind ? t.layout.actions.behind(git.behind) : undefined,
          keywords: "git pull holen aktualisieren update",
        });
        // Choosing push is the consent, also for main, like the button in the Git tab.
        act("git-push", t.layout.actions.gitPush, icon(ArrowUp), () => void gitSync(qc, project.id, t.layout.actions.push, () => call("git.push", { projectId: project.id, allowProtected: true }), t.layout.actions.pushed), {
          hint: git.ahead ? t.layout.actions.ahead(git.ahead) : undefined,
          keywords: "git push hochladen upload",
        });
      }
      act("git-new-branch", t.layout.actions.newBranch, icon(GitBranchPlus), () => ctx.openDialog({ kind: "new-branch", projectId: project.id }), { keywords: "neuen branch anlegen git checkout new create" });
      const onMain = git.branch === "main" || git.branch === "master";
      if (git.remoteUrl?.includes("github.com") && ctx.githubConnected && !onMain) {
        act("git-pr", t.layout.actions.createPr, icon(GitPullRequest), () => ctx.openDialog({ kind: "create-pr", project }), { keywords: "pull request erstellen github pr create", hint: git.branch ?? undefined });
      }
    }

    if (root?.exists && root.git) {
      const r = root;
      act("agent-new", t.layout.actions.agentNew, icon(Bot), () => ctx.openDialog({ kind: "new-agent", root: r }), { keywords: "parallelen agenten starten worktree branch agent parallel start" });
    }
    for (const a of ctx.agents ?? []) {
      act(`agent-dev-${a.id}`, t.layout.actions.agentDev(a.git?.branch ?? a.name), icon(Globe), () => void openDevServer(qc, a.id), {
        keywords: "dev-server agenten agent worktree vorschau browser port starten dev server preview start",
        hint: a.id === project.id ? t.layout.actions.thisAgent : undefined,
      });
    }
    if (project.parentId && project.exists) {
      act("agent-prepare", t.layout.actions.agentPrepare, icon(RotateCcw), () => void prepareWorktree(qc, project.id), {
        keywords: "worktree agenten vorbereiten agent abhängigkeiten installieren pnpm install env konfiguration kopieren build cache datenbank prepare dependencies configuration copy database",
      });
    }

    act("knowledge-merge", t.layout.actions.knowledgeMerge, icon(Combine), () => ui.openKnowledge(KNOWLEDGE_MERGE_REQUEST), {
      keywords: "projektwissen einträge zusammenführen wissen aufräumen überschneidungen doppelt merge automatisch claude project knowledge entries clean up overlaps duplicates",
    });
    act("knowledge-stale", t.layout.actions.knowledgeStale, icon(Link2Off), () => ui.openKnowledge(KNOWLEDGE_STALE_REQUEST), {
      keywords: "projektwissen wissen veraltet verweise fehlen dateien bezeichner kaputt alt prüfen project knowledge outdated stale references missing files identifiers broken check",
    });
    act("knowledge-recheck", t.layout.actions.knowledgeRecheck, icon(RefreshCw), () => void recheckKnowledgeRefs(qc, owner), {
      keywords: "projektwissen wissen veraltet verweise dateien bezeichner prüfen aktualisieren project knowledge outdated references files identifiers recheck refresh",
    });
    act("report-project", t.layout.actions.reportProject, icon(CalendarDays), () => ui.openReport(root?.id ?? project.id), {
      keywords: "tagesbericht projekt heute passiert rückblick agenten commits zusammenfassung tag daily report project today review agents summary day",
      hint: root?.name ?? project.name,
    });

    if (project.exists) {
      act("explorer-project", t.layout.actions.explorerProject, icon(FolderOpen), () => void revealInProject(project.path, ""), { keywords: "projektordner explorer ordner dateien windows project folder files" });
      const file = ui.selectedFile[project.id];
      if (file) act("explorer-file", t.layout.actions.explorerFile, icon(FolderOpen), () => void revealInProject(project.path, file), { keywords: "datei explorer ordner windows file folder show", hint: file });
    }
    act("terminal", t.layout.actions.terminal, icon(SquareTerminal), () => ui.openTerminal(project.id, "shell"), { keywords: "terminal shell konsole console" });
    act("bottom", t.layout.actions.bottom, icon(PanelBottom), () => ui.toggleBottomPanel(), { hint: t.layout.actions.ctrl("J"), keywords: "unteres panel einblenden ausblenden bottom panel toggle show hide" });
    act("right", t.layout.actions.right, icon(PanelRight), () => ui.toggleRightPanel(), { hint: t.layout.actions.ctrlShift("E"), keywords: "seitenleiste einblenden ausblenden sidebar side panel toggle show hide" });
    if (ui.splitRoom > 0) {
      act("split-add", t.layout.actions.splitAdd, icon(Columns2), () => ui.addSplitPane(), {
        keywords: "geteilte ansicht teilen split mehrere sessions projekte nebeneinander raster bereich chat daneben split view multiple side by side grid area beside",
      });
    }
    if (ui.splitPanes.length) {
      act("split-close", t.layout.actions.splitClose, icon(Columns2), () => ui.closeSplitPanes(), {
        hint: t.layout.actions.moreAreas(ui.splitPanes.length),
        keywords: "geteilte ansicht split mehrere sessions projekte bereiche schließen einzeln split view close areas single",
      });
    } else if (ui.splitStash) {
      const n = ui.splitStash.panes.length + 1;
      act("split-restore", t.layout.actions.splitRestore, icon(Columns2), () => ui.restoreSplit(), {
        hint: t.layout.actions.areas(n),
        keywords: "geteilte ansicht split mehrere sessions projekte bereiche zurück wiederherstellen raster split view reopen restore areas grid",
      });
    }
    for (const p of PROFILE_IDS) {
      if (p === project.profile || (p === "autonomous" && project.tags.includes("sandbox-only"))) continue;
      act(`profile-${p}`, t.layout.actions.switchProfile(PROFILE_INFO[p].label), icon(Shield), () => {
        void updateProject(qc, project.id, { profile: p }, t.layout.actions.profileSet(PROFILE_INFO[p].label), t.layout.actions.profileBody);
      }, { keywords: "profil wechseln rechte permission profile switch" });
    }

    for (const id of PROJECT_SETTINGS_SECTIONS) {
      const def = byId(PROJECT_SECTION_DEFS, id);
      setting(`project-settings-${id}`, t.layout.actions.projectSettings(def.label), icon(def.Icon), () => ui.openProjectSettings(id), { hint: def.hint, keywords: `projekt-einstellungen project settings ${project.name}` });
    }
    if (!project.parentId) {
      const on = project.gitEnabled;
      setting("project-git", on ? t.layout.actions.gitOff : t.layout.actions.gitOn, icon(on ? ToggleRight : ToggleLeft), () => {
        void updateProject(qc, project.id, { gitEnabled: !on }, on ? t.layout.actions.gitTurnedOff : t.layout.actions.gitTurnedOn, on ? t.layout.actions.gitOffBody : project.name);
      }, { keywords: "git einschalten ausschalten versionsverwaltung ohne git agenten repository turn on off version control without agents", hint: project.name });
    }
    for (const tag of TAG_INFO) {
      if ((tag.rootOnly && project.parentId) || (tag.git && !project.gitEnabled)) continue;
      const on = project.tags.includes(tag.tag);
      setting(`tag-${tag.tag}`, t.layout.actions.toggleLabel(tag.label, on), icon(on ? ToggleRight : ToggleLeft), () => {
        void updateProject(qc, project.id, { tags: on ? project.tags.filter((x) => x !== tag.tag) : [...project.tags, tag.tag] }, t.layout.actions.toggled(tag.label, on), project.name);
      }, { hint: tag.tag, keywords: `automatik tag projekt einschalten ausschalten automation project turn on off ${tag.info}` });
    }
  }

  for (const tpl of ctx.templates) {
    act(`template-${tpl.id}`, t.layout.actions.template(tpl.name), icon(FileStack), () => useTemplateDialogs.getState().openApply({ projectId: project?.id ?? null, templateId: tpl.id }), {
      hint: tpl.projectId ? (root?.name ?? project?.name) : t.layout.actions.global,
      keywords: `vorlage prompt auftrag template task ${tpl.description ?? ""} ${tpl.text.slice(0, 200)}`,
    });
  }
  act("templates-manage", t.layout.actions.templatesManage, icon(FileStack), () => ui.openSettings("templates"), { keywords: "vorlagen verwalten prompt vorlagen templates wiederkehrende aufträge bearbeiten löschen sortieren manage recurring tasks edit delete sort" });
  act("templates-learn", t.layout.actions.templatesLearn, icon(Sparkles), () => void learnTemplatesNow(qc), {
    keywords: "vorlagen lernen nachrichten prompt vorlagen templates wiederkehrende aufträge automatisch shortcuts textvorschläge learn messages recurring automatic suggestions",
  });
  act("template-new", t.layout.actions.templateNew, icon(FilePlus2), () => useTemplateDialogs.getState().openEdit({ id: null, projectId: null }), { keywords: "neue vorlage anlegen prompt vorlage template speichern new create save" });
  act("report", t.layout.actions.report, icon(CalendarDays), () => ui.openReport(null), { keywords: "tagesbericht was ist heute passiert rückblick alle projekte agenten commits zusammenfassung tag gestern daily report today what happened review all projects agents summary day yesterday" });
  act("add-project", t.layout.actions.addProject, icon(FolderPlus), () => ui.setNewProject("import"), { hint: t.layout.actions.ctrl("O"), keywords: "projekt hinzufügen importieren ordner add project import folder" });
  act("create-project", t.layout.actions.createProject, icon(FolderPlus), () => ui.setNewProject("create"), { keywords: "neues projekt anlegen new project create" });
  act("clone-project", t.layout.actions.cloneProject, icon(FolderDown), () => ui.setNewProject("clone"), { keywords: "projekt github klonen clone repository project" });

  const remoteOn = ctx.remote?.enabled ?? false;
  act("remote", remoteOn ? t.layout.actions.remoteOff : t.layout.actions.remoteOn, icon(MonitorSmartphone), () => {
    call(remoteOn ? "remote.stop" : "remote.start", {})
      .then((st) => qc.setQueryData(keys.remote, st))
      .catch((e: unknown) => toast.error(t.layout.actions.remoteError, errorMessage(e)));
  }, { keywords: "remote control einschalten ausschalten claude app handy weiterarbeiten turn on off phone mobile continue" });

  if (ctx.phone) {
    const phoneOn = ctx.phone.enabled;
    act("phone", phoneOn ? t.layout.actions.phoneOff : t.layout.actions.phoneOn, icon(phoneOn ? PhoneOff : Phone), () => void setPhone(qc, !phoneOn), { keywords: "telefon einschalten ausschalten anruf sprache phone turn on off call voice" });
    if (ctx.phone.registration === "registered") {
      act("phone-test", t.layout.actions.testCall, icon(PhoneOutgoing), () => {
        call("phone.testCall", {})
          .then((st) => qc.setQueryData(keys.phoneState, st))
          .catch((e: unknown) => toast.error(t.layout.actions.testCallFailed, errorMessage(e)));
      }, { keywords: "testanruf telefon anrufen test call phone" });
    }
  }

  act("screenshot", t.layout.actions.screenshot, icon(Camera), takeScreenshot, { hint: settings?.screenshotKey ? t.layout.actions.printKey : undefined, keywords: "screenshot aufnehmen bildschirmfoto snipping ausschneiden markieren bild take capture screen cut mark image" });
  act("backup", t.layout.actions.backup, icon(Archive), () => void createBackup(qc), { keywords: "backup anlegen sichern sicherung create" });
  if (settings?.syncEnabled) act("sync-now", t.layout.actions.syncNow, icon(RefreshCcw), () => void syncNow(qc), { keywords: "jetzt github abgleichen sync synchronisieren andere pc now other computers" });
  act("setup-wizard", t.layout.actions.setupWizard, icon(Wand2), () => ui.setSetupWizard(true), { keywords: "einrichtungsassistent einrichten erster start setup onboarding assistant wizard first start" });
  act("usage-forecast", t.layout.actions.usageForecast, icon(Gauge), () => ui.openSettings("claude"), {
    keywords: "nutzung limit-prognose usage limit abo verbrauch prognose reicht reset 5 stunden woche tempo forecast subscription consumption hours week pace",
  });
  act("usage-refresh", t.layout.actions.usageRefresh, icon(RefreshCw), () => void refreshUsage(qc), { keywords: "nutzung aktualisieren usage limit abo verbrauch prognose neu laden refresh reload subscription forecast" });
  act("claude-login", t.layout.actions.claudeLogin, icon(LogIn), () => ui.openClaudeLogin("manual"), { keywords: "claude anmelden login anmeldung abgelaufen konto abo neu anmelden oauth log in sign in expired account subscription" });
  act("claude-switch", t.layout.actions.claudeSwitch, icon(ArrowLeftRight), () => ui.openClaudeLogin("switch"), { keywords: "claude-konto account konto wechseln anderes login switch other" });
  act("claude-logout", t.layout.actions.claudeLogout, icon(LogOut), () => ui.setClaudeLogout(true), { keywords: "claude logout abmelden konto account log out sign out" });
  act("update-check", t.layout.actions.updateCheck, icon(RefreshCw), () => void checkForUpdate(qc), { keywords: "updates suchen version release aktualisieren check update" });
  act("support-open", t.layout.actions.supportOpen, icon(HandHeart), () => ui.setSupportOpen(true), { hint: t.layout.actions.supportHint, keywords: "unterstützen spenden vorschlag feedback herz support donate suggestion heart" });
  act("support-donate", t.layout.actions.supportDonate, icon(HandHeart), () => void openExternal(SUPPORT_LINKS.donate), { hint: "Vanturis", keywords: "spenden spende beitrag zahlen unterstützen danke support donate donation contribution pay thanks" });
  act("usage-stats-public", t.layout.actions.usageStatsPublic, icon(Gauge), () => void openExternal(STATS_PAGE_URL), {
    hint: t.layout.actions.statsHint,
    keywords: "gesamtzahlen statistik zahlen tokens projekte agenten öffentlich gesamt nutzer statistics totals numbers projects agents public users",
  });
  act("support-feedback", t.layout.actions.supportFeedback, icon(Lightbulb), () => void openExternal(SUPPORT_LINKS.feedback), {
    hint: "GitHub Issues",
    keywords: "feedback vorschlag idee wunsch feature fehler melden bug issue verbesserung suggestion idea wish error report improvement",
  });
  const update = qc.getQueryData<AppUpdateState>(keys.appUpdate);
  if (update?.latest && update.installable && ["available", "downloading", "ready"].includes(update.phase)) {
    act("update-install", t.layout.actions.updateInstall(update.latest.version), icon(ArrowUpCircle), () => void installUpdate(qc), { keywords: "update installieren aktualisieren neustart version install restart" });
  }
  const installKeywords = "vollständig installation unvollständig setup installer laufzeit runtime git gh github cli node fehlt reparieren complete incomplete install missing repair";
  if (supportsFullInstall) act("install-check", t.layout.actions.installCheck, icon(PackageCheck), () => void checkInstall(qc), { keywords: installKeywords });
  const install = qc.getQueryData<AppInstallState>(keys.appInstall);
  if (supportsFullInstall && install?.checkable && install.complete === false) {
    if (install.installer || install.phase === "ready") act("install-full", t.layout.actions.installFull, icon(PackageCheck), () => void installFull(qc), { keywords: installKeywords });
    act("install-file", t.layout.actions.installFile, icon(FileUp), () => void installFromFile(qc), { keywords: installKeywords });
  }
  const claudeUpdate = qc.getQueryData<ClaudeUpdateInfo>(keys.claudeUpdate);
  if (claudeUpdate?.available) {
    act(
      "claude-update",
      t.layout.actions.claudeUpdate(claudeUpdate.latest ?? ""),
      icon(Download),
      () => void call("claude.update", {}).catch((e: unknown) => toast.error(t.layout.actions.updateNotStarted, errorMessage(e))),
      { keywords: "claude code update aktualisieren version cli" },
    );
  }
  for (const n of NAV) act(`nav-${n.view}`, t.layout.actions.goTo(n.label), icon(n.Icon), () => ui.setView(n.view), { keywords: `gehe zu go to ${NAV_KEYWORDS[n.view]}` });

  for (const id of EXTENSIONS_TABS) {
    const def = EXTENSION_TAB_DEFS.find((d) => d.value === id)!;
    add("Erweiterungen", `ext-${id}`, t.layout.actions.extensions(def.label), icon(def.Icon), () => ui.openExtensions(id), { keywords: "erweiterungen plugins extensions" });
  }
  for (const id of SKILLS_TABS) {
    const def = SKILLS_TAB_DEFS.find((d) => d.value === id)!;
    add("Erweiterungen", `skills-${id}`, t.layout.actions.skills(def.label), icon(def.Icon), () => ui.openExtensions("skills", id), { keywords: "skills erweiterungen plugins extensions" });
  }

  for (const id of SETTINGS_SECTIONS) {
    const def = byId(SETTINGS_SECTION_DEFS, id);
    setting(`settings-${id}`, t.layout.actions.settings(def.label), icon(def.Icon), () => ui.openSettings(id), { hint: def.hint, keywords: "einstellungen settings" });
  }
  for (const o of SETTING_OPTIONS) {
    setting(`option-${o.id}`, o.label, icon(byId(SETTINGS_SECTION_DEFS, o.section).Icon), () => ui.openSettings(o.section), {
      hint: byId(SETTINGS_SECTION_DEFS, o.section).label,
      keywords: o.keywords,
    });
  }
  for (const [key, def] of Object.entries(SETTING_TOGGLES) as Array<[keyof typeof SETTING_TOGGLES, (typeof SETTING_TOGGLES)[keyof typeof SETTING_TOGGLES]]>) {
    const on = settings?.[key];
    if (on === undefined) continue;
    const section = byId(SETTINGS_SECTION_DEFS, def.section).label;
    const run =
      key === "alwaysOnTop"
        ? () => void setAlwaysOnTop(qc, !on)
        : () =>
            void saveSetting(
              qc,
              key === "syncEnabled" ? { syncEnabled: !on, syncAsked: true } : key === "usageStats" ? { usageStats: !on, usageStatsAsked: true } : { [key]: !on },
              t.layout.actions.toggled(def.label, on),
            );
    const ic = key === "alwaysOnTop" ? icon(on ? PinOff : Pin) : icon(on ? ToggleRight : ToggleLeft);
    setting(`setting-${key}`, t.layout.actions.toggleLabel(def.label, on), ic, run, { hint: section, keywords: `schalter einstellung einschalten ausschalten switch setting turn on off ${def.keywords ?? ""}` });
  }
  if (settings) {
    for (const l of LANGUAGES) {
      if (l === settings.language) continue;
      const label = t.layout.paletteLanguage(LANGUAGE_NAMES[l]);
      setting(`language-${l}`, label, icon(Languages), () => void saveSetting(qc, { language: l }, label), {
        hint: t.layout.paletteLanguageNow(LANGUAGE_NAMES[settings.language]),
        // both languages: whoever looks for the switch may not read the one on screen
        keywords: "sprache language english englisch deutsch german oberfläche interface",
      });
    }
    for (const m of IDLE_CLOSE_CHOICES) {
      if (m === settings.idleCloseMinutes) continue;
      const label = m > 0 ? t.layout.actions.idleCloseAfter(idleCloseLabel(m)) : t.layout.actions.idleCloseNever;
      setting(`idle-close-${m}`, label, icon(Timer), () => void saveSetting(qc, { idleCloseMinutes: m }, label), {
        hint: t.layout.actions.now(idleCloseLabel(settings.idleCloseMinutes)),
        keywords: "untätige sessions claude-prozess beenden inaktiv leerlauf timeout automatisch schließen idle close process inactive automatic",
      });
    }
    for (const tokens of LONG_SESSION_CHOICES) {
      if (tokens === settings.longSessionTokens) continue;
      const label = tokens > 0 ? t.layout.actions.longSessionOn(longSessionLabel(tokens)) : t.layout.actions.longSessionOff;
      setting(`long-session-${tokens}`, label, icon(MessageSquarePlus), () => void saveSetting(qc, { longSessionTokens: tokens }, label), {
        hint: t.layout.actions.now(longSessionLabel(settings.longSessionTokens)),
        keywords: "lange sessions melden kontext tokens verbrauch limit warnung hinweis neue session übergabe long session context usage limit warning hint new session handoff",
      });
    }
  }
  for (const group of RULE_GROUPS) {
    for (const rule of group.rules) {
      const blocked = !settings?.disabledPolicyRules.includes(rule.id);
      setting(`policy-${rule.id}`, t.layout.actions.blocklist(rule.label), icon(ShieldBan), () => ui.openSettings("policy"), {
        hint: settings ? (blocked ? t.layout.actions.blocked : t.layout.actions.allowed) : undefined,
        keywords: `sperrliste regel blockieren policy blocklist rule block ${group.title} ${rule.info}`,
      });
    }
  }
  return list;
}
