import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, ChevronDown, FileText, GitBranch, MessageSquare, PanelBottom, PanelRight, Plus, Settings2, Star } from "lucide-react";
import type { ProfileId } from "@forge/protocol";
import { call, keys, useProject } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, shortPath } from "@/lib/utils";
import { useUi, type WorkspaceTab } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, EmptyState, ErrorBanner, Spinner } from "@/components/ui/misc";
import { TabBar } from "@/components/ui/tabs";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { PROFILE_INFO, ProfileBadge } from "@/components/projects/ProfileBadge";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { GitPanel } from "@/components/git/GitPanel";
import { GitCenter, NewBranchDialog, checkoutBranch } from "@/components/git/GitCenter";
import { FilesTab } from "@/components/workspace/FilesTab";
import { ProjectSettingsTab } from "@/components/workspace/ProjectSettingsTab";
import { ActivityFeed } from "@/components/workspace/ActivityFeed";
import { OutputPanel } from "@/components/workspace/OutputPanel";
import { useQuery } from "@tanstack/react-query";

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
  if (project.isLoading) return <div className="p-6"><Spinner /></div>;
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
  const { workspaceTab, setWorkspaceTab, rightPanelOpen, toggleRightPanel, bottomPanelOpen, toggleBottomPanel } = useUi();
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
      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <TabBar<WorkspaceTab>
          value={workspaceTab}
          onChange={setWorkspaceTab}
          tabs={[
            { value: "chat", label: "Chat", icon: <MessageSquare className="h-3.5 w-3.5" /> },
            { value: "git", label: "Git", icon: <GitBranch className="h-3.5 w-3.5" />, badge: project.git?.changedCount ? <Badge tone="warning">{project.git.changedCount}</Badge> : undefined },
            { value: "files", label: "Dateien", icon: <FileText className="h-3.5 w-3.5" /> },
            { value: "settings", label: "Einstellungen", icon: <Settings2 className="h-3.5 w-3.5" /> },
          ]}
        />
        <div className="flex-1" />
        <Button size="icon-sm" variant="ghost" onClick={() => toggleBottomPanel()} aria-pressed={bottomPanelOpen} title="Claude Output (Strg+J)" className={cn(bottomPanelOpen && "text-accent")}>
          <PanelBottom className="h-4 w-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => toggleRightPanel()}
          aria-pressed={showRight}
          disabled={narrow || workspaceTab !== "chat"}
          title={narrow ? "Fenster zu schmal für die Seitenleiste" : "Seitenleiste (Strg+Umschalt+E)"}
          className={cn(showRight && "text-accent")}
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      </div>

      {!project.exists && (
        <div className="px-4 pt-3">
          <ErrorBanner title="Projektordner fehlt">
            {project.path} existiert nicht mehr. Sessions und Git sind deaktiviert. Entferne das Projekt unter Einstellungen oder stelle den Ordner wieder her.
          </ErrorBanner>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {workspaceTab === "chat" &&
              (project.exists ? <ChatPanel project={project} /> : <EmptyState title="Chat nicht verfügbar">Der Projektordner fehlt.</EmptyState>)}
            {workspaceTab === "git" && <GitCenter project={project} />}
            {workspaceTab === "files" && <FilesTab project={project} />}
            {workspaceTab === "settings" && <ProjectSettingsTab project={project} />}
          </div>
          {bottomPanelOpen && <OutputPanel projectId={project.id} />}
        </div>
        {showRight && <RightPanel projectId={projectId} />}
      </div>
    </div>
  );
}

function RightPanel({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const [tab, setTab] = useState<"git" | "activity">("git");
  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-border bg-sidebar xl:w-[440px]">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-2">
        <TabBar
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "git", label: "Git & Änderungen", icon: <GitBranch className="h-3.5 w-3.5" /> },
            { value: "activity", label: "Aktivität", icon: <Activity className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">{tab === "git" ? <GitPanel project={project} compact /> : <ActivityFeed projectId={projectId} projectDir={project.path} />}</div>
    </aside>
  );
}

function WorkspaceHeader({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data!;
  const qc = useQueryClient();
  const setWorkspaceTab = useUi((s) => s.setWorkspaceTab);
  const [newBranch, setNewBranch] = useState(false);
  const branches = useQuery({
    queryKey: keys.branches(projectId),
    queryFn: () => call("git.branches", { projectId }),
    enabled: project.exists && !!project.git,
    retry: false,
  });

  const setProfile = async (profile: ProfileId) => {
    if (profile === "autonomous" && !project.autonomousConfirmed) {
      setWorkspaceTab("settings");
      toast.info("Autonomous muss bestätigt werden", "Unter Einstellungen im Abschnitt Profil.");
      return;
    }
    try {
      await call("projects.update", { projectId, profile });
      await qc.invalidateQueries({ queryKey: keys.project(projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Profil ${PROFILE_INFO[profile].label}`, "Gilt für neu gestartete oder fortgesetzte Sessions.");
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
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4">
      <ProjectIcon name={project.name} size={38} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h1 className="truncate text-base font-semibold">{project.name}</h1>
          <button onClick={() => void toggleFavorite()} className="rounded p-0.5 text-subtle hover:text-warning" aria-label={project.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten"}>
            <Star className={cn("h-3.5 w-3.5", project.favorite && "fill-warning text-warning")} />
          </button>
        </div>
        <div className="truncate font-mono text-[11px] text-subtle" title={project.path}>
          {shortPath(project.path, 4)}
        </div>
      </div>

      {project.git && (
        <DropdownMenu
          align="start"
          header="Branch wechseln"
          trigger={
            <button className="ml-2 flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[13px] hover:border-border-strong">
              <GitBranch className="h-3.5 w-3.5 text-muted" />
              <span className="max-w-48 truncate font-mono text-xs">{project.git.branch ?? "detached"}</span>
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

      <div className="flex-1" />

      <div className="hidden items-center gap-1.5 lg:flex">
        {project.tags.slice(0, 4).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>

      <DropdownMenu
        header="Permission-Profil"
        trigger={
          <button className="flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-left hover:border-border-strong" aria-label="Permission-Profil wählen">
            <div className="leading-tight">
              <div className="text-[10px] uppercase tracking-wide text-subtle">Permission-Profil</div>
              <ProfileBadge profile={project.profile} />
            </div>
            <ChevronDown className="h-3.5 w-3.5 text-muted" />
          </button>
        }
        items={(["safe", "balanced", "autonomous"] as const).map((p) => ({
          label: `${PROFILE_INFO[p].label}${p === project.profile ? " (aktiv)" : ""}`,
          hint: p === "autonomous" && !project.autonomousConfirmed ? "gesperrt" : undefined,
          icon: p === "autonomous" ? <AlertTriangle className="h-3.5 w-3.5 text-danger" /> : undefined,
          onSelect: () => void setProfile(p),
        }))}
      />
      <NewBranchDialog open={newBranch} onOpenChange={setNewBranch} projectId={projectId} />
    </header>
  );
}
