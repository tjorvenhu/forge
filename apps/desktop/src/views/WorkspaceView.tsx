import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { Activity, Bot, FolderTree, GitCompare, GitMerge, AlertTriangle, BookOpen, ChevronDown, FileText, FlaskConical, GitBranch, MessageSquare, Settings2, SquareTerminal, Star, Tag, Wrench } from "lucide-react";
import type { ProfileId } from "@forge/protocol";
import { call, keys, useProject } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, shortPath } from "@/lib/utils";
import { useUi, workspaceTabsFor, type WorkspaceTab } from "@/stores/ui";
import { useAgentReview } from "@/stores/agent-review";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { TabBar, type TabDef } from "@/components/ui/tabs";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { PROFILE_IDS, PROFILE_INFO, ProfileBadge } from "@/components/projects/ProfileBadge";
import { ChatPanelSkeleton } from "@/components/workspace/ChatPanel";
import { SplitChat } from "@/components/workspace/SplitView";
import { GitPanel } from "@/components/git/GitPanel";
import { GitCenter } from "@/components/git/GitCenter";
import { FilesTab } from "@/components/workspace/FilesTab";
import { ProjectSettingsTab, tagLabel } from "@/components/workspace/ProjectSettingsTab";
import { AgentsTab } from "@/components/workspace/AgentsTab";
import { ActivityFeed } from "@/components/workspace/ActivityFeed";
import { FileTree } from "@/components/workspace/FileTree";
import { WorkingCard } from "@/components/workspace/WorkingCard";
import { BottomPanel } from "@/components/workspace/BottomPanel";
import { RemoteControlButton } from "@/components/workspace/RemoteControl";
import { DevToolsTab } from "@/components/devtools/DevToolsTab";
import { KnowledgeTab } from "@/components/knowledge/KnowledgeTab";
import { PhoneButton } from "@/components/layout/PhoneButton";
import { AlwaysOnTopButton } from "@/components/layout/AlwaysOnTopButton";
import { HeaderDivider } from "@/components/layout/Page";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Collapse } from "@/components/ui/collapse";
import { DevToolsBadge } from "@/components/devtools/DevToolsBadge";

export function WorkspaceView() {
  const projectId = useUi((s) => s.activeProjectId);
  const project = useProject(projectId);
  const qc = useQueryClient();

  const missing = project.error instanceof RpcCallError && project.error.code === "NOT_FOUND";
  useEffect(() => {
    // The remembered project was removed meanwhile: fall back to Home.
    if (missing) useUi.getState().closeProject();
  }, [missing]);

  useEffect(() => {
    if (!projectId) return;
    call("projects.touch", { projectId })
      .then(() => qc.invalidateQueries({ queryKey: keys.projects }))
      .catch(() => {});
  }, [projectId, qc]);

  if (!projectId) return <EmptyState title="Kein Projekt geöffnet">Wähle links ein Projekt oder füge eines hinzu.</EmptyState>;
  if (project.isLoading) return <WorkspaceSkeleton />;
  if (project.isError || !project.data)
    return (
      <div className="p-6">
        <ErrorBanner>{errorMessage(project.error)}</ErrorBanner>
      </div>
    );
  return <Workspace projectId={projectId} />;
}

function Workspace({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const { setWorkspaceTab, toolbarOpen, rightPanelOpen } = useUi(
    useShallow((s) => ({
      toolbarOpen: s.toolbarOpen,
      setWorkspaceTab: s.setWorkspaceTab,
      rightPanelOpen: s.rightPanelOpen,
    })),
  );
  const visibleTabs = workspaceTabsFor(project);
  const workspaceTab = useWorkspaceTab(project);
  const narrow = useNarrow();
  const showRight = rightPanelOpen && !narrow && workspaceTab === "chat";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader projectId={projectId} />

      {!project.exists && (
        <div className="px-4 pt-3">
          <ErrorBanner title="Projektordner fehlt">
            {project.path} existiert nicht mehr. Sessions und Git sind deaktiviert. Entferne das Projekt unter Einstellungen oder stelle den Ordner wieder her.
          </ErrorBanner>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Collapse open={toolbarOpen}>
            <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-4">
              <TabBar<WorkspaceTab>
                size="lg"
                fit
                value={workspaceTab}
                onChange={setWorkspaceTab}
                tabs={(
                  [
                    { value: "chat", label: "Chat", icon: <MessageSquare className="h-4 w-4" /> },
                    { value: "agents", label: "Agenten", icon: <Bot className="h-4 w-4" /> },
                    { value: "git", label: "Git", icon: <GitBranch className="h-4 w-4" />, badge: project.git?.changedCount ? <Badge tone="warning">{project.git.changedCount}</Badge> : undefined },
                    { value: "files", label: "Dateien", icon: <FileText className="h-4 w-4" /> },
                    { value: "devtools", label: "Dev-Tools", icon: <FlaskConical className="h-4 w-4" />, badge: <DevToolsBadge project={project} /> },
                    { value: "knowledge", label: "Wissen", icon: <BookOpen className="h-4 w-4" /> },
                    { value: "settings", label: "Einstellungen", icon: <Settings2 className="h-4 w-4" /> },
                  ] satisfies TabDef<WorkspaceTab>[]
                ).filter((t) => visibleTabs.includes(t.value))}
              />
            </div>
          </Collapse>
          <div key={workspaceTab} className="min-h-0 flex-1 animate-view-in">
            {workspaceTab === "chat" &&
              (project.exists ? <SplitChat project={project} workingInPanel={showRight} /> : <EmptyState title="Chat nicht verfügbar">Der Projektordner fehlt.</EmptyState>)}
            {workspaceTab === "agents" && <AgentsTab project={project} />}
            {workspaceTab === "git" && <GitCenter project={project} />}
            {workspaceTab === "files" && <FilesTab project={project} />}
            {workspaceTab === "devtools" &&
              (project.exists ? <DevToolsTab project={project} /> : <EmptyState title="Dev-Tools nicht verfügbar">Der Projektordner fehlt.</EmptyState>)}
            {workspaceTab === "knowledge" &&
              (project.exists ? <KnowledgeTab project={project} /> : <EmptyState title="Wissen nicht verfügbar">Der Projektordner fehlt.</EmptyState>)}
            {workspaceTab === "settings" && <ProjectSettingsTab project={project} />}
          </div>
          <BottomPanel project={project} />
        </div>
        {showRight && <RightPanel projectId={projectId} />}
      </div>
    </div>
  );
}

/** Header, tab row, content and side panel at the heights of Workspace, so nothing moves when the project arrives. */
function WorkspaceSkeleton() {
  const { workspaceTab, toolbarOpen, rightPanelOpen } = useUi(useShallow((s) => ({ workspaceTab: s.workspaceTab, toolbarOpen: s.toolbarOpen, rightPanelOpen: s.rightPanelOpen })));
  const narrow = useNarrow();
  const showRight = rightPanelOpen && !narrow && workspaceTab === "chat";
  const tab = (w: number) => (
    <div key={w} className="flex h-12 items-center gap-2 px-3.5">
      <Skeleton className="h-4 w-4 rounded-sm" />
      <Skeleton className="h-3" style={{ width: w }} />
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
        <Skeleton className="h-6.5 w-6.5 rounded-lg" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-7" />
        <div className="flex-1" />
        <div className="flex items-center gap-0.5">
          <Skeleton className="h-7 w-7" />
          <Skeleton className="h-7 w-7" />
          <Skeleton className="h-7 w-7" />
        </div>
        <Skeleton className="h-7 w-7" />
        <Skeleton className="h-6 w-24" />
        <HeaderDivider />
        <Skeleton className="h-7 w-7" />
        <Skeleton className="h-7 w-7" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {toolbarOpen && <div className="flex h-12 shrink-0 items-center gap-1 overflow-hidden border-b border-border px-4">{[32, 56, 24, 48, 56, 44, 84].map(tab)}</div>}
          <div className="min-h-0 flex-1">{workspaceTab === "chat" ? <ChatPanelSkeleton /> : <ListSkeleton rows={8} className="p-5" />}</div>
        </div>
        {showRight && (
          <div className="flex w-100 shrink-0 flex-col border-l border-border bg-sidebar xl:w-110">
            <div className="flex h-12 shrink-0 items-center border-b border-border px-3">{[52, 76, 60].map(tab)}</div>
            <ListSkeleton rows={8} className="px-4" />
          </div>
        )}
      </div>
    </div>
  );
}

type RightTab = "files" | "git" | "activity";

function RightPanel({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const [chosen, setTab] = useState<RightTab>("files");
  const tab = chosen === "git" && !project.gitEnabled ? "files" : chosen;
  return (
    <aside className="flex w-100 shrink-0 animate-panel-in flex-col border-l border-border bg-sidebar xl:w-110">
      <div className="flex h-12 shrink-0 items-center border-b border-border px-3">
        <TabBar<RightTab>
          size="lg"
          fit
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "files", label: "Dateien", icon: <FolderTree className="h-4 w-4" /> },
            ...(project.gitEnabled
              ? [{ value: "git" as const, label: "Änderungen", icon: <GitCompare className="h-4 w-4" />, badge: project.git?.changedCount ? <Badge tone="warning">{project.git.changedCount}</Badge> : undefined }]
              : []),
            { value: "activity", label: "Aktivität", icon: <Activity className="h-4 w-4" /> },
          ]}
        />
      </div>
      <div key={tab} className="min-h-0 flex-1 animate-view-in">
        {tab === "files" ? <FileTree project={project} /> : tab === "git" ? <GitPanel project={project} compact /> : <ActivityFeed projectId={projectId} projectDir={project.path} />}
      </div>
      <WorkingCard project={project} />
    </aside>
  );
}

/** The tab is stored for the whole app, not per project: a project without git shows the chat instead of Agenten or Git. */
function useWorkspaceTab(project: { gitEnabled: boolean }): WorkspaceTab {
  const stored = useUi((s) => s.workspaceTab);
  return workspaceTabsFor(project).includes(stored) ? stored : "chat";
}

/** Below this window width the right sidebar does not fit next to the chat. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

/**
 * The three layout switches side by side: tab row (Chat, Agenten, Git ...) like a ribbon, by default
 * the chat fills the view; bottom panel; right sidebar.
 */
function LayoutToggles({ project }: { project: { gitEnabled: boolean } }) {
  const workspaceTab = useWorkspaceTab(project);
  const { toolbarOpen, toggleToolbar, rightPanelOpen, toggleRightPanel, bottomPanelOpen, toggleBottomPanel } = useUi(
    useShallow((s) => ({
      toolbarOpen: s.toolbarOpen,
      toggleToolbar: s.toggleToolbar,
      rightPanelOpen: s.rightPanelOpen,
      toggleRightPanel: s.toggleRightPanel,
      bottomPanelOpen: s.bottomPanelOpen,
      toggleBottomPanel: s.toggleBottomPanel,
    })),
  );
  const narrow = useNarrow();
  const showRight = rightPanelOpen && !narrow && workspaceTab === "chat";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => toggleToolbar()}
        aria-pressed={toolbarOpen}
        aria-label="Werkzeugleiste"
        title={`Werkzeugleiste ${toolbarOpen ? "ausblenden" : "einblenden"}\nReiter oben im Projekt:\n- ${project.gitEnabled ? "Chat, Agenten, Git, Dateien" : "Chat, Dateien"}\n- Dev-Tools, Wissen, Einstellungen${toolbarOpen ? "\n\nAusblenden führt zurück zum Chat." : ""}`}
        className={cn(toolbarOpen && "text-accent")}
      >
        <Wrench className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => toggleBottomPanel()}
        aria-pressed={bottomPanelOpen}
        aria-label="Untere Leiste"
        title={`Untere Leiste ${bottomPanelOpen ? "ausblenden" : "einblenden"} (Strg+J)\n- Terminal\n- Dev-Server\n- Claude-Ausgabe`}
        className={cn(bottomPanelOpen && "text-accent")}
      >
        <SquareTerminal className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => toggleRightPanel()}
        aria-pressed={showRight}
        aria-label="Rechte Seitenleiste"
        disabled={narrow || workspaceTab !== "chat"}
        title={
          narrow
            ? "Seitenleiste\nDas Fenster ist zu schmal dafür."
            : workspaceTab !== "chat"
              ? "Seitenleiste\nGibt es nur im Chat."
              : `Seitenleiste ${showRight ? "ausblenden" : "einblenden"} (Strg+Umschalt+E)\n- Dateien${project.gitEnabled ? "\n- Änderungen" : ""}\n- Aktivität`
        }
        className={cn(showRight && "text-accent")}
      >
        <FolderTree className="h-4 w-4" />
      </Button>
    </div>
  );
}

function WorkspaceHeader({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const qc = useQueryClient();
  const openProjectSettings = useUi((s) => s.openProjectSettings);

  const sandboxOnly = project.tags.includes("sandbox-only");

  /** Shows a project change at once; the refetch afterwards brings the stored state, also after an error. */
  const optimistic = (patch: Partial<typeof project>) => qc.setQueryData(keys.project(projectId), (p: typeof project | undefined) => (p ? { ...p, ...patch } : p));

  const setProfile = async (profile: ProfileId) => {
    optimistic({ profile });
    try {
      await call("projects.update", { projectId, profile });
      await qc.invalidateQueries({ queryKey: keys.project(projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Profil ${PROFILE_INFO[profile].label}`, "Gilt sofort, auch für laufende Sessions.");
    } catch (e) {
      void qc.invalidateQueries({ queryKey: keys.project(projectId) });
      toast.error("Profil nicht geändert", errorMessage(e));
    }
  };

  const toggleFavorite = async () => {
    const favorite = !project.favorite;
    optimistic({ favorite });
    try {
      await call("projects.update", { projectId, favorite });
      await qc.invalidateQueries({ queryKey: keys.project(projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
    } catch (e) {
      void qc.invalidateQueries({ queryKey: keys.project(projectId) });
      toast.error("Nicht gespeichert", errorMessage(e));
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
      <ProjectIcon id={project.parentId ?? project.id} name={project.name} size={26} />
      {/* Only the name gives way in a narrow window; the star sits outside it, so it cannot slide over the tags. */}
      <h1 className="-mr-1.5 min-w-0 truncate text-title-sm font-semibold" title={`${project.name}\n${shortPath(project.path, 4)}`}>
        {project.name}
      </h1>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => void toggleFavorite()}
        className="hover:text-warning"
        aria-label={project.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten"}
        title={project.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}
      >
        <Star className={cn("h-4 w-4", project.favorite && "fill-warning text-warning")} />
      </Button>

      {project.tags.length > 0 && (
        <button
          type="button"
          onClick={() => openProjectSettings("automation")}
          title={`Aktive Tags\n${project.tags.map((t) => `- ${tagLabel(t)}`).join("\n")}\n\nKlicken, um sie unter Automatik einzustellen.`}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-lg text-muted transition-colors duration-120 hover:bg-surface-3 hover:text-fg"
        >
          <Tag className="h-3.5 w-3.5" />
          {project.tags.length === 1 ? "1 Tag" : `${project.tags.length} Tags`}
        </button>
      )}

      <div className="flex-1" />

      {project.parentId && (
        <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => useAgentReview.getState().request(projectId)} title="Arbeit dieses Agenten zusammenführen oder verwerfen">
          <GitMerge className="h-4 w-4" />
          <span className="hidden xl:inline">Agent abschließen</span>
        </Button>
      )}
      <LayoutToggles project={project} />
      <RemoteControlButton project={project} />

      <DropdownMenu
        header="Berechtigungsprofil"
        trigger={
          <button
            className="flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 hover:bg-surface-3"
            aria-label={`Berechtigungsprofil: ${PROFILE_INFO[project.profile].label}. Klicken zum Ändern`}
            title="Berechtigungsprofil ändern"
          >
            <ProfileBadge profile={project.profile} />
            <ChevronDown className="h-3.5 w-3.5 text-muted" />
          </button>
        }
        items={PROFILE_IDS.map((p) => ({
          label: `${PROFILE_INFO[p].label}${p === project.profile ? " (aktiv)" : ""}`,
          disabled: p === "autonomous" && sandboxOnly,
          hint: p === "autonomous" && sandboxOnly ? "sandbox-only" : undefined,
          icon: p === "autonomous" ? <AlertTriangle className="h-3.5 w-3.5 text-danger" /> : undefined,
          onSelect: () => void setProfile(p),
        }))}
      />
      {/* App-wide switches, apart from the project's own controls. */}
      <HeaderDivider />
      <AlwaysOnTopButton />
      <PhoneButton />
    </header>
  );
}
