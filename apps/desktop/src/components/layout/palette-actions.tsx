import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpCircle,
  BookOpen,
  Bot,
  CloudDownload,
  Columns2,
  Cpu,
  Database,
  FileText,
  FlaskConical,
  FolderDown,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  ListChecks,
  LogIn,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  MonitorSmartphone,
  NotebookText,
  PanelBottom,
  PanelRight,
  Pencil,
  Phone,
  PhoneOff,
  PhoneOutgoing,
  Pin,
  PinOff,
  Play,
  Power,
  RefreshCcw,
  RefreshCw,
  Settings2,
  Shield,
  ShieldBan,
  Shrink,
  Square,
  SquareTerminal,
  Timer,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wand2,
  type LucideIcon,
  Combine,
} from "lucide-react";
import type {
  AppUpdateState,
  DevServerState,
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PhoneSetupIncomplete,
  PhoneState,
  ProfileId,
  ProjectWithStatus,
  RemoteState,
  SearchHit,
  Session,
  Settings,
  TestDbState,
} from "@forge/protocol";
import { IDLE_CLOSE_CHOICES } from "@forge/protocol";
import { installUpdate } from "@/lib/app-install";
import { call, keys } from "@/lib/queries";
import { EFFORT_LEVELS, modelLabel } from "@/lib/models";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { setAlwaysOnTop } from "@/lib/window-options";
import { useActivity } from "@/stores/activity";
import { draftKey, useDrafts } from "@/stores/drafts";
import { lastEditablePrompt, useMessageEdit } from "@/stores/message-edit";
import { toast } from "@/stores/toast";
import { DEV_TOOLS_SECTIONS, KNOWLEDGE_MERGE_REQUEST, PROJECT_SETTINGS_SECTIONS, SETTINGS_SECTIONS, SKILLS_TABS, EXTENSIONS_TABS, workspaceTabsFor, useUi, type SettingsSection, type WorkspaceTab } from "@/stores/ui";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { RULE_GROUPS } from "@/components/settings/PolicySettings";
import { idleCloseLabel } from "@/components/settings/idle-close";
import { SECTIONS as DEV_TOOLS_SECTION_DEFS } from "@/components/devtools/DevToolsTab";
import { integratedText } from "@/components/git/Sync";
import { SECTIONS as PROJECT_SECTION_DEFS, TAG_INFO } from "@/components/workspace/ProjectSettingsTab";
import { compactSession, PROFILE_MODE, stopSession } from "@/components/workspace/useSendMessage";
import { revealInProject } from "@/components/workspace/file-links";
import { SECTIONS as SETTINGS_SECTION_DEFS } from "@/views/SettingsView";
import { EXTENSION_TAB_DEFS, SKILLS_TAB_DEFS } from "@/views/ExtensionsView";
import { NAV } from "./nav";

export type PaletteGroup = "Aktionen" | "Einstellungen" | "Projekte" | "Sessions" | "Erweiterungen" | "Wissen" | "Dateien" | "In Verläufen";

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
  | { kind: "create-pr"; project: ProjectWithStatus };

export interface ActionContext {
  qc: QueryClient;
  /** the project open in the workspace */
  project: ProjectWithStatus | null;
  /** main project of a worktree, otherwise the project itself */
  root: ProjectWithStatus | null;
  /** the session shown in the project's chat */
  session: Session | null;
  settings: Settings | undefined;
  models: ModelInfo[];
  devServer: DevServerState | undefined;
  testDb: TestDbState | undefined;
  phone: PhoneState | undefined;
  remote: RemoteState | undefined;
  githubConnected: boolean;
  openDialog: (dialog: PaletteDialog) => void;
}

type BooleanSetting = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/** Boolean settings the palette leaves out on purpose, with the reason. */
export const UNLISTED_SETTINGS = {
  debugLogs: "hat keinen Schalter in den Einstellungen und wird nirgends ausgewertet",
  setupDone: "merkt sich, dass der Einrichtungsassistent durch ist; den Assistenten öffnet die Aktion „Einrichtungsassistent öffnen“",
  syncAsked: "merkt sich, dass die Frage nach der Synchronisierung beantwortet ist",
} as const satisfies Partial<Record<BooleanSetting, string>>;

const SETTING_TOGGLES: Record<Exclude<BooleanSetting, keyof typeof UNLISTED_SETTINGS>, { label: string; section: SettingsSection; keywords?: string }> = {
  enterToSend: { label: "Enter sendet", section: "general", keywords: "senden zeilenumbruch tastatur" },
  desktopNotifications: { label: "Windows-Benachrichtigungen", section: "general", keywords: "desktop benachrichtigung meldung" },
  alwaysOnTop: { label: "Im Vordergrund bleiben", section: "general", keywords: "fenster immer oben anheften always on top" },
  sounds: { label: "Töne", section: "general", keywords: "sound signal klang" },
  autoContinueAfterLimit: { label: "Nach Nutzungslimit weitermachen", section: "claude", keywords: "auto weitermachen limit reset" },
  stripApiKey: { label: "ANTHROPIC_API_KEY ausblenden", section: "claude", keywords: "api key abo" },
  updateChecks: { label: "Automatisch nach Updates suchen", section: "about", keywords: "update release version" },
  syncEnabled: { label: "Synchronisierung über GitHub", section: "github", keywords: "sync abgleich andere pc rechner repository forge-data cloud" },
};

/** Single options of the settings that are no switch; the entry opens their section. */
const SETTING_OPTIONS: ReadonlyArray<{ id: string; label: string; section: SettingsSection; keywords?: string }> = [
  { id: "default-model", label: "Standardmodell für neue Sessions", section: "general", keywords: "modell model opus sonnet haiku" },
  { id: "default-effort", label: "Standard-Denkaufwand", section: "general", keywords: "aufwand effort thinking nachdenken" },
  { id: "default-profile", label: "Profil für neue Projekte", section: "general", keywords: "rechte permission safe balanced autonomous" },
  { id: "project-dir", label: "Ordner für neue Projekte", section: "general", keywords: "pfad verzeichnis" },
  { id: "github", label: "GitHub-Anmeldung", section: "github", keywords: "konto login account" },
  { id: "claude-setup", label: "Claude Code installieren und anmelden", section: "claude", keywords: "login abo update version" },
  { id: "claude-path", label: "Pfad zur Claude-CLI", section: "claude", keywords: "executable programm" },
  { id: "idle-close", label: "Untätige Sessions schließen nach", section: "claude", keywords: "claude-prozess beenden inaktiv leerlauf timeout automatisch schließen minuten stunden" },
  { id: "phone-setup", label: "Telefon einrichten", section: "phone", keywords: "anruf sip gemini openai stimme tischtelefon" },
  { id: "phone-numbers", label: "Telefonnummern: wen FORGE anruft, wer anrufen darf", section: "phone", keywords: "nummer handy rufnummer erlaubte anrufer benachrichtigung einschalten ausschalten" },
  { id: "sync-projects", label: "Projekte von anderen PCs holen", section: "github", keywords: "sync klonen abgleich rechner" },
  { id: "sync-passphrase", label: "Sync-Passwort eingeben oder neu festlegen", section: "github", keywords: "verschlüsselung schlüssel passwort vergessen github" },
  { id: "sync-local-only", label: "Nur lokal: auf anderen PCs Entferntes", section: "github", keywords: "out of sync nicht synchronisiert gelöscht anderer pc" },
  { id: "sync-force", label: "Diesen PC hart auf den Stand von GitHub setzen", section: "github", keywords: "sync zurücksetzen überschreiben neuester stand" },
  { id: "sync-versions", label: "Versionen auf GitHub zurückholen", section: "github", keywords: "sync verlauf commit wiederherstellen backup" },
  { id: "backup-restore", label: "Backup herunterladen oder zurücksetzen", section: "backup", keywords: "sichern wiederherstellen export" },
  { id: "global-rules", label: "Globale Regeln bearbeiten", section: "rules", keywords: "claude.md memory anweisungen" },
  { id: "updates", label: "Updates und Version", section: "about", keywords: "version release" },
  { id: "privacy", label: "Datenschutz", section: "about", keywords: "telemetrie" },
  { id: "diagnostics", label: "Diagnose", section: "about", keywords: "system node git gh api key fehler" },
];

const TAB_ENTRIES: Record<WorkspaceTab, { label: string; Icon: LucideIcon; keywords?: string }> = {
  chat: { label: "Chat öffnen", Icon: MessageSquare, keywords: "verlauf unterhaltung" },
  agents: { label: "Agenten öffnen", Icon: Bot, keywords: "parallel worktree subagenten" },
  git: { label: "Git öffnen", Icon: GitBranch, keywords: "commit diff änderungen" },
  files: { label: "Dateien öffnen", Icon: FileText, keywords: "explorer" },
  devtools: { label: "Dev-Tools öffnen", Icon: FlaskConical, keywords: "testdatenbank umgebung env" },
  knowledge: { label: "Wissen öffnen", Icon: BookOpen, keywords: "notizen wissensbasis" },
  settings: { label: "Projekt-Einstellungen öffnen", Icon: Settings2, keywords: "claude.md tags testbefehl" },
};

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Jede Aktion freigeben",
  acceptEdits: "Datei-Edits automatisch",
  plan: "Nur planen",
  bypassPermissions: "Ohne Rückfragen",
};

const icon = (Icon: LucideIcon) => <Icon className="h-4 w-4" />;

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
    toast.error("Einstellung nicht gespeichert", errorMessage(e));
  }
}

async function updateProject(qc: QueryClient, projectId: string, patch: { profile?: ProfileId; tags?: string[]; gitEnabled?: boolean }, success: string, body?: string) {
  try {
    await call("projects.update", { projectId, ...patch });
    await qc.invalidateQueries({ queryKey: keys.project(projectId) });
    void qc.invalidateQueries({ queryKey: keys.projects });
    toast.success(success, body);
  } catch (e) {
    toast.error("Nicht gespeichert", errorMessage(e));
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
      toast.info("Konflikte mit dem Remote", "Claude führt die Stände in einer neuen Session zusammen und fragt nach, wenn etwas unklar ist.");
    } else {
      toast.success(success, integratedText(r?.integrated ?? null));
    }
  } catch (e) {
    toast.error(`${label} fehlgeschlagen`, errorMessage(e));
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
    toast.success(r.session ? "Zweig erstellt" : "Neu begonnen", r.session ? "Der ganze Verlauf ist übernommen, das Original bleibt." : "Die Session hat noch keinen Verlauf.");
  } catch (e) {
    toast.error("Nicht verzweigt", errorMessage(e));
  }
}

async function setPhone(qc: QueryClient, enabled: boolean) {
  try {
    qc.setQueryData(keys.phoneState, await call("phone.setEnabled", { enabled }));
  } catch (e) {
    toast.error(enabled ? "Telefon nicht eingeschaltet" : "Telefon nicht ausgeschaltet", errorMessage(e));
    if (e instanceof RpcCallError && (e.details as Partial<PhoneSetupIncomplete> | undefined)?.phoneSetupIncomplete) useUi.getState().openSettings("phone");
  }
}

async function checkForUpdate(qc: QueryClient) {
  try {
    const next = await call("app.checkUpdate", {});
    qc.setQueryData(keys.appUpdate, next);
    if (next.phase === "uptodate") toast.success("FORGE ist aktuell", next.message ?? `Version ${next.currentVersion}`);
    else if (next.phase === "error") toast.error("Prüfung fehlgeschlagen", next.message ?? "");
    else if (next.phase === "available" || next.phase === "ready") toast.info("Update verfügbar", `Version ${next.latest?.version ?? ""}`);
  } catch (e) {
    toast.error("Prüfung fehlgeschlagen", errorMessage(e));
  }
}

async function syncNow(qc: QueryClient) {
  try {
    qc.setQueryData(keys.sync, await call("sync.now", {}));
    toast.success("Synchronisiert");
  } catch (e) {
    toast.error("Synchronisieren fehlgeschlagen", errorMessage(e));
  }
}

async function createBackup(qc: QueryClient) {
  try {
    await call("backup.create", {});
    void qc.invalidateQueries({ queryKey: keys.backups });
    toast.success("Backup angelegt");
  } catch (e) {
    toast.error("Backup nicht angelegt", errorMessage(e));
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
    act("new-session", `Neue Session in ${project.name}`, icon(MessageSquarePlus), () => {
      ui.setActiveSession(project.id, null);
      ui.setWorkspaceTab("chat");
      requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
    }, { hint: "Strg+N", keywords: "chat starten" });

    if (session) {
      const s = session;
      if (SESSION_BUSY.has(s.status)) act("session-stop", "Session stoppen", icon(Square), () => void stopSession(s.id), { keywords: "abbrechen anhalten" });
      if (s.live && s.status === "idle") act("compact", "Kontext komprimieren", icon(Shrink), () => void compactSession(s.id), { keywords: "compact zusammenfassen" });
    }

    const dev = ctx.devServer;
    if (dev?.status === "running") {
      act("dev-stop", "Dev-Server stoppen", icon(Square), () => {
        call("devserver.stop", { projectId: project.id }).then((st) => qc.setQueryData(keys.devServer(project.id), st)).catch((e: unknown) => toast.error("Dev-Server nicht gestoppt", errorMessage(e)));
      });
    } else if (dev?.effectiveCommand) {
      act("dev-start", "Dev-Server starten", icon(Play), () => {
        call("devserver.start", { projectId: project.id }).then((st) => qc.setQueryData(keys.devServer(project.id), st)).catch((e: unknown) => toast.error("Dev-Server nicht gestartet", errorMessage(e)));
      }, { hint: dev.effectiveCommand });
    }

    // Without a query only the first entries show: tabs before the rarer session actions.
    workspaceTabsFor(project).forEach((t, i) => {
      const def = TAB_ENTRIES[t];
      act(`tab-${t}`, def.label, icon(def.Icon), () => ui.setWorkspaceTab(t), { hint: `Strg+${i + 1}`, keywords: def.keywords });
    });

    if (session) {
      const s = session;
      if (s.live && !SESSION_BUSY.has(s.status)) {
        act("session-close", "Claude-Prozess der Session beenden", icon(Power), () => {
          call("sessions.close", { sessionId: s.id }).catch((e: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(e)));
        }, { keywords: "session schließen prozess schließen stoppen bleibt fortsetzbar" });
      }
      act("session-summary", "Session zusammenfassen", icon(NotebookText), () => ctx.openDialog({ kind: "summary", session: s }), { keywords: "wo war ich wiedereinstieg" });
      act("session-fork", "Session verzweigen", icon(GitFork), () => void forkSession(qc, s), { keywords: "fork kopie zweig" });
      const lastPrompt = lastEditablePrompt(s.id);
      if (lastPrompt !== null) {
        act("session-edit-last", "Letzte Nachricht bearbeiten", icon(Pencil), () => useMessageEdit.getState().start(s.id, lastPrompt), {
          keywords: "ändern korrigieren neu senden prompt",
        });
      }
      act("session-delete", "Session löschen", icon(Trash2), () => ctx.openDialog({ kind: "delete-session", session: s }), { keywords: "entfernen" });
      for (const m of ctx.models) {
        if (m.value === "default" || m.value === s.model) continue;
        act(`session-model-${m.value}`, `Modell wechseln: ${m.displayName || m.value}`, icon(Cpu), () => {
          void updateSession(qc, s, { model: m.value }, () => call("sessions.setModel", { sessionId: s.id, model: m.value }), "Modell nicht gewechselt");
        }, { keywords: "model", hint: s.model ? `jetzt ${modelLabel(s.model, ctx.models)}` : undefined });
      }
      for (const level of EFFORT_LEVELS) {
        if (level === s.effort) continue;
        act(`session-effort-${level}`, `Denkaufwand: ${level}`, icon(Gauge), () => {
          void updateSession(qc, s, { effort: level }, () => call("sessions.setEffort", { sessionId: s.id, effort: level as EffortLevel }), "Effort nicht gewechselt");
        }, { keywords: "effort aufwand thinking nachdenken", hint: s.effort ? `jetzt ${s.effort}` : undefined });
      }
      const mode: PermissionMode = s.permissionMode === "plan" ? PROFILE_MODE[s.profile] : "plan";
      act("session-mode", s.permissionMode === "plan" ? "Plan-Modus beenden" : "Plan-Modus einschalten", icon(ListChecks), () => {
        void updateSession(qc, s, { permissionMode: mode }, () => call("sessions.setPermissionMode", { sessionId: s.id, mode }), "Modus nicht gewechselt");
      }, { keywords: "modus planen permission", hint: `danach: ${MODE_LABEL[mode]}` });
    }

    const owner = root?.id ?? project.id;
    const db = ctx.testDb;
    if (db) {
      const running = db.status === "running";
      const method = running ? "testdb.stop" : "testdb.start";
      act(running ? "testdb-stop" : "testdb-start", running ? "Test-Datenbank stoppen" : "Test-Datenbank starten", icon(Database), () => {
        call(method, { projectId: owner })
          .then((st) => qc.setQueryData(keys.testDb(owner), st))
          .catch((e: unknown) => toast.error(running ? "Test-Datenbank nicht gestoppt" : "Test-Datenbank nicht gestartet", errorMessage(e)));
      }, { keywords: "postgres postgresql db" });
    }

    for (const id of DEV_TOOLS_SECTIONS) {
      const def = byId(DEV_TOOLS_SECTION_DEFS, id);
      act(`devtools-${id}`, `Dev-Tools: ${def.label}`, icon(def.Icon), () => ui.openDevTools(id), { hint: def.hint });
    }

    const git = project.git;
    if (git?.isRepo) {
      act("git-commit", "Commit erstellen", icon(GitCommitHorizontal), () => ui.setWorkspaceTab("git"), { keywords: "git änderungen stage", hint: git.changedCount ? `${git.changedCount} geändert` : undefined });
      if (git.remoteUrl) {
        act("git-fetch", "Git: Abrufen (fetch)", icon(CloudDownload), () => void gitSync(qc, project.id, "Abrufen", () => call("git.fetch", { projectId: project.id }), "Remote abgerufen"));
        act("git-pull", "Git: Pull", icon(ArrowDown), () => void gitSync(qc, project.id, "Pull", () => call("git.pull", { projectId: project.id }), "Aktualisiert"), {
          hint: git.behind ? `${git.behind} neu auf dem Remote` : undefined,
        });
        // Choosing push is the consent, also for main, like the button in the Git tab.
        act("git-push", "Git: Push", icon(ArrowUp), () => void gitSync(qc, project.id, "Push", () => call("git.push", { projectId: project.id, allowProtected: true }), "Gepusht"), {
          hint: git.ahead ? `${git.ahead} Commits` : undefined,
        });
      }
      act("git-new-branch", "Neuen Branch anlegen", icon(GitBranchPlus), () => ctx.openDialog({ kind: "new-branch", projectId: project.id }), { keywords: "git checkout" });
      const onMain = git.branch === "main" || git.branch === "master";
      if (git.remoteUrl?.includes("github.com") && ctx.githubConnected && !onMain) {
        act("git-pr", "Pull Request erstellen", icon(GitPullRequest), () => ctx.openDialog({ kind: "create-pr", project }), { keywords: "github pr", hint: git.branch ?? undefined });
      }
    }

    if (root?.exists && root.git) {
      const r = root;
      act("agent-new", "Parallelen Agenten starten", icon(Bot), () => ctx.openDialog({ kind: "new-agent", root: r }), { keywords: "worktree branch agent" });
    }

    act("knowledge-merge", "Projektwissen: Einträge zusammenführen", icon(Combine), () => ui.openKnowledge(KNOWLEDGE_MERGE_REQUEST), {
      keywords: "wissen aufräumen überschneidungen doppelt merge automatisch claude",
    });

    if (project.exists) {
      act("explorer-project", "Projektordner im Explorer öffnen", icon(FolderOpen), () => void revealInProject(project.path, ""), { keywords: "explorer ordner dateien windows" });
      const file = ui.selectedFile[project.id];
      if (file) act("explorer-file", "Datei im Explorer zeigen", icon(FolderOpen), () => void revealInProject(project.path, file), { keywords: "explorer ordner windows", hint: file });
    }
    act("terminal", "Terminal öffnen", icon(SquareTerminal), () => ui.openTerminal(project.id, "shell"), { keywords: "shell konsole" });
    act("bottom", "Unteres Panel ein- oder ausblenden", icon(PanelBottom), () => ui.toggleBottomPanel(), { hint: "Strg+J" });
    act("right", "Seitenleiste ein- oder ausblenden", icon(PanelRight), () => ui.toggleRightPanel(), { hint: "Strg+Umschalt+E" });
    if (ui.splitRoom > 0) {
      act("split-add", "Ansicht teilen: weiteren Bereich öffnen", icon(Columns2), () => ui.addSplitPane(), {
        keywords: "geteilte ansicht split mehrere sessions projekte nebeneinander raster bereich chat daneben",
      });
    }
    if (ui.splitPanes.length) {
      act("split-close", "Geteilte Ansicht schließen", icon(Columns2), () => ui.closeSplitPanes(), {
        hint: ui.splitPanes.length === 1 ? "1 weiterer Bereich" : `${ui.splitPanes.length} weitere Bereiche`,
        keywords: "split mehrere sessions projekte bereiche schließen einzeln",
      });
    } else if (ui.splitStash) {
      const n = ui.splitStash.panes.length + 1;
      act("split-restore", "Geteilte Ansicht wieder öffnen", icon(Columns2), () => ui.restoreSplit(), {
        hint: `${n} Bereiche`,
        keywords: "split mehrere sessions projekte bereiche zurück wiederherstellen raster",
      });
    }
    for (const p of PROFILE_IDS) {
      if (p === project.profile || (p === "autonomous" && project.tags.includes("sandbox-only"))) continue;
      act(`profile-${p}`, `Profil wechseln: ${PROFILE_INFO[p].label}`, icon(Shield), () => {
        void updateProject(qc, project.id, { profile: p }, `Profil ${PROFILE_INFO[p].label}`, "Gilt sofort, auch für laufende Sessions.");
      }, { keywords: "rechte permission" });
    }

    for (const id of PROJECT_SETTINGS_SECTIONS) {
      const def = byId(PROJECT_SECTION_DEFS, id);
      setting(`project-settings-${id}`, `Projekt-Einstellungen: ${def.label}`, icon(def.Icon), () => ui.openProjectSettings(id), { hint: def.hint, keywords: project.name });
    }
    if (!project.parentId) {
      const on = project.gitEnabled;
      setting("project-git", on ? "Git für dieses Projekt ausschalten" : "Git für dieses Projekt einschalten", icon(on ? ToggleRight : ToggleLeft), () => {
        void updateProject(qc, project.id, { gitEnabled: !on }, on ? "Git ausgeschaltet" : "Git eingeschaltet", on ? "Agenten und Git-Bereiche sind ausgeblendet. Claude verwendet kein Git." : project.name);
      }, { keywords: "versionsverwaltung ohne git agenten repository", hint: project.name });
    }
    for (const t of TAG_INFO) {
      if ((t.rootOnly && project.parentId) || (t.git && !project.gitEnabled)) continue;
      const on = project.tags.includes(t.tag);
      setting(`tag-${t.tag}`, `${t.label}: ${on ? "ausschalten" : "einschalten"}`, icon(on ? ToggleRight : ToggleLeft), () => {
        void updateProject(qc, project.id, { tags: on ? project.tags.filter((x) => x !== t.tag) : [...project.tags, t.tag] }, `${t.label} ${on ? "ausgeschaltet" : "eingeschaltet"}`, project.name);
      }, { hint: t.tag, keywords: `automatik tag projekt ${t.info}` });
    }
  }

  act("add-project", "Projekt hinzufügen", icon(FolderPlus), () => ui.setNewProject("import"), { hint: "Strg+O", keywords: "importieren ordner" });
  act("create-project", "Neues Projekt anlegen", icon(FolderPlus), () => ui.setNewProject("create"));
  act("clone-project", "Projekt von GitHub klonen", icon(FolderDown), () => ui.setNewProject("clone"), { keywords: "clone repository" });

  const remoteOn = ctx.remote?.enabled ?? false;
  act("remote", remoteOn ? "Remote Control ausschalten" : "Remote Control einschalten", icon(MonitorSmartphone), () => {
    call(remoteOn ? "remote.stop" : "remote.start", {})
      .then((st) => qc.setQueryData(keys.remote, st))
      .catch((e: unknown) => toast.error("Remote-Steuerung", errorMessage(e)));
  }, { keywords: "claude app handy weiterarbeiten" });

  if (ctx.phone) {
    const phoneOn = ctx.phone.enabled;
    act("phone", phoneOn ? "Telefon ausschalten" : "Telefon einschalten", icon(phoneOn ? PhoneOff : Phone), () => void setPhone(qc, !phoneOn), { keywords: "anruf sprache" });
    if (ctx.phone.registration === "registered") {
      act("phone-test", "Testanruf", icon(PhoneOutgoing), () => {
        call("phone.testCall", {})
          .then((st) => qc.setQueryData(keys.phoneState, st))
          .catch((e: unknown) => toast.error("Testanruf fehlgeschlagen", errorMessage(e)));
      }, { keywords: "telefon anrufen" });
    }
  }

  act("backup", "Backup anlegen", icon(Archive), () => void createBackup(qc), { keywords: "sichern sicherung" });
  if (settings?.syncEnabled) act("sync-now", "Jetzt über GitHub abgleichen", icon(RefreshCcw), () => void syncNow(qc), { keywords: "sync synchronisieren andere pc" });
  act("setup-wizard", "Einrichtungsassistent öffnen", icon(Wand2), () => ui.setSetupWizard(true), { keywords: "einrichten erster start setup onboarding" });
  act("claude-login", "Bei Claude anmelden", icon(LogIn), () => ui.openClaudeLogin("manual"), { keywords: "login anmeldung abgelaufen konto abo neu anmelden oauth" });
  act("claude-switch", "Claude-Konto wechseln", icon(ArrowLeftRight), () => ui.openClaudeLogin("switch"), { keywords: "account konto wechseln anderes login" });
  act("claude-logout", "Von Claude abmelden", icon(LogOut), () => ui.setClaudeLogout(true), { keywords: "logout abmelden konto account" });
  act("update-check", "Nach Updates suchen", icon(RefreshCw), () => void checkForUpdate(qc), { keywords: "version release aktualisieren" });
  const update = qc.getQueryData<AppUpdateState>(keys.appUpdate);
  if (update?.latest && update.installable && ["available", "downloading", "ready"].includes(update.phase)) {
    act("update-install", `FORGE ${update.latest.version} installieren`, icon(ArrowUpCircle), () => void installUpdate(qc), { keywords: "update aktualisieren neustart version" });
  }
  for (const n of NAV) act(`nav-${n.view}`, `Gehe zu ${n.label}`, icon(n.Icon), () => ui.setView(n.view));

  for (const id of EXTENSIONS_TABS) {
    const def = EXTENSION_TAB_DEFS.find((d) => d.value === id)!;
    add("Erweiterungen", `ext-${id}`, `Erweiterungen: ${def.label}`, icon(def.Icon), () => ui.openExtensions(id), { keywords: "plugins" });
  }
  for (const id of SKILLS_TABS) {
    const def = SKILLS_TAB_DEFS.find((d) => d.value === id)!;
    add("Erweiterungen", `skills-${id}`, `Skills: ${def.label}`, icon(def.Icon), () => ui.openExtensions("skills", id), { keywords: "erweiterungen plugins" });
  }

  for (const id of SETTINGS_SECTIONS) {
    const def = byId(SETTINGS_SECTION_DEFS, id);
    setting(`settings-${id}`, `Einstellungen: ${def.label}`, icon(def.Icon), () => ui.openSettings(id), { hint: def.hint });
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
        : () => void saveSetting(qc, key === "syncEnabled" ? { syncEnabled: !on, syncAsked: true } : { [key]: !on }, `${def.label} ${on ? "ausgeschaltet" : "eingeschaltet"}`);
    const ic = key === "alwaysOnTop" ? icon(on ? PinOff : Pin) : icon(on ? ToggleRight : ToggleLeft);
    setting(`setting-${key}`, `${def.label}: ${on ? "ausschalten" : "einschalten"}`, ic, run, { hint: section, keywords: `schalter einstellung ${def.keywords ?? ""}` });
  }
  if (settings) {
    for (const m of IDLE_CLOSE_CHOICES) {
      if (m === settings.idleCloseMinutes) continue;
      const label = m > 0 ? `Untätige Sessions schließen nach ${idleCloseLabel(m)}` : "Untätige Sessions nicht mehr schließen";
      setting(`idle-close-${m}`, label, icon(Timer), () => void saveSetting(qc, { idleCloseMinutes: m }, label), {
        hint: `jetzt ${idleCloseLabel(settings.idleCloseMinutes)}`,
        keywords: "claude-prozess beenden inaktiv leerlauf timeout automatisch schließen",
      });
    }
  }
  for (const group of RULE_GROUPS) {
    for (const rule of group.rules) {
      const blocked = !settings?.disabledPolicyRules.includes(rule.id);
      setting(`policy-${rule.id}`, `Sperrliste: ${rule.label}`, icon(ShieldBan), () => ui.openSettings("policy"), {
        hint: settings ? (blocked ? "gesperrt" : "erlaubt") : undefined,
        keywords: `regel blockieren policy ${group.title} ${rule.info}`,
      });
    }
  }
  return list;
}
