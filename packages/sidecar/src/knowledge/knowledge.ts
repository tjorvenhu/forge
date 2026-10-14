import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type KnowledgeEntry, type KnowledgeSummary } from "@forge/protocol";
import type { ProjectManager } from "../projects/project-manager.js";
import { stripBom } from "../devtools/dev-tools.js";

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

export function serializeEntry(e: Omit<KnowledgeEntry, "id">): string {
  return [
    "---",
    `title: ${JSON.stringify(e.title)}`,
    `summary: ${JSON.stringify(e.summary)}`,
    `tags: ${JSON.stringify(e.tags)}`,
    `updated: ${JSON.stringify(e.updatedAt)}`,
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
    const text = serializeEntry(fields);
    if (input.id) {
      const full = this.locate(projectId, input.id);
      if (!full) throw new ForgeError("NOT_FOUND", `Kein Eintrag „${input.id}“.`);
      // Write and rename: an editor or Claude reading at the same moment never sees half a file.
      const tmp = `${full}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      try {
        await writeFile(tmp, text, "utf8");
        await rename(tmp, full);
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
      this.emit(this.owner(projectId));
      return { id: input.id, ...fields };
    }
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

function statMtime(file: string): Date {
  try {
    return statSync(file).mtime;
  } catch {
    return new Date(0);
  }
}
