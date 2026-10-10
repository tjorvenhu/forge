import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, GitBranch, Plus, Trash2, Users } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, keys, useProjects, useRuntimeInfo } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, SectionTitle, Loading } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { SessionStatusBadge } from "@/components/workspace/SessionStatusBadge";

/**
 * Parallel agents: each runs in its own git worktree (separate folder and branch), so several Claude
 * sessions can work on one repository at the same time without touching each other's files.
 */
export function AgentsView() {
  const projects = useProjects();
  const info = useRuntimeInfo();
  const openProject = useUi((s) => s.openProject);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<ProjectWithStatus | null>(null);
  const [force, setForce] = useState(false);
  const qc = useQueryClient();
  const all = projects.data ?? [];
  const worktrees = all.filter((p) => p.parentId);
  const parents = all.filter((p) => !p.parentId);
  const subagents = info.data?.agents ?? [];

  return (
    <Page
      title="Agenten"
      subtitle="Parallele Claude-Sessions in eigenen Worktrees"
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" /> Paralleler Agent
        </Button>
      }
    >
      <div className="flex max-w-5xl flex-col gap-6">
        <section>
          <SectionTitle>Laufende Worktrees</SectionTitle>
          {projects.isLoading && <Loading />}
          {projects.isSuccess && worktrees.length === 0 && (
            <EmptyState icon={<Users className="h-9 w-9" />} title="Noch keine parallelen Agenten">
              Ein paralleler Agent bekommt einen eigenen Ordner mit eigenem Branch. Du kannst mehrere gleichzeitig arbeiten lassen und am Ende per Pull Request zusammenführen.
              Nichts wird automatisch gemergt.
            </EmptyState>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {worktrees.map((w) => {
              const parent = all.find((p) => p.id === w.parentId);
              return (
                <div key={w.id} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-accent" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{w.git?.branch ?? "?"}</span>
                    {w.git && (w.git.changedCount > 0 ? <Badge tone="warning">{w.git.changedCount} geändert</Badge> : <Badge tone="success">sauber</Badge>)}
                  </div>
                  <div className="text-xs text-muted">aus {parent?.name ?? "Projekt"}</div>
                  <div className="flex items-center gap-2 text-xs">
                    {w.lastSession ? (
                      <>
                        <SessionStatusBadge status={w.lastSession.status as Parameters<typeof SessionStatusBadge>[0]["status"]} />
                        <span className="min-w-0 flex-1 truncate text-muted">{w.lastSession.title}</span>
                        <span className="text-subtle">{relativeTime(w.lastSession.updatedAt)}</span>
                      </>
                    ) : (
                      <span className="text-subtle">noch keine Session</span>
                    )}
                  </div>
                  <div className="mt-1 flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => openProject(w.id)}>
                      Öffnen
                    </Button>
                    <div className="flex-1" />
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => {
                        setForce(false);
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

        <section>
          <SectionTitle>Subagenten</SectionTitle>
          <p className="mb-2 text-xs text-muted">Spezialisierte Helfer, die Claude innerhalb einer Session startet. Eigene Subagenten legst du unter Erweiterungen an.</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
            {subagents.map((a) => (
              <div key={a.name} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex items-center gap-2 text-[13px]">
                  <Bot className="h-4 w-4 text-accent" /> {a.name}
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-muted">{a.description}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <NewAgentDialog open={creating} onOpenChange={setCreating} parents={parents} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Worktree entfernen?"
        description={force ? "Der Ordner wird samt nicht committeter Änderungen gelöscht. Der Branch und seine Commits bleiben im Repository." : "Der Ordner wird entfernt. Branch und Commits bleiben im Repository erhalten."}
        confirmLabel={force ? "Trotzdem entfernen" : "Entfernen"}
        danger
        requireText={force ? "LÖSCHEN" : undefined}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await call("worktrees.remove", { projectId: removing.id, force });
            void qc.invalidateQueries({ queryKey: keys.projects });
            toast.success("Worktree entfernt");
          } catch (e) {
            if (e instanceof RpcCallError && e.code === "CONFLICT") {
              setForce(true);
              setTimeout(() => setRemoving(removing), 0);
            } else toast.error("Nicht entfernt", errorMessage(e));
          }
        }}
      />
    </Page>
  );
}

function NewAgentDialog({ open, onOpenChange, parents }: { open: boolean; onOpenChange: (o: boolean) => void; parents: ProjectWithStatus[] }) {
  const activeProjectId = useUi((s) => s.activeProjectId);
  const openProject = useUi((s) => s.openProject);
  const qc = useQueryClient();
  const withGit = parents.filter((p) => p.exists && p.git);
  const [projectId, setProjectId] = useState<string | undefined>(activeProjectId ?? undefined);
  const [branch, setBranch] = useState("agent/");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const project = withGit.find((p) => p.id === projectId) ?? withGit[0];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Paralleler Agent"
      description="Legt einen Worktree mit eigenem Branch an und startet dort eine Session."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!project || !branch.trim() || branch.endsWith("/")}
            onClick={async () => {
              if (!project) return;
              setBusy(true);
              try {
                const wt = await call("worktrees.create", { projectId: project.id, branch: branch.trim() });
                let sessionId: string | null = null;
                if (prompt.trim()) sessionId = (await call("sessions.start", { projectId: wt.id, prompt })).id;
                void qc.invalidateQueries({ queryKey: keys.projects });
                onOpenChange(false);
                openProject(wt.id, sessionId);
              } catch (e) {
                toast.error("Agent nicht gestartet", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Starten
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Projekt">
          <Select value={project?.id} onChange={setProjectId} className="w-full" options={withGit.map((p) => ({ value: p.id, label: p.name }))} placeholder="Projekt mit Git wählen" />
        </Field>
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
