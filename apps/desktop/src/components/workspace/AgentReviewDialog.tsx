import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, GitBranch, GitMerge, Trash2 } from "lucide-react";
import type { AgentReview } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { closeProjectTerminals } from "@/lib/terminal-registry";
import { useAgentReview } from "@/stores/agent-review";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Loading } from "@/components/ui/misc";
import { Markdown } from "./Markdown";

const SHOWN_COMMITS = 5;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Asks in the main window what happens with a parallel agent whose turn ended: merge its branch into
 * the one it started from, or discard it. Either way worktree and branch are gone afterwards.
 */
export function AgentReviewDialog() {
  const projectId = useAgentReview((s) => s.queue[0] ?? null);
  const done = useAgentReview((s) => s.done);
  const review = useQuery({
    queryKey: keys.agentReview(projectId ?? ""),
    queryFn: () => call("agents.review", { projectId: projectId! }),
    enabled: !!projectId,
    staleTime: 0,
    retry: false,
  });
  const gone = review.error instanceof RpcCallError && review.error.code === "NOT_FOUND";

  useEffect(() => {
    // Removed meanwhile (Agents tab, phone, another session): nothing left to decide.
    if (projectId && gone) done(projectId);
  }, [projectId, gone, done]);

  if (!projectId) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && done(projectId)}
      title="Agent fertig"
      description={review.data ? <Heading r={review.data} /> : undefined}
      className="w-160"
      footer={review.data ? <Actions key={projectId} r={review.data} onDone={() => done(projectId)} /> : undefined}
    >
      {review.isLoading && <Loading />}
      {review.isError && !gone && <p className="text-body text-danger">{errorMessage(review.error)}</p>}
      {review.data && <Details r={review.data} />}
    </Dialog>
  );
}

function Heading({ r }: { r: AgentReview }) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      <Bot className="h-3.5 w-3.5 text-accent" />
      <span className="font-mono text-fg">{r.branch ?? "ohne Branch"}</span>
      <span>in {r.rootName}</span>
      {r.targetBranch && (
        <>
          <span>, zurück nach</span>
          <span className="font-mono text-fg">{r.targetBranch}</span>
        </>
      )}
    </span>
  );
}

function Details({ r }: { r: AgentReview }) {
  const facts = [
    r.ahead ? plural(r.ahead, "Commit", "Commits") : "keine Commits",
    r.filesChanged ? plural(r.filesChanged, "Datei geändert", "Dateien geändert") : null,
    r.uncommitted ? `${plural(r.uncommitted, "nicht committete Änderung", "nicht committete Änderungen")}, wird beim Zusammenführen committet` : null,
    r.behind && r.targetBranch ? `${r.targetBranch} hat ${plural(r.behind, "neuen Commit", "neue Commits")}, die Arbeit des Agenten kommt obendrauf` : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1.5 text-caption font-medium uppercase tracking-wide text-subtle">Zusammenfassung</h3>
        {r.summary.trim() ? (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-surface-2 px-3 py-2">
            <Markdown text={r.summary} />
          </div>
        ) : (
          <p className="text-body text-muted">Der Agent hat keine Zusammenfassung geschrieben.</p>
        )}
      </section>
      <section>
        <h3 className="mb-1.5 text-caption font-medium uppercase tracking-wide text-subtle">Änderungen</h3>
        <p className="text-body text-muted">{facts.join(". ")}.</p>
        {r.commits.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {r.commits.slice(0, SHOWN_COMMITS).map((c) => (
              <li key={c.hash} className="flex min-w-0 items-center gap-2 text-body">
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-subtle" />
                <span className="shrink-0 font-mono text-xs text-subtle">{c.hash}</span>
                <span className="truncate">{c.subject}</span>
              </li>
            ))}
            {r.ahead > SHOWN_COMMITS && <li className="text-xs text-subtle">und {r.ahead - SHOWN_COMMITS} weitere</li>}
          </ul>
        )}
      </section>
      {r.mergeBlocker && <p className="rounded-lg bg-warning-soft px-3 py-2 text-body text-fg">{r.mergeBlocker}</p>}
    </div>
  );
}

function Actions({ r, onDone }: { r: AgentReview; onDone: () => void }) {
  const qc = useQueryClient();
  const openProject = useUi((s) => s.openProject);
  const [busy, setBusy] = useState<"merge" | "discard" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const finish = async (action: "merge" | "discard") => {
    setBusy(action);
    try {
      // A terminal open in the worktree folder keeps Windows from deleting it.
      closeProjectTerminals([r.projectId]);
      const res = await call("agents.finish", { projectId: r.projectId, action });
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.git(r.rootId) });
      void qc.invalidateQueries({ queryKey: keys.log(r.rootId) });
      void qc.invalidateQueries({ queryKey: keys.branches(r.rootId) });
      onDone();
      if (res.outcome === "conflict") {
        const sessionId = res.sessionId;
        toast.notify({
          tone: "warning",
          title: "Konflikte beim Zusammenführen",
          body: res.message,
          action: sessionId ? { label: "Agent öffnen", onClick: () => openProject(r.projectId, sessionId) } : undefined,
          duration: 15_000,
        });
        return;
      }
      const ui = useUi.getState();
      if (ui.view === "workspace" && ui.activeProjectId === r.projectId) openProject(r.rootId);
      toast.success(res.outcome === "merged" ? "Agent zusammengeführt" : "Agent verworfen", res.message);
    } catch (e) {
      toast.error(action === "merge" ? "Nicht zusammengeführt" : "Nicht verworfen", errorMessage(e));
      void qc.invalidateQueries({ queryKey: keys.agentReview(r.projectId) });
    } finally {
      setBusy(null);
    }
  };

  if (confirmDiscard) {
    return (
      <div className="flex w-full items-center gap-2">
        <span className="mr-auto text-body text-danger">
          {r.ahead || r.uncommitted ? "Die Arbeit des Agenten wird gelöscht und lässt sich nicht wiederherstellen." : "Worktree und Branch werden gelöscht."}
        </span>
        <Button variant="ghost" onClick={() => setConfirmDiscard(false)} disabled={!!busy}>
          Zurück
        </Button>
        <Button variant="danger" loading={busy === "discard"} onClick={() => void finish("discard")}>
          Endgültig verwerfen
        </Button>
      </div>
    );
  }
  return (
    <div className="flex w-full items-center gap-2">
      {r.sessionId && (
        <Button
          variant="ghost"
          className="mr-auto"
          onClick={() => {
            onDone();
            openProject(r.projectId, r.sessionId);
          }}
        >
          Agent öffnen
        </Button>
      )}
      <Button variant="ghost" onClick={onDone} disabled={!!busy} className={r.sessionId ? undefined : "mr-auto"}>
        Später
      </Button>
      <Button variant="danger-ghost" onClick={() => setConfirmDiscard(true)} disabled={!!busy || r.busy}>
        <Trash2 className="h-3.5 w-3.5" /> Verwerfen
      </Button>
      <Button variant="primary" loading={busy === "merge"} disabled={!!busy || !!r.mergeBlocker} title={r.mergeBlocker ?? undefined} onClick={() => void finish("merge")}>
        <GitMerge className="h-3.5 w-3.5" /> Zusammenführen
      </Button>
    </div>
  );
}
