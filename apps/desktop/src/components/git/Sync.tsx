import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, CircleDashed, CloudDownload, ExternalLink, GitPullRequest, RefreshCw, Sparkles, UploadCloud, XCircle } from "lucide-react";
import type { GitIntegrated, Project, Session } from "@forge/protocol";
import { call, keys, useGitHubAccount, useGitStatus } from "@/lib/queries";
import { useUi } from "@/stores/ui";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { toast } from "@/stores/toast";
import { useActivity } from "@/stores/activity";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Checkbox } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { GitHubOwnerSelect } from "@/components/github/GitHubOwnerSelect";
import { t } from "@/i18n";

function useRefreshGit(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.git(projectId) });
    void qc.invalidateQueries({ queryKey: ["pr", projectId] });
    void qc.invalidateQueries({ queryKey: keys.log(projectId) });
  };
}

/** "3 neue Commits vom Remote übernommen, 2 eigene darauf gesetzt" for the toast after push or pull. */
export function integratedText(i: GitIntegrated | null): string | undefined {
  if (!i) return undefined;
  const remote = t.git.sync.remoteCommits(i.remoteCommits);
  if (i.mode === "fast-forward") return t.git.sync.fastForward(remote);
  if (i.mode === "merge") return t.git.sync.mergedRemote(remote, i.localCommits);
  return t.git.sync.rebased(remote, i.localCommits);
}

type SyncResult = { integrated: GitIntegrated | null; session: Session | null };

/**
 * Runs a fetch, pull or push as project activity, refreshes the Git views and reports the outcome.
 * Conflicts with origin open the Claude session that resolves them. False when it failed.
 */
export async function runGitSync(qc: QueryClient, projectId: string, label: string, fn: () => Promise<SyncResult | unknown>, success: string): Promise<boolean> {
  try {
    const r = (await useActivity.getState().track(projectId, label, fn)) as Partial<SyncResult> | undefined;
    void qc.invalidateQueries({ queryKey: keys.git(projectId) });
    void qc.invalidateQueries({ queryKey: ["pr", projectId] });
    void qc.invalidateQueries({ queryKey: keys.log(projectId) });
    if (r?.session) {
      // Conflicts with origin: Claude resolves them in a new session and asks when it is unclear.
      qc.setQueryData(keys.session(r.session.id), r.session);
      void qc.invalidateQueries({ queryKey: keys.sessions(projectId) });
      useUi.getState().openProject(projectId, r.session.id);
      toast.info(t.git.sync.conflicts, t.git.sync.conflictsHint);
    } else {
      toast.success(success, integratedText(r?.integrated ?? null));
    }
    return true;
  } catch (e) {
    toast.error(t.git.sync.failed(label), errorMessage(e));
    return false;
  }
}

/**
 * Fetch, pull and push; "Veröffentlichen" without a remote. As icon buttons for a section header, or
 * `labeled` as framed buttons with text for a toolbar.
 */
export function SyncActions({ project, labeled = false }: { project: Project; labeled?: boolean }) {
  const status = useGitStatus(project.id, project.exists);
  const account = useGitHubAccount();
  const refresh = useRefreshGit(project.id);
  const qc = useQueryClient();
  const summary = status.data?.summary;
  const [busy, setBusy] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  // One at a time: a pull or push rebases, a second git command meanwhile fails on the lock or races it.
  const run = async (label: string, fn: () => Promise<SyncResult | unknown>, success: string) => {
    if (busy) return;
    setBusy(label);
    try {
      await runGitSync(qc, project.id, label, fn, success);
    } finally {
      setBusy(null);
    }
  };

  if (!summary)
    return status.isLoading ? (
      <SkeletonRegion label={t.git.sync.loadingSync} className={labeled ? "flex items-center gap-2" : "flex items-center gap-0.5"}>
        <Skeleton className={labeled ? "h-8 w-22" : "h-6 w-6"} />
        <Skeleton className={labeled ? "h-8 w-16" : "h-6 w-6.5"} />
        <Skeleton className={labeled ? "h-8 w-16" : "h-6 w-6.5"} />
      </SkeletonRegion>
    ) : null;

  const btn = labeled ? { size: "sm" as const, variant: "outline" as const, className: "h-8 gap-1.5 px-3" } : { size: "sm" as const, variant: "ghost" as const, className: "h-6 gap-1 px-1.5" };

  return (
    <>
      {!summary.remoteUrl ? (
        <Button
          {...btn}
          disabled={!account.data}
          onClick={() => setPublishing(true)}
          title={account.data ? t.git.sync.publishOnGitHub : t.git.sync.signInFirst}
        >
          <UploadCloud className="h-3.5 w-3.5" /> {t.git.common.publish}
        </Button>
      ) : (
        <>
          <Button
            {...(labeled ? btn : { size: "icon-sm" as const, variant: "ghost" as const, className: "h-6 w-6" })}
            onClick={() => void run(t.git.sync.fetch, () => call("git.fetch", { projectId: project.id }), t.git.sync.fetched)}
            loading={busy === t.git.sync.fetch}
            disabled={busy !== null}
            aria-label={t.git.sync.fetch}
            title={t.git.sync.fetchTitle(summary.upstream ?? null)}
          >
            <CloudDownload className="h-3.5 w-3.5" />
            {labeled && t.git.sync.fetch}
          </Button>
          <Button
            {...btn}
            onClick={() => void run(t.git.sync.pull, () => call("git.pull", { projectId: project.id }), t.git.sync.pulled)}
            loading={busy === t.git.sync.pull}
            disabled={busy !== null}
            aria-label={t.git.sync.pull}
            title={t.git.sync.pullTitle(summary.behind)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {labeled && t.git.sync.pull}
            {summary.behind > 0 && <span className="text-warning">{summary.behind}</span>}
          </Button>
          <Button
            {...btn}
            // A click on push is the consent, also for main; only automatic pushes stay off protected branches.
            onClick={() => void run(t.git.sync.push, () => call("git.push", { projectId: project.id, allowProtected: true }), t.git.sync.pushed)}
            loading={busy === t.git.sync.push}
            disabled={busy !== null}
            aria-label={t.git.sync.push}
            title={t.git.sync.pushTitle(summary.ahead)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
            {labeled && t.git.sync.push}
            {summary.ahead > 0 && <span className="text-fg">{summary.ahead}</span>}
          </Button>
        </>
      )}

      <PublishDialog open={publishing} onOpenChange={setPublishing} project={project} onDone={refresh} />
    </>
  );
}

/** The pull request of the current branch (or a button to create one), for GitHub remotes only. */
export function PullRequestBar({ project }: { project: Project }) {
  const status = useGitStatus(project.id, project.exists);
  const account = useGitHubAccount();
  const refresh = useRefreshGit(project.id);
  const summary = status.data?.summary;
  const onGitHub = !!summary?.remoteUrl?.includes("github.com");
  const pr = useQuery({
    queryKey: ["pr", project.id, summary?.branch],
    queryFn: () => call("github.pr", { projectId: project.id }),
    enabled: onGitHub && !!account.data,
    staleTime: 30_000,
  });
  const [creatingPr, setCreatingPr] = useState(false);

  // Until status and account are known the bar may still appear; its height is kept so the graph does not jump.
  if (status.isLoading || (onGitHub && account.isLoading))
    return (
      <SkeletonRegion label={t.git.sync.loadingPr} className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
        <PrStatusSkeleton />
      </SkeletonRegion>
    );
  if (!summary || !onGitHub || !account.data) return null;
  const onMain = summary.branch === "main" || summary.branch === "master";

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-small-lg">
      <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted" />
      {pr.isLoading ? (
        <SkeletonRegion label={t.git.sync.loadingPr} className="flex min-w-0 flex-1 items-center gap-2">
          <PrStatusSkeleton />
        </SkeletonRegion>
      ) : pr.isError ? (
        <>
          <span className="min-w-0 flex-1 truncate text-danger" title={errorMessage(pr.error)}>
            {t.git.sync.prNotQueried}
          </span>
          <Button size="icon-sm" variant="ghost" className="h-6 w-6" onClick={() => void pr.refetch()} loading={pr.isFetching} aria-label={t.git.sync.retry} title={t.git.sync.retry}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : pr.data ? (
        <>
          <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => void openExternal(pr.data!.url)} title={t.git.sync.openOnGitHub}>
            #{pr.data.number} {pr.data.title}
          </button>
          <Badge tone={pr.data.state === "OPEN" ? (pr.data.draft ? "neutral" : "success") : pr.data.state === "MERGED" ? "accent" : "neutral"}>
            {pr.data.draft ? t.git.sync.draft : pr.data.state === "OPEN" ? t.git.sync.open : pr.data.state === "MERGED" ? t.git.sync.merged : t.git.sync.closed}
          </Badge>
          {pr.data.checks.total > 0 &&
            (pr.data.checks.failed > 0 ? (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" aria-label={t.git.sync.checksFailed(pr.data.checks.failed)} />
            ) : pr.data.checks.pending > 0 ? (
              <CircleDashed className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={t.git.sync.checksRunning} />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-label={t.git.sync.checksPassed} />
            ))}
          {pr.data.reviewDecision === "APPROVED" && <Badge tone="success">{t.git.sync.approved}</Badge>}
          {pr.data.reviewDecision === "CHANGES_REQUESTED" && <Badge tone="warning">{t.git.sync.changesRequested}</Badge>}
          <Button size="icon-sm" variant="ghost" className="h-6 w-6" aria-label={t.git.sync.openPr} onClick={() => void openExternal(pr.data!.url)}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-muted">{t.git.sync.noPr(summary.branch)}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5"
            onClick={() => setCreatingPr(true)}
            disabled={onMain}
            title={onMain ? t.git.sync.featureBranchFirst : undefined}
          >
            {t.git.common.create}
          </Button>
        </>
      )}
      <CreatePrDialog open={creatingPr} onOpenChange={setCreatingPr} project={project} onDone={refresh} />
    </div>
  );
}

/** Title, state badge and open button of a pull request, as placeholders. */
function PrStatusSkeleton() {
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center">
        <Skeleton className="h-3 w-1/2 rounded-sm" />
      </div>
      <Skeleton className="h-5 w-12 shrink-0 rounded" />
      <Skeleton className="h-6 w-6 shrink-0" />
    </>
  );
}

function PublishDialog({ open, onOpenChange, project, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; onDone: () => void }) {
  const [name, setName] = useState(project.name.replace(/\s+/g, "-"));
  const [isPrivate, setPrivate] = useState(true);
  /** "" is the personal account */
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.git.sync.publishOnGitHub}
      description={t.git.sync.publishDescription}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t.git.common.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await call("github.publish", { projectId: project.id, private: isPrivate, name, owner: owner || undefined });
                toast.success(t.git.sync.published, r.url);
                onDone();
                onOpenChange(false);
              } catch (e) {
                toast.error(t.git.sync.notPublished, errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.git.common.publish}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t.git.sync.createIn}>
          <GitHubOwnerSelect value={owner} onChange={setOwner} />
        </Field>
        <Field label={t.git.sync.repoName}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-body">
          <Checkbox checked={isPrivate} onChange={setPrivate} label={t.git.sync.private} /> {t.git.sync.private}
        </label>
      </div>
    </Dialog>
  );
}

export function CreatePrDialog({ open, onOpenChange, project, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("main");
  const [draft, setDraft] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);

  const suggest = async () => {
    setSuggesting(true);
    try {
      const s = await call("github.suggestPr", { projectId: project.id });
      setTitle(s.title);
      setBody(s.body);
      setBase(s.base);
    } catch (e) {
      toast.error(t.git.sync.noSuggestion, errorMessage(e));
    } finally {
      setSuggesting(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // Every opening starts fresh: the branch may have changed since the last PR.
    setTitle("");
    setBody("");
    setBase("main");
    setDraft(false);
    void suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- suggest once when the dialog opens
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.git.sync.createPrTitle}
      className="w-170"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t.git.common.cancel}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim() || suggesting}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await call("github.createPr", { projectId: project.id, title, body, base, draft });
                toast.success(t.git.sync.prCreated, r.url);
                void openExternal(r.url);
                onDone();
                onOpenChange(false);
              } catch (e) {
                toast.error(t.git.sync.prNotCreated, errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.git.common.create}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label={t.git.sync.title}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={suggesting} />
            </Field>
          </div>
          <Button variant="ghost" onClick={() => void suggest()} loading={suggesting} title={t.git.sync.suggestHint}>
            {!suggesting && <Sparkles className="h-3.5 w-3.5 text-accent" />} {t.git.sync.suggestion}
          </Button>
        </div>
        <Field label={t.git.sync.description}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} className="font-mono text-xs" disabled={suggesting} />
        </Field>
        <div className="flex items-center gap-4">
          <div className="w-48">
            <Field label={t.git.sync.baseBranch}>
              <Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono text-xs" />
            </Field>
          </div>
          <label className="mt-5 flex items-center gap-2 text-body">
            <Checkbox checked={draft} onChange={setDraft} label={t.git.sync.asDraft} /> {t.git.sync.asDraft}
          </label>
        </div>
        <p className="text-xs text-subtle">{t.git.sync.pushedFirst}</p>
      </div>
    </Dialog>
  );
}
