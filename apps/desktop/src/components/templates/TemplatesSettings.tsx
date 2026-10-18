import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FileStack, Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { templatePlaceholders, type PromptTemplate } from "@forge/protocol";
import { t } from "@/i18n";
import { call, keys, useAllTemplates, useProjects, useSettings } from "@/lib/queries";
import { learnTemplatesNow } from "@/lib/template-learning";
import { contextItems } from "@/lib/context-menu";
import { errorMessage } from "@/lib/rpc";
import { useTemplateDialogs, useTemplateLearning } from "@/stores/templates";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Group, SwitchRow } from "@/components/settings/layout";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, EmptyState } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

const icon = "h-3.5 w-3.5";

/** Moves a template one place up or down within its list. */
async function move(list: PromptTemplate[], tpl: PromptTemplate, by: -1 | 1) {
  const i = list.findIndex((x) => x.id === tpl.id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  const ids = list.map((x) => x.id);
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  try {
    await call("templates.reorder", { ids });
  } catch (e) {
    toast.error(t.templates.settings.orderNotSaved, errorMessage(e));
  }
}

/** Settings page: prompt templates, global and per project, to create, edit, sort and delete. */
export function TemplatesSettings() {
  const all = useAllTemplates();
  const projects = useProjects().data ?? [];
  const openEdit = useTemplateDialogs((s) => s.openEdit);
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);
  const qc = useQueryClient();
  const learnOn = useSettings().data?.learnTemplates;
  const learning = useTemplateLearning((s) => s.running);

  if (all.isPending) {
    return (
      <SkeletonRegion label={t.templates.common.loading} className="flex flex-col gap-6">
        {[3, 2].map((rows, g) => (
          <div key={g} className="overflow-hidden rounded-xl border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-7 w-28 rounded-md" />
            </div>
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 17) % 25)}%` }} />
                  <Skeleton className="h-2.5" style={{ width: `${55 - ((i * 11) % 20)}%` }} />
                </div>
                <Skeleton className="h-7 w-28 rounded-md" />
              </div>
            ))}
          </div>
        ))}
      </SkeletonRegion>
    );
  }

  const list = all.data ?? [];
  const globals = list.filter((tpl) => !tpl.projectId);
  const byProject = projects
    .filter((p) => !p.parentId)
    .map((p) => ({ project: p, items: list.filter((tpl) => tpl.projectId === p.id) }))
    .filter((g) => g.items.length);

  const apply = (tpl: PromptTemplate) => {
    const ui = useUi.getState();
    useTemplateDialogs.getState().openApply({ projectId: tpl.projectId ?? ui.activeProjectId, templateId: tpl.id });
  };
  const rows = (items: PromptTemplate[]) =>
    items.map((tpl, i) => {
      const holes = templatePlaceholders(tpl.text);
      const actions = [
        { label: t.templates.settings.apply, icon: <Play className={icon} />, onSelect: () => apply(tpl) },
        { label: t.templates.common.edit, icon: <Pencil className={icon} />, onSelect: () => openEdit({ id: tpl.id }) },
        ...(i > 0 ? [{ label: t.templates.common.moveUp, icon: <ArrowUp className={icon} />, onSelect: () => void move(items, tpl, -1) }] : []),
        ...(i < items.length - 1 ? [{ label: t.templates.common.moveDown, icon: <ArrowDown className={icon} />, onSelect: () => void move(items, tpl, 1) }] : []),
        { label: t.templates.common.delete, icon: <Trash2 className={icon} />, danger: true, onSelect: () => setDeleting(tpl) },
      ];
      return (
        <div key={tpl.id} className="group flex items-center gap-4 px-4 py-3" onContextMenu={contextItems(() => actions)}>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-body font-medium">{tpl.name}</span>
              {tpl.learned && (
                <Badge tone="accent">
                  <Sparkles className="h-3 w-3" /> {t.templates.settings.learned}
                </Badge>
              )}
              {holes.slice(0, 4).map((h) => (
                <Badge key={h}>{`{${h}}`}</Badge>
              ))}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted">{tpl.description || tpl.text}</p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button size="icon-sm" variant="ghost" aria-label={t.templates.settings.moveUpAria(tpl.name)} title={t.templates.common.moveUp} disabled={i === 0} onClick={() => void move(items, tpl, -1)}>
              <ArrowUp className={icon} />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={t.templates.settings.moveDownAria(tpl.name)} title={t.templates.common.moveDown} disabled={i === items.length - 1} onClick={() => void move(items, tpl, 1)}>
              <ArrowDown className={icon} />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={t.templates.settings.editAria(tpl.name)} title={t.templates.common.edit} onClick={() => openEdit({ id: tpl.id })}>
              <Pencil className={icon} />
            </Button>
            <Button size="icon-sm" variant="danger-ghost" aria-label={t.templates.settings.deleteAria(tpl.name)} title={t.templates.common.delete} onClick={() => setDeleting(tpl)}>
              <Trash2 className={icon} />
            </Button>
          </div>
        </div>
      );
    });

  const newButton = (projectId: string | null) => (
    <Button size="sm" onClick={() => openEdit({ id: null, projectId })}>
      <Plus className={icon} /> {t.templates.common.newTemplate}
    </Button>
  );

  const setLearn = async (on: boolean) => {
    try {
      qc.setQueryData(keys.settings, await call("settings.update", { learnTemplates: on }));
      toast.saved();
    } catch (e) {
      toast.error(t.templates.settings.settingNotSaved, errorMessage(e));
    }
  };

  return (
    <>
      <Group
        title={t.templates.settings.learnTitle}
        description={t.templates.settings.learnDescription}
        action={
          <Button size="sm" variant="outline" disabled={learning} onClick={() => void learnTemplatesNow(qc)}>
            <Sparkles className={icon} /> {learning ? t.templates.settings.learning : t.templates.settings.learnNow}
          </Button>
        }
      >
        {learnOn === undefined ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3" aria-hidden>
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        ) : (
          <SwitchRow
            label={t.templates.settings.learnSwitch}
            description={t.templates.settings.learnSwitchDescription}
            checked={learnOn}
            onChange={(v) => void setLearn(v)}
          />
        )}
      </Group>
      <Group title={t.templates.common.global} description={t.templates.settings.globalDescription} action={newButton(null)}>
        {globals.length ? (
          rows(globals)
        ) : (
          <EmptyState icon={<FileStack className="h-5 w-5" />} title={t.templates.settings.globalEmptyTitle}>
            {t.templates.settings.globalEmptyBody}
          </EmptyState>
        )}
      </Group>
      {byProject.map(({ project, items }) => (
        <Group key={project.id} title={project.name} description={t.templates.settings.projectDescription} action={newButton(project.id)}>
          {rows(items)}
        </Group>
      ))}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t.templates.settings.deleteTitle}
        description={deleting ? t.templates.settings.deleteDescription(deleting.name, !!deleting.learned) : undefined}
        confirmLabel={t.templates.common.delete}
        danger
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await call("templates.delete", { id: deleting.id });
            void qc.invalidateQueries({ queryKey: ["templates"] });
            toast.success(t.templates.settings.deleted, deleting.name);
          } catch (e) {
            toast.error(t.templates.settings.deleteFailed, errorMessage(e));
            throw e;
          }
        }}
      />
    </>
  );
}
