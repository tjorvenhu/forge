import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, Combine, Eye, Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { KnowledgeEntry, Project } from "@forge/protocol";
import { call, keys, useKnowledge } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { KNOWLEDGE_MERGE_REQUEST, useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Markdown } from "@/components/workspace/Markdown";
import { filterKnowledge, parseTags, suggestedMerge } from "./knowledge-text";
import { MergeDialog } from "./MergeDialog";

/** Entry ids never contain a colon, so this cannot clash with one. */
const NEW = ":new";

/**
 * Knowledge of the project in `.forge/knowledge`: Claude writes and reads it through FORGE tools,
 * here it can be read, corrected and extended by hand. Worktrees show the knowledge of their project.
 */
export function KnowledgeTab({ project }: { project: Project }) {
  const owner = project.parentId ?? project.id;
  const list = useKnowledge(owner);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  /** entry the user wants to switch to while the open one has unsaved changes */
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const entries = useMemo(() => filterKnowledge(list.data ?? [], query), [list.data, query]);
  const cleanup = useKnowledgeCleanup(owner);
  /** ids preselected in the merge dialog; null while it is closed */
  const [merging, setMerging] = useState<string[] | null>(null);
  const overlapCount = cleanup.data?.overlaps.length ?? 0;
  // An edited entry stays open even when the search hides it or someone deletes it meanwhile.
  const pinned = selected !== null && (selected === NEW || dirty || !!list.data?.some((e) => e.id === selected));
  const current = pinned ? selected : (entries[0]?.id ?? null);

  useEffect(() => {
    if (dirty && current && selected !== current) setSelected(current);
  }, [dirty, current, selected]);

  const select = (id: string) => {
    if (id === current) return;
    if (dirty) setLeaveTo(id);
    else setSelected(id);
  };

  const request = useUi((s) => s.knowledgeRequest);
  useEffect(() => {
    if (!request) return;
    useUi.getState().clearKnowledgeRequest();
    if (request === KNOWLEDGE_MERGE_REQUEST) {
      setMerging(suggestedMerge(cleanup.data, null));
      return;
    }
    // A search could hide the requested entry.
    setQuery("");
    select(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request counts
  }, [request]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border xl:w-96">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Wissen durchsuchen" className="pl-8" aria-label="Wissen durchsuchen" />
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setMerging(suggestedMerge(cleanup.data, null))}
            disabled={(list.data?.length ?? 0) < 2}
            aria-label="Einträge zusammenführen"
            title={overlapCount ? `Einträge zusammenführen: ${overlapCount === 1 ? "1 Überschneidung" : `${overlapCount} Überschneidungen`} gefunden` : "Einträge zusammenführen"}
            className="relative"
          >
            <Combine className="h-4 w-4" />
            {overlapCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-caption font-semibold leading-none text-accent-fg">
                {overlapCount}
              </span>
            )}
          </Button>
          <Button size="icon" variant="primary" onClick={() => select(NEW)} aria-label="Neuer Eintrag" title="Neuer Eintrag">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.isLoading ? (
            <EntryListSkeleton />
          ) : list.isError ? (
            <div className="p-2">
              <ErrorBanner>{errorMessage(list.error)}</ErrorBanner>
            </div>
          ) : !list.data?.length ? (
            <p className="px-2 py-3 text-xs text-muted">Noch keine Einträge.</p>
          ) : !entries.length ? (
            <p className="px-2 py-3 text-xs text-muted">Nichts gefunden.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {entries.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => select(e.id)}
                    aria-current={current === e.id ? "true" : undefined}
                    className={cn(
                      "w-full rounded-lg px-3 py-2 text-left transition-colors duration-120",
                      current === e.id ? "bg-accent-soft" : "hover:bg-surface-2",
                    )}
                  >
                    <div className="truncate text-body font-medium">{e.title}</div>
                    {e.summary && <div className="line-clamp-2 text-xs text-muted">{e.summary}</div>}
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {e.tags.slice(0, 4).map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                      <span className="text-caption text-subtle">{relativeTime(e.updatedAt)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="border-t border-border px-3 py-2.5 text-caption text-subtle">
          Liegt in <span className="font-mono">.forge/knowledge</span> im Projekt und wird mit committet. Claude bekommt zu Beginn jeder Session den Index, liest passende Einträge
          selbst und legt Neues an.
        </p>
      </aside>

      <section className="min-w-0 flex-1">
        {current ? (
          <EntryEditor
            key={current}
            owner={owner}
            id={current === NEW ? null : current}
            onDirtyChange={setDirty}
            onSaved={(id) => setSelected(id)}
            onDeleted={() => setSelected(null)}
            onMerge={(list.data?.length ?? 0) >= 2 ? () => setMerging(suggestedMerge(cleanup.data, current === NEW ? null : current)) : undefined}
          />
        ) : list.isLoading ? (
          <EntrySkeleton />
        ) : (
          <EmptyState
            icon={<BookOpen className="h-8 w-8" />}
            title="Noch kein Projektwissen"
            action={
              <Button variant="primary" onClick={() => select(NEW)}>
                <Plus className="h-3.5 w-3.5" /> Ersten Eintrag anlegen
              </Button>
            }
          >
            Claude legt hier selbst ab, was es über das Projekt herausfindet: Entscheidungen, Stolperfallen, Abläufe wie Setup, Tests und Deploy. Jede neue Session bekommt den Index
            und liest bei Bedarf nach.
          </EmptyState>
        )}
      </section>

      <ConfirmDialog
        open={leaveTo !== null}
        onOpenChange={(open) => !open && setLeaveTo(null)}
        title="Änderungen verwerfen?"
        description="Der offene Eintrag hat ungespeicherte Änderungen. Beim Wechsel gehen sie verloren."
        confirmLabel="Verwerfen"
        danger
        onConfirm={() => {
          setDirty(false);
          setSelected(leaveTo);
        }}
      />
      <MergeDialog owner={owner} entries={list.data ?? []} cleanup={cleanup.data} initial={merging} onClose={() => setMerging(null)} onMerged={(id) => select(id)} />
    </div>
  );
}

function useKnowledgeCleanup(owner: string) {
  return useQuery({ queryKey: keys.knowledgeCleanup(owner), queryFn: () => call("knowledge.cleanup", { projectId: owner }), staleTime: 60_000 });
}

/** Entries of the list while it loads: title, summary, tags and date like the real buttons. */
function EntryListSkeleton() {
  return (
    <SkeletonRegion label="Lädt Einträge" className="flex flex-col gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="px-3 py-2">
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 rounded-sm" style={{ width: `${45 + ((i * 19) % 35)}%` }} />
          </div>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 w-[90%] rounded-sm" />
          </div>
          <div className="flex h-4 items-center">
            <Skeleton className="h-2.5 rounded-sm" style={{ width: `${30 + ((i * 23) % 40)}%` }} />
          </div>
          <div className="mt-1 flex items-center gap-1">
            <Skeleton className="h-5 w-14 rounded" />
            <Skeleton className="h-5 w-12 rounded" />
            <Skeleton className="ml-0.5 h-2.5 w-16 rounded-sm" />
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** An entry in the preview it opens with: header with its buttons, summary, tags and the text box. */
function EntrySkeleton() {
  return (
    <SkeletonRegion label="Lädt Eintrag" className="flex h-full flex-col gap-3 overflow-hidden px-6 py-5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 min-w-0 flex-1 items-center">
          <Skeleton className="h-4 w-1/3" />
        </div>
        <Skeleton className="h-2.5 w-24 rounded-sm" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-7 w-9" />
        <Skeleton className="h-7 w-22" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex h-5 items-center">
          <Skeleton className="h-3 w-3/5 rounded-sm" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="h-5 w-16 rounded" />
          <Skeleton className="h-5 w-12 rounded" />
          <Skeleton className="h-5 w-14 rounded" />
        </div>
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4">
          {[85, 92, 70, 0, 88, 76, 40].map((w, i) => (w ? <Skeleton key={i} className="h-3 rounded-sm" style={{ width: `${w}%` }} /> : <div key={i} className="h-1" />))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

interface Form {
  title: string;
  summary: string;
  tags: string;
  content: string;
  /** updatedAt of the entry the edit started from */
  base: string | null;
}

function toForm(e: KnowledgeEntry | null): Form {
  return e ? { title: e.title, summary: e.summary, tags: e.tags.join(", "), content: e.content, base: e.updatedAt } : { title: "", summary: "", tags: "", content: "", base: null };
}

function EntryEditor({
  owner,
  id,
  onDirtyChange,
  onSaved,
  onDeleted,
  onMerge,
}: {
  owner: string;
  id: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  /** opens the merge dialog with this entry; missing while there is nothing to merge with */
  onMerge?: () => void;
}) {
  const qc = useQueryClient();
  const entry = useQuery({ queryKey: keys.knowledgeEntry(owner, id ?? ""), queryFn: () => call("knowledge.read", { projectId: owner, id: id! }), enabled: !!id });
  const [form, setForm] = useState<Form | null>(id ? null : toForm(null));
  const [preview, setPreview] = useState(!!id);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const shown = form ?? toForm(entry.data ?? null);
  const dirty = form !== null;
  /** the open entry was deleted outside this editor, e.g. by Claude */
  const gone = !!id && entry.error instanceof RpcCallError && entry.error.code === "NOT_FOUND";
  const changedMeanwhile = !!id && !gone && dirty && !!entry.data && form.base !== entry.data.updatedAt;
  const unsaved = id ? dirty : !!form && !!(form.title.trim() || form.summary.trim() || form.tags.trim() || form.content.trim());
  useEffect(() => onDirtyChange(unsaved), [unsaved, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const edit = (patch: Partial<Form>) => {
    setForm({ ...shown, ...patch });
    setPreview(false);
  };

  const save = async () => {
    if (!form || saving) return;
    if (!form.title.trim()) return toast.error("Titel fehlt", "Jeder Eintrag braucht einen Titel.");
    setSaving(true);
    try {
      const saved = await call("knowledge.save", { projectId: owner, id: gone ? null : id, title: form.title, summary: form.summary, tags: parseTags(form.tags), content: form.content });
      qc.setQueryData(keys.knowledgeEntry(owner, saved.id), saved);
      void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
      setForm(null);
      toast.saved();
      if (!id || gone) onSaved(saved.id);
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (id && entry.isLoading) return <EntrySkeleton />;
  if (id && entry.isError && !(gone && dirty)) {
    return (
      <div className="p-6">
        <ErrorBanner>{errorMessage(entry.error)}</ErrorBanner>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-6 py-5">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-title-sm font-semibold">{id ? shown.title || "Ohne Titel" : "Neuer Eintrag"}</h2>
        {id && entry.data && <span className="text-caption text-subtle">geändert {relativeTime(entry.data.updatedAt)}</span>}
        <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)} aria-pressed={preview}>
          {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {preview ? "Bearbeiten" : "Vorschau"}
        </Button>
        {id && !gone && onMerge && (
          <Button size="sm" variant="ghost" onClick={onMerge}>
            <Combine className="h-3.5 w-3.5" /> Zusammenführen
          </Button>
        )}
        {id && !gone && (
          <Button size="sm" variant="danger-ghost" onClick={() => setDeleting(true)} aria-label="Eintrag löschen">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty} loading={saving}>
          Speichern
        </Button>
      </div>

      {changedMeanwhile && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Der Eintrag wurde inzwischen geändert, zum Beispiel von Claude.</div>
            <div className="text-xs text-muted">Neu laden verwirft deine Änderungen. Speichern überschreibt die neue Fassung.</div>
          </div>
          <Button size="sm" onClick={() => setForm(null)}>
            Neu laden
          </Button>
        </div>
      )}
      {gone && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Der Eintrag wurde inzwischen gelöscht, zum Beispiel von Claude.</div>
            <div className="text-xs text-muted">Deine Änderungen sind noch da. Speichern legt den Eintrag neu an.</div>
          </div>
        </div>
      )}

      {preview && id ? (
        <div className="flex flex-col gap-3">
          {shown.summary && <p className="text-body text-muted">{shown.summary}</p>}
          {shown.tags && (
            <div className="flex flex-wrap gap-1">
              {parseTags(shown.tags).map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          )}
          <div className="rounded-lg border border-border bg-surface p-4">
            {shown.content.trim() ? <Markdown text={shown.content} /> : <p className="text-body text-muted">Kein Text.</p>}
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Titel">
              <Input value={shown.title} onChange={(e) => edit({ title: e.target.value })} maxLength={120} placeholder="z. B. Datenbank-Migrationen mit Prisma" autoFocus={!id} />
            </Field>
            <Field label="Tags" hint="Mit Komma oder Leerzeichen getrennt">
              <Input value={shown.tags} onChange={(e) => edit({ tags: e.target.value })} placeholder="datenbank, prisma" />
            </Field>
          </div>
          <Field label="Zusammenfassung" hint="Ein Satz. Steht im Index, den Claude zu Beginn jeder Session bekommt.">
            <Input value={shown.summary} onChange={(e) => edit({ summary: e.target.value })} maxLength={300} placeholder="Wann man den Eintrag braucht und worum es geht" />
          </Field>
          <div className="min-h-72 flex-1">
            <CodeEditor value={shown.content} onChange={(content) => edit({ content })} language="markdown" onSave={() => void save()} ariaLabel="Inhalt des Eintrags" />
          </div>
        </>
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Eintrag löschen?"
        description={`„${shown.title}“ wird aus .forge/knowledge gelöscht. Über Git lässt er sich wiederherstellen, falls er schon committet war.`}
        confirmLabel="Löschen"
        danger
        onConfirm={async () => {
          try {
            await call("knowledge.delete", { projectId: owner, id: id! });
            void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
            onDeleted();
          } catch (e) {
            toast.error("Nicht gelöscht", errorMessage(e));
            throw e;
          }
        }}
      />
    </div>
  );
}
