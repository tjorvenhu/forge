import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { Activity, Bot, FolderTree, GitCompare, BookOpen, FileText, FlaskConical, GitBranch, MessageSquare, Settings2 } from "lucide-react";
import { call, keys, useProject } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { useUi, workspaceTabsFor, type WorkspaceTab } from "@/stores/ui";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { TabBar, type TabDef } from "@/components/ui/tabs";
import { ChatPanel, ChatPanelSkeleton } from "@/components/workspace/ChatPanel";
import { SplitWorkspace } from "@/components/workspace/SplitView";
import { useNarrow, useWorkspaceTab, WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { GitPanel } from "@/components/git/GitPanel";
import { GitCenter } from "@/components/git/GitCenter";
import { FilesTab } from "@/components/workspace/FilesTab";
import { ProjectSettingsTab } from "@/components/workspace/ProjectSettingsTab";
import { AgentsTab } from "@/components/workspace/AgentsTab";
import { ActivityFeed } from "@/components/workspace/ActivityFeed";
import { FileTree } from "@/components/workspace/FileTree";
import { WorkingCard } from "@/components/workspace/WorkingCard";
import { BottomPanel } from "@/components/workspace/BottomPanel";
import { DevToolsTab } from "@/components/devtools/DevToolsTab";
import { KnowledgeTab } from "@/components/knowledge/KnowledgeTab";
import { HeaderDivider } from "@/components/layout/Page";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Collapse } from "@/components/ui/collapse";
import { DevToolsBadge } from "@/components/devtools/DevToolsBadge";

export function WorkspaceView() {
  const projectId = useUi((s) => s.activeProjectId);
  if (!projectId) return <EmptyState title="Kein Projekt geöffnet">Wähle links ein Projekt oder füge eines hinzu.</EmptyState>;
  return (
    <SplitWorkspace projectId={projectId}>
      <MainArea projectId={projectId} />
    </SplitWorkspace>
  );
}

/** The open project with its tabs and panels: the main area of the split view. */
function MainArea({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const qc = useQueryClient();

  const missing = project.error instanceof RpcCallError && project.error.code === "NOT_FOUND";
  useEffect(() => {
    // The remembered project was removed meanwhile: fall back to Home.
    if (missing) useUi.getState().closeProject();
  }, [missing]);

  useEffect(() => {
    call("projects.touch", { projectId })
      .then(() => qc.invalidateQueries({ queryKey: keys.projects }))
      .catch(() => {});
  }, [projectId, qc]);

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
