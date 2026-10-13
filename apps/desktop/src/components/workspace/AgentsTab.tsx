import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, GitBranch, GitMerge, Plus, Trash2, Users } from "lucide-react";
import type { Project, ProjectWithStatus, SessionStatus } from "@forge/protocol";
import { call, keys, useProjects } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { closeProjectTerminals } from "@/lib/terminal-registry";
import { relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { useAgentReview } from "@/stores/agent-review";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, EmptyState, ErrorBanner, SectionTitle } from "@/components/ui/misc";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

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
      ? "Das Hauptprojekt dieses Worktrees ist nicht mehr in FORGE."
      : !root.exists
        ? "Der Projektordner fehlt."
        : !root.git
          ? "Parallele Agenten brauchen ein Git-Repository."
          : null;

  const remove = async () => {
    if (!removing) return;
    try {
      closeProjectTerminals([removing.id]);
      const r = await call("worktrees.remove", { projectId: removing.id, force, deleteBranch });
      const ui = useUi.getState();
      if (ui.activeProjectId === removing.id) {
        if (root) ui.openProject(root.id);
        else ui.closeProject();
      }
      await qc.invalidateQueries({ queryKey: keys.projects });
      if (root) void qc.invalidateQueries({ queryKey: keys.branches(root.id) });
      if (r.branchError) toast.error("Worktree entfernt, Branch nicht gelöscht", r.branchError);
      else if (r.deletedBranch) toast.success("Worktree und Branch gelöscht", r.deletedBranch);
      else toast.success("Worktree entfernt", `Der Branch ${removing.git?.branch ?? ""} bleibt im Repository.`);
    } catch (e) {
      // Uncommitted changes: the dialog stays open and switches to the forced variant.
      if (e instanceof RpcCallError && e.code === "CONFLICT" && !force) setForce(true);
      else toast.error("Worktree nicht entfernt", errorMessage(e));
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
                <Plus className="h-3.5 w-3.5" /> Paralleler Agent
              </Button>
            }
          >
            Parallele Agenten
          </SectionTitle>
          <p className="mb-3 text-xs text-muted">
            Jeder Agent arbeitet in einem eigenen Worktree{root ? ` von ${root.name}` : ""}: eigener Ordner, eigener Branch. Ist ein Agent fertig, fragt FORGE, ob seine Arbeit in den Branch zurückgeht, von dem er abgezweigt ist, oder verworfen wird. Danach sind Worktree und Branch gelöscht.
            {project.parentId && root && (
              <>
                {" "}
                <button className="text-accent underline" onClick={() => openProject(root.id)}>
                  Hauptprojekt öffnen
                </button>
              </>
            )}
          </p>
          {blocker && <p className="mb-3 text-xs text-warning">{blocker}</p>}
          {projects.isLoading && <WorktreeGridSkeleton />}
          {projects.isError && <ErrorBanner title="Worktrees nicht geladen">{errorMessage(projects.error)}</ErrorBanner>}
          {projects.isSuccess && worktrees.length === 0 && (
            <EmptyState icon={<Users className="h-9 w-9" />} title="Noch keine parallelen Agenten">
              Ein paralleler Agent bekommt einen eigenen Ordner mit eigenem Branch. Du kannst mehrere gleichzeitig arbeiten lassen.
            </EmptyState>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {worktrees.map((w) => {
              const current = w.id === project.id;
              return (
                <div key={w.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate font-mono text-body" title={w.path}>
                      {w.git?.branch ?? w.name}
                    </span>
                    {!w.exists ? (
                      <Badge tone="danger">Ordner fehlt</Badge>
                    ) : (
                      w.git && (w.git.changedCount > 0 ? <Badge tone="warning">{w.git.changedCount} geändert</Badge> : <Badge tone="success">sauber</Badge>)
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {w.lastSession ? (
                      <>
                        <SessionStatusBadge status={w.lastSession.status as SessionStatus} />
                        <span className="min-w-0 flex-1 truncate text-muted">{w.lastSession.title ?? "Ohne Titel"}</span>
                        <span className="shrink-0 text-subtle">{relativeTime(w.lastSession.updatedAt)}</span>
                      </>
                    ) : (
                      <span className="text-subtle">noch keine Session</span>
                    )}
                  </div>
                  <div className="mt-1 flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => openProject(w.id)} disabled={current} title={current ? "Dieser Worktree ist gerade geöffnet" : undefined}>
                      {current ? "Geöffnet" : "Öffnen"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => useAgentReview.getState().request(w.id)} disabled={!w.exists} title="Zusammenführen oder verwerfen">
                      <GitMerge className="h-3.5 w-3.5" /> Abschließen
                    </Button>
                    <div className="flex-1" />
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => {
                        setForce(w.exists && !!w.git?.changedCount);
                        setDeleteBranch(false);
                        setRemoving(w);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Entfernen
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
        title="Worktree entfernen?"
        description={[
          force ? "Der Worktree hat nicht committete Änderungen. Der Ordner wird samt dieser Änderungen gelöscht." : "Der Ordner wird entfernt.",
          deleteBranch ? "Der Branch wird ohne Merge gelöscht, seine Commits gehen verloren." : "Branch und Commits bleiben im Repository erhalten.",
        ].join(" ")}
        confirmLabel={force || deleteBranch ? "Trotzdem entfernen" : "Entfernen"}
        danger
        requireText={force ? "LÖSCHEN" : undefined}
        onConfirm={remove}
      >
        <div className="space-y-3">
          <Checkbox
            checked={deleteBranch}
            onChange={setDeleteBranch}
            label={removing?.git?.branch ? `Branch ${removing.git.branch} auch löschen (ohne Merge)` : "Branch auch löschen (ohne Merge)"}
          />
          <p className="text-xs text-muted">Eine laufende Session, Terminals und der Dev-Server dieses Worktrees werden vorher beendet.</p>
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
      <SectionTitle>Subagenten</SectionTitle>
      <p className="mb-2 text-xs text-muted">
        Spezialisierte Helfer, die Claude innerhalb einer Session startet. Hier stehen deine eigenen, global und für dieses Projekt; dazu kommen die eingebauten von Claude Code. Anlegen und
        bearbeiten kannst du sie unter{" "}
        <button className="text-accent underline" onClick={() => setView("mcp")}>
          Erweiterungen
        </button>
        .
      </p>
      {docs.isLoading && <SubagentGridSkeleton />}
      {docs.isError && <ErrorBanner title="Subagenten nicht geladen">{errorMessage(docs.error)}</ErrorBanner>}
      {docs.data?.length === 0 && <p className="text-xs text-subtle">Noch keine eigenen Subagenten.</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
        {docs.data?.map((a) => (
          <div key={`${a.scope}:${a.name}`} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex items-center gap-2 text-body">
              <Bot className="h-4 w-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <Badge>{a.scope === "user" ? "global" : "Projekt"}</Badge>
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
    <SkeletonRegion label="Lädt Worktrees" className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
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
    <SkeletonRegion label="Lädt Subagenten" className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
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
      toast.error("Agent nicht gestartet", errorMessage(e));
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
        title: "Worktree angelegt, Session nicht gestartet",
        body: errorMessage(failure),
        action: { label: "Worktree öffnen", onClick: () => openProject(id) },
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
      title="Paralleler Agent"
      description={`Legt einen Worktree von ${root.name} mit eigenem Branch an und startet dort eine Session.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="primary" loading={busy} disabled={!name || name.endsWith("/")} onClick={() => void start()}>
            Starten
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Branch">
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono text-xs" autoFocus />
        </Field>
        <Field label="Erste Aufgabe (optional)">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Was soll dieser Agent erledigen?" />
        </Field>
      </div>
    </Dialog>
  );
}
