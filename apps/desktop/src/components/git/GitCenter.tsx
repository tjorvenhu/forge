import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, GitBranch, GitCommitHorizontal, GitCompareArrows, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import type { CommitInfo, Project } from "@forge/protocol";
import { call, keys, useGitStatus } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Field, Input } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { GitPanel } from "./GitPanel";
import { DiffView } from "./DiffView";
import { CommitGraph, RefBadges } from "./CommitGraph";
import { PullRequestBar, SyncActions } from "./Sync";
import { RestoreDialog } from "./RestoreDialog";
import { DeleteBranchDialog } from "./DeleteBranchDialog";

/** Workspace tab, laid out like Source Control in VS Code: changes, graph and branches on the left, the diff or commit on the right. */
export function GitCenter({ project }: { project: Project }) {
  const log = useQuery({ queryKey: keys.log(project.id), queryFn: () => call("git.log", { projectId: project.id, limit: 200 }), enabled: project.exists, retry: false });
  const branches = useQuery({ queryKey: keys.branches(project.id), queryFn: () => call("git.branches", { projectId: project.id }), enabled: project.exists, retry: false });
  const status = useGitStatus(project.id, project.exists);
  const [open, setOpen] = useState({ changes: true, graph: true, branches: false });
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState(false);
  const [restoring, setRestoring] = useState<CommitInfo | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);

  const files = status.data?.files ?? [];
  const focusFile = focusPath ? files.find((f) => f.path === focusPath) : undefined;
  const selected = selectedHash ? log.data?.find((c) => c.hash === selectedHash) : undefined;
  const localBranches = useMemo(() => new Set(branches.data?.map((b) => b.name)), [branches.data]);
  const toggle = (k: keyof typeof open) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  // Without a repository only the "initialise" prompt of GitPanel makes sense. GitPanel keeps its place
  // in the tree: remounting it would refetch the failed status and flip this condition in a loop.
  const notRepo = status.error instanceof RpcCallError && status.error.code === "GIT_NOT_REPO";

  return (
    <div className={cn("grid h-full min-h-0", notRepo ? "grid-cols-1" : "grid-cols-[minmax(340px,5fr)_minmax(0,7fr)]")}>
      <div className={cn("flex min-h-0 flex-col", !notRepo && "border-r border-border bg-surface")}>
        <div className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2", notRepo && "hidden")}>
          <span className="flex-1 truncate text-caption font-semibold uppercase tracking-wide text-muted">Quellcodeverwaltung</span>
          <BranchMenu project={project} branches={branches.data ?? []} onNew={() => setNewBranch(true)} />
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => {
              void status.refetch();
              void log.refetch();
              void branches.refetch();
            }}
            aria-label="Aktualisieren"
            title="Aktualisieren"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", (status.isFetching || log.isFetching) && "animate-spin")} />
          </Button>
        </div>

        <Pane
          title="Änderungen"
          count={files.length}
          open={open.changes}
          onToggle={() => toggle("changes")}
          bare={notRepo}
          className={notRepo ? "flex-1" : open.graph ? "max-h-[55%] shrink-0" : "flex-1"}
        >
          <GitPanel
            project={project}
            focusPath={focusPath}
            onFocus={(p) => {
              setFocusPath(p);
              setSelectedHash(null);
            }}
          />
        </Pane>

        <Pane
          title="Graph"
          open={open.graph}
          onToggle={() => toggle("graph")}
          className={cn(open.graph && "flex-1", notRepo && "hidden")}
          actions={<SyncActions project={project} />}
        >
          <PullRequestBar project={project} />
          {log.isLoading && <ListSkeleton rows={8} />}
          {log.isError && (
            <div className="p-3">
              <ErrorBanner title="Verlauf nicht geladen">{errorMessage(log.error)}</ErrorBanner>
            </div>
          )}
          {log.data?.length === 0 && <p className="px-3 py-2 text-xs text-subtle">Noch keine Commits.</p>}
          {!!log.data?.length && (
            <CommitGraph
              commits={log.data}
              localBranches={localBranches}
              selected={selected?.hash ?? null}
              onSelect={(h) => {
                setSelectedHash(h);
                setFocusPath(null);
              }}
            />
          )}
        </Pane>

        <Pane
          title="Branches"
          count={branches.data?.length}
          open={open.branches}
          onToggle={() => toggle("branches")}
          className={cn(open.branches && "max-h-[35%] shrink-0", notRepo && "hidden")}
          actions={
            <Button size="icon-sm" variant="ghost" className="h-6 w-6" onClick={() => setNewBranch(true)} disabled={!branches.data} aria-label="Neuer Branch" title="Neuer Branch">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          }
        >
          {branches.isLoading && <ListSkeleton rows={3} />}
          {branches.isError && (
            <div className="p-3">
              <ErrorBanner title="Branches nicht geladen">{errorMessage(branches.error)}</ErrorBanner>
            </div>
          )}
          <ul className="py-0.5">
            {branches.data?.map((b) => (
              <li key={b.name} className="group flex h-7 items-center gap-2 pl-4 pr-2 text-small-lg hover:bg-surface-2">
                <GitBranch className={cn("h-3.5 w-3.5 shrink-0", b.current ? "text-accent" : "text-muted")} />
                <span className={cn("min-w-0 truncate", b.current && "font-semibold")}>{b.name}</span>
                {b.upstream && <span className="min-w-0 flex-1 truncate text-caption text-subtle">{b.upstream}</span>}
                {!b.upstream && <span className="flex-1" />}
                {b.current ? (
                  <Badge tone="accent">aktuell</Badge>
                ) : (
                  <span className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => void checkout(project.id, b.name, false).catch(() => {})}>
                      Wechseln
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="h-6 w-6 hover:text-danger"
                      onClick={() => setDeletingBranch(b.name)}
                      aria-label={`Branch ${b.name} löschen`}
                      title="Branch löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Pane>
      </div>

      <div className={cn("flex min-h-0 flex-col p-3", notRepo && "hidden")}>
        {focusFile ? (
          <DiffView projectId={project.id} path={focusFile.path} staged={focusFile.staged && !focusFile.unstaged} onClose={() => setFocusPath(null)} />
        ) : selected ? (
          <CommitDetails
            commit={selected}
            current={selected.hash === log.data?.[0]?.hash}
            openChanges={files.length}
            localBranches={localBranches}
            known={(h) => !!log.data?.some((c) => c.hash === h)}
            onSelect={setSelectedHash}
            onRestore={() => setRestoring(selected)}
            onClose={() => setSelectedHash(null)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState icon={<GitCompareArrows className="h-10 w-10" />} title="Nichts ausgewählt">
              Eine Datei unter Änderungen zeigt ihren Diff. Ein Commit im Graph zeigt seine Daten und lässt sich wiederherstellen.
            </EmptyState>
          </div>
        )}
      </div>

      <NewBranchDialog open={newBranch} onOpenChange={setNewBranch} projectId={project.id} />
      <DeleteBranchDialog projectId={project.id} branch={deletingBranch} onOpenChange={(o) => !o && setDeletingBranch(null)} />
      <RestoreDialog
        projectId={project.id}
        commit={restoring}
        current={!!restoring && restoring.hash === log.data?.[0]?.hash}
        openChanges={files.length}
        onOpenChange={(o) => !o && setRestoring(null)}
      />
    </div>
  );
}

/** A collapsible section of the Source Control column. `bare` hides the header (no repository yet). */
function Pane({
  title,
  count,
  open,
  onToggle,
  actions,
  bare,
  className,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  bare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex min-h-0 flex-col border-b border-border last:border-b-0", className)}>
      <header className={cn("flex h-7 shrink-0 items-center gap-1 pl-1 pr-2", bare && "hidden")}>
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-1 text-left text-caption font-semibold uppercase tracking-wide text-muted hover:text-fg"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-120", open && "rotate-90")} />
          <span className="truncate">{title}</span>
          {!!count && <span className="ml-1 rounded-full bg-surface-3 px-1.5 text-2xs font-medium normal-case tracking-normal text-fg">{count}</span>}
        </button>
        {open && <div className="flex items-center gap-0.5">{actions}</div>}
      </header>
      {(open || bare) && <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>}
    </section>
  );
}

function BranchMenu({ project, branches, onNew }: { project: Project; branches: Array<{ name: string; current: boolean }>; onNew: () => void }) {
  const status = useGitStatus(project.id, project.exists);
  const summary = status.data?.summary;
  if (!summary) return null;
  return (
    <DropdownMenu
      header="Branch wechseln"
      items={[
        ...branches.map((b) => ({
          label: b.name,
          icon: b.current ? <Check className="h-3.5 w-3.5 text-accent" /> : <GitBranch className="h-3.5 w-3.5 text-muted" />,
          disabled: b.current,
          onSelect: () => void checkout(project.id, b.name, false).catch(() => {}),
        })),
        { label: "Neuer Branch …", icon: <Plus className="h-3.5 w-3.5 text-muted" />, onSelect: onNew },
      ]}
      trigger={
        <Button size="sm" variant="ghost" className="h-6 min-w-0 gap-1 px-1.5 text-small" title="Branch wechseln">
          <GitBranch className="h-3.5 w-3.5" />
          <span className="max-w-40 truncate">{summary.branch ?? "ohne Branch"}</span>
          {summary.ahead > 0 && (
            <span className="flex items-center text-fg">
              <ArrowUp className="h-3 w-3" />
              {summary.ahead}
            </span>
          )}
          {summary.behind > 0 && (
            <span className="flex items-center text-warning">
              <ArrowDown className="h-3 w-3" />
              {summary.behind}
            </span>
          )}
          <ChevronDown className="h-3 w-3" />
        </Button>
      }
    />
  );
}

function CommitDetails({
  commit,
  current,
  openChanges,
  localBranches,
  known,
  onSelect,
  onRestore,
  onClose,
}: {
  commit: CommitInfo;
  current: boolean;
  openChanges: number;
  localBranches: ReadonlySet<string>;
  known: (hash: string) => boolean;
  onSelect: (hash: string) => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <GitCommitHorizontal className="h-3.5 w-3.5 text-muted" />
        <span className="font-mono">{commit.shortHash}</span>
        {current && <Badge tone="accent">aktuell</Badge>}
        <span className="flex-1" />
        <button onClick={onClose} className="rounded p-0.5 text-subtle hover:text-fg" aria-label="Commit schließen">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <h2 className="text-title-sm font-semibold">{commit.subject}</h2>
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-body">
          <dt className="text-muted">Autor</dt>
          <dd>{commit.author}</dd>
          <dt className="text-muted">Datum</dt>
          <dd>
            {new Date(commit.date).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" })}
            <span className="ml-2 text-subtle">{relativeTime(commit.date)}</span>
          </dd>
          <dt className="text-muted">Commit</dt>
          <dd className="select-all break-all font-mono text-xs leading-5">{commit.hash}</dd>
          {commit.parents.length > 0 && (
            <>
              <dt className="text-muted">{commit.parents.length > 1 ? "Eltern (Merge)" : "Vorgänger"}</dt>
              <dd className="flex flex-wrap gap-2">
                {commit.parents.map((p) => (
                  <button
                    key={p}
                    onClick={() => onSelect(p)}
                    disabled={!known(p)}
                    className="font-mono text-xs text-accent hover:underline disabled:text-subtle disabled:no-underline"
                    title={known(p) ? "Commit anzeigen" : "Nicht im geladenen Verlauf"}
                  >
                    {p.slice(0, 7)}
                  </button>
                ))}
              </dd>
            </>
          )}
          {commit.refs.length > 0 && (
            <>
              <dt className="text-muted">Branches</dt>
              <dd>
                <RefBadges refs={commit.refs} localBranches={localBranches} />
              </dd>
            </>
          )}
        </dl>
        {(!current || openChanges > 0) && (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <p className="min-w-0 flex-1 text-xs text-muted">
              {current
                ? "Legt die offenen Änderungen als Git-Stash beiseite. Der Commit selbst bleibt."
                : "Holt alle Dateien auf diesen Stand zurück. Branch und Verlauf bleiben, das Ergebnis sind neue, nicht committete Änderungen."}
            </p>
            <Button size="sm" onClick={onRestore}>
              <RotateCcw className="h-3.5 w-3.5" /> {current ? "Beiseitelegen" : "Wiederherstellen"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

async function checkout(projectId: string, branch: string, create: boolean) {
  try {
    await call("git.checkout", { projectId, branch, create });
    toast.success(create ? "Branch angelegt" : "Branch gewechselt", branch);
  } catch (e) {
    toast.error("Branch-Wechsel fehlgeschlagen", errorMessage(e));
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
      title="Neuen Branch anlegen"
      description="Der Branch wird vom aktuellen Stand abgezweigt. Uncommittete Änderungen werden mitgenommen."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
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
            Anlegen und wechseln
          </Button>
        </>
      }
    >
      <Field label="Branch-Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="font-mono text-xs" />
      </Field>
    </Dialog>
  );
}

export { checkout as checkoutBranch };
