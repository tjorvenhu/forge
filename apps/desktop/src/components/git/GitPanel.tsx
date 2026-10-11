import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, GitBranch, GitCommitHorizontal, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import type { FileStatus, Project } from "@forge/protocol";
import { call, keys, useGitStatus } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Badge, Checkbox, EmptyState, ErrorBanner, Tooltip, Loading } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DiffView } from "./DiffView";

const KIND: Record<FileStatus["kind"], { letter: string; tone: string; label: string }> = {
  modified: { letter: "M", tone: "text-warning", label: "geändert" },
  added: { letter: "A", tone: "text-success", label: "neu" },
  untracked: { letter: "U", tone: "text-success", label: "neu, nicht versioniert" },
  deleted: { letter: "D", tone: "text-danger", label: "gelöscht" },
  renamed: { letter: "R", tone: "text-accent", label: "umbenannt" },
  conflicted: { letter: "!", tone: "text-danger", label: "Konflikt" },
  typechange: { letter: "T", tone: "text-warning", label: "Typ geändert" },
};

/** Changed files, real diffs and a reviewed commit for one project. */
export function GitPanel({ project, compact = false }: { project: Project; compact?: boolean }) {
  const status = useGitStatus(project.id, project.exists);
  const qc = useQueryClient();
  const files = useMemo(() => status.data?.files ?? [], [status.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Only the path is kept; staged/unstaged come from the latest status, not from when it was clicked.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const focus = focusPath ? (files.find((f) => f.path === focusPath) ?? null) : null;
  const [message, setMessage] = useState("");
  const [review, setReview] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [flagged, setFlagged] = useState<Array<{ path: string; reason: string }> | null>(null);

  // Keep the selection consistent with the current status; new files are not auto-selected.
  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((p) => files.some((f) => f.path === p))));
    setFocusPath((p) => (p && files.some((x) => x.path === p) ? p : null));
  }, [files]);

  if (!project.exists) return <EmptyState title="Projektordner fehlt">Der Ordner {project.path} existiert nicht mehr.</EmptyState>;
  if (status.isLoading) return <Loading />;
  if (status.isError) {
    const notRepo = status.error instanceof RpcCallError && status.error.code === "GIT_NOT_REPO";
    return notRepo ? (
      <EmptyState
        icon={<GitBranch className="h-8 w-8" />}
        title="Kein Git-Repository"
        action={
          <Button
            onClick={async () => {
              try {
                await call("git.init", { projectId: project.id });
                toast.success("Git initialisiert");
              } catch (e) {
                toast.error("git init fehlgeschlagen", errorMessage(e));
              }
            }}
          >
            Repository initialisieren
          </Button>
        }
      >
        Mit Git sieht FORGE, was Claude geändert hat, und du kannst geprüfte Commits erstellen.
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
      if (r.skipped.length) toast.info("Sensible Dateien nicht an Claude gesendet", r.skipped.join(", "));
    } catch (e) {
      toast.error("Commit-Nachricht nicht erzeugt", errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const doCommit = async (allowSensitive: boolean) => {
    try {
      const r = await call("git.commit", { projectId: project.id, message: message.trim(), paths: [...selected], allowSensitive });
      toast.success("Commit erstellt", `${r.hash.slice(0, 7)} ${r.summary}`);
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
      toast.error("Commit fehlgeschlagen", errorMessage(e));
      throw e;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className={cn("flex items-center gap-3 rounded-lg border px-3 py-2.5", files.length ? "border-accent/30 bg-accent-soft" : "border-border bg-surface")}>
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium">{files.length ? "Änderungen erkannt" : "Keine Änderungen"}</div>
          <div className="text-xs text-muted">
            <GitBranch className="mr-1 inline h-3 w-3" />
            {st.summary.branch ?? "ohne Branch"}
            {st.summary.ahead > 0 && ` · ${st.summary.ahead} voraus`}
            {st.summary.behind > 0 && ` · ${st.summary.behind} zurück`}
            {files.length > 0 && ` · ${files.length} Dateien`}
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => void status.refetch()} aria-label="Status aktualisieren" title="Status aktualisieren">
          <RefreshCw className={cn("h-3.5 w-3.5", status.isFetching && "animate-spin")} />
        </Button>
      </div>

      {st.summary.conflicted && (
        <ErrorBanner title="Merge-Konflikt">Löse die Konflikte (Dateien mit „!“) zuerst auf. Commits sind bis dahin gesperrt.</ErrorBanner>
      )}

      {files.length > 0 && (
        <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border border-border", compact ? "max-h-56" : "max-h-[40%]")}>
          <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-xs text-muted">
            <Checkbox checked={allSelected} onChange={(v) => setSelected(v ? new Set(files.map((f) => f.path)) : new Set())} label="Alle auswählen" />
            <span className="flex-1">Für Commit auswählen ({selected.size})</span>
          </div>
          <div className="min-h-0 overflow-y-auto">
            {files.map((f) => {
              const k = KIND[f.kind];
              return (
                <div key={f.path} className={cn("flex items-center gap-2 px-3 py-1 text-small-lg", focus?.path === f.path ? "bg-surface-3" : "hover:bg-surface-2")}>
                  <Checkbox checked={selected.has(f.path)} onChange={(v) => toggle(f.path, v)} label={`${f.path} auswählen`} />
                  <button className="min-w-0 flex-1 truncate text-left font-mono" onClick={() => setFocusPath(f.path)} title={`${f.path} (${k.label})`}>
                    {f.path}
                    {f.origPath && (
                      <span className="text-subtle">
                        <ArrowLeft className="mx-1 inline h-3 w-3" aria-hidden />
                        <span className="sr-only">umbenannt von </span>
                        {f.origPath}
                      </span>
                    )}
                  </button>
                  {f.staged && <span className="text-2xs text-subtle">vorgemerkt</span>}
                  <span className={cn("w-3 text-center font-mono text-caption font-bold", k.tone)} title={k.label}>
                    {k.letter}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {focus ? (
        <DiffView projectId={project.id} path={focus.path} staged={focus.staged && !focus.unstaged} onClose={() => setFocusPath(null)} />
      ) : (
        files.length > 0 && <div className="flex-1 rounded-lg border border-dashed border-border p-4 text-center text-xs text-subtle">Datei anklicken, um den Diff zu sehen.</div>
      )}

      {files.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2">
          <div className="relative">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={message.includes("\n") ? 4 : 2}
              placeholder="Commit-Nachricht, z. B. feat: Login mit Passkeys"
              aria-label="Commit-Nachricht"
              className="pr-10"
              disabled={generating}
            />
            <Tooltip content={selected.size ? `Nachricht aus den ${selected.size} ausgewählten Dateien erzeugen` : "Nachricht aus allen Änderungen erzeugen"}>
              <Button
                size="icon-sm"
                variant="ghost"
                className="absolute right-1.5 top-1.5 text-accent"
                onClick={() => void generate()}
                loading={generating}
                aria-label="Commit-Nachricht mit Claude erzeugen"
              >
                {!generating && <Sparkles className="h-3.5 w-3.5" />}
              </Button>
            </Tooltip>
          </div>
          <Button variant="primary" disabled={!selected.size || !message.trim() || st.summary.conflicted} onClick={() => setReview(true)}>
            <GitCommitHorizontal className="h-4 w-4" /> Commit erstellen ({selected.size})
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={review}
        onOpenChange={setReview}
        title="Commit prüfen"
        description="Nur diese Dateien werden mit ihrem aktuellen Inhalt committet. Andere Änderungen bleiben unberührt. Es wird nichts gepusht."
        confirmLabel="Committen"
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
        title="Trotzdem committen?"
        description="Unter den ausgewählten Dateien sind sensible Dateien (z. B. .env oder Schlüsseldateien) oder Build-Artefakte. Prüfe sie, bevor du committest."
        confirmLabel="Trotzdem committen"
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
