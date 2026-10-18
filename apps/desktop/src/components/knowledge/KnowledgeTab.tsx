import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpen, CheckCheck, Combine, Eye, Link2Off, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import type { KnowledgeEntry, KnowledgeMissingRef, Project } from "@forge/protocol";
import { contextItems } from "@/lib/context-menu";
import { call, keys, useKnowledge, useKnowledgeStale } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { t } from "@/i18n";
import { KNOWLEDGE_MERGE_REQUEST, KNOWLEDGE_STALE_REQUEST, knowledgeFixRequest, useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Markdown } from "@/components/workspace/Markdown";
import { filterKnowledge, parseTags, refsMissingLabel, staleById, suggestedMerge } from "./knowledge-text";
import { markKnowledgeChecked, recheckKnowledgeRefs } from "./knowledge-actions";
import { AutoMergeDialog } from "./AutoMergeDialog";
import { FixDialog } from "./FixDialog";
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
  const qc = useQueryClient();
  const staleQuery = useKnowledgeStale(owner, (list.data?.length ?? 0) > 0);
  const stale = useMemo(() => staleById(staleQuery.data), [staleQuery.data]);
  /** only entries whose references go nowhere */
  const [onlyStale, setOnlyStale] = useState(false);
  const entries = useMemo(() => filterKnowledge(list.data ?? [], query).filter((e) => !onlyStale || stale.has(e.id)), [list.data, query, onlyStale, stale]);
  const cleanup = useKnowledgeCleanup(owner);
  /** entry Claude corrects; null while the dialog is closed */
  const [fixing, setFixing] = useState<string | null>(null);
  /** entry whose references are being checked again ("" for all) */
  const [rechecking, setRechecking] = useState<string | null>(null);
  const recheck = async (id?: string) => {
    setRechecking(id ?? "");
    await recheckKnowledgeRefs(qc, owner, id);
    setRechecking(null);
  };
  /** ids preselected in the merge dialog; null while it is closed */
  const [merging, setMerging] = useState<string[] | null>(null);
  /** Claude picks and merges on its own */
  const [tidying, setTidying] = useState(false);
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
      setTidying(true);
      return;
    }
    // A search could hide the requested entry.
    setQuery("");
    if (request === KNOWLEDGE_STALE_REQUEST) {
      setOnlyStale(true);
      return;
    }
    const fix = request.startsWith(knowledgeFixRequest("")) ? request.slice(knowledgeFixRequest("").length) : null;
    setOnlyStale(false);
    select(fix ?? request);
    if (fix) setFixing(fix);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request counts
  }, [request]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border xl:w-96">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.knowledge.tab.search} className="pl-8" aria-label={t.knowledge.tab.search} />
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setTidying(true)}
            disabled={(list.data?.length ?? 0) < 2}
            aria-label={t.knowledge.tab.mergeEntries}
            title={overlapCount ? t.knowledge.tab.mergeHintWithOverlaps(overlapCount) : t.knowledge.tab.mergeHint}
            className="relative"
          >
            <Combine className="h-4 w-4" />
            {overlapCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-caption font-semibold leading-none text-accent-fg">
                {overlapCount}
              </span>
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setOnlyStale(!onlyStale)}
            aria-pressed={onlyStale}
            aria-label={t.knowledge.tab.onlyStale}
            title={stale.size ? t.knowledge.tab.staleHint(stale.size) : t.knowledge.tab.onlyStale}
            className={cn("relative", onlyStale && "bg-accent-soft")}
          >
            <Link2Off className="h-4 w-4" />
            {stale.size > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-caption font-semibold leading-none text-accent-fg">
                {stale.size}
              </span>
            )}
          </Button>
          <Button size="icon" variant="primary" onClick={() => select(NEW)} aria-label={t.knowledge.tab.newEntry} title={t.knowledge.tab.newEntry}>
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
            <p className="px-2 py-3 text-xs text-muted">{t.knowledge.tab.noEntries}</p>
          ) : !entries.length ? (
            <p className="px-2 py-3 text-xs text-muted">{onlyStale && !query.trim() ? t.knowledge.tab.noStale : t.knowledge.common.nothingFound}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {entries.map((e) => {
                const missing = stale.get(e.id);
                return (
                <li
                  key={e.id}
                  onContextMenu={contextItems(() => [
                    { label: t.knowledge.tab.checkRefs, icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: () => void recheck(e.id) },
                    ...(missing
                      ? [
                          {
                            label: t.knowledge.common.checkWithClaude,
                            icon: <Sparkles className="h-3.5 w-3.5" />,
                            onSelect: () => {
                              select(e.id);
                              setFixing(e.id);
                            },
                          },
                          { label: t.knowledge.common.markChecked, icon: <CheckCheck className="h-3.5 w-3.5" />, onSelect: () => void markKnowledgeChecked(qc, owner, e.id) },
                        ]
                      : []),
                  ])}
                >
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
                      {missing && (
                        <span title={refsMissingLabel(missing.length)}>
                          <Badge tone="warning">
                            <Link2Off className="h-3 w-3" aria-hidden /> {missing.length}
                          </Badge>
                        </span>
                      )}
                      {e.tags.slice(0, 4).map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                      <span className="text-caption text-subtle">{relativeTime(e.updatedAt)}</span>
                    </div>
                  </button>
                </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="border-t border-border px-3 py-2.5 text-caption text-subtle">
          {t.knowledge.tab.storedIn}
          <span className="font-mono">.forge/knowledge</span>
          {t.knowledge.tab.storedInRest}
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
            refs={
              current === NEW
                ? undefined
                : {
                    missing: staleQuery.isPending ? null : (stale.get(current) ?? []),
                    rechecking: rechecking === current || rechecking === "",
                    onRecheck: () => void recheck(current),
                    onFix: () => setFixing(current),
                    onMarkChecked: () => void markKnowledgeChecked(qc, owner, current),
                  }
            }
          />
        ) : list.isLoading ? (
          <EntrySkeleton />
        ) : (
          <EmptyState
            icon={<BookOpen className="h-8 w-8" />}
            title={t.knowledge.tab.emptyTitle}
            action={
              <Button variant="primary" onClick={() => select(NEW)}>
                <Plus className="h-3.5 w-3.5" /> {t.knowledge.tab.createFirst}
              </Button>
            }
          >
            {t.knowledge.tab.emptyHint}
          </EmptyState>
        )}
      </section>

      <ConfirmDialog
        open={leaveTo !== null}
        onOpenChange={(open) => !open && setLeaveTo(null)}
        title={t.knowledge.tab.discardTitle}
        description={t.knowledge.tab.discardDescription}
        confirmLabel={t.knowledge.common.discard}
        danger
        onConfirm={() => {
          setDirty(false);
          setSelected(leaveTo);
        }}
      />
      <AutoMergeDialog owner={owner} entries={list.data ?? []} open={tidying} onClose={() => setTidying(false)} onManual={() => setMerging(suggestedMerge(cleanup.data, null))} />
      <FixDialog owner={owner} id={fixing} missing={fixing ? (stale.get(fixing) ?? []) : []} onClose={() => setFixing(null)} />
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
    <SkeletonRegion label={t.knowledge.tab.loadingEntries} className="flex flex-col gap-0.5">
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
    <SkeletonRegion label={t.knowledge.common.loadingEntry} className="flex h-full flex-col gap-3 overflow-hidden px-6 py-5">
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

interface RefState {
  /** null while the first check runs */
  missing: KnowledgeMissingRef[] | null;
  rechecking: boolean;
  onRecheck: () => void;
  onFix: () => void;
  onMarkChecked: () => void;
}

/** Place in the header for the result of the reference check: a skeleton while it runs, a badge when refs are missing. */
function RefStatus({ refs }: { refs: RefState }) {
  if (refs.missing === null) {
    return (
      <SkeletonRegion label={t.knowledge.tab.checkingRefs} className="flex items-center">
        <Skeleton className="h-5 w-10 rounded" />
      </SkeletonRegion>
    );
  }
  if (!refs.missing.length) return null;
  return (
    <span title={refsMissingLabel(refs.missing.length)}>
      <Badge tone="warning">
        <Link2Off className="h-3 w-3" aria-hidden /> {refs.missing.length}
      </Badge>
    </span>
  );
}

/** Which references go nowhere, with the actions for them; the list turns into a skeleton while it is checked again. */
function MissingRefs({ refs, missing }: { refs: RefState; missing: KnowledgeMissingRef[] }) {
  return (
    <div role="status" aria-label={t.knowledge.tab.missingRefs} className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-56 flex-1 items-center gap-3">
          <Link2Off className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="font-medium">{t.knowledge.tab.missingInProject(refsMissingLabel(missing.length))}</div>
            <div className="text-xs text-muted">{t.knowledge.tab.probablyStale}</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={refs.onRecheck} disabled={refs.rechecking} aria-label={t.knowledge.tab.recheckRefs} title={t.knowledge.tab.recheck}>
            <RefreshCw className={cn("h-3.5 w-3.5", refs.rechecking && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={refs.onMarkChecked} title={t.knowledge.tab.refsAreFine}>
            <CheckCheck className="h-3.5 w-3.5" /> {t.knowledge.common.markChecked}
          </Button>
          <Button size="sm" variant="primary" onClick={refs.onFix}>
            <Sparkles className="h-3.5 w-3.5" /> {t.knowledge.common.checkWithClaude}
          </Button>
        </div>
      </div>
      {refs.rechecking ? (
        <SkeletonRegion label={t.knowledge.tab.checkingRefs} className="flex flex-col gap-1 pl-7">
          {missing.map((m, i) => (
            <div key={`${m.kind}:${m.ref}`} className="flex h-5 items-center gap-2">
              <Skeleton className="h-4 rounded bg-surface-3" style={{ width: `${Math.min(40, 8 + m.ref.length)}ch` }} />
              <Skeleton className="h-2.5 rounded-sm bg-surface-3" style={{ width: `${20 + ((i * 17) % 25)}%` }} />
            </div>
          ))}
        </SkeletonRegion>
      ) : (
        <ul className="flex flex-col gap-1 pl-7">
          {missing.map((m) => (
            <li key={`${m.kind}:${m.ref}`} className="flex min-h-5 flex-wrap items-center gap-x-2 text-xs">
              <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-caption text-fg">{m.ref}</code>
              <span className="text-muted">
                {m.kind === "path" ? t.knowledge.tab.fileOrFolder : t.knowledge.tab.identifier}
                {m.hint ? `, ${m.hint}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  refs,
}: {
  owner: string;
  id: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  /** opens the merge dialog with this entry; missing while there is nothing to merge with */
  onMerge?: () => void;
  /** references of the entry that go nowhere; missing for a new entry */
  refs?: RefState;
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
    if (!form.title.trim()) return toast.error(t.knowledge.common.titleMissing, t.knowledge.common.needsTitle);
    setSaving(true);
    try {
      const saved = await call("knowledge.save", { projectId: owner, id: gone ? null : id, title: form.title, summary: form.summary, tags: parseTags(form.tags), content: form.content });
      qc.setQueryData(keys.knowledgeEntry(owner, saved.id), saved);
      void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
      setForm(null);
      toast.saved();
      if (!id || gone) onSaved(saved.id);
    } catch (e) {
      toast.error(t.knowledge.common.notSaved, errorMessage(e));
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
        <h2 className="min-w-0 flex-1 truncate text-title-sm font-semibold">{id ? shown.title || t.knowledge.tab.untitled : t.knowledge.tab.newEntry}</h2>
        {id && !gone && refs && <RefStatus refs={refs} />}
        {id && entry.data && <span className="text-caption text-subtle">{t.knowledge.tab.changedAgo(relativeTime(entry.data.updatedAt))}</span>}
        <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)} aria-pressed={preview}>
          {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {preview ? t.knowledge.common.edit : t.knowledge.tab.preview}
        </Button>
        {id && !gone && onMerge && (
          <Button size="sm" variant="ghost" onClick={onMerge}>
            <Combine className="h-3.5 w-3.5" /> {t.knowledge.common.merge}
          </Button>
        )}
        {id && !gone && (
          <Button size="sm" variant="danger-ghost" onClick={() => setDeleting(true)} aria-label={t.knowledge.tab.deleteEntry}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty} loading={saving}>
          {t.knowledge.tab.save}
        </Button>
      </div>

      {changedMeanwhile && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.knowledge.tab.changedMeanwhile}</div>
            <div className="text-xs text-muted">{t.knowledge.tab.changedMeanwhileHint}</div>
          </div>
          <Button size="sm" onClick={() => setForm(null)}>
            {t.knowledge.tab.reload}
          </Button>
        </div>
      )}
      {id && !gone && refs?.missing?.length ? <MissingRefs refs={refs} missing={refs.missing} /> : null}
      {gone && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.knowledge.tab.deletedMeanwhile}</div>
            <div className="text-xs text-muted">{t.knowledge.tab.deletedMeanwhileHint}</div>
          </div>
        </div>
      )}

      {preview && id ? (
        <div className="flex flex-col gap-3">
          {shown.summary && <p className="text-body text-muted">{shown.summary}</p>}
          {shown.tags && (
            <div className="flex flex-wrap gap-1">
              {parseTags(shown.tags).map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}
          <div className="rounded-lg border border-border bg-surface p-4">
            {shown.content.trim() ? <Markdown text={shown.content} /> : <p className="text-body text-muted">{t.knowledge.tab.noText}</p>}
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label={t.knowledge.common.title}>
              <Input value={shown.title} onChange={(e) => edit({ title: e.target.value })} maxLength={120} placeholder={t.knowledge.tab.titlePlaceholder} autoFocus={!id} />
            </Field>
            <Field label={t.knowledge.common.tags} hint={t.knowledge.common.tagsHint}>
              <Input value={shown.tags} onChange={(e) => edit({ tags: e.target.value })} placeholder={t.knowledge.tab.tagsPlaceholder} />
            </Field>
          </div>
          <Field label={t.knowledge.common.summary} hint={t.knowledge.tab.summaryHint}>
            <Input value={shown.summary} onChange={(e) => edit({ summary: e.target.value })} maxLength={300} placeholder={t.knowledge.tab.summaryPlaceholder} />
          </Field>
          <div className="min-h-72 flex-1">
            <CodeEditor value={shown.content} onChange={(content) => edit({ content })} language="markdown" onSave={() => void save()} ariaLabel={t.knowledge.tab.content} />
          </div>
        </>
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t.knowledge.tab.deleteTitle}
        description={t.knowledge.tab.deleteDescription(shown.title)}
        confirmLabel={t.knowledge.tab.delete}
        danger
        onConfirm={async () => {
          try {
            await call("knowledge.delete", { projectId: owner, id: id! });
            void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
            onDeleted();
          } catch (e) {
            toast.error(t.knowledge.tab.notDeleted, errorMessage(e));
            throw e;
          }
        }}
      />
    </div>
  );
}
