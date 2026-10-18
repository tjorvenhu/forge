import type { KnowledgeCleanup, KnowledgeMissingRef, KnowledgeStaleReport, KnowledgeSummary } from "@forge/protocol";
import { t } from "@/i18n";

/** Missing references per entry id; entries without any are left out. */
export function staleById(report: KnowledgeStaleReport | undefined): Map<string, KnowledgeMissingRef[]> {
  return new Map((report?.entries ?? []).filter((e) => e.missing.length).map((e) => [e.id, e.missing]));
}

export function refsMissingLabel(n: number): string {
  return t.knowledge.common.refsMissing(n);
}

/** Entries whose title, summary or tags contain every word of the query. */
export function filterKnowledge(entries: KnowledgeSummary[], query: string): KnowledgeSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries.filter((e) => {
    const hay = `${e.title} ${e.summary} ${e.tags.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

/** Entries overlapping with `id` and how strongly (0-1), the strongest first. */
export function overlapPartners(cleanup: KnowledgeCleanup | undefined, id: string): Array<{ id: string; score: number }> {
  return (cleanup?.overlaps ?? [])
    .flatMap((o) => (o.a === id ? [{ id: o.b, score: o.score }] : o.b === id ? [{ id: o.a, score: o.score }] : []))
    .sort((x, y) => y.score - x.score);
}

/**
 * Entries to preselect when merging: the open entry with its strongest partner, otherwise the strongest
 * overlap of the whole knowledge. The longer entry of a pair (`b`) stays, the one it contains goes into it.
 */
export function suggestedMerge(cleanup: KnowledgeCleanup | undefined, open: string | null): string[] {
  if (open) {
    const partner = overlapPartners(cleanup, open)[0];
    return partner ? [open, partner.id] : [open];
  }
  const top = cleanup?.overlaps[0];
  return top ? [top.b, top.a] : [];
}
