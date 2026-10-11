import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { Activity, FolderTree, GitCompare, AlertTriangle, ChevronDown, FileText, GitBranch, MessageSquare, PanelBottom, PanelRight, Plus, Settings2, Star } from "lucide-react";
import type { ProfileId } from "@forge/protocol";
import { call, keys, useProject } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, shortPath } from "@/lib/utils";
import { useUi, type WorkspaceTab } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, EmptyState, ErrorBanner, Loading } from "@/components/ui/misc";
import { TabBar } from "@/components/ui/tabs";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { PROFILE_IDS, PROFILE_INFO, ProfileBadge } from "@/components/projects/ProfileBadge";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { GitPanel } from "@/components/git/GitPanel";
import { GitCenter, NewBranchDialog, checkoutBranch } from "@/components/git/GitCenter";
import { FilesTab } from "@/components/workspace/FilesTab";
import { ProjectSettingsTab } from "@/components/workspace/ProjectSettingsTab";
import { ActivityFeed } from "@/components/workspace/ActivityFeed";
import { FileTree } from "@/components/workspace/FileTree";
import { WorkingCard } from "@/components/workspace/WorkingCard";
import { BottomPanel } from "@/components/workspace/BottomPanel";
import { RemoteControlButton } from "@/components/workspace/RemoteControl";
import { DevServerButton } from "@/components/workspace/DevServer";
import { PhoneButton } from "@/components/layout/PhoneButton";
import { HeaderDivider } from "@/components/layout/Page";
import { SearchField } from "@/components/layout/SearchField";

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
  if (project.isLoading) return <Loading className="py-12" />;
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
  const { workspaceTab, setWorkspaceTab, rightPanelOpen, toggleRightPanel, bottomPanelOpen, toggleBottomPanel } = useUi(
    useShallow((s) => ({
      workspaceTab: s.workspaceTab,
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
          <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
            <TabBar<WorkspaceTab>
              size="lg"
              value={workspaceTab}
              onChange={setWorkspaceTab}
              tabs={[
                { value: "chat", label: "Chat", icon: <MessageSquare className="h-4 w-4" /> },
                { value: "git", label: "Git", icon: <GitBranch className="h-4 w-4" />, badge: project.git?.changedCount ? <Badge tone="warning">{project.git.changedCount}</Badge> : undefined },
                { value: "files", label: "Dateien", icon: <FileText className="h-4 w-4" /> },
                { value: "settings", label: "Einstellungen", icon: <Settings2 className="h-4 w-4" /> },
              ]}
            />
            <div className="flex-1" />
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
          <div className="min-h-0 flex-1">
            {workspaceTab === "chat" &&
              (project.exists ? <ChatPanel project={project} workingInPanel={showRight} /> : <EmptyState title="Chat nicht verfügbar">Der Projektordner fehlt.</EmptyState>)}
            {workspaceTab === "git" && <GitCenter project={project} />}
            {workspaceTab === "files" && <FilesTab project={project} />}
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
    <aside className="flex w-100 shrink-0 flex-col border-l border-border bg-sidebar xl:w-110">
      <div className="flex h-12 shrink-0 items-center border-b border-border px-3">
        <TabBar<RightTab>
          size="lg"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "files", label: "Dateien", icon: <FolderTree className="h-4 w-4" /> },
            { value: "git", label: "Änderungen", icon: <GitCompare className="h-4 w-4" />, badge: project.git?.changedCount ? <Badge tone="warning">{project.git.changedCount}</Badge> : undefined },
            { value: "activity", label: "Aktivität", icon: <Activity className="h-4 w-4" /> },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">
        {tab === "files" ? <FileTree project={project} /> : tab === "git" ? <GitPanel project={project} compact /> : <ActivityFeed projectId={projectId} projectDir={project.path} />}
      </div>
      <WorkingCard project={project} />
    </aside>
  );
}

function WorkspaceHeader({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const qc = useQueryClient();
  const [newBranch, setNewBranch] = useState(false);
  const branches = useQuery({
    queryKey: keys.branches(projectId),
    queryFn: () => call("git.branches", { projectId }),
    enabled: project.exists && !!project.git,
    retry: false,
  });

  const sandboxOnly = project.tags.includes("sandbox-only");

  const setProfile = async (profile: ProfileId) => {
    try {
      await call("projects.update", { projectId, profile });
      await qc.invalidateQueries({ queryKey: keys.project(projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Profil ${PROFILE_INFO[profile].label}`, "Gilt sofort, auch für laufende Sessions.");
    } catch (e) {
      toast.error("Profil nicht geändert", errorMessage(e));
    }
  };

  const toggleFavorite = async () => {
    try {
      await call("projects.update", { projectId, favorite: !project.favorite });
      await qc.invalidateQueries({ queryKey: keys.project(projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    }
  };

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
      <ProjectIcon name={project.name} size={36} />
      <div className="flex min-w-0 items-center gap-2" title={shortPath(project.path, 4)}>
        <h1 className="truncate text-title-lg font-semibold">{project.name}</h1>
        <Button size="icon-sm" variant="ghost" onClick={() => void toggleFavorite()} className="hover:text-warning" aria-label={project.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten"}>
          <Star className={cn("h-4 w-4", project.favorite && "fill-warning text-warning")} />
        </Button>
      </div>

      {project.git && (
        <DropdownMenu
          align="start"
          header="Branch wechseln"
          trigger={
            <button className="ml-2 flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-surface px-3 text-body-lg hover:border-border-strong">
              <GitBranch className="h-4 w-4 text-muted" />
              <span className="max-w-48 truncate" title={project.git.branch ? undefined : "Kein Branch ausgecheckt"}>
                {project.git.branch ?? "ohne Branch"}
              </span>
              {project.git.changedCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Uncommittete Änderungen" />}
              <ChevronDown className="h-3.5 w-3.5 text-muted" />
            </button>
          }
          items={[
            ...(branches.data ?? [])
              .filter((b) => !b.current)
              .slice(0, 20)
              .map((b) => ({ label: b.name, icon: <GitBranch className="h-3.5 w-3.5" />, onSelect: () => void checkoutBranch(projectId, b.name, false).catch(() => {}) })),
            { label: "Neuer Branch …", icon: <Plus className="h-3.5 w-3.5" />, onSelect: () => setNewBranch(true) },
          ]}
        />
      )}

      {project.exists && <DevServerButton project={project} />}

      {project.tags.length > 0 && (
        <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden xl:flex" title={project.tags.join(", ")}>
          {project.tags.slice(0, 4).map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
          {project.tags.length > 4 && <span className="text-caption text-subtle">+{project.tags.length - 4}</span>}
        </div>
      )}

      <div className="flex-1" />

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
      <NewBranchDialog open={newBranch} onOpenChange={setNewBranch} projectId={projectId} />
    </header>
  );
}
