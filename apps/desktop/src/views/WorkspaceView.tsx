import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { Activity, Bot, FolderTree, GitCompare, AlertTriangle, BookOpen, ChevronDown, FileText, FlaskConical, PanelTop, GitBranch, MessageSquare, PanelBottom, PanelRight, Settings2, Star } from "lucide-react";
import type { ProfileId } from "@forge/protocol";
import { call, keys, useProject } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, shortPath } from "@/lib/utils";
import { useUi, type WorkspaceTab } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { TabBar } from "@/components/ui/tabs";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { PROFILE_IDS, PROFILE_INFO, ProfileBadge } from "@/components/projects/ProfileBadge";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { GitPanel } from "@/components/git/GitPanel";
import { GitCenter } from "@/components/git/GitCenter";
import { FilesTab } from "@/components/workspace/FilesTab";
import { ProjectSettingsTab } from "@/components/workspace/ProjectSettingsTab";
import { AgentsTab } from "@/components/workspace/AgentsTab";
import { ActivityFeed } from "@/components/workspace/ActivityFeed";
import { FileTree } from "@/components/workspace/FileTree";
import { WorkingCard } from "@/components/workspace/WorkingCard";
import { BottomPanel } from "@/components/workspace/BottomPanel";
import { RemoteControlButton } from "@/components/workspace/RemoteControl";
import { DevToolsTab } from "@/components/devtools/DevToolsTab";
import { KnowledgeTab } from "@/components/knowledge/KnowledgeTab";
import { PhoneButton } from "@/components/layout/PhoneButton";
import { HeaderDivider } from "@/components/layout/Page";
import { SearchField } from "@/components/layout/SearchField";
import { ChatSkeleton } from "@/components/ui/skeleton";
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
  if (project.isLoading) return <ChatSkeleton />;
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
  const { workspaceTab, setWorkspaceTab, toolbarOpen, rightPanelOpen, toggleRightPanel, bottomPanelOpen, toggleBottomPanel } = useUi(
    useShallow((s) => ({
      workspaceTab: s.workspaceTab,
      toolbarOpen: s.toolbarOpen,
      setWorkspaceTab: s.setWorkspaceTab,
      rightPanelOpen: s.rightPanelOpen,
      toggleRightPanel: s.toggleRightPanel,
      bottomPanelOpen: s.bottomPanelOpen,
      toggleBottomPanel: s.toggleBottomPanel,
    })),
  );
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
                tabs={[
                  { value: "chat", label: "Chat", icon: <MessageSquare className="h-4 w-4" /> },
                  { value: "agents", label: "Agenten", icon: <Bot className="h-4 w-4" /> },
                  { value: "git", label: "Git", icon: <GitBranch className="h-4 w-4" />, badge: project.git?.changedCount ? <Badge tone="warning">{project.git.changedCount}</Badge> : undefined },
                  { value: "files", label: "Dateien", icon: <FileText className="h-4 w-4" /> },
                  { value: "devtools", label: "Dev-Tools", icon: <FlaskConical className="h-4 w-4" />, badge: <DevToolsBadge project={project} /> },
                  { value: "knowledge", label: "Wissen", icon: <BookOpen className="h-4 w-4" /> },
                  { value: "settings", label: "Einstellungen", icon: <Settings2 className="h-4 w-4" /> },
                ]}
              />
              <Button size="icon-sm" variant="ghost" onClick={() => toggleBottomPanel()} aria-pressed={bottomPanelOpen} title="Terminal, Dev-Server und Claude-Ausgabe (Strg+J)" className={cn(bottomPanelOpen && "text-accent")}>
                <PanelBottom className="h-4 w-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => toggleRightPanel()}
                aria-pressed={showRight}
                disabled={narrow || workspaceTab !== "chat"}
                title={narrow ? "Fenster zu schmal für die Seitenleiste" : "Seitenleiste mit Dateien und Änderungen (Strg+Umschalt+E)"}
                className={cn(showRight && "text-accent")}
              >
                <PanelRight className="h-4 w-4" />
              </Button>
            </div>
          </Collapse>
          <div key={workspaceTab} className="min-h-0 flex-1 animate-view-in">
            {workspaceTab === "chat" &&
              (project.exists ? <ChatPanel project={project} workingInPanel={showRight} /> : <EmptyState title="Chat nicht verfügbar">Der Projektordner fehlt.</EmptyState>)}
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

type RightTab = "files" | "git" | "activity";

function RightPanel({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const [tab, setTab] = useState<RightTab>("files");
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
            { value: "git", label: "Änderungen", icon: <GitCompare className="h-4 w-4" />, badge: project.git?.changedCount ? <Badge tone="warning">{project.git.changedCount}</Badge> : undefined },
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

/** Shows or hides the tab row (Chat, Agenten, Git ...), like a ribbon: by default the chat fills the view. */
function ToolbarToggle() {
  const open = useUi((s) => s.toolbarOpen);
  const toggle = useUi((s) => s.toggleToolbar);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => toggle()}
      aria-pressed={open}
      title={open ? "Werkzeugleiste ausblenden (zurück zum Chat)" : "Werkzeugleiste einblenden: Agenten, Git, Dateien, Dev-Tools, Wissen, Einstellungen"}
      className={cn("shrink-0 gap-1.5", open && "text-accent")}
    >
      <PanelTop className="h-4 w-4" />
      <span className="hidden xl:inline">Werkzeuge</span>
    </Button>
  );
}

function WorkspaceHeader({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const qc = useQueryClient();

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
      <ProjectIcon name={project.name} size={26} />
      <div className="flex min-w-0 items-center gap-1.5" title={shortPath(project.path, 4)}>
        <h1 className="truncate text-title-sm font-semibold">{project.name}</h1>
        <Button size="icon-sm" variant="ghost" onClick={() => void toggleFavorite()} className="hover:text-warning" aria-label={project.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten"}>
          <Star className={cn("h-4 w-4", project.favorite && "fill-warning text-warning")} />
        </Button>
      </div>

      {project.tags.length > 0 && (
        <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden xl:flex" title={project.tags.join(", ")}>
          {project.tags.slice(0, 4).map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
          {project.tags.length > 4 && <span className="text-caption text-subtle">+{project.tags.length - 4}</span>}
        </div>
      )}

      <div className="flex-1" />

      <ToolbarToggle />
      <SearchField />
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
      <HeaderDivider />
      <PhoneButton />
    </header>
  );
}
