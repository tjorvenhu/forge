import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, GitCommitHorizontal, Plus, RotateCcw } from "lucide-react";
import type { CommitInfo, Project } from "@forge/protocol";
import { call, keys, useGitStatus } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Badge, ErrorBanner, SectionTitle, Loading } from "@/components/ui/misc";
import { GitPanel } from "./GitPanel";
import { SyncCard } from "./SyncCard";
import { RestoreDialog } from "./RestoreDialog";

/** Workspace tab: changes + history + branches. */
export function GitCenter({ project }: { project: Project }) {
  const log = useQuery({ queryKey: keys.log(project.id), queryFn: () => call("git.log", { projectId: project.id, limit: 100 }), enabled: project.exists, retry: false });
  const branches = useQuery({ queryKey: keys.branches(project.id), queryFn: () => call("git.branches", { projectId: project.id }), enabled: project.exists, retry: false });
  const [newBranch, setNewBranch] = useState(false);
  const [restoring, setRestoring] = useState<CommitInfo | null>(null);
  const status = useGitStatus(project.id, project.exists);
  const openChanges = status.data?.files.length ?? 0;

  // Without a repository only the "initialise" prompt of GitPanel makes sense. GitPanel keeps its place
  // in the tree: remounting it would refetch the failed status and flip this condition in a loop.
  const notRepo = status.error instanceof RpcCallError && status.error.code === "GIT_NOT_REPO";

  return (
    <div className={cn("grid h-full min-h-0", notRepo ? "grid-cols-1" : "grid-cols-[minmax(0,1.3fr)_minmax(280px,1fr)]")}>
      <div className={cn("min-h-0", !notRepo && "border-r border-border")}>
        <GitPanel project={project} />
      </div>
      <div className={cn("flex min-h-0 flex-col gap-4 overflow-y-auto p-4", notRepo && "hidden")}>
        <SyncCard project={project} />
        <section>
          <SectionTitle
            action={
              <Button size="sm" variant="ghost" onClick={() => setNewBranch(true)} disabled={!branches.data}>
                <Plus className="h-3.5 w-3.5" /> Branch
              </Button>
            }
          >
            Branches
          </SectionTitle>
          {branches.isLoading && <Loading />}
          {branches.isError && <ErrorBanner title="Branches nicht geladen">{errorMessage(branches.error)}</ErrorBanner>}
          <div className={cn("divide-y divide-border rounded-lg border border-border bg-surface", !branches.data?.length && "hidden")}>
            {branches.data?.map((b) => (
              <div key={b.name} className="flex items-center gap-2 px-3 py-1.5 text-body">
                <GitBranch className="h-3.5 w-3.5 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
                {b.upstream && <span className="truncate text-caption text-subtle">{b.upstream}</span>}
                {b.current ? (
                  <Badge tone="accent">aktuell</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void checkout(project.id, b.name, false)}>
                    Wechseln
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
        <section className="min-h-0">
          <SectionTitle>Verlauf und Wiederherstellung</SectionTitle>
          {log.isLoading && <Loading />}
          {log.isError && <ErrorBanner title="Verlauf nicht geladen">{errorMessage(log.error)}</ErrorBanner>}
          {log.data?.length === 0 && <div className="text-xs text-muted">Noch keine Commits.</div>}
          {!!log.data?.length && <p className="mb-2 text-xs text-muted">Wähle einen Commit, um alle Dateien auf seinen Stand zurückzuholen. Der Verlauf bleibt erhalten.</p>}
          <div className={cn("divide-y divide-border rounded-lg border border-border bg-surface", !log.data?.length && "hidden")}>
            {log.data?.map((c, i) => {
              const current = i === 0;
              return (
                <div key={c.hash} className="group flex items-start gap-2 px-3 py-2 text-body">
                  <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{c.subject}</span>
                      {current && <Badge tone="accent">aktuell</Badge>}
                    </div>
                    <div className="text-caption text-subtle">
                      <span className="font-mono">{c.shortHash}</span> · {c.author} · {relativeTime(c.date)}
                    </div>
                  </div>
                  {(!current || openChanges > 0) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => setRestoring(c)}
                      aria-label={current ? "Offene Änderungen beiseitelegen" : `Auf den Stand von ${c.shortHash} zurück`}
                      title={current ? "Offene Änderungen beiseitelegen" : "Alle Dateien auf diesen Stand zurückholen"}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> {current ? "Beiseitelegen" : "Wiederherstellen"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
      <NewBranchDialog open={newBranch} onOpenChange={setNewBranch} projectId={project.id} />
      <RestoreDialog
        projectId={project.id}
        commit={restoring}
        current={!!restoring && restoring.hash === log.data?.[0]?.hash}
        openChanges={openChanges}
        onOpenChange={(o) => !o && setRestoring(null)}
      />
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
