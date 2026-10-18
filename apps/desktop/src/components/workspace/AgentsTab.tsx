import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FolderOpen, GitBranch, GitMerge, Globe, Plus, RotateCcw, Square, Trash2, Users } from "lucide-react";
import type { DevServerState, Project, ProjectWithStatus, SessionStatus } from "@forge/protocol";
import { call, keys, useProjects } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { chatWindowsOfProject, closeChatWindows } from "@/lib/chat-windows";
import { closeProjectTerminals } from "@/lib/terminal-registry";
import { relativeTime } from "@/lib/utils";
import { contextItems } from "@/lib/context-menu";
import { openDevServer, prepareWorktree, stopDevServer } from "@/lib/dev-server-actions";
import { useUi } from "@/stores/ui";
import { useAgentReview } from "@/stores/agent-review";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, EmptyState, ErrorBanner, SectionTitle } from "@/components/ui/misc";
import { LimitForecastWarning } from "@/components/usage/UsageWindows";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { AgentEnvironment } from "./AgentEnvironment";

/**
 * Parallel agents of the open project: each runs in its own git worktree (separate folder and
 * branch), so several Claude sessions can work on one repository at the same time. Inside a
 * worktree the tab shows the agents of its main project.
 */
export function AgentsTab({ project }: { project: ProjectWithStatus }) {
  const projects = useProjects();
  const openProject = useUi((s) => s.openProject);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<ProjectWithStatus | null>(null);
  const [force, setForce] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const qc = useQueryClient();
  const all = projects.data ?? [];
  const rootId = project.parentId ?? project.id;
  const root = project.parentId ? all.find((p) => p.id === rootId) : project;
  const worktrees = all.filter((p) => p.parentId === rootId);
  // A worktree finds its main project only in the project list; until that is there, nothing is missing yet.
  const findingRoot = !!project.parentId && projects.isLoading;
  const blocker = findingRoot
    ? null
    : !root
      ? t.workspace.agents.rootMissing
      : !root.exists
        ? t.workspace.agents.folderMissing
        : !root.git
          ? t.workspace.agents.needsGit
          : null;

  const remove = async () => {
    if (!removing) return;
    try {
      closeProjectTerminals([removing.id]);
      const windows = await chatWindowsOfProject(qc, removing.id);
      const r = await call("worktrees.remove", { projectId: removing.id, force, deleteBranch });
      closeChatWindows(windows);
      const ui = useUi.getState();
      if (ui.activeProjectId === removing.id) {
        if (root) ui.openProject(root.id);
        else ui.closeProject();
      }
      await qc.invalidateQueries({ queryKey: keys.projects });
      if (root) void qc.invalidateQueries({ queryKey: keys.branches(root.id) });
      if (r.branchError) toast.error(t.workspace.agents.removedBranchKept, r.branchError);
      else if (r.deletedBranch) toast.success(t.workspace.agents.removedWithBranch, r.deletedBranch);
      else toast.success(t.workspace.agents.removed, t.workspace.agents.branchStays(removing.git?.branch ?? ""));
    } catch (e) {
      // Uncommitted changes: the dialog stays open and switches to the forced variant.
      if (e instanceof RpcCallError && e.code === "CONFLICT" && !force) setForce(true);
      else toast.error(t.workspace.agents.notRemoved, errorMessage(e));
      throw e;
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex max-w-5xl flex-col gap-6">
        <section>
          <SectionTitle
            action={
              <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={!!blocker || findingRoot} title={blocker ?? undefined}>
                <Plus className="h-3.5 w-3.5" /> {t.workspace.agents.newAgent}
              </Button>
            }
          >
            {t.workspace.agents.title}
          </SectionTitle>
          <p className="mb-3 text-xs text-muted">
            {t.workspace.agents.intro(root?.name ?? null)}
            {project.parentId && root && (
              <>
                {" "}
                <button className="text-accent underline" onClick={() => openProject(root.id)}>
                  {t.workspace.agents.openRoot}
                </button>
              </>
            )}
          </p>
          {blocker && <p className="mb-3 text-xs text-warning">{blocker}</p>}
          {projects.isLoading && <WorktreeGridSkeleton />}
          {projects.isError && <ErrorBanner title={t.workspace.agents.notLoaded}>{errorMessage(projects.error)}</ErrorBanner>}
          {projects.isSuccess && worktrees.length === 0 && (
            <EmptyState icon={<Users className="h-9 w-9" />} title={t.workspace.agents.emptyTitle}>
              {t.workspace.agents.emptyText}
            </EmptyState>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {worktrees.map((w) => {
              const current = w.id === project.id;
              const startRemove = () => {
                setForce(w.exists && !!w.git?.changedCount);
                setDeleteBranch(false);
                setRemoving(w);
              };
              const menu = () => {
                const dev = qc.getQueryData<DevServerState>(keys.devServer(w.id));
                return [
                  { label: t.workspace.agents.open, icon: <FolderOpen className="h-3.5 w-3.5" />, onSelect: () => openProject(w.id), disabled: current },
                  { label: t.workspace.agents.openDev, icon: <Globe className="h-3.5 w-3.5" />, onSelect: () => void openDevServer(qc, w.id), disabled: !w.exists },
                  ...(dev?.status === "running" ? [{ label: t.workspace.agents.stopDev, icon: <Square className="h-3.5 w-3.5" />, onSelect: () => void stopDevServer(qc, w.id) }] : []),
                  { label: t.workspace.agents.retrySetup, icon: <RotateCcw className="h-3.5 w-3.5" />, onSelect: () => void prepareWorktree(qc, w.id), disabled: !w.exists, hint: t.workspace.agents.retrySetupHint },
                  { label: t.workspace.agents.finish, icon: <GitMerge className="h-3.5 w-3.5" />, onSelect: () => useAgentReview.getState().request(w.id), disabled: !w.exists },
                  { label: t.workspace.agents.remove, icon: <Trash2 className="h-3.5 w-3.5" />, onSelect: startRemove, danger: true },
                ];
              };
              return (
                <div key={w.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4" onContextMenu={contextItems(menu)}>
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate font-mono text-body" title={w.path}>
                      {w.git?.branch ?? w.name}
                    </span>
                    {!w.exists ? (
                      <Badge tone="danger">{t.workspace.agents.folderMissingBadge}</Badge>
                    ) : (
                      w.git && (w.git.changedCount > 0 ? <Badge tone="warning">{t.workspace.agents.changed(w.git.changedCount)}</Badge> : <Badge tone="success">{t.workspace.agents.clean}</Badge>)
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {w.lastSession ? (
                      <>
                        <SessionStatusBadge status={w.lastSession.status as SessionStatus} />
                        <span className="min-w-0 flex-1 truncate text-muted">{w.lastSession.title ?? t.workspace.agents.untitled}</span>
                        <span className="shrink-0 text-subtle">{relativeTime(w.lastSession.updatedAt)}</span>
                      </>
                    ) : (
                      <span className="text-subtle">{t.workspace.agents.noSession}</span>
                    )}
                  </div>
                  {w.exists && <AgentEnvironment projectId={w.id} />}
                  <div className="mt-1 flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => openProject(w.id)} disabled={current} title={current ? t.workspace.agents.currentlyOpen : undefined}>
                      {current ? t.workspace.agents.opened : t.workspace.agents.open}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => useAgentReview.getState().request(w.id)} disabled={!w.exists} title={t.workspace.agents.finishTitle}>
                      <GitMerge className="h-3.5 w-3.5" /> {t.workspace.agents.finish}
                    </Button>
                    <div className="flex-1" />
                    <Button size="sm" variant="danger-ghost" onClick={startRemove}>
                      <Trash2 className="h-3.5 w-3.5" /> {t.workspace.agents.remove}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <Subagents projectId={project.id} />
      </div>

      {root && <NewAgentDialog open={creating} onOpenChange={setCreating} root={root} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t.workspace.agents.removeTitle}
        description={[
          force ? t.workspace.agents.removeForce : t.workspace.agents.removePlain,
          deleteBranch ? t.workspace.agents.removeDeleteBranch : t.workspace.agents.removeKeepBranch,
        ].join(" ")}
        confirmLabel={force || deleteBranch ? t.workspace.agents.removeAnyway : t.workspace.agents.remove}
        danger
        requireText={force ? t.workspace.agents.confirmWord : undefined}
        onConfirm={remove}
      >
        <div className="space-y-3">
          <Checkbox
            checked={deleteBranch}
            onChange={setDeleteBranch}
            label={removing?.git?.branch ? t.workspace.agents.deleteBranchNamed(removing.git.branch) : t.workspace.agents.deleteBranch}
          />
          <p className="text-xs text-muted">{t.workspace.agents.removeNote}</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}

function Subagents({ projectId }: { projectId: string }) {
  const setView = useUi((s) => s.setView);
  const docs = useQuery({ queryKey: ["docs", "agent", projectId], queryFn: () => call("config.docs", { kind: "agent", projectId }) });
  return (
    <section>
      <SectionTitle>{t.workspace.agents.subagents}</SectionTitle>
      <p className="mb-2 text-xs text-muted">
        {t.workspace.agents.subagentsIntro}{" "}
        <button className="text-accent underline" onClick={() => setView("mcp")}>
          {t.workspace.agents.subagentsLink}
        </button>
        .
      </p>
      {docs.isLoading && <SubagentGridSkeleton />}
      {docs.isError && <ErrorBanner title={t.workspace.agents.subagentsNotLoaded}>{errorMessage(docs.error)}</ErrorBanner>}
      {docs.data?.length === 0 && <p className="text-xs text-subtle">{t.workspace.agents.noSubagents}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
        {docs.data?.map((a) => (
          <div key={`${a.scope}:${a.name}`} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex items-center gap-2 text-body">
              <Bot className="h-4 w-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <Badge>{a.scope === "user" ? t.workspace.agents.scopeGlobal : t.workspace.agents.scopeProject}</Badge>
            </div>
            {a.description && <p className="mt-1 line-clamp-3 text-xs text-muted">{a.description}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Worktree cards as AgentsTab renders them: branch row, session row, buttons. */
function WorktreeGridSkeleton() {
  return (
    <SkeletonRegion label={t.workspace.agents.loadingWorktrees} className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
      {[45, 60].map((w) => (
        <div key={w} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
            <div className="flex-1" />
            <Skeleton className="h-5 w-16 rounded" />
          </div>
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="h-5 w-16 rounded" />
            <Skeleton className="h-2.5 flex-1" />
            <Skeleton className="h-2.5 w-12" />
          </div>
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="h-2.5 w-2/5" />
            <div className="flex-1" />
            <Skeleton className="h-2.5 w-20" />
          </div>
          <div className="mt-1 flex gap-2">
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-7 w-28" />
            <div className="flex-1" />
            <Skeleton className="h-7 w-24" />
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Subagent cards: name row with scope badge, then a two-line description. */
function SubagentGridSkeleton() {
  return (
    <SkeletonRegion label={t.workspace.agents.loadingSubagents} className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
      {[50, 35, 60].map((w) => (
        <div key={w} className="rounded-lg border border-border bg-surface p-3">
          <div className="flex h-5 items-center gap-2">
            <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
            <div className="flex-1" />
            <Skeleton className="h-5 w-12 rounded" />
          </div>
          <div className="mt-1 flex flex-col">
            <div className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-[90%]" />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-3/5" />
            </div>
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

const BRANCH_PREFIX = "agent/";

export function NewAgentDialog({ open, onOpenChange, root }: { open: boolean; onOpenChange: (o: boolean) => void; root: ProjectWithStatus }) {
  const openProject = useUi((s) => s.openProject);
  const qc = useQueryClient();
  const [branch, setBranch] = useState(BRANCH_PREFIX);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const setOpen = (o: boolean) => {
    if (busy) return;
    if (!o) {
      setBranch(BRANCH_PREFIX);
      setPrompt("");
    }
    onOpenChange(o);
  };
  const name = branch.trim();

  const start = async () => {
    setBusy(true);
    let wt: Project;
    try {
      wt = await call("worktrees.create", { projectId: root.id, branch: name });
    } catch (e) {
      toast.error(t.workspace.agents.notStarted, errorMessage(e));
      setBusy(false);
      return;
    }
    void qc.invalidateQueries({ queryKey: keys.projects });
    let sessionId: string | null = null;
    let failure: unknown = null;
    if (prompt.trim()) {
      try {
        sessionId = (await call("sessions.start", { projectId: wt.id, prompt })).id;
      } catch (e) {
        failure = e;
      }
    }
    setBusy(false);
    setBranch(BRANCH_PREFIX);
    setPrompt("");
    onOpenChange(false);
    if (failure) {
      // The worktree exists now; a retry from this dialog would fail on the existing branch.
      const id = wt.id;
      toast.notify({
        tone: "error",
        title: t.workspace.agents.sessionNotStarted,
        body: errorMessage(failure),
        action: { label: t.workspace.agents.openWorktree, onClick: () => openProject(id) },
        duration: 15_000,
      });
      return;
    }
    openProject(wt.id, sessionId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title={t.workspace.agents.newAgent}
      description={t.workspace.agents.newDescription(root.name)}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {t.workspace.agents.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={!name || name.endsWith("/")} onClick={() => void start()}>
            {t.workspace.agents.start}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t.workspace.agents.branch}>
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono text-xs" autoFocus />
        </Field>
        <Field label={t.workspace.agents.firstTask}>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder={t.workspace.agents.firstTaskPlaceholder} />
        </Field>
        <LimitForecastWarning />
      </div>
    </Dialog>
  );
}
