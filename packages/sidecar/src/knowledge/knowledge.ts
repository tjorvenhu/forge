import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type KnowledgeEntry, type KnowledgeSummary } from "@forge/protocol";
import type { ProjectManager } from "../projects/project-manager.js";
import { stripBom } from "../devtools/dev-tools.js";

/** Inside the project, so the knowledge travels with the repository and every clone and agent sees it. */
export const KNOWLEDGE_DIR = path.join(".forge", "knowledge");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** Index lines Claude gets at session start; the rest is found with knowledge_search. */
const INDEX_MAX_ENTRIES = 60;
const INDEX_MAX_CHARS = 6000;

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

  private file(projectId: string, id: string): string {
    if (!ID_RE.test(id)) throw new ForgeError("VALIDATION", `Ungültige Kennung „${id}“.`);
    return path.join(this.dir(projectId), `${id}.md`);
  }

  /** Synchronous, for the session start context; the files are small and few. */
  entriesSync(projectId: string): KnowledgeEntry[] {
    let dir: string;
    try {
      dir = this.dir(projectId);
    } catch {
      return [];
    }
    if (!existsSync(dir)) return [];
    const out: KnowledgeEntry[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const id = name.slice(0, -3);
      if (!ID_RE.test(id)) continue;
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
    const full = this.file(projectId, id);
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

  async save(projectId: string, input: KnowledgeInput): Promise<KnowledgeEntry> {
    const dir = this.dir(projectId);
    await mkdir(dir, { recursive: true });
    let id = input.id;
    if (id) {
      if (!existsSync(this.file(projectId, id))) throw new ForgeError("NOT_FOUND", `Kein Eintrag „${id}“.`);
    } else {
      const base = slugifyId(input.title);
      id = base;
      for (let n = 2; existsSync(path.join(dir, `${id}.md`)); n++) id = `${base}-${n}`;
    }
    const entry: KnowledgeEntry = {
      id,
      title: input.title.trim(),
      summary: input.summary.trim(),
      tags: [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))],
      updatedAt: new Date().toISOString(),
      content: input.content,
    };
    const full = this.file(projectId, id);
    // Write and rename: an editor or Claude reading at the same moment never sees half a file.
    const tmp = `${full}.${process.pid}.tmp`;
    await writeFile(tmp, serializeEntry(entry), "utf8");
    await rename(tmp, full);
    this.emit(this.owner(projectId));
    return entry;
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const full = this.file(projectId, id);
    if (!existsSync(full)) return false;
    await rm(full, { force: true });
    this.emit(this.owner(projectId));
    return true;
  }

  /** Index for Claude's start context; empty when the project has no knowledge yet. */
  index(projectId: string): { lines: string[]; total: number } {
    const entries = this.list(projectId);
    const lines: string[] = [];
    let chars = 0;
    for (const e of entries.slice(0, INDEX_MAX_ENTRIES)) {
      const line = `- ${e.id}: ${e.title}${e.summary ? `. ${e.summary}` : ""}${e.tags.length ? ` [${e.tags.join(", ")}]` : ""}`;
      if (chars + line.length > INDEX_MAX_CHARS) break;
      lines.push(line);
      chars += line.length + 1;
    }
    return { lines, total: entries.length };
  }
}

function statMtime(file: string): Date {
  try {
    return statSync(file).mtime;
  } catch {
    return new Date(0);
  }
}
