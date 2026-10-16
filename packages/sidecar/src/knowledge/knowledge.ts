import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type KnowledgeEntry, type KnowledgeMissingRef, type KnowledgeStaleReport, type KnowledgeSummary } from "@forge/protocol";
import type { ProjectManager } from "../projects/project-manager.js";
import { stripBom } from "../devtools/dev-tools.js";
import { GitEngine } from "../git/git.js";
import { extractRefs, RefChecker } from "./staleness.js";

/** Inside the project, so the knowledge travels with the repository and every clone and agent sees it. */
export const KNOWLEDGE_DIR = path.join(".forge", "knowledge");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/**
 * Index Claude gets at session start. With summaries while everything fits; otherwise one short line
 * (id, title, tags) per entry, so every entry stays visible. Entries beyond the budget need knowledge_search.
 */
const INDEX_MAX_CHARS = 8000;
/** Share of an entry's weighted words found in another from which both likely cover the same topic. */
export const OVERLAP_MIN = 0.55;
/** Entries longer than this cost noticeable context on every read and get a hint to trim them. */
export const LONG_ENTRY_CHARS = 8000;

export interface KnowledgeInput {
  id: string | null;
  title: string;
  summary: string;
  tags: string[];
  content: string;
}

export interface KnowledgeHit extends KnowledgeSummary {
  score: number;
  snippet: string;
}

export interface KnowledgeOverlap {
  /** the entry that is largely contained in `b` */
  a: string;
  b: string;
  score: number;
}

type Comparable = Pick<KnowledgeEntry, "title" | "summary" | "tags" | "content">;

export function slugifyId(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "eintrag";
}

/** Words of a text for matching; umlauts and digits count as letters. */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

function fmValue(raw: string): unknown {
  const v = raw.trim();
  try {
    return JSON.parse(v) as unknown;
  } catch {
    // Hand-edited files: plain YAML scalars and [a, b] lists.
    if (v.startsWith("[") && v.endsWith("]"))
      return v
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    return v.replace(/^["']|["']$/g, "");
  }
}

/** Reads the small front matter FORGE writes (JSON values, so any YAML reader understands it too). */
export function parseEntry(id: string, text: string, mtime: Date): KnowledgeEntry {
  const src = stripBom(text).replace(/\r\n/g, "\n");
  const fm: Record<string, unknown> = {};
  let body = src;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1]!.split("\n")) {
      const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]!] = fmValue(kv[2]!);
    }
  }
  const content = body.replace(/^\n+/, "");
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : (heading ?? id);
  const summary = typeof fm.summary === "string" ? fm.summary.trim() : firstLine(content);
  const tags = Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()) : [];
  const updatedAt = typeof fm.updated === "string" && !Number.isNaN(Date.parse(fm.updated)) ? new Date(fm.updated).toISOString() : mtime.toISOString();
  return { id, title, summary, tags, updatedAt, content };
}

function firstLine(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  return line ? (line.length > 160 ? `${line.slice(0, 157)}...` : line) : "";
}

/**
 * References of an entry the user marked as fine although the check found them missing (front matter
 * `verified`). Stored in the file, so the mark travels with the repository like the entry.
 */
export function parseVerified(text: string): string[] {
  const m = /^---\n([\s\S]*?)\n---/.exec(stripBom(text).replace(/\r\n/g, "\n"));
  const line = m?.[1]!.split("\n").find((l) => l.startsWith("verified:"));
  if (!line) return [];
  const v = fmValue(line.slice("verified:".length));
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function serializeEntry(e: Omit<KnowledgeEntry, "id">, verified: string[] = []): string {
  return [
    "---",
    `title: ${JSON.stringify(e.title)}`,
    `summary: ${JSON.stringify(e.summary)}`,
    `tags: ${JSON.stringify(e.tags)}`,
    `updated: ${JSON.stringify(e.updatedAt)}`,
    ...(verified.length ? [`verified: ${JSON.stringify(verified)}`] : []),
    "---",
    "",
    e.content.replace(/\r\n/g, "\n").trimEnd(),
    "",
  ].join("\n");
}

/** Share of title words two titles have in common (0-1). */
export function titleOverlap(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return common / Math.min(x.size, y.size);
}

/**
 * Scores entries for a query: every query word counts where it appears, title and tags most, then
 * the summary, then the text. Prefix matches count half, so "migrat" finds "migrations".
 */
export function rank(entries: KnowledgeEntry[], query: string): KnowledgeHit[] {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const hits: KnowledgeHit[] = [];
  for (const e of entries) {
    const fields: Array<[string[], number]> = [
      [tokens(e.title), 5],
      [e.tags.flatMap(tokens), 4],
      [tokens(e.summary), 3],
      [tokens(e.content), 1],
    ];
    let score = 0;
    let matched = 0;
    for (const w of q) {
      let best = 0;
      for (const [words, weight] of fields) {
        let s = 0;
        for (const t of words) {
          if (t === w) s += weight;
          else if (t.startsWith(w) || (w.length >= 5 && w.startsWith(t) && t.length >= 4)) s += weight / 2;
          if (s >= weight * 3) break;
        }
        best += s;
      }
      if (best > 0) matched++;
      score += best;
    }
    if (!score) continue;
    // Entries that match every word beat those that match one word often.
    score *= matched / q.length;
    hits.push({ id: e.id, title: e.title, summary: e.summary, tags: e.tags, updatedAt: e.updatedAt, score, snippet: snippet(e.content, q) });
  }
  return hits.sort((a, b) => b.score - a.score);
}

const STOP_WORDS = new Set(
  (
    "aber alle als also auch auf aus bei beim bis da damit dann das dass dem den der des die dies diese diesem diesen dieser doch dort " +
    "durch ein eine einem einen einer eines es für gibt hat hier ihr im in ist jetzt kann kein keine man mit muss nach nicht noch nur " +
    "ob oder ohne schon sich sie sind so über um und uns vom von vor war was weil wenn wer wie wird wo zu zum zur and the for with from that this not are"
  ).split(" "),
);

/** tf-idf weights per entry; the smoothed idf keeps shared words meaningful in small stores. */
function weights(entries: Comparable[]): Array<Map<string, number>> {
  const counts = entries.map((e) => {
    const m = new Map<string, number>();
    for (const t of tokens(`${e.title} ${e.title} ${e.tags.join(" ")} ${e.summary} ${e.content}`))
      if (t.length > 2 && !STOP_WORDS.has(t)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const df = new Map<string, number>();
  for (const c of counts) for (const t of c.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return counts.map((c) => {
    const w = new Map<string, number>();
    for (const [t, n] of c) w.set(t, (1 + Math.log(n)) * Math.log(1 + entries.length / df.get(t)!));
    return w;
  });
}

/**
 * Share of a's weight whose words also occur in b. Asymmetric on purpose: a short note on a topic
 * that a long entry already covers scores high, two long entries that merely share vocabulary do not.
 */
function containment(a: Map<string, number>, b: Map<string, number>): number {
  let inB = 0;
  let total = 0;
  for (const [t, w] of a) {
    total += w;
    if (b.has(t)) inB += w;
  }
  return total ? inB / total : 0;
}

/** Pairs of entries that likely cover the same topic, the strongest first. */
export function overlaps(entries: KnowledgeEntry[], min = OVERLAP_MIN): KnowledgeOverlap[] {
  const w = weights(entries);
  const out: KnowledgeOverlap[] = [];
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const [s, l] = entries[i]!.content.length <= entries[j]!.content.length ? [i, j] : [j, i];
      const score = containment(w[s]!, w[l]!);
      if (score >= min) out.push({ a: entries[s]!.id, b: entries[l]!.id, score });
    }
  return out.sort((x, y) => y.score - x.score);
}

/** Existing entries that already cover most of `text`, the strongest first. */
export function covering(entries: KnowledgeEntry[], text: Comparable, min = OVERLAP_MIN): Array<KnowledgeEntry & { score: number }> {
  const w = weights([...entries, text]);
  const own = w[entries.length]!;
  return entries
    .map((e, i) => ({ ...e, score: containment(own, w[i]!) }))
    .filter((e) => e.score >= min)
    .sort((x, y) => y.score - x.score);
}

export const MERGE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "kurzer Titel mit den Suchbegriffen, höchstens 100 Zeichen" },
    summary: { type: "string", description: "ein Satz, höchstens 250 Zeichen" },
    tags: { type: "array", items: { type: "string" }, description: "2 bis 6 Stichwörter in Kleinbuchstaben" },
    content: { type: "string", description: "der zusammengeführte Eintrag in Markdown" },
  },
  required: ["title", "summary", "tags", "content"],
  additionalProperties: false,
};

/** Task for the one-shot call that merges entries; the entries go in completely, so nothing is lost on the way. */
export function buildMergePrompt(entries: KnowledgeEntry[]): string {
  return [
    "Führe diese Einträge aus dem Projektwissen eines Softwareprojekts zu einem einzigen Eintrag zusammen.",
    "- Erhalte alles Wissen: Dateipfade, Befehle, Begründungen, Stolperfallen, Daten. Lass nur Doppeltes weg.",
    "- Widersprechen sich Einträge, gilt der mit dem neueren Stand.",
    "- Nichts erfinden, nichts hinzufügen, was nicht in den Einträgen steht.",
    "- Titel: kurz, mit den Begriffen, unter denen man ihn sucht (Code-Namen gern in Klammern).",
    "- Zusammenfassung: ein Satz, worum es geht und wann man den Eintrag braucht.",
    "- Tags: 2 bis 6, aus denen der Einträge.",
    "- Inhalt: Markdown, beginnt mit '# <Titel>', danach Abschnitte mit '##'. Sprache wie in den Einträgen.",
    "",
    ...entries.flatMap((e) => [
      `=== Eintrag ${e.id} (Stand ${e.updatedAt.slice(0, 10)}) ===`,
      `Titel: ${e.title}`,
      `Zusammenfassung: ${e.summary}`,
      `Tags: ${e.tags.join(", ")}`,
      "",
      e.content.trim(),
      "",
    ]),
  ].join("\n");
}

export interface KnowledgeMergeGroup {
  /** the first entry stays, the others go into it */
  ids: string[];
  reason: string;
}

/** At most this many entries per group, like knowledge.merge. */
const MAX_GROUP = 6;

export const MERGE_PLAN_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Kennungen der Einträge; der erste bleibt bestehen, die anderen gehen in ihm auf" },
          reason: { type: "string", description: "ein kurzer Satz, warum diese Einträge dasselbe Thema behandeln" },
        },
        required: ["ids", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

/**
 * Task for the one-shot call that decides which entries to merge. Claude sees titles, summaries, tags,
 * the outline and the length of every entry, not the full texts: the topic shows there, and the whole
 * knowledge would cost many times the tokens. The full texts only go into the merge itself.
 */
export function buildMergePlanPrompt(entries: KnowledgeEntry[], pairs: KnowledgeOverlap[]): string {
  return [
    "Prüfe das Projektwissen eines Softwareprojekts: Welche Einträge behandeln dasselbe Thema und sollten zu einem Eintrag zusammengeführt werden?",
    "- Nur Einträge, die wirklich dasselbe Thema behandeln oder sich inhaltlich doppeln. Derselbe Bereich (z. B. beide UI) oder gleiche Tags reichen nicht.",
    `- Höchstens ${MAX_GROUP} Einträge pro Gruppe, jeder Eintrag in höchstens einer Gruppe.`,
    `- Zusammen höchstens etwa ${LONG_ENTRY_CHARS} Zeichen (Summe der Längen), sonst wird der neue Eintrag zu lang.`,
    "- Der erste Eintrag einer Gruppe bleibt bestehen: nimm den umfassendsten.",
    "- Passt nichts zusammen, gib eine leere Liste zurück. Lieber eine Gruppe zu wenig als eine erzwungene.",
    "",
    ...(pairs.length
      ? ["Ein lokaler Wortvergleich hält diese Paare für ähnlich (nur ein Hinweis, prüfe selbst):", ...pairs.slice(0, 20).map((p) => `- ${p.a} + ${p.b} (${Math.round(p.score * 100)} %)`), ""]
      : []),
    ...entries.flatMap((e) => {
      const outline = e.content
        .split("\n")
        .filter((l) => /^#{2,3}\s/.test(l))
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .slice(0, 15);
      return [
        `=== ${e.id} (${e.content.length} Zeichen) ===`,
        `Titel: ${e.title}`,
        `Zusammenfassung: ${e.summary}`,
        `Tags: ${e.tags.join(", ")}`,
        ...(outline.length ? [`Gliederung: ${outline.join(" | ")}`] : []),
        "",
      ];
    }),
  ].join("\n");
}

/** Keeps the groups that can be merged: known ids, each entry once, two to six per group. */
export function cleanMergePlan(groups: KnowledgeMergeGroup[], entries: KnowledgeSummary[]): KnowledgeMergeGroup[] {
  const known = new Set(entries.map((e) => e.id));
  const used = new Set<string>();
  const out: KnowledgeMergeGroup[] = [];
  for (const g of groups) {
    const ids = [...new Set(g.ids.map((id) => id.trim()))].filter((id) => known.has(id) && !used.has(id)).slice(0, MAX_GROUP);
    if (ids.length < 2) continue;
    for (const id of ids) used.add(id);
    out.push({ ids, reason: g.reason.trim() });
  }
  return out;
}

/**
 * Task for the one-shot call that corrects an entry whose references go nowhere. Claude has no tools
 * there, so the prompt carries what FORGE found out: hints and the diff of the commit that removed a name.
 */
export function buildFixPrompt(entry: KnowledgeEntry, missing: KnowledgeMissingRef[], details: string): string {
  return [
    "Dieser Eintrag aus dem Projektwissen eines Softwareprojekts verweist auf Dateien, Ordner oder Bezeichner, die es im Projekt nicht mehr gibt. Korrigiere ihn.",
    "- Ersetze veraltete Verweise durch die aktuellen, wenn die Hinweise unten eindeutig zeigen, wohin etwas verschoben oder wie es umbenannt wurde.",
    "- Ist nicht eindeutig, was an die Stelle getreten ist, entferne die Aussage oder kennzeichne sie knapp als veraltet. Nicht raten.",
    "- Alles andere bleibt unverändert: Aufbau, Begründungen, Stolperfallen, Sprache und Ton.",
    "- Nichts erfinden, nichts hinzufügen, was weder im Eintrag noch in den Hinweisen steht.",
    "- Titel, Zusammenfassung und Tags nur anpassen, wenn sie selbst veraltete Namen enthalten.",
    "- Inhalt: Markdown wie bisher, beginnt mit '# <Titel>'.",
    "",
    `Fehlende Verweise: ${missing.map((m) => `\`${m.ref}\``).join(", ")}`,
    "",
    "Hinweise aus dem Projekt:",
    details || "(keine)",
    "",
    `=== Eintrag ${entry.id} (Stand ${entry.updatedAt.slice(0, 10)}) ===`,
    `Titel: ${entry.title}`,
    `Zusammenfassung: ${entry.summary}`,
    `Tags: ${entry.tags.join(", ")}`,
    "",
    entry.content.trim(),
  ].join("\n");
}

function snippet(content: string, words: string[]): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, 200);
  const start = Math.max(0, at - 80);
  return `${start > 0 ? "..." : ""}${flat.slice(start, start + 220)}${start + 220 < flat.length ? "..." : ""}`;
}

/**
 * Knowledge of a project: Markdown files with a short front matter in `.forge/knowledge`. Worktrees
 * (agents) use the folder of their project, so all of them share one store.
 */
export class KnowledgeStore {
  constructor(
    private readonly projects: ProjectManager,
    private readonly emit: (projectId: string) => void,
    private readonly refs = new RefChecker(new GitEngine()),
  ) {}

  /** Project whose folder holds the knowledge: the project itself or, for a worktree, its parent. */
  owner(projectId: string): string {
    const p = this.projects.get(projectId);
    return p.parentId ?? p.id;
  }

  dir(projectId: string): string {
    return path.join(this.projects.requireExisting(this.owner(projectId)).path, KNOWLEDGE_DIR);
  }

  /**
   * File names by entry id. Files created by hand with another name ("Deploy.md", "db_setup.md") get
   * an id derived from the name and keep their file name; ids of FORGE's own files win.
   */
  private files(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    if (!existsSync(dir)) return out;
    const names = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .sort();
    for (const n of names) if (ID_RE.test(n.slice(0, -3))) out.set(n.slice(0, -3), n);
    for (const n of names) {
      const stem = n.slice(0, -3);
      if (ID_RE.test(stem)) continue;
      const base = slugifyId(stem);
      let id = base;
      for (let k = 2; out.has(id); k++) id = `${base}-${k}`;
      out.set(id, n);
    }
    return out;
  }

  /** Path of an existing entry, null if there is none. Only names read from the folder are used. */
  private locate(projectId: string, id: string): string | null {
    if (!ID_RE.test(id)) throw new ForgeError("VALIDATION", `Ungültige Kennung „${id}“.`);
    const dir = this.dir(projectId);
    const name = this.files(dir).get(id);
    return name ? path.join(dir, name) : null;
  }

  /** Synchronous, for the session start context; the files are small and few. */
  entriesSync(projectId: string): KnowledgeEntry[] {
    let dir: string;
    try {
      dir = this.dir(projectId);
    } catch {
      return [];
    }
    const out: KnowledgeEntry[] = [];
    for (const [id, name] of this.files(dir)) {
      try {
        const full = path.join(dir, name);
        out.push(parseEntry(id, readFileSync(full, "utf8"), statMtime(full)));
      } catch {
        /* unreadable file: skipped */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  list(projectId: string): KnowledgeSummary[] {
    return this.entriesSync(projectId).map(({ content: _content, ...rest }) => rest);
  }

  async read(projectId: string, id: string): Promise<KnowledgeEntry> {
    const full = this.locate(projectId, id);
    if (!full) throw new ForgeError("NOT_FOUND", `Kein Eintrag „${id}“.`);
    let text: string;
    try {
      text = await readFile(full, "utf8");
    } catch {
      throw new ForgeError("NOT_FOUND", `Kein Eintrag „${id}“.`);
    }
    return parseEntry(id, text, statMtime(full));
  }

  search(projectId: string, query: string, limit = 8): KnowledgeHit[] {
    return rank(this.entriesSync(projectId), query).slice(0, limit);
  }

  /** Entries whose title is close to this one; used to update instead of creating a duplicate. */
  similar(projectId: string, title: string, exceptId: string | null = null): KnowledgeSummary[] {
    return this.list(projectId).filter((e) => e.id !== exceptId && titleOverlap(e.title, title) >= 0.75);
  }

  /** Entries whose text already covers most of this one: candidates to merge with. */
  covering(projectId: string, text: Comparable, exceptIds: string[] = []): KnowledgeSummary[] {
    const others = this.entriesSync(projectId).filter((e) => !exceptIds.includes(e.id));
    return covering(others, text).map(({ content: _content, score: _score, ...rest }) => rest);
  }

  /** What to tidy up: entries that overlap and entries that grew long. */
  cleanup(projectId: string): { overlaps: KnowledgeOverlap[]; long: Array<{ id: string; chars: number }> } {
    const entries = this.entriesSync(projectId);
    return {
      overlaps: overlaps(entries),
      long: entries
        .filter((e) => e.content.length > LONG_ENTRY_CHARS)
        .map((e) => ({ id: e.id, chars: e.content.length }))
        .sort((a, b) => b.chars - a.chars),
    };
  }

  /** Tags in use, the most frequent first; offered to Claude so entries share one vocabulary. */
  tags(projectId: string): string[] {
    const n = new Map<string, number>();
    for (const e of this.list(projectId)) for (const t of e.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }

  /** Writes the merged text into the first entry and deletes the others. All must exist beforehand. */
  async merge(projectId: string, ids: string[], input: Omit<KnowledgeInput, "id">): Promise<{ entry: KnowledgeEntry; removed: string[] }> {
    const unique = [...new Set(ids)];
    if (unique.length < 2) throw new ForgeError("VALIDATION", "Zum Zusammenführen braucht es mindestens zwei verschiedene Einträge.");
    for (const id of unique) if (!this.locate(projectId, id)) throw new ForgeError("NOT_FOUND", `Kein Eintrag „${id}“.`);
    const [target, ...rest] = unique as [string, ...string[]];
    const entry = await this.save(projectId, { ...input, id: target });
    for (const id of rest) await this.delete(projectId, id);
    return { entry, removed: rest };
  }

  async save(projectId: string, input: KnowledgeInput): Promise<KnowledgeEntry> {
    const dir = this.dir(projectId);
    await mkdir(dir, { recursive: true });
    const fields = {
      title: input.title.trim(),
      summary: input.summary.trim(),
      tags: [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))],
      updatedAt: new Date().toISOString(),
      content: input.content,
    };
    if (input.id) {
      const full = this.locate(projectId, input.id);
      if (!full) throw new ForgeError("NOT_FOUND", `Kein Eintrag „${input.id}“.`);
      // Marks for refs the new text no longer has would only hide a future alarm.
      const refs = new Set(extractRefs(fields.content).map((r) => r.ref));
      const verified = parseVerified(await readFile(full, "utf8").catch(() => "")).filter((r) => refs.has(r));
      await writeAtomic(full, serializeEntry(fields, verified));
      this.emit(this.owner(projectId));
      return { id: input.id, ...fields };
    }
    const text = serializeEntry(fields);
    // Claude in several sessions may save the same title at once: "wx" claims the name or fails.
    const taken = this.files(dir);
    const base = slugifyId(input.title);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (taken.has(id)) continue;
      try {
        await writeFile(path.join(dir, `${id}.md`), text, { encoding: "utf8", flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      this.emit(this.owner(projectId));
      return { id, ...fields };
    }
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const full = this.locate(projectId, id);
    if (!full || !existsSync(full)) return false;
    await rm(full, { force: true });
    this.emit(this.owner(projectId));
    return true;
  }

  /**
   * References of the entries (all, or `ids`) that go nowhere in the project. Cached per entry text and
   * project state (HEAD and working tree), so opening the knowledge again costs nothing.
   */
  async staleness(projectId: string, opts: { ids?: string[]; refresh?: boolean } = {}): Promise<KnowledgeStaleReport> {
    const owner = this.owner(projectId);
    const project = this.projects.requireExisting(owner);
    const dir = this.dir(owner);
    const inputs: Array<{ id: string; content: string; verified: string[] }> = [];
    for (const [id, name] of this.files(dir)) {
      if (opts.ids && !opts.ids.includes(id)) continue;
      try {
        const text = readFileSync(path.join(dir, name), "utf8");
        inputs.push({ id, content: parseEntry(id, text, new Date(0)).content, verified: parseVerified(text) });
      } catch {
        /* unreadable file: skipped */
      }
    }
    if (opts.ids?.length === 1 && !inputs.length) throw new ForgeError("NOT_FOUND", `Kein Eintrag „${opts.ids[0]}“.`);
    const { git, results } = await this.refs.check(project.path, project.gitEnabled !== false, inputs, opts.refresh);
    return { git, entries: inputs.map((i) => ({ id: i.id, ...(results.get(i.id) ?? { missing: [], checked: 0 }) })) };
  }

  /** The refs the check finds missing were a false alarm: they are left out from now on. The date stays. */
  async markChecked(projectId: string, id: string): Promise<{ verified: string[] }> {
    const full = this.locate(projectId, id);
    if (!full) throw new ForgeError("NOT_FOUND", `Kein Eintrag „${id}“.`);
    const missing = (await this.staleness(projectId, { ids: [id] })).entries[0]?.missing ?? [];
    const text = await readFile(full, "utf8");
    const before = parseVerified(text);
    if (!missing.length) return { verified: before };
    const verified = [...new Set([...before, ...missing.map((m) => m.ref)])];
    await writeAtomic(full, serializeEntry(parseEntry(id, text, statMtime(full)), verified));
    this.emit(this.owner(projectId));
    return { verified };
  }

  /** Entry, its missing refs and what FORGE knows about them, for Claude's corrected draft. */
  async fixContext(projectId: string, id: string): Promise<{ entry: KnowledgeEntry; missing: KnowledgeMissingRef[]; details: string }> {
    const entry = await this.read(projectId, id);
    const missing = (await this.staleness(projectId, { ids: [id] })).entries[0]?.missing ?? [];
    if (!missing.length) throw new ForgeError("VALIDATION", "Alle Verweise des Eintrags gibt es im Projekt. Da ist nichts zu korrigieren.");
    const project = this.projects.requireExisting(this.owner(projectId));
    return { entry, missing, details: await this.refs.details(project.path, project.gitEnabled !== false, missing) };
  }

  /** Index for Claude's start context; empty when the project has no knowledge yet. */
  index(projectId: string): { lines: string[]; total: number; summaries: boolean } {
    const entries = this.list(projectId);
    const tags = (e: KnowledgeSummary) => (e.tags.length ? ` [${e.tags.join(", ")}]` : "");
    const full = entries.map((e) => `- ${e.id}: ${e.title}${e.summary ? `. ${e.summary}` : ""}${tags(e)}`);
    if (full.reduce((n, l) => n + l.length + 1, 0) <= INDEX_MAX_CHARS) return { lines: full, total: entries.length, summaries: true };
    const lines: string[] = [];
    let chars = 0;
    for (const e of entries) {
      const line = `- ${e.id}: ${e.title}${tags(e)}`;
      if (chars + line.length > INDEX_MAX_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
    }
    return { lines, total: entries.length, summaries: false };
  }
}

/** Write and rename: an editor or Claude reading at the same moment never sees half a file. */
async function writeAtomic(full: string, text: string) {
  const tmp = `${full}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, full);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

function statMtime(file: string): Date {
  try {
    return statSync(file).mtime;
  } catch {
    return new Date(0);
  }
}
