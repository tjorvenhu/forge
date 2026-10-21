import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, GitBranch, GitCommitHorizontal, History, Link, MoreHorizontal, Plus, RefreshCw, RotateCcw, Search, Tag, Trash2 } from "lucide-react";
import type { CommitInfo, Project } from "@forge/protocol";
import { useGitRemoteDialog } from "@/stores/git-remote";
import { call, keys, useGitStatus } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { addContextItems, contextItems, copyText } from "@/lib/context-menu";
import { cn, relativeTime } from "@/lib/utils";
import { locale, t } from "@/i18n";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu, type MenuItem } from "@/components/ui/dropdown";
import { Field, Input } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { ListSkeleton, Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { TabBar } from "@/components/ui/tabs";
import { GitPanel } from "./GitPanel";
import { DiffView } from "./DiffView";
import { CommitGraph, CommitListSkeleton } from "./CommitGraph";
import { CommitView, CommitViewSkeleton } from "./CommitView";
import { PullRequestBar, SyncActions } from "./Sync";
import { RestoreDialog } from "./RestoreDialog";
import { DeleteBranchDialog } from "./DeleteBranchDialog";
import { parseRefs } from "./graph-layout";

type GitTab = "history" | "changes" | "branches" | "tags";

/** The commits git.log loads for the tab; the palette asks for the same, so both share the data. */
export const LOG_LIMIT = 200;

/**
 * Workspace tab: branch and sync on top, history, changes, branches and tags on the left, and on the
 * right always a commit (the checked-out one until another is chosen) or the diff of a changed file.
 */
export function GitCenter({ project }: { project: Project }) {
  const log = useQuery({ queryKey: keys.log(project.id), queryFn: () => call("git.log", { projectId: project.id, limit: LOG_LIMIT }), enabled: project.exists, retry: false });
  // Under the log key, so new commits also refresh the pictures. Asks GitHub, so the graph never waits for it.
  const avatars = useQuery({
    queryKey: [...keys.log(project.id), "avatars"],
    queryFn: () => call("git.authorAvatars", { projectId: project.id, limit: LOG_LIMIT }),
    enabled: project.exists && !!log.data?.length,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const branches = useQuery({ queryKey: keys.branches(project.id), queryFn: () => call("git.branches", { projectId: project.id }), enabled: project.exists, retry: false });
  const status = useGitStatus(project.id, project.exists);
  const [tab, setTab] = useState<GitTab>("history");
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [author, setAuthor] = useState("all");
  const [newBranch, setNewBranch] = useState(false);
  const [restoring, setRestoring] = useState<CommitInfo | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);

  // A commit chosen in the search.
  const request = useUi((s) => s.commitRequest);
  useEffect(() => {
    if (!request || request.projectId !== project.id) return;
    setSelectedHash(request.hash);
    setFocusPath(null);
    setTab("history");
    useUi.getState().clearCommitRequest();
  }, [request, project.id]);

  const files = status.data?.files ?? [];
  const focusFile = focusPath ? files.find((f) => f.path === focusPath) : undefined;
  const commits = useMemo(() => log.data ?? [], [log.data]);
  const head = commits[0];
  // Never empty: without a choice (or once the chosen commit left the history) the checked-out one.
  const selected = (selectedHash ? commits.find((c) => c.hash === selectedHash) : undefined) ?? head;
  const localBranches = useMemo(() => new Set(branches.data?.filter((b) => !b.remote).map((b) => b.name)), [branches.data]);
  const authors = useMemo(() => [...new Set(commits.map((c) => c.author))].sort((a, b) => a.localeCompare(b, locale)), [commits]);
  const q = query.trim().toLowerCase();
  const filtering = !!q || author !== "all";
  const shown = useMemo(
    () =>
      filtering
        ? commits.filter(
            (c) =>
              (author === "all" || c.author === author) &&
              (!q || c.subject.toLowerCase().includes(q) || c.hash.startsWith(q) || c.author.toLowerCase().includes(q) || c.refs.some((r) => r.toLowerCase().includes(q))),
          )
        : commits,
    [commits, filtering, author, q],
  );
  const tags = useMemo(
    () => commits.flatMap((c) => parseRefs(c.refs, localBranches).flatMap((r) => (r.kind === "tag" ? [{ name: r.name, commit: c }] : []))),
    [commits, localBranches],
  );

  const select = (hash: string) => {
    setSelectedHash(hash);
    setFocusPath(null);
  };
  const refresh = () => {
    void status.refetch();
    void log.refetch();
    void branches.refetch();
  };
  const commitMenu = (c: CommitInfo): MenuItem[] => {
    const current = c.hash === head?.hash;
    return [
      { label: t.git.common.copyHash, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(c.hash) },
      { label: t.git.common.copyMessage, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(c.subject) },
      ...(!current || files.length > 0
        ? [{ label: current ? t.git.common.putAside : t.git.common.restore, icon: <RotateCcw className="h-3.5 w-3.5" />, onSelect: () => setRestoring(c) }]
        : []),
    ];
  };

  // Without a repository only the "initialise" prompt of GitPanel makes sense. GitPanel keeps its place
  // in the tree: remounting it would refetch the failed status and flip this condition in a loop.
  const notRepo = status.error instanceof RpcCallError && status.error.code === "GIT_NOT_REPO";

  return (
    <div className={cn("grid h-full min-h-0", notRepo ? "grid-cols-1" : "grid-cols-[minmax(380px,5fr)_minmax(0,7fr)]")}>
      <div className={cn("flex min-h-0 flex-col", !notRepo && "border-r border-border")}>
        <div className={cn("flex shrink-0 items-center gap-2 px-3 pt-3", notRepo && "hidden")}>
          <BranchMenu project={project} branches={branches.data ?? []} onNew={() => setNewBranch(true)} />
          <span className="flex-1" />
          <SyncActions project={project} labeled />
          <DropdownMenu
            items={[
              { label: t.git.common.newBranchEllipsis, icon: <Plus className="h-3.5 w-3.5" />, onSelect: () => setNewBranch(true), disabled: !branches.data },
              { label: t.git.remote.menu, icon: <Link className="h-3.5 w-3.5" />, onSelect: () => useGitRemoteDialog.getState().open(project) },
              { label: t.git.center.refresh, icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: refresh },
            ]}
            trigger={
              <Button size="icon" variant="outline" aria-label={t.git.center.moreActions} title={t.git.center.moreActions}>
                {status.isFetching || log.isFetching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </Button>
            }
          />
        </div>

        <div className={cn("shrink-0 border-b border-border px-2 pt-1", notRepo && "hidden")}>
          <TabBar
            value={tab}
            onChange={(next) => {
              setTab(next);
              if (next !== "changes") setFocusPath(null);
            }}
            fit
            tabs={[
              { value: "history", label: t.git.center.tabHistory, icon: <History className="h-3.5 w-3.5" /> },
              {
                value: "changes",
                label: t.git.center.tabChanges,
                icon: <GitCommitHorizontal className="h-3.5 w-3.5" />,
                badge: files.length ? <Badge tone="warning">{files.length}</Badge> : undefined,
              },
              { value: "branches", label: t.git.center.tabBranches, icon: <GitBranch className="h-3.5 w-3.5" /> },
              { value: "tags", label: t.git.center.tabTags, icon: <Tag className="h-3.5 w-3.5" /> },
            ]}
          />
        </div>

        {tab === "history" && !notRepo && (
          <div className="flex min-h-0 flex-1 flex-col">
            <PullRequestBar project={project} />
            <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.git.center.searchCommits} className="pl-8" aria-label={t.git.center.searchCommits} />
              </div>
              {authors.length > 1 && (
                <Select
                  value={author}
                  onChange={setAuthor}
                  aria-label={t.git.center.filterByAuthor}
                  className="max-w-40"
                  options={[{ value: "all", label: t.git.center.allAuthors }, ...authors.map((a) => ({ value: a, label: a }))]}
                />
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {log.isLoading && <CommitListSkeleton />}
              {log.isError && (
                <div className="p-3">
                  <ErrorBanner title={t.git.common.historyNotLoaded}>{errorMessage(log.error)}</ErrorBanner>
                </div>
              )}
              {log.data?.length === 0 && <p className="px-4 py-2 text-small text-subtle">{t.git.center.noCommitsYet}</p>}
              {!!commits.length && filtering && !shown.length && <p className="px-4 py-2 text-small text-subtle">{t.git.center.noSearchMatch}</p>}
              {!!shown.length && (
                <CommitGraph
                  commits={shown}
                  avatars={avatars.data}
                  localBranches={localBranches}
                  selected={focusFile ? null : (selected?.hash ?? null)}
                  headHash={head?.hash ?? null}
                  graph={!filtering}
                  onSelect={select}
                  onContextMenu={(e: MouseEvent, c) => addContextItems(e, commitMenu(c))}
                />
              )}
            </div>
          </div>
        )}

        {/* Always mounted (see notRepo), so a commit message survives switching tabs. */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto pt-2", !notRepo && tab !== "changes" && "hidden", notRepo && "pt-0")}>
          <GitPanel
            project={project}
            focusPath={focusPath}
            onFocus={(p) => {
              setFocusPath(p);
            }}
          />
        </div>

        {tab === "branches" && !notRepo && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-center gap-2 px-4 pb-1 pt-3">
              <span className="flex-1 text-caption font-semibold uppercase tracking-wide text-subtle">{t.git.center.localBranches}</span>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setNewBranch(true)} disabled={!branches.data}>
                <Plus className="h-3.5 w-3.5" /> {t.git.center.newBranch}
              </Button>
            </div>
            {branches.isLoading && <ListSkeleton rows={4} label={t.git.center.loadingBranches} />}
            {branches.isError && (
              <div className="p-3">
                <ErrorBanner title={t.git.center.branchesNotLoaded}>{errorMessage(branches.error)}</ErrorBanner>
              </div>
            )}
            {[false, true].map((remote) => {
              const list = branches.data?.filter((b) => !!b.remote === remote) ?? [];
              if (remote && !list.length) return null;
              return (
                <div key={String(remote)}>
                  {remote && (
                    <div className="px-4 pb-1 pt-3 text-caption font-semibold uppercase tracking-wide text-subtle">{t.git.center.remoteBranches}</div>
                  )}
                  <ul className="px-2 pb-2">
                    {list.map((b) => {
                      const items: MenuItem[] = [
                        ...(b.current ? [] : [{ label: t.git.center.switch, icon: <GitBranch className="h-3.5 w-3.5" />, onSelect: () => void checkout(project.id, b.name, false).catch(() => {}) }]),
                        { label: t.git.center.copyName, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(b.name) },
                        ...(b.current || b.remote ? [] : [{ label: t.git.center.deleteEllipsis, icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onSelect: () => setDeletingBranch(b.name) }]),
                      ];
                      return (
                        <li
                          key={b.name}
                          onContextMenu={contextItems(() => items)}
                          className={cn("group flex h-10 items-center gap-2.5 rounded-md px-2.5", b.current ? "bg-accent-soft" : "hover:bg-surface-2")}
                        >
                          <GitBranch className={cn("h-4 w-4 shrink-0", b.current ? "text-accent" : "text-muted")} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className={cn("truncate text-body", b.current && "font-semibold")}>{b.name}</span>
                            {b.upstream && <span className="truncate text-caption text-subtle">{b.upstream}</span>}
                          </span>
                          {b.current ? (
                            <Badge tone="accent">{t.git.common.current}</Badge>
                          ) : (
                            <span className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => void checkout(project.id, b.name, false).catch(() => {})}>
                                {t.git.center.switch}
                              </Button>
                              {!b.remote && (
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="hover:text-danger"
                                  onClick={() => setDeletingBranch(b.name)}
                                  aria-label={t.git.center.deleteBranchNamed(b.name)}
                                  title={t.git.center.deleteBranch}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {tab === "tags" && !notRepo && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {log.isLoading && <ListSkeleton rows={4} label={t.git.center.loadingTags} />}
            {log.data && !tags.length && <p className="px-4 py-3 text-small text-subtle">{t.git.center.noTags(LOG_LIMIT)}</p>}
            <ul className="px-2 py-2">
              {tags.map((tag) => {
                const active = !focusFile && selected?.hash === tag.commit.hash;
                return (
                  <li key={tag.name}>
                    <button
                      onClick={() => select(tag.commit.hash)}
                      onContextMenu={contextItems(() => [
                        { label: t.git.center.copyTagName, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(tag.name) },
                        ...commitMenu(tag.commit),
                      ])}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left",
                        active ? "bg-accent-soft ring-1 ring-inset ring-accent/40" : "hover:bg-surface-2",
                      )}
                    >
                      <Tag className="h-4 w-4 shrink-0 text-muted" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body font-medium">{tag.name}</span>
                        <span className="truncate text-caption text-subtle">
                          {tag.commit.subject} · {relativeTime(tag.commit.date)}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-caption text-subtle">{tag.commit.shortHash}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div className={cn("flex min-h-0 min-w-0 flex-col p-4", notRepo && "hidden")}>
        {focusFile ? (
          <DiffView projectId={project.id} path={focusFile.path} staged={focusFile.staged && !focusFile.unstaged} onClose={() => setFocusPath(null)} />
        ) : selected ? (
          <CommitView
            projectId={project.id}
            commit={selected}
            avatarUrl={selected.avatarUrl ?? avatars.data?.[selected.authorEmail]}
            current={selected.hash === head?.hash}
            openChanges={files.length}
            localBranches={localBranches}
            known={(h) => commits.some((c) => c.hash === h)}
            onSelect={(h) => {
              select(h);
              setTab("history");
            }}
            onRestore={() => setRestoring(selected)}
          />
        ) : log.isLoading || status.isLoading ? (
          <CommitViewSkeleton />
        ) : log.isError ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<GitCommitHorizontal className="h-10 w-10" />} title={t.git.common.historyNotLoaded}>
              {errorMessage(log.error)}
            </EmptyState>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<GitCommitHorizontal className="h-10 w-10" />} title={t.git.center.noCommitsTitle}>
              {t.git.center.noCommitsHint}
            </EmptyState>
          </div>
        )}
      </div>

      <NewBranchDialog open={newBranch} onOpenChange={setNewBranch} projectId={project.id} />
      <DeleteBranchDialog projectId={project.id} branch={deletingBranch} onOpenChange={(o) => !o && setDeletingBranch(null)} />
      <RestoreDialog
        projectId={project.id}
        commit={restoring}
        current={!!restoring && restoring.hash === head?.hash}
        openChanges={files.length}
        onOpenChange={(o) => !o && setRestoring(null)}
      />
    </div>
  );
}

function BranchMenu({ project, branches, onNew }: { project: Project; branches: Array<{ name: string; current: boolean }>; onNew: () => void }) {
  const status = useGitStatus(project.id, project.exists);
  const summary = status.data?.summary;
  if (!summary)
    return status.isLoading ? (
      <SkeletonRegion label={t.git.center.loadingBranch} className="shrink-0">
        <Skeleton className="h-8 w-32" />
      </SkeletonRegion>
    ) : null;
  return (
    <DropdownMenu
      align="start"
      header={t.git.center.switchBranch}
      items={[
        ...branches.map((b) => ({
          label: b.name,
          icon: b.current ? <Check className="h-3.5 w-3.5 text-accent" /> : <GitBranch className="h-3.5 w-3.5 text-muted" />,
          disabled: b.current,
          onSelect: () => void checkout(project.id, b.name, false).catch(() => {}),
        })),
        { label: t.git.common.newBranchEllipsis, icon: <Plus className="h-3.5 w-3.5 text-muted" />, onSelect: onNew },
      ]}
      trigger={
        <Button size="sm" variant="outline" className="h-8 min-w-0 gap-1.5 px-2.5" title={t.git.center.switchBranch}>
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="max-w-40 truncate text-body font-semibold">{summary.branch ?? t.git.common.noBranch}</span>
          {summary.ahead > 0 && (
            <span className="flex items-center text-small text-fg">
              <ArrowUp className="h-3 w-3" />
              {summary.ahead}
            </span>
          )}
          {summary.behind > 0 && (
            <span className="flex items-center text-small text-warning">
              <ArrowDown className="h-3 w-3" />
              {summary.behind}
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
        </Button>
      }
    />
  );
}

async function checkout(projectId: string, branch: string, create: boolean) {
  try {
    await call("git.checkout", { projectId, branch, create });
    toast.success(create ? t.git.center.branchCreated : t.git.center.branchSwitched, branch);
  } catch (e) {
    toast.error(t.git.center.checkoutFailed, errorMessage(e));
    throw e;
  }
}

export function NewBranchDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string }) {
  const [name, setName] = useState("feature/");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName("feature/");
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.git.center.newBranchTitle}
      description={t.git.center.newBranchDescription}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t.git.common.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || name.endsWith("/")}
            onClick={async () => {
              setBusy(true);
              try {
                await checkout(projectId, name.trim(), true);
                onOpenChange(false);
              } catch {
                /* toast shown */
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.git.center.createAndSwitch}
          </Button>
        </>
      }
    >
      <Field label={t.git.center.branchName}>
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="font-mono text-xs" />
      </Field>
    </Dialog>
  );
}

export { checkout as checkoutBranch };
