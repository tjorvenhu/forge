import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, GitCommitHorizontal, Plus } from "lucide-react";
import type { Project } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Badge, SectionTitle, Spinner } from "@/components/ui/misc";
import { GitPanel } from "./GitPanel";
import { SyncCard } from "./SyncCard";

/** Workspace tab: changes + history + branches. */
export function GitCenter({ project }: { project: Project }) {
  const log = useQuery({ queryKey: keys.log(project.id), queryFn: () => call("git.log", { projectId: project.id, limit: 100 }), enabled: project.exists, retry: false });
  const branches = useQuery({ queryKey: keys.branches(project.id), queryFn: () => call("git.branches", { projectId: project.id }), enabled: project.exists, retry: false });
  const [newBranch, setNewBranch] = useState(false);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.3fr)_minmax(280px,1fr)]">
      <div className="min-h-0 border-r border-border">
        <GitPanel project={project} />
      </div>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
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
          {branches.isLoading && <Spinner />}
          <div className="divide-y divide-border rounded-lg border border-border bg-surface">
            {branches.data?.map((b) => (
              <div key={b.name} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
                <GitBranch className="h-3.5 w-3.5 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.name}</span>
                {b.upstream && <span className="truncate text-[11px] text-subtle">{b.upstream}</span>}
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
          <SectionTitle>Verlauf</SectionTitle>
          {log.isLoading && <Spinner />}
          {log.data?.length === 0 && <div className="text-xs text-muted">Noch keine Commits.</div>}
          <div className="divide-y divide-border rounded-lg border border-border bg-surface">
            {log.data?.map((c) => (
              <div key={c.hash} className="flex items-start gap-2 px-3 py-2 text-[13px]">
                <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{c.subject}</div>
                  <div className="text-[11px] text-subtle">
                    <span className="font-mono">{c.shortHash}</span> · {c.author} · {relativeTime(c.date)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <NewBranchDialog open={newBranch} onOpenChange={setNewBranch} projectId={project.id} />
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
