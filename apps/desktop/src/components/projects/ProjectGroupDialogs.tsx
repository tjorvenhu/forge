import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Folders } from "lucide-react";
import { call, keys, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { groupKey, groupNames } from "@/lib/project-tree";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useProjectGroupDialogs } from "@/stores/project-groups";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { t } from "@/i18n";

const m = t.projects.groups;
const MAX_LENGTH = 60;

async function refresh(qc: QueryClient, projectId?: string) {
  await qc.invalidateQueries({ queryKey: keys.projects });
  if (projectId) void qc.invalidateQueries({ queryKey: keys.project(projectId) });
}

/** Puts a project into a group (null: out of its group); false when it failed (the toast is shown). */
export async function setProjectGroup(qc: QueryClient, p: { id: string; name: string }, group: string | null): Promise<boolean> {
  try {
    const next = await call("projects.update", { projectId: p.id, group });
    await refresh(qc, p.id);
    toast.success(next.group ? m.saved(next.name, next.group) : m.removed(next.name));
    return true;
  } catch (e) {
    toast.error(m.notSaved, errorMessage(e));
    return false;
  }
}

/** Assigning, renaming and dissolving groups, wherever they were asked for. */
export function ProjectGroupDialogs() {
  const s = useProjectGroupDialogs();
  return (
    <>
      {s.assign && <AssignDialog key={s.assign.projectId} target={s.assign} onClose={s.close} />}
      {s.rename && <RenameDialog key={s.rename} group={s.rename} onClose={s.close} />}
      <DissolveDialog group={s.dissolve} onClose={s.close} />
    </>
  );
}

function AssignDialog({ target, onClose }: { target: { projectId: string; name: string; group: string | null }; onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useProjects();
  const [value, setValue] = useState(target.group ?? "");
  const [busy, setBusy] = useState(false);
  const existing = groupNames(projects.data ?? []);
  const name = value.trim();
  const unchanged = name === (target.group ?? "");

  const save = async (group: string | null) => {
    setBusy(true);
    const ok = await setProjectGroup(qc, { id: target.projectId, name: target.name }, group);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={m.assignTitle(target.name)}
      description={m.assignDescription}
      footer={
        <>
          {target.group && (
            <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void save(null)}>
              {m.removeFromGroup}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {m.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={!name || unchanged} onClick={() => void save(name)}>
            {m.save}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name && !unchanged && !busy) void save(name);
        }}
      >
        <Field label={m.nameLabel}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={m.namePlaceholder} maxLength={MAX_LENGTH} autoFocus />
        </Field>
      </form>
      {existing.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-muted">{m.existing}</div>
          <div className="flex flex-wrap gap-1.5">
            {existing.map((g) => {
              const current = groupKey(g) === groupKey(name || null);
              return (
                <button
                  key={g}
                  type="button"
                  onClick={() => setValue(g)}
                  aria-pressed={current}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-caption transition-colors duration-120",
                    current ? "border-accent bg-accent-soft text-fg" : "border-border bg-surface-2 text-muted hover:border-border-strong hover:text-fg",
                  )}
                >
                  <Folders className="h-3.5 w-3.5" />
                  {g}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function RenameDialog({ group, onClose }: { group: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(group);
  const [busy, setBusy] = useState(false);
  const name = value.trim();
  const blocked = !name || name === group;

  const save = async () => {
    setBusy(true);
    try {
      await call("projects.renameGroup", { from: group, to: name });
      await refresh(qc);
      // The page filter follows the group to its new name.
      if (useUi.getState().projectGroupFilter === groupKey(group)) useUi.setState({ projectGroupFilter: groupKey(name) });
      toast.success(m.renamed(name));
      onClose();
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={m.renameTitle(group)}
      description={m.renameDescription}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {m.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={blocked} onClick={() => void save()}>
            {m.save}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked && !busy) void save();
        }}
      >
        <Field label={m.newName}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={MAX_LENGTH} autoFocus onFocus={(e) => e.target.select()} />
        </Field>
      </form>
    </Dialog>
  );
}

function DissolveDialog({ group, onClose }: { group: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useProjects();
  const count = group ? (projects.data ?? []).filter((p) => !p.parentId && groupKey(p.group) === groupKey(group)).length : 0;
  return (
    <ConfirmDialog
      open={group !== null}
      onOpenChange={(o) => !o && onClose()}
      title={m.dissolveTitle(group ?? "")}
      description={m.dissolveDescription(count)}
      confirmLabel={m.dissolve}
      onConfirm={async () => {
        if (!group) return;
        try {
          await call("projects.renameGroup", { from: group, to: null });
          await refresh(qc);
          if (useUi.getState().projectGroupFilter === groupKey(group)) useUi.setState({ projectGroupFilter: null });
          toast.success(m.dissolved(group));
        } catch (e) {
          toast.error(m.notSaved, errorMessage(e));
          throw e;
        }
      }}
    />
  );
}
