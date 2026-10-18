import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, GitBranch, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import type { FileStatus, Project } from "@forge/protocol";
import { call, keys, useGitStatus } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge, Checkbox, EmptyState, ErrorBanner, Tooltip } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DiffView } from "./DiffView";
import { ListSkeleton } from "@/components/ui/skeleton";

export const KIND: Record<FileStatus["kind"], { letter: string; tone: string; label: string }> = {
  modified: { letter: "M", tone: "text-warning", label: t.git.kind.modified },
  added: { letter: "A", tone: "text-success", label: t.git.kind.added },
  untracked: { letter: "U", tone: "text-success", label: t.git.kind.untracked },
  deleted: { letter: "D", tone: "text-danger", label: t.git.kind.deleted },
  renamed: { letter: "R", tone: "text-accent", label: t.git.kind.renamed },
  conflicted: { letter: "!", tone: "text-danger", label: t.git.kind.conflicted },
  typechange: { letter: "T", tone: "text-warning", label: t.git.kind.typechange },
};

/**
 * Changed files, real diffs and a reviewed commit for one project. With `onFocus` the panel is a section
 * of the Git tab: no status header, and the diff of the clicked file is shown by the parent.
 */
export function GitPanel({
  project,
  compact = false,
  focusPath: outerFocus,
  onFocus,
}: {
  project: Project;
  compact?: boolean;
  focusPath?: string | null;
  onFocus?: (path: string | null) => void;
}) {
  const status = useGitStatus(project.id, project.exists);
  const qc = useQueryClient();
  const files = useMemo(() => status.data?.files ?? [], [status.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Only the path is kept; staged/unstaged come from the latest status, not from when it was clicked.
  const [ownFocus, setOwnFocus] = useState<string | null>(null);
  const embedded = !!onFocus;
  const focusPath = embedded ? (outerFocus ?? null) : ownFocus;
  const setFocusPath = onFocus ?? setOwnFocus;
  const focus = focusPath ? (files.find((f) => f.path === focusPath) ?? null) : null;
  const [message, setMessage] = useState("");
  const [review, setReview] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [flagged, setFlagged] = useState<Array<{ path: string; reason: string }> | null>(null);

  // Keep the selection consistent with the current status; new files are not auto-selected.
  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((p) => files.some((f) => f.path === p))));
    setOwnFocus((p) => (p && files.some((x) => x.path === p) ? p : null));
  }, [files]);

  if (!project.exists) return <EmptyState title={t.git.panel.folderMissing}>{t.git.panel.folderGone(project.path)}</EmptyState>;
  if (status.isLoading) return <ListSkeleton rows={6} />;
  if (status.isError) {
    const notRepo = status.error instanceof RpcCallError && status.error.code === "GIT_NOT_REPO";
    return notRepo ? (
      <EmptyState
        icon={<GitBranch className="h-8 w-8" />}
        title={t.git.panel.notRepo}
        action={
          <Button
            onClick={async () => {
              try {
                await call("git.init", { projectId: project.id });
                toast.success(t.git.panel.initialized);
              } catch (e) {
                toast.error(t.git.panel.initFailed, errorMessage(e));
              }
            }}
          >
            {t.git.panel.initRepo}
          </Button>
        }
      >
        {t.git.panel.notRepoHint}
      </EmptyState>
    ) : (
      <div className="p-3">
        <ErrorBanner>{errorMessage(status.error)}</ErrorBanner>
      </div>
    );
  }

  const st = status.data!;
  const allSelected = files.length > 0 && selected.size === files.length;
  const toggle = (p: string, v: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (v) n.add(p);
      else n.delete(p);
      return n;
    });

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await call("git.suggestCommitMessage", { projectId: project.id, paths: selected.size ? [...selected] : undefined });
      setMessage(r.message);
      if (r.skipped.length) toast.info(t.git.panel.sensitiveSkipped, r.skipped.join(", "));
    } catch (e) {
      toast.error(t.git.panel.messageNotGenerated, errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const doCommit = async (allowSensitive: boolean) => {
    try {
      const r = await call("git.commit", { projectId: project.id, message: message.trim(), paths: [...selected], allowSensitive });
      toast.success(t.git.panel.commitCreated, `${r.hash.slice(0, 7)} ${r.summary}`);
      setMessage("");
      setSelected(new Set());
      setFlagged(null);
      void qc.invalidateQueries({ queryKey: keys.git(project.id) });
      void qc.invalidateQueries({ queryKey: keys.log(project.id) });
    } catch (e) {
      // Flagged files: resolve normally so the review dialog closes and the "Trotzdem committen?" question takes over.
      if (e instanceof RpcCallError && e.code === "POLICY_DENIED") {
        setFlagged(((e.details as { flagged?: Array<{ path: string; reason: string }> })?.flagged ?? []) as Array<{ path: string; reason: string }>);
        return;
      }
      toast.error(t.git.panel.commitFailed, errorMessage(e));
      throw e;
    }
  };

  const canCommit = selected.size > 0 && !!message.trim() && !st.summary.conflicted;
  const branch = st.summary.branch;

  return (
    <div className={cn("flex min-h-0 flex-col", embedded ? "gap-2 px-3 pb-3 pt-0.5" : "h-full gap-3 p-3")}>
      {!embedded && (
        <div className={cn("flex items-center gap-3 rounded-lg border px-3 py-2.5", files.length ? "border-accent/30 bg-accent-soft" : "border-border bg-surface")}>
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium">{files.length ? t.git.panel.changesFound : t.git.panel.noChanges}</div>
            <div className="text-xs text-muted">
              <GitBranch className="mr-1 inline h-3 w-3" />
              {branch ?? t.git.common.noBranch}
              {st.summary.ahead > 0 && t.git.panel.ahead(st.summary.ahead)}
              {st.summary.behind > 0 && t.git.panel.behind(st.summary.behind)}
              {files.length > 0 && t.git.panel.files(files.length)}
            </div>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={() => void status.refetch()} aria-label={t.git.panel.refreshStatus} title={t.git.panel.refreshStatus}>
            <RefreshCw className={cn("h-3.5 w-3.5", status.isFetching && "animate-spin")} />
          </Button>
        </div>
      )}

      {st.summary.conflicted && (
        <ErrorBanner title={t.git.panel.mergeConflict}>{t.git.panel.mergeConflictHint}</ErrorBanner>
      )}

      {files.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2">
          <div className="relative">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) {
                  e.preventDefault();
                  setReview(true);
                }
              }}
              rows={Math.min(6, message.split("\n").length + (message.length > 60 ? 1 : 0))}
              placeholder={t.git.panel.messagePlaceholder(branch ?? "HEAD")}
              aria-label={t.git.panel.commitMessage}
              className="min-h-8 py-1.5 pr-9"
              disabled={generating}
            />
            <Tooltip content={selected.size ? t.git.panel.generateFromSelected(selected.size) : t.git.panel.generateFromAll}>
              <Button
                size="icon-sm"
                variant="ghost"
                className="absolute right-0.5 top-0.5 h-7 w-7 text-accent"
                onClick={() => void generate()}
                loading={generating}
                aria-label={t.git.panel.generateWithClaude}
              >
                {!generating && <Sparkles className="h-3.5 w-3.5" />}
              </Button>
            </Tooltip>
          </div>
          <Button variant="primary" className="w-full" disabled={!canCommit} onClick={() => setReview(true)}>
            <Check className="h-4 w-4" /> {t.git.panel.createCommit(selected.size)}
          </Button>
        </div>
      )}

      {files.length === 0 && embedded && <p className="px-1 py-1 text-xs text-subtle">{t.git.panel.allCommitted}</p>}

      {files.length > 0 && (
        <div className={cn("flex min-h-0 flex-col", !embedded && (compact ? "max-h-56" : "max-h-[40%]"))}>
          <div className="flex h-6 shrink-0 items-center gap-2 px-1 text-xs text-muted">
            <Checkbox checked={allSelected} onChange={(v) => setSelected(v ? new Set(files.map((f) => f.path)) : new Set())} label={t.git.panel.selectAll} />
            <span className="flex-1">{t.git.panel.selectForCommit(selected.size, files.length)}</span>
          </div>
          <div className={cn("min-h-0", !embedded && "overflow-y-auto")}>
            {files.map((f) => {
              const k = KIND[f.kind];
              const slash = f.path.lastIndexOf("/");
              return (
                <div
                  key={f.path}
                  className={cn("flex h-6 items-center gap-2 rounded px-1 text-small-lg", focus?.path === f.path ? "bg-surface-3" : "hover:bg-surface-2")}
                >
                  <Checkbox checked={selected.has(f.path)} onChange={(v) => toggle(f.path, v)} label={t.git.panel.selectFile(f.path)} />
                  <button
                    className={cn("flex min-w-0 flex-1 items-baseline gap-1.5 text-left", f.kind === "deleted" && "line-through decoration-subtle")}
                    onClick={() => setFocusPath(f.path)}
                    title={`${f.path} (${k.label})`}
                  >
                    <span className="shrink-0 truncate">{f.path.slice(slash + 1)}</span>
                    {slash > 0 && <span className="min-w-0 truncate text-caption text-subtle">{f.path.slice(0, slash)}</span>}
                    {f.origPath && (
                      <span className="min-w-0 truncate text-caption text-subtle">
                        <ArrowLeft className="mx-1 inline h-3 w-3" aria-hidden />
                        <span className="sr-only">{t.git.panel.renamedFrom}</span>
                        {f.origPath}
                      </span>
                    )}
                  </button>
                  {f.staged && <span className="text-2xs text-subtle">{t.git.common.staged}</span>}
                  <span className={cn("w-3 text-center font-mono text-caption font-bold", k.tone)} title={k.label}>
                    {k.letter}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!embedded &&
        (focus ? (
          <DiffView projectId={project.id} path={focus.path} staged={focus.staged && !focus.unstaged} onClose={() => setFocusPath(null)} />
        ) : (
          files.length > 0 && <div className="flex-1 rounded-lg border border-dashed border-border p-4 text-center text-xs text-subtle">{t.git.panel.clickForDiff}</div>
        ))}

      <ConfirmDialog
        open={review}
        onOpenChange={setReview}
        title={t.git.panel.reviewTitle}
        description={t.git.panel.reviewDescription}
        confirmLabel={t.git.panel.commit}
        onConfirm={() => doCommit(false)}
      >
        <div className="mb-3 rounded-md bg-surface-2 px-3 py-2 font-mono text-xs whitespace-pre-wrap">{message.trim()}</div>
        <ul className="max-h-60 overflow-y-auto text-xs">
          {[...selected].map((p) => (
            <li key={p} className="truncate py-0.5 font-mono text-muted">
              {p}
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!flagged}
        onOpenChange={(o) => !o && setFlagged(null)}
        title={t.git.panel.commitAnywayTitle}
        description={t.git.panel.commitAnywayDescription}
        confirmLabel={t.git.panel.commitAnyway}
        danger
        onConfirm={() => doCommit(true)}
      >
        <ul className="space-y-1 text-xs">
          {flagged?.map((f) => (
            <li key={f.path} className="flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-danger" />
              <span className="font-mono">{f.path}</span>
              <Badge tone="danger">{f.reason}</Badge>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
