import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CheckCircle2, CircleDashed, ExternalLink, GitPullRequest, RefreshCw, Sparkles, UploadCloud, XCircle } from "lucide-react";
import type { Project } from "@forge/protocol";
import { call, keys, useGitHubAccount, useGitStatus } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, SectionTitle, Spinner } from "@/components/ui/misc";

/** Push/pull, publish to GitHub and the pull request of the current branch. */
export function SyncCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const status = useGitStatus(project.id, project.exists);
  const account = useGitHubAccount();
  const summary = status.data?.summary;
  const hasRemote = !!summary?.remoteUrl;
  const onGitHub = !!summary?.remoteUrl?.includes("github.com");
  const pr = useQuery({
    queryKey: ["pr", project.id, summary?.branch],
    queryFn: () => call("github.pr", { projectId: project.id }),
    enabled: onGitHub && !!account.data,
    staleTime: 30_000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmProtected, setConfirmProtected] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.git(project.id) });
    void qc.invalidateQueries({ queryKey: ["pr", project.id] });
    void qc.invalidateQueries({ queryKey: keys.log(project.id) });
  };

  const run = async (label: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await fn();
      toast.success(success);
      refresh();
    } catch (e) {
      if (e instanceof RpcCallError && e.code === "POLICY_DENIED" && (e.details as { protectedBranch?: string })?.protectedBranch) {
        setConfirmProtected((e.details as { protectedBranch: string }).protectedBranch);
      } else {
        toast.error(`${label} fehlgeschlagen`, errorMessage(e));
      }
    } finally {
      setBusy(null);
    }
  };

  if (!summary) return null;

  return (
    <section>
      <SectionTitle
        action={
          hasRemote && (
            <Button size="sm" variant="ghost" onClick={() => void run("Abrufen", () => call("git.fetch", { projectId: project.id }), "Remote abgerufen")} loading={busy === "Abrufen"}>
              <RefreshCw className="h-3.5 w-3.5" /> Abrufen
            </Button>
          )
        }
      >
        Synchronisieren
      </SectionTitle>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
        {!hasRemote ? (
          <div className="flex items-center gap-3">
            <p className="flex-1 text-[13px] text-muted">Kein Remote verbunden.</p>
            <Button size="sm" variant="primary" disabled={!account.data} onClick={() => setPublishing(true)} title={account.data ? undefined : "Erst unter GitHub anmelden"}>
              <UploadCloud className="h-3.5 w-3.5" /> Auf GitHub veröffentlichen
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-muted">
              {summary.upstream ?? "kein Upstream"}
              {summary.ahead > 0 && <span className="ml-2 text-fg">{summary.ahead} zum Pushen</span>}
              {summary.behind > 0 && <span className="ml-2 text-warning">{summary.behind} neu auf dem Remote</span>}
            </span>
            <Button size="sm" onClick={() => void run("Pull", () => call("git.pull", { projectId: project.id }), "Aktualisiert")} loading={busy === "Pull"}>
              <ArrowDown className="h-3.5 w-3.5" /> Pull
            </Button>
            <Button size="sm" variant="primary" onClick={() => void run("Push", () => call("git.push", { projectId: project.id }), "Gepusht")} loading={busy === "Push"}>
              <ArrowUp className="h-3.5 w-3.5" /> Push
            </Button>
          </div>
        )}

        {onGitHub && account.data && (
          <div className="border-t border-border pt-3">
            {pr.isLoading ? (
              <Spinner className="h-3.5 w-3.5" />
            ) : pr.data ? (
              <div className="flex items-center gap-2 text-[13px]">
                <GitPullRequest className="h-4 w-4 text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  #{pr.data.number} {pr.data.title}
                </span>
                <Badge tone={pr.data.state === "OPEN" ? (pr.data.draft ? "neutral" : "success") : pr.data.state === "MERGED" ? "accent" : "neutral"}>
                  {pr.data.draft ? "Entwurf" : pr.data.state === "OPEN" ? "offen" : pr.data.state === "MERGED" ? "gemergt" : "geschlossen"}
                </Badge>
                {pr.data.checks.total > 0 &&
                  (pr.data.checks.failed > 0 ? (
                    <Badge tone="danger">
                      <XCircle className="h-3 w-3" /> {pr.data.checks.failed} Checks rot
                    </Badge>
                  ) : pr.data.checks.pending > 0 ? (
                    <Badge tone="warning">
                      <CircleDashed className="h-3 w-3" /> Checks laufen
                    </Badge>
                  ) : (
                    <Badge tone="success">
                      <CheckCircle2 className="h-3 w-3" /> Checks grün
                    </Badge>
                  ))}
                {pr.data.reviewDecision === "APPROVED" && <Badge tone="success">freigegeben</Badge>}
                {pr.data.reviewDecision === "CHANGES_REQUESTED" && <Badge tone="warning">Änderungen gewünscht</Badge>}
                <Button size="icon-sm" variant="ghost" aria-label="Pull Request öffnen" onClick={() => void openExternal(pr.data!.url)}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <p className="flex-1 text-[13px] text-muted">Kein Pull Request für {summary.branch}.</p>
                <Button size="sm" onClick={() => setCreatingPr(true)} disabled={summary.branch === "main" || summary.branch === "master"} title={summary.branch === "main" || summary.branch === "master" ? "Erst einen Feature-Branch anlegen" : undefined}>
                  <GitPullRequest className="h-3.5 w-3.5" /> Pull Request erstellen
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmProtected}
        onOpenChange={(o) => !o && setConfirmProtected(null)}
        title={`Direkt auf ${confirmProtected ?? ""} pushen?`}
        description="Üblich ist ein Feature-Branch mit Pull Request. Direkt auf den Hauptbranch pushen nur, wenn das in diesem Projekt so gewollt ist. Force-Push gibt es in FORGE nicht."
        confirmLabel="Trotzdem pushen"
        danger
        requireText={confirmProtected ?? undefined}
        onConfirm={() => run("Push", () => call("git.push", { projectId: project.id, allowProtected: true }), "Gepusht")}
      />
      <PublishDialog open={publishing} onOpenChange={setPublishing} project={project} onDone={refresh} />
      <CreatePrDialog open={creatingPr} onOpenChange={setCreatingPr} project={project} onDone={refresh} />
    </section>
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
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={isPrivate} onChange={setPrivate} label="Privat" /> Privat
        </label>
      </div>
    </Dialog>
  );
}

function CreatePrDialog({ open, onOpenChange, project, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; onDone: () => void }) {
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
    if (open && !title) void suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- suggest once when the dialog opens
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pull Request erstellen"
      className="w-[680px]"
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
          <label className="mt-5 flex items-center gap-2 text-[13px]">
            <Checkbox checked={draft} onChange={setDraft} label="Als Entwurf" /> Als Entwurf
          </label>
        </div>
        <p className="text-xs text-subtle">Der Branch wird vorher gepusht (kein Force-Push).</p>
      </div>
    </Dialog>
  );
}
