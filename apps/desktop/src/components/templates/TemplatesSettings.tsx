import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FileStack, Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import { templatePlaceholders, type PromptTemplate } from "@forge/protocol";
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
async function move(list: PromptTemplate[], t: PromptTemplate, by: -1 | 1) {
  const i = list.findIndex((x) => x.id === t.id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return;
  const ids = list.map((x) => x.id);
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  try {
    await call("templates.reorder", { ids });
  } catch (e) {
    toast.error("Reihenfolge nicht gespeichert", errorMessage(e));
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
      <SkeletonRegion label="Lädt Vorlagen" className="flex flex-col gap-6">
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
  const globals = list.filter((t) => !t.projectId);
  const byProject = projects
    .filter((p) => !p.parentId)
    .map((p) => ({ project: p, items: list.filter((t) => t.projectId === p.id) }))
    .filter((g) => g.items.length);

  const apply = (t: PromptTemplate) => {
    const ui = useUi.getState();
    useTemplateDialogs.getState().openApply({ projectId: t.projectId ?? ui.activeProjectId, templateId: t.id });
  };
  const rows = (items: PromptTemplate[]) =>
    items.map((t, i) => {
      const holes = templatePlaceholders(t.text);
      const actions = [
        { label: "Anwenden", icon: <Play className={icon} />, onSelect: () => apply(t) },
        { label: "Bearbeiten", icon: <Pencil className={icon} />, onSelect: () => openEdit({ id: t.id }) },
        ...(i > 0 ? [{ label: "Nach oben", icon: <ArrowUp className={icon} />, onSelect: () => void move(items, t, -1) }] : []),
        ...(i < items.length - 1 ? [{ label: "Nach unten", icon: <ArrowDown className={icon} />, onSelect: () => void move(items, t, 1) }] : []),
        { label: "Löschen", icon: <Trash2 className={icon} />, danger: true, onSelect: () => setDeleting(t) },
      ];
      return (
        <div key={t.id} className="group flex items-center gap-4 px-4 py-3" onContextMenu={contextItems(() => actions)}>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-body font-medium">{t.name}</span>
              {t.learned && (
                <Badge tone="accent">
                  <Sparkles className="h-3 w-3" /> Gelernt
                </Badge>
              )}
              {holes.slice(0, 4).map((h) => (
                <Badge key={h}>{`{${h}}`}</Badge>
              ))}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted">{t.description || t.text}</p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button size="icon-sm" variant="ghost" aria-label={`${t.name} nach oben`} title="Nach oben" disabled={i === 0} onClick={() => void move(items, t, -1)}>
              <ArrowUp className={icon} />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`${t.name} nach unten`} title="Nach unten" disabled={i === items.length - 1} onClick={() => void move(items, t, 1)}>
              <ArrowDown className={icon} />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`${t.name} bearbeiten`} title="Bearbeiten" onClick={() => openEdit({ id: t.id })}>
              <Pencil className={icon} />
            </Button>
            <Button size="icon-sm" variant="danger-ghost" aria-label={`${t.name} löschen`} title="Löschen" onClick={() => setDeleting(t)}>
              <Trash2 className={icon} />
            </Button>
          </div>
        </div>
      );
    });

  const newButton = (projectId: string | null) => (
    <Button size="sm" onClick={() => openEdit({ id: null, projectId })}>
      <Plus className={icon} /> Neue Vorlage
    </Button>
  );

  const setLearn = async (on: boolean) => {
    try {
      qc.setQueryData(keys.settings, await call("settings.update", { learnTemplates: on }));
      toast.saved();
    } catch (e) {
      toast.error("Einstellung nicht gespeichert", errorMessage(e));
    }
  };

  return (
    <>
      <Group
        title="Automatisch lernen"
        description="FORGE schaut nach etwa 30 neuen Nachrichten, höchstens alle 6 Stunden, welche Aufträge du immer wieder schickst. Ab drei ähnlichen Nachrichten legt es eine Vorlage an, markiert mit „Gelernt“. Was du löschst, legt es nicht noch einmal an."
        action={
          <Button size="sm" variant="outline" disabled={learning} onClick={() => void learnTemplatesNow(qc)}>
            <Sparkles className={icon} /> {learning ? "Lernt …" : "Jetzt lernen"}
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
            label="Vorlagen aus wiederkehrenden Nachrichten lernen"
            description="Dafür liest Haiku deine letzten Nachrichten. Das zählt wie andere kurze Aufrufe von FORGE zu deinem Claude-Abo."
            checked={learnOn}
            onChange={(v) => void setLearn(v)}
          />
        )}
      </Group>
      <Group title="Global" description="In jedem Projekt. Im Chat schlägt FORGE passende Vorlagen beim Tippen vor, mit # listest du alle." action={newButton(null)}>
        {globals.length ? (
          rows(globals)
        ) : (
          <EmptyState icon={<FileStack className="h-5 w-5" />} title="Noch keine globalen Vorlagen">
            Speichere wiederkehrende Aufträge wie „Review vor Release“ einmal. Platzhalter wie {"{datei}"} fragt FORGE vor dem Senden ab. Auch per Rechtsklick auf eine eigene Nachricht im Chat.
          </EmptyState>
        )}
      </Group>
      {byProject.map(({ project, items }) => (
        <Group key={project.id} title={project.name} description="Nur in diesem Projekt und seinen Agenten" action={newButton(project.id)}>
          {rows(items)}
        </Group>
      ))}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Vorlage löschen?"
        description={
          deleting ? `„${deleting.name}“ wird gelöscht, auch auf anderen PCs mit Synchronisierung.${deleting.learned ? " FORGE lernt diese Vorlage danach nicht noch einmal." : ""}` : undefined
        }
        confirmLabel="Löschen"
        danger
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await call("templates.delete", { id: deleting.id });
            void qc.invalidateQueries({ queryKey: ["templates"] });
            toast.success("Vorlage gelöscht", deleting.name);
          } catch (e) {
            toast.error("Vorlage nicht gelöscht", errorMessage(e));
            throw e;
          }
        }}
      />
    </>
  );
}
