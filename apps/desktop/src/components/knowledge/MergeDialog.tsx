import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import type { KnowledgeCleanup, KnowledgeSummary } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { filterKnowledge, overlapPartners, parseTags } from "./knowledge-text";

/** knowledge.merge takes at most six entries: the one that stays and five that go into it. */
const MAX_OTHERS = 5;

interface Draft {
  title: string;
  summary: string;
  tags: string;
  content: string;
  model: string;
}

/**
 * Merging entries on one topic: pick the entry that stays and those that go into it, let Claude write
 * the merged text, check and correct it, then merge. Nothing changes before the last step.
 */
export function MergeDialog({
  owner,
  entries,
  cleanup,
  initial,
  onClose,
  onMerged,
}: {
  owner: string;
  entries: KnowledgeSummary[];
  cleanup: KnowledgeCleanup | undefined;
  /** preselected ids, the first one stays; null closes the dialog */
  initial: string[] | null;
  onClose: () => void;
  onMerged: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [target, setTarget] = useState("");
  const [others, setOthers] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<"pick" | "draft">("pick");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  /** a draft that arrives after "Zurück" or a new request belongs to an old choice */
  const attempt = useRef(0);

  useEffect(() => {
    if (!initial) return;
    const known = new Set(entries.map((e) => e.id));
    const ids = initial.filter((id) => known.has(id));
    setTarget(ids[0] ?? entries[0]?.id ?? "");
    setOthers(ids.slice(1, 1 + MAX_OTHERS));
    setQuery("");
    setStep("pick");
    setDraft(null);
    setDraftError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new opening resets the choice
  }, [initial]);

  const title = useMemo(() => new Map(entries.map((e) => [e.id, e.title])), [entries]);
  const partners = useMemo(() => new Map(overlapPartners(cleanup, target).map((p) => [p.id, p.score])), [cleanup, target]);
  const candidates = useMemo(() => {
    const rest = filterKnowledge(entries, query).filter((e) => e.id !== target);
    return [...rest.filter((e) => partners.has(e.id)).sort((a, b) => partners.get(b.id)! - partners.get(a.id)!), ...rest.filter((e) => !partners.has(e.id))];
  }, [entries, query, target, partners]);

  const ids = [target, ...others.filter((id) => id !== target)];
  const toggle = (id: string) => setOthers((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < MAX_OTHERS ? [...cur, id] : cur));

  const requestDraft = async () => {
    const mine = ++attempt.current;
    setStep("draft");
    setDraft(null);
    setDraftError(null);
    try {
      const d = await call("knowledge.mergeDraft", { projectId: owner, ids });
      if (mine === attempt.current) setDraft({ title: d.title, summary: d.summary, tags: d.tags.join(", "), content: d.content, model: d.model });
    } catch (e) {
      if (mine === attempt.current) setDraftError(errorMessage(e));
    }
  };

  const back = () => {
    attempt.current++;
    setStep("pick");
  };

  const merge = async () => {
    if (!draft || merging) return;
    if (!draft.title.trim()) return toast.error("Titel fehlt", "Der zusammengeführte Eintrag braucht einen Titel.");
    setMerging(true);
    try {
      const { entry, removed } = await call("knowledge.merge", { projectId: owner, ids, title: draft.title, summary: draft.summary, tags: parseTags(draft.tags), content: draft.content });
      qc.setQueryData(keys.knowledgeEntry(owner, entry.id), entry);
      void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
      toast.success("Einträge zusammengeführt", `${removed.length === 1 ? "1 Eintrag" : `${removed.length} Einträge`} in „${entry.title}“ aufgegangen.`);
      onMerged(entry.id);
      onClose();
    } catch (e) {
      toast.error("Nicht zusammengeführt", errorMessage(e));
    } finally {
      setMerging(false);
    }
  };

  const edit = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const removedTitles = others.map((id) => `„${title.get(id) ?? id}“`).join(", ");

  return (
    <Dialog
      open={initial !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Einträge zusammenführen"
      description={
        step === "pick"
          ? "Ein Eintrag bleibt bestehen, die anderen gehen in ihm auf. Claude schreibt einen Entwurf, den du vor dem Zusammenführen prüfst."
          : `„${title.get(target) ?? target}“ bekommt diesen Text. Danach gelöscht: ${removedTitles}.`
      }
      className="w-220"
      footer={
        step === "pick" ? (
          <>
            <Button onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" onClick={() => void requestDraft()} disabled={!target || !others.length}>
              Entwurf erstellen
            </Button>
          </>
        ) : (
          <>
            <Button onClick={back} disabled={merging}>
              Zurück
            </Button>
            <Button variant="primary" onClick={() => void merge()} disabled={!draft || !draft.content.trim()} loading={merging}>
              Zusammenführen
            </Button>
          </>
        )
      }
    >
      {step === "pick" ? (
        <div className="flex flex-col gap-3">
          <Field label="Bleibt bestehen">
            <Select
              value={target || undefined}
              onChange={(id) => {
                setTarget(id);
                setOthers((cur) => cur.filter((x) => x !== id));
              }}
              options={entries.map((e) => ({ value: e.id, label: e.title }))}
              placeholder="Eintrag wählen"
            />
          </Field>
          <div>
            <div className="mb-1.5 flex h-4 items-center justify-between">
              <span className="text-xs font-medium text-muted">Geht darin auf</span>
              <span className="text-caption text-subtle">
                {others.length} von höchstens {MAX_OTHERS}
              </span>
            </div>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Einträge durchsuchen" className="pl-8" aria-label="Einträge durchsuchen" />
            </div>
            <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
              {candidates.map((e) => {
                const on = others.includes(e.id);
                const score = partners.get(e.id);
                return (
                  <li key={e.id}>
                    <button
                      onClick={() => toggle(e.id)}
                      aria-pressed={on}
                      disabled={!on && others.length >= MAX_OTHERS}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-120 disabled:opacity-50",
                        on ? "bg-accent-soft" : "hover:bg-surface-2",
                      )}
                    >
                      <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-accent bg-accent text-accent-fg" : "border-border-strong")}>
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium">{e.title}</span>
                        {e.summary && <span className="block truncate text-xs text-muted">{e.summary}</span>}
                      </span>
                      {score !== undefined && <Badge tone="warning">überschneidet sich zu {Math.round(score * 100)} %</Badge>}
                    </button>
                  </li>
                );
              })}
              {!candidates.length && <li className="px-3 py-2 text-xs text-muted">Nichts gefunden.</li>}
            </ul>
          </div>
        </div>
      ) : draftError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorBanner>{draftError}</ErrorBanner>
          <Button onClick={() => void requestDraft()}>Erneut versuchen</Button>
        </div>
      ) : !draft ? (
        <DraftSkeleton />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Titel">
              <Input value={draft.title} onChange={(e) => edit({ title: e.target.value })} maxLength={120} />
            </Field>
            <Field label="Tags" hint="Mit Komma oder Leerzeichen getrennt">
              <Input value={draft.tags} onChange={(e) => edit({ tags: e.target.value })} />
            </Field>
          </div>
          <Field label="Zusammenfassung">
            <Input value={draft.summary} onChange={(e) => edit({ summary: e.target.value })} maxLength={300} />
          </Field>
          <div className="h-80">
            <CodeEditor value={draft.content} onChange={(content) => edit({ content })} language="markdown" ariaLabel="Inhalt des zusammengeführten Eintrags" />
          </div>
          <p className="text-caption text-subtle">Entwurf von Claude ({draft.model}). Alte Fassungen bleiben im Git.</p>
        </div>
      )}
    </Dialog>
  );
}

/** The draft form while Claude writes: two fields side by side, the summary and the text box. */
function DraftSkeleton() {
  return (
    <SkeletonRegion label="Claude schreibt den Entwurf" className="flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i}>
            <div className="mb-1.5 flex h-4 items-center">
              <Skeleton className="h-2.5 w-16 rounded-sm" />
            </div>
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1.5 flex h-4 items-center">
          <Skeleton className="h-2.5 w-28 rounded-sm" />
        </div>
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="flex h-80 flex-col gap-2.5 rounded-lg border border-border bg-surface p-4">
        {[60, 92, 85, 0, 40, 88, 76, 81, 0, 45, 90].map((w, i) => (w ? <Skeleton key={i} className="h-3 rounded-sm" style={{ width: `${w}%` }} /> : <div key={i} className="h-1" />))}
      </div>
      <p className="text-caption text-subtle">Claude führt die Einträge zusammen. Das dauert meist unter einer Minute.</p>
    </SkeletonRegion>
  );
}
