import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { KnowledgeMissingRef } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { TabBar } from "@/components/ui/tabs";
import { collapseContext, lineDiff, type DiffLine } from "@/components/workspace/tool-view";
import { parseTags, refsMissingLabel } from "./knowledge-text";

interface Draft {
  title: string;
  summary: string;
  tags: string;
  content: string;
  model: string;
}

type View = "changes" | "edit";

/**
 * "Mit Claude prüfen": Claude corrects the references of an entry that go nowhere. The draft shows as a
 * diff against the entry and can be edited; nothing is saved before "Übernehmen".
 */
export function FixDialog({
  owner,
  id,
  missing,
  onClose,
}: {
  owner: string;
  /** entry to correct; null closes the dialog */
  id: string | null;
  missing: KnowledgeMissingRef[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const entry = useQuery({ queryKey: keys.knowledgeEntry(owner, id ?? ""), queryFn: () => call("knowledge.read", { projectId: owner, id: id! }), enabled: !!id });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("changes");
  const [saving, setSaving] = useState(false);
  /** a draft that arrives after closing or a new request belongs to an old request */
  const attempt = useRef(0);

  const request = async () => {
    if (!id) return;
    const mine = ++attempt.current;
    setDraft(null);
    setError(null);
    setView("changes");
    try {
      const d = await call("knowledge.fixDraft", { projectId: owner, id });
      if (mine === attempt.current) setDraft({ title: d.title, summary: d.summary, tags: d.tags.join(", "), content: d.content, model: d.model });
    } catch (e) {
      if (mine === attempt.current) setError(errorMessage(e));
    }
  };

  useEffect(() => {
    if (id) void request();
    else attempt.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new entry starts a new draft
  }, [id]);

  const diff = useMemo(() => (draft && entry.data ? collapseContext(lineDiff(entry.data.content.trimEnd(), draft.content.trimEnd())) : null), [draft, entry.data]);
  const edit = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const apply = async () => {
    if (!id || !draft || saving) return;
    if (!draft.title.trim()) return toast.error(t.knowledge.common.titleMissing, t.knowledge.common.needsTitle);
    setSaving(true);
    try {
      const saved = await call("knowledge.save", { projectId: owner, id, title: draft.title, summary: draft.summary, tags: parseTags(draft.tags), content: draft.content });
      qc.setQueryData(keys.knowledgeEntry(owner, saved.id), saved);
      void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
      toast.success(t.knowledge.fix.corrected, t.knowledge.fix.correctedDetail(saved.title));
      onClose();
    } catch (e) {
      toast.error(t.knowledge.common.notSaved, errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={id !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t.knowledge.common.checkWithClaude}
      description={t.knowledge.fix.description}
      className="w-220"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t.knowledge.common.discard}
          </Button>
          <Button variant="primary" onClick={() => void apply()} disabled={!draft || !draft.content.trim()} loading={saving}>
            {t.knowledge.fix.apply}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {missing.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{refsMissingLabel(missing.length)}:</span>
            {missing.map((m) => (
              <code key={`${m.kind}:${m.ref}`} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-fg">
                {m.ref}
              </code>
            ))}
          </div>
        )}
        {error ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorBanner>{error}</ErrorBanner>
            <Button onClick={() => void request()}>{t.knowledge.common.retry}</Button>
          </div>
        ) : !draft ? (
          <FixSkeleton />
        ) : (
          <>
            <TabBar<View>
              value={view}
              onChange={setView}
              tabs={[
                { value: "changes", label: t.knowledge.fix.changes },
                { value: "edit", label: t.knowledge.common.edit },
              ]}
            />
            {view === "changes" ? (
              <DiffList lines={diff} />
            ) : (
              <>
                <div className="grid gap-3 lg:grid-cols-2">
                  <Field label={t.knowledge.common.title}>
                    <Input value={draft.title} onChange={(e) => edit({ title: e.target.value })} maxLength={120} />
                  </Field>
                  <Field label={t.knowledge.common.tags} hint={t.knowledge.common.tagsHint}>
                    <Input value={draft.tags} onChange={(e) => edit({ tags: e.target.value })} />
                  </Field>
                </div>
                <Field label={t.knowledge.common.summary}>
                  <Input value={draft.summary} onChange={(e) => edit({ summary: e.target.value })} maxLength={300} />
                </Field>
                <div className="h-80">
                  <CodeEditor value={draft.content} onChange={(content) => edit({ content })} language="markdown" ariaLabel={t.knowledge.fix.content} />
                </div>
              </>
            )}
            <p className="text-caption text-subtle">{t.knowledge.common.draftBy(draft.model)}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The draft view while Claude writes: the two tabs, the text box and the note below. */
function FixSkeleton() {
  return (
    <SkeletonRegion label={t.knowledge.common.claudeWritesDraft} className="flex flex-col gap-3">
      <div className="flex h-10 items-center gap-7 px-3">
        <Skeleton className="h-3 w-20 rounded-sm" />
        <Skeleton className="h-3 w-18 rounded-sm" />
      </div>
      <div className="flex h-80 flex-col gap-2.5 rounded-lg border border-border bg-surface p-4">
        {[30, 0, 85, 88, 0, 25, 76, 81, 45].map((w, i) => (w ? <Skeleton key={i} className="h-3 rounded-sm" style={{ width: `${w}%` }} /> : <div key={i} className="h-1" />))}
      </div>
      <p className="text-caption text-subtle">{t.knowledge.fix.checking}</p>
    </SkeletonRegion>
  );
}

const ROW: Record<Exclude<DiffLine["kind"], "gap">, { row: string; sign: string; mark: string }> = {
  add: { row: "bg-diff-add", sign: "+", mark: "text-success" },
  del: { row: "bg-diff-del", sign: "-", mark: "text-danger" },
  ctx: { row: "", sign: "", mark: "" },
};

/** The draft against the entry, unchanged runs folded; the text box has the same height as the editor. */
function DiffList({ lines }: { lines: DiffLine[] | null }) {
  if (!lines) {
    return (
      <SkeletonRegion label={t.knowledge.common.loadingEntry} className="flex h-80 flex-col gap-2.5 rounded-lg border border-border bg-surface p-4">
        {[70, 88, 0, 62, 91, 45].map((w, i) => (w ? <Skeleton key={i} className="h-3 rounded-sm" style={{ width: `${w}%` }} /> : <div key={i} className="h-1" />))}
      </SkeletonRegion>
    );
  }
  if (!lines.some((l) => l.kind === "add" || l.kind === "del")) {
    return <p className="flex h-80 items-center justify-center rounded-lg border border-border bg-surface text-body text-muted">{t.knowledge.fix.unchanged}</p>;
  }
  return (
    <div className="h-80 overflow-y-auto rounded-lg border border-border bg-surface py-1 font-mono text-small leading-relaxed" aria-label={t.knowledge.fix.diff}>
      {lines.map((l, i) =>
        l.kind === "gap" ? (
          <div key={i} className="my-1 border-t border-dashed border-border" />
        ) : (
          <div key={i} className={cn("flex", ROW[l.kind].row)}>
            <span aria-hidden className={cn("w-5 shrink-0 select-none text-center", ROW[l.kind].mark)}>
              {ROW[l.kind].sign}
            </span>
            <span className={cn("min-w-0 flex-1 whitespace-pre-wrap pr-4 wrap-anywhere", l.kind === "ctx" ? "text-muted" : "text-fg")}>{l.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}
