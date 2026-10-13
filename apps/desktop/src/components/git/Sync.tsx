import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Badge, Checkbox, Spinner } from "@/components/ui/misc";

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
  const remote = i.remoteCommits === 1 ? "1 neuer Commit" : `${i.remoteCommits} neue Commits`;
  if (i.mode === "fast-forward") return `${remote} vom Remote übernommen.`;
  return `${remote} vom Remote übernommen, ${i.localCommits === 1 ? "dein Commit" : `deine ${i.localCommits} Commits`} darauf gesetzt (Rebase).`;
}

type SyncResult = { integrated: GitIntegrated | null; session: Session | null };

/** Fetch, pull and push as icon buttons for a section header; "Veröffentlichen" without a remote. */
export function SyncActions({ project }: { project: Project }) {
  const status = useGitStatus(project.id, project.exists);
  const account = useGitHubAccount();
  const refresh = useRefreshGit(project.id);
  const qc = useQueryClient();
  const summary = status.data?.summary;
  const [busy, setBusy] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  const run = async (label: string, fn: () => Promise<SyncResult | unknown>, success: string) => {
    setBusy(label);
    try {
      const r = (await useActivity.getState().track(project.id, label, fn)) as Partial<SyncResult> | undefined;
      refresh();
      if (r?.session) {
        // Conflicts with origin: Claude resolves them in a new session and asks when it is unclear.
        qc.setQueryData(keys.session(r.session.id), r.session);
        void qc.invalidateQueries({ queryKey: keys.sessions(project.id) });
        useUi.getState().openProject(project.id, r.session.id);
        toast.info("Konflikte mit dem Remote", "Claude führt die Stände in einer neuen Session zusammen und fragt nach, wenn etwas unklar ist.");
      } else {
        toast.success(success, integratedText(r?.integrated ?? null));
      }
    } catch (e) {
      toast.error(`${label} fehlgeschlagen`, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!summary) return null;

  return (
    <>
      {!summary.remoteUrl ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5"
          disabled={!account.data}
          onClick={() => setPublishing(true)}
          title={account.data ? "Auf GitHub veröffentlichen" : "Erst unter Einstellungen → Allgemein bei GitHub anmelden"}
        >
          <UploadCloud className="h-3.5 w-3.5" /> Veröffentlichen
        </Button>
      ) : (
        <>
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => void run("Abrufen", () => call("git.fetch", { projectId: project.id }), "Remote abgerufen")}
            loading={busy === "Abrufen"}
            aria-label="Abrufen"
            title={`Abrufen (fetch)${summary.upstream ? ` von ${summary.upstream}` : ""}`}
          >
            <CloudDownload className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5"
            onClick={() => void run("Pull", () => call("git.pull", { projectId: project.id }), "Aktualisiert")}
            loading={busy === "Pull"}
            aria-label="Pull"
            title={summary.behind > 0 ? `Pull: ${summary.behind} neu auf dem Remote` : "Pull"}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {summary.behind > 0 && <span className="text-warning">{summary.behind}</span>}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5"
            // A click on push is the consent, also for main; only automatic pushes stay off protected branches.
            onClick={() => void run("Push", () => call("git.push", { projectId: project.id, allowProtected: true }), "Gepusht")}
            loading={busy === "Push"}
            aria-label="Push"
            title={`${summary.ahead > 0 ? `Push: ${summary.ahead} Commits zum Pushen` : "Push"}. Neue Commits vom Remote übernimmt FORGE vorher, bei Konflikten hilft Claude.`}
          >
            <ArrowUp className="h-3.5 w-3.5" />
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

  if (!summary || !onGitHub || !account.data) return null;
  const onMain = summary.branch === "main" || summary.branch === "master";

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-small-lg">
      <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted" />
      {pr.isLoading ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : pr.isError ? (
        <>
          <span className="min-w-0 flex-1 truncate text-danger" title={errorMessage(pr.error)}>
            Pull Request nicht abgefragt
          </span>
          <Button size="icon-sm" variant="ghost" className="h-6 w-6" onClick={() => void pr.refetch()} loading={pr.isFetching} aria-label="Erneut abfragen" title="Erneut abfragen">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : pr.data ? (
        <>
          <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => void openExternal(pr.data!.url)} title="Auf GitHub öffnen">
            #{pr.data.number} {pr.data.title}
          </button>
          <Badge tone={pr.data.state === "OPEN" ? (pr.data.draft ? "neutral" : "success") : pr.data.state === "MERGED" ? "accent" : "neutral"}>
            {pr.data.draft ? "Entwurf" : pr.data.state === "OPEN" ? "offen" : pr.data.state === "MERGED" ? "gemergt" : "geschlossen"}
          </Badge>
          {pr.data.checks.total > 0 &&
            (pr.data.checks.failed > 0 ? (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" aria-label={`${pr.data.checks.failed} Checks rot`} />
            ) : pr.data.checks.pending > 0 ? (
              <CircleDashed className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Checks laufen" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Checks grün" />
            ))}
          {pr.data.reviewDecision === "APPROVED" && <Badge tone="success">freigegeben</Badge>}
          {pr.data.reviewDecision === "CHANGES_REQUESTED" && <Badge tone="warning">Änderungen gewünscht</Badge>}
          <Button size="icon-sm" variant="ghost" className="h-6 w-6" aria-label="Pull Request öffnen" onClick={() => void openExternal(pr.data!.url)}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-muted">Kein Pull Request für {summary.branch}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5"
            onClick={() => setCreatingPr(true)}
            disabled={onMain}
            title={onMain ? "Erst einen Feature-Branch anlegen" : undefined}
          >
            Erstellen
          </Button>
        </>
      )}
      <CreatePrDialog open={creatingPr} onOpenChange={setCreatingPr} project={project} onDone={refresh} />
    </div>
  );
}

function PublishDialog({ open, onOpenChange, project, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; onDone: () => void }) {
  const [name, setName] = useState(project.name.replace(/\s+/g, "-"));
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Auf GitHub veröffentlichen"
      description="Legt ein Repository in deinem GitHub-Konto an, verbindet es als origin und pusht den aktuellen Branch."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await call("github.publish", { projectId: project.id, private: isPrivate, name });
                toast.success("Veröffentlicht", r.url);
                onDone();
                onOpenChange(false);
              } catch (e) {
                toast.error("Nicht veröffentlicht", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Veröffentlichen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Repository-Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-body">
          <Checkbox checked={isPrivate} onChange={setPrivate} label="Privat" /> Privat
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
      toast.error("Kein Vorschlag", errorMessage(e));
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
      title="Pull Request erstellen"
      className="w-170"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim() || suggesting}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await call("github.createPr", { projectId: project.id, title, body, base, draft });
                toast.success("Pull Request erstellt", r.url);
                void openExternal(r.url);
                onDone();
                onOpenChange(false);
              } catch (e) {
                toast.error("Pull Request nicht erstellt", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Erstellen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Titel">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={suggesting} />
            </Field>
          </div>
          <Button variant="ghost" onClick={() => void suggest()} loading={suggesting} title="Titel und Beschreibung von Claude vorschlagen lassen">
            {!suggesting && <Sparkles className="h-3.5 w-3.5 text-accent" />} Vorschlag
          </Button>
        </div>
        <Field label="Beschreibung (Markdown)">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} className="font-mono text-xs" disabled={suggesting} />
        </Field>
        <div className="flex items-center gap-4">
          <div className="w-48">
            <Field label="Ziel-Branch">
              <Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono text-xs" />
            </Field>
          </div>
          <label className="mt-5 flex items-center gap-2 text-body">
            <Checkbox checked={draft} onChange={setDraft} label="Als Entwurf" /> Als Entwurf
          </label>
        </div>
        <p className="text-xs text-subtle">Der Branch wird vorher gepusht (kein Force-Push).</p>
      </div>
    </Dialog>
  );
}
