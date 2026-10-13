import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, Bot, Plus } from "lucide-react";
import type { ConfigDoc, ConfigDocKind } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, EmptyState, ErrorBanner, SectionTitle } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { CreateDocDialog } from "./CreateDocDialog";
import { DocEditor } from "./DocEditor";

// Must match deleteDoc in packages/sidecar/src/config/claude-config.ts.
const DELETE_NOTE: Record<ConfigDocKind, string> = {
  skill: "Der Skill-Ordner wird in den Papierkorb von FORGE verschoben: trash/skills im Datenordner (siehe Einstellungen, Diagnose). Claude lädt ihn danach nicht mehr.",
  agent: "Die Datei wird in .md.bak umbenannt und bleibt im selben Ordner. Claude lädt sie danach nicht mehr.",
};

/** Skills and subagents: list on the left, editor on the right. */
export function DocsTab({ kind, projectId }: { kind: ConfigDocKind; projectId?: string }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ["docs", kind, projectId ?? "global"], queryFn: () => call("config.docs", { kind, projectId }) });
  const [selected, setSelected] = useState<ConfigDoc | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ConfigDoc | null>(null);
  const label = kind === "skill" ? "Skill" : "Subagent";
  const plural = kind === "skill" ? "Skills" : "Subagenten";
  const refresh = () => qc.invalidateQueries({ queryKey: ["docs", kind] });

  return (
    <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-4">
      <section className="rounded-xl border border-border bg-surface p-3">
        <SectionTitle
          action={
            <Button size="icon-sm" variant="ghost" aria-label={`${label} anlegen`} onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
            </Button>
          }
        >
          {plural}
        </SectionTitle>
        {docs.isLoading && (
          <SkeletonRegion label={`Lädt ${plural}`} className="flex flex-col gap-0.5">
            {[60, 45, 70, 50].map((w, i) => (
              <div key={i} className="flex flex-col gap-1 px-2 py-1.5">
                <div className="flex h-5 items-center gap-1.5">
                  <Skeleton className="h-3" style={{ width: `${w}%` }} />
                  <Skeleton className="h-5 w-12 rounded" />
                </div>
                <Skeleton className="h-2.5 w-4/5" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {docs.isError && <ErrorBanner title={`${plural} nicht geladen`}>{errorMessage(docs.error)}</ErrorBanner>}
        {docs.data?.length === 0 && <p className="px-1 text-xs text-muted">Noch keine eigenen {plural}.</p>}
        <ul className="flex flex-col gap-0.5">
          {docs.data?.map((d) => (
            <li key={`${d.scope}:${d.name}`}>
              <button
                onClick={() => setSelected(d)}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left",
                  selected?.name === d.name && selected.scope === d.scope ? "bg-accent-soft" : "hover:bg-surface-3",
                )}
              >
                <div className="flex items-center gap-1.5 text-body">
                  <span className="truncate">{d.name}</span>
                  <Badge>{d.scope === "user" ? "global" : "Projekt"}</Badge>
                </div>
                {d.description && <div className="line-clamp-2 text-caption text-subtle">{d.description}</div>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="min-w-0 rounded-xl border border-border bg-surface p-4">
        {selected ? (
          <DocEditor key={`${selected.scope}:${selected.name}`} doc={selected} projectId={projectId} onDelete={() => setDeleting(selected)} />
        ) : (
          <EmptyState icon={kind === "skill" ? <Blocks className="h-8 w-8" /> : <Bot className="h-8 w-8" />} title={`${label} auswählen oder anlegen`}>
            {kind === "skill"
              ? "Skills sind Anleitungen, die Claude bei passenden Aufgaben automatisch lädt (SKILL.md)."
              : "Subagenten sind spezialisierte Helfer mit eigener Rolle, die Claude für Teilaufgaben startet."}
          </EmptyState>
        )}
      </section>
      <CreateDocDialog
        kind={kind}
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        onCreated={(d) => {
          void refresh();
          setSelected(d);
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`${label} ${deleting?.name ?? ""} löschen?`}
        description={DELETE_NOTE[kind]}
        confirmLabel="Löschen"
        danger
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await call("config.docDelete", { kind, scope: deleting.scope, name: deleting.name, projectId });
            toast.success(`${label} gelöscht`, deleting.name);
            setSelected(null);
            void refresh();
          } catch (e) {
            toast.error("Nicht gelöscht", errorMessage(e));
            throw e;
          }
        }}
      />
    </div>
  );
}
