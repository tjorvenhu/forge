import { useMemo, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Folders } from "lucide-react";
import { call, keys, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { groupKey, groupNames, splitProjects } from "@/lib/project-tree";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useProjectGroupDialogs } from "@/stores/project-groups";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";
import { ProjectIcon } from "./ProjectIcon";
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
    if (next.group) useProjectGroupDialogs.getState().removeEmptyGroup(next.group);
    toast.success(next.group ? m.saved(next.name, next.group) : m.removed(next.name));
    return true;
  } catch (e) {
    toast.error(m.notSaved, errorMessage(e));
    return false;
  }
}

/** Puts several projects into one group with a single toast; false when one of them failed. */
export async function moveProjectsToGroup(qc: QueryClient, projects: readonly { id: string; name: string }[], group: string): Promise<boolean> {
  if (projects.length === 1) return setProjectGroup(qc, projects[0]!, group);
  const results = await Promise.allSettled(projects.map((p) => call("projects.update", { projectId: p.id, group })));
  await refresh(qc);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    toast.error(m.notSaved, errorMessage(failed.reason));
    return false;
  }
  useProjectGroupDialogs.getState().removeEmptyGroup(group);
  const first = results[0] as PromiseFulfilledResult<{ group: string | null }>;
  toast.success(m.moved(projects.length, first.value.group ?? group));
  return true;
}

/** Assigning, renaming and dissolving groups, wherever they were asked for. */
export function ProjectGroupDialogs() {
  const s = useProjectGroupDialogs();
  return (
    <>
      {s.assign && <AssignDialog key={s.assign.projectId} target={s.assign} onClose={s.close} />}
      {s.create && <CreateDialog key={s.create.group ?? ""} group={s.create.group} onClose={s.close} />}
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
  const emptyGroups = useProjectGroupDialogs((s) => s.emptyGroups);
  const existing = withEmpty(groupNames(projects.data ?? []), emptyGroups);
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

/** Group names in use plus the empty ones, sorted, each spelling once. */
function withEmpty(names: string[], empty: readonly string[]): string[] {
  const keys = new Set(names.map(groupKey));
  return [...names, ...empty.filter((g) => !keys.has(groupKey(g)))].sort((a, b) => a.localeCompare(b));
}

/**
 * "Gruppe erstellen" (group null: asks for the name) or adding projects to a group. With projects
 * picked they move into the group; without, the group is kept as an empty section to drag into.
 */
function CreateDialog({ group, onClose }: { group: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useProjects();
  const emptyGroups = useProjectGroupDialogs((s) => s.emptyGroups);
  const [value, setValue] = useState(group ?? "");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const name = value.trim();
  const roots = useMemo(() => splitProjects(projects.data ?? []).roots, [projects.data]);
  const exists = !!name && withEmpty(groupNames(roots), emptyGroups).some((g) => groupKey(g) === groupKey(name));
  const candidates = useMemo(
    () => roots.filter((p) => !name || groupKey(p.group) !== groupKey(name)).sort((a, b) => a.name.localeCompare(b.name)),
    [roots, name],
  );
  const chosen = candidates.filter((p) => picked.has(p.id));
  // Without projects there is nothing to save for a group that is already there.
  const blocked = !name || (chosen.length === 0 && (group !== null || exists));

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async () => {
    if (blocked || busy) return;
    if (chosen.length === 0) {
      useProjectGroupDialogs.getState().addEmptyGroup(name);
      // The new section must be visible: no filter for another group, and the projects page.
      useUi.getState().showProjectGroup(null);
      toast.success(m.created(name));
      onClose();
      return;
    }
    setBusy(true);
    const ok = await moveProjectsToGroup(qc, chosen, name);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={group ? m.addTitle(group) : m.create}
      description={group ? m.addDescription : m.createDescription}
      bodyClassName="flex min-h-0 flex-col"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {m.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={blocked} onClick={() => void save()}>
            {group ? m.addSubmit : m.createSubmit}
          </Button>
        </>
      }
    >
      {group === null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={m.nameLabel}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={m.namePlaceholder} maxLength={MAX_LENGTH} autoFocus />
          </Field>
          {exists && chosen.length === 0 && <p className="mt-1 text-xs text-subtle">{m.alreadyExists}</p>}
        </form>
      )}
      <div className={cn("flex min-h-0 flex-col", group === null && "mt-4")}>
        <div className="mb-1.5 text-xs font-medium text-muted">{m.projectsLabel}</div>
        {projects.isLoading ? (
          <ListSkeleton rows={4} className="rounded-lg border border-border" />
        ) : candidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-caption text-subtle">{m.noCandidates}</div>
        ) : (
          <ul className="max-h-64 overflow-y-auto rounded-lg border border-border p-1">
            {candidates.map((p) => {
              const on = picked.has(p.id);
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-3">
                    <Checkbox checked={on} onChange={(v) => toggle(p.id, v)} label={p.name} />
                    <ProjectIcon id={p.id} name={p.name} size={18} />
                    <span className="min-w-0 flex-1 truncate text-body text-fg">{p.name}</span>
                    {p.group && (
                      <span className="flex shrink-0 items-center gap-1 text-caption text-subtle">
                        <Folders className="h-3 w-3" />
                        {p.group}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
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
