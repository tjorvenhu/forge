import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { KnowledgeMissingRef } from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import { tr } from "../i18n/index.js";

/**
 * Finds references in knowledge entries that go nowhere: paths and file names that are not in the
 * project and code names (functions, components, constants, settings) that the code no longer has.
 * Built to stay quiet when unsure: commands, options, values and plain words in backticks are not
 * references, and with git a name only counts as missing if the code once had it.
 */

export interface KnowledgeRef {
  /** as written in the entry (line numbers and call arguments stripped) */
  ref: string;
  kind: "path" | "name";
  /** path: "/"-separated, aliases and ./ stripped; name: the whole dotted name first, then its code-like parts */
  lookup: string[];
  /** path without extension: a folder or an import specifier like lib/utils */
  dir?: boolean;
  /** a file name without folder */
  bare?: boolean;
}

/** Extensions of source files; a bare file name in backticks only counts with one of these. */
const CODE_EXT = new Set(
  "ts tsx js jsx mjs cjs mts cts rs py go java kt kts swift rb php cs vue svelte astro css scss sass less sql sh ps1 bat c h cpp hpp dart lua ex exs zig".split(" "),
);
/** Extensions of paths with a folder; others (.exe, .db, .log) are usually build output or local data. */
const FILE_EXT = new Set([
  ...CODE_EXT,
  ..."json jsonc json5 md mdx toml yaml yml html txt lock xml svg png jpg ico prisma graphql gql ini cfg conf gradle plist wxs nsi proto csv tsbuildinfo".split(" "),
]);
/** Generated or installed folders: paths into them are not part of the project's own files. */
export const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", "__pycache__", ".git", ".next", ".turbo", ".venv", "venv", ".cache", ".svelte-kit", ".nuxt"]);
/** Library and product names that look like file names. */
const NOT_FILES = new Set("node.js next.js nuxt.js vue.js react.js express.js three.js d3.js chart.js socket.io ember.js backbone.js alpine.js solid.js nest.js deno.js bun.js".split(" "));
/** File names (without extension) that only serve as examples. */
const PLACEHOLDER = /^(?:[a-z]|foo|bar|baz|qux|xyz|example|beispiel|datei|file|name|pfad|path)$/i;
/** Product names and terms that look like code names. */
const NOT_NAMES = new Set(
  (
    "GitHub GitLab BitBucket JavaScript TypeScript CoffeeScript PowerShell PostgreSQL MySQL SQLite MongoDB MariaDB DuckDB ClickHouse RabbitMQ OAuth WebView WebView2 " +
    "WebSocket WebSockets WebRTC WebAssembly WebGL WebGPU macOS iOS iPadOS watchOS tvOS iPhone iPad iCloud eBay YouTube LinkedIn OpenAI ChatGPT DevTools VSCode " +
    "NodeJS NextJS ShareX FastAPI GraphQL TailwindCSS DigitalOcean PayPal WordPress WooCommerce SharePoint OneDrive OneNote FaceTime AirDrop PlayStation " +
    "CamelCase camelCase PascalCase snake_case SCREAMING_SNAKE_CASE DevOps HiDPI McAfee AppData LocalAppData ProgramData ProgramFiles README CHANGELOG"
  ).split(" "),
);
/** Environment variables of tools and platforms; they live outside the project's code. */
const ENV_NAME =
  /^(NODE|NPM|PNPM|YARN|GITHUB|RUNNER|CI|VITE|NEXT|TAURI|CARGO|RUST|RUSTUP|ANTHROPIC|CLAUDE|OPENAI|GIT|LC|XDG|AWS|GOOGLE|AZURE|DOCKER|COMPOSE|SSH|GPG|HTTP|HTTPS|NO|PYTHON|PIP|JAVA|PG|USER|HOME|PATH|TEMP|TMP|WINDIR|SYSTEMROOT|APPDATA|LOCALAPPDATA)_/;

/** Code-like: camelCase, PascalCase with two humps, snake_case or CONSTANT_CASE. Plain words are not. */
export function looksLikeCode(word: string): boolean {
  if (word.length < 4 || NOT_NAMES.has(word)) return false;
  if (!/^[A-Za-z_$][\w$]*$/.test(word)) return false;
  if (/^[a-z_$][a-z0-9]*(?:_[a-z0-9]+)+$/.test(word)) return true;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(word)) return !ENV_NAME.test(word);
  return /[a-z0-9][A-Z]/.test(word) || /[A-Z]{2}[a-z]{2}/.test(word);
}

function stripLine(s: string): string {
  return s.replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?:[:-]\d+)?$/, "");
}

/** A path or file name, or null when the text is something else (a command, a URL, a glob, a value). */
export function pathRef(raw: string, inCode: boolean): KnowledgeRef | null {
  const ref = stripLine(raw.trim().replace(/^["'(]+|["'),.;:]+$/g, ""));
  let t = ref.replace(/\\/g, "/");
  if (!t || /\s/.test(t) || /[*?{}<>|"'`$%=,;!#&^+]/.test(t) || t.includes("://") || t.includes("...")) return null;
  // Absolute paths (C:/…, /c/…, ~/…) point outside the project.
  if (/^(?:\/|~|[A-Za-z]:\/)/.test(t)) return null;
  const alias = t.startsWith("@/");
  if (alias) t = t.slice(2);
  while (/^\.{1,2}\//.test(t)) t = t.replace(/^\.{1,2}\//, "");
  t = t.replace(/\/+$/, "");
  const segs = t.split("/");
  if (!t || segs.some((s) => !s || s === "." || s === ".." || !/[A-Za-z]/.test(s))) return null;
  const last = segs[segs.length - 1]!;
  // Dot files (.env, .gitignore) are often local and not committed.
  const ext = /^[^.].*\.([A-Za-z0-9]+)$/.exec(last)?.[1]?.toLowerCase();
  // Examples like src/a.ts or foo.ts stand for any file.
  if (ext && PLACEHOLDER.test(last.slice(0, -ext.length - 1))) return null;
  if (segs.length === 1) {
    if (!inCode || alias || !ext || !CODE_EXT.has(ext) || NOT_FILES.has(last.toLowerCase())) return null;
    if (!/[A-Za-z]/.test(last.slice(0, -ext.length - 1))) return null;
    return { ref, kind: "path", lookup: [last], bare: true };
  }
  if (segs.some((s) => SKIP_DIRS.has(s))) return null;
  // Folders with a dot inside (github.com, v1.2) are hosts or versions, not project folders.
  if (segs.slice(0, -1).some((s) => !/^\.?[^.]+$/.test(s))) return null;
  // Scoped packages (@tanstack/react-query).
  if (segs[0]!.startsWith("@")) return null;
  if (ext) return FILE_EXT.has(ext) ? { ref, kind: "path", lookup: [t] } : null;
  // Folders and import specifiers only from code spans, never from prose.
  if (!inCode || last.includes(".")) return null;
  return { ref, kind: "path", lookup: [t], dir: true };
}

/** A code name, or null for commands, options, values and plain words. */
export function nameRef(raw: string): KnowledgeRef | null {
  let t = raw.trim();
  const call = /^(?:new\s+|await\s+)?([A-Za-z_$][\w$.]*)\s*\(.*\)$/s.exec(t);
  if (call) t = call[1]!;
  // FORGE's MCP tools are called mcp__forge__<tool>; the code only has the tool name.
  t = t.replace(/^mcp__[\w-]+?__/, "");
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t)) return null;
  const parts = t.split(".");
  const code = parts.filter(looksLikeCode);
  if (!code.length) return null;
  return { ref: t, kind: "name", lookup: parts.length > 1 ? [t, ...code] : [t] };
}

/**
 * Parts of a name that must exist: the name itself, or the code-like parts of a dotted one. A dotted name
 * (ClaudeAssist.mergeKnowledge) is often notation and never written like that in the code.
 */
function codeParts(r: KnowledgeRef): string[] {
  return r.lookup.length > 1 ? r.lookup.slice(1) : r.lookup;
}

/** Prose without fenced code blocks; commands and examples there are not claims about the project. */
function withoutFences(content: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = null;
      out.push("");
      continue;
    }
    out.push(fence ? "" : line);
  }
  return out.join("\n");
}

const PROSE_PATH = /(?<![\w./\\@-])((?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?![\w/])/g;

/** References an entry makes: paths and file names, and code names in backticks. Each once. */
export function extractRefs(content: string): KnowledgeRef[] {
  const text = withoutFences(content);
  const out = new Map<string, KnowledgeRef>();
  const add = (r: KnowledgeRef | null) => {
    if (r && !out.has(`${r.kind}:${r.ref}`)) out.set(`${r.kind}:${r.ref}`, r);
  };
  const prose = text.replace(/`([^`\n]+)`/g, (_m, span: string) => {
    add(pathRef(span, true) ?? nameRef(span));
    return " ";
  });
  const plain = prose.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, " ");
  for (const m of plain.matchAll(PROSE_PATH)) add(pathRef(m[1]!, false));
  return [...out.values()];
}

/** Files and folders of the project at one state, indexed for suffix lookups. */
interface TreeIndex {
  state: string;
  head: string | null;
  git: boolean;
  root: string;
  files: Set<string>;
  dirs: Set<string>;
  /** last segment (lower case) -> files and folders with it */
  byBase: Map<string, string[]>;
  /** file name without extension (lower case) -> files */
  byStem: Map<string, string[]>;
  /** names of all folders, for the anchor check */
  dirNames: Set<string>;
  /** name -> found in the code at this state */
  found: Map<string, boolean>;
  /** without git: every word of the code */
  words: Set<string> | null;
}

interface HistoryHit {
  /** HEAD up to which the history was searched */
  head: string;
  hit: { hash: string; subject: string } | null;
}

/** What the checker keeps per project across restarts. */
interface StoredRoot {
  /** without git: names and files an earlier check found in the project */
  seen: string[];
  /** with git: history results per key */
  history: Record<string, HistoryHit>;
}

function gone(hit: { hash: string; subject: string }): string {
  return hit.hash ? tr().core.knowledge.lastChangedIn(hit.hash, hit.subject) : tr().core.knowledge.seenEarlier;
}

export interface RefCheck {
  missing: KnowledgeMissingRef[];
  checked: number;
}

/** Entries to check: id, text and refs marked as fine. */
export interface CheckInput {
  id: string;
  content: string;
  verified: string[];
}

const MAX_WALK_FILES = 30_000;
const MAX_READ_FILES = 8000;
const MAX_READ_BYTES = 512 * 1024;
const WALK_TTL_MS = 5 * 60_000;
const GREP_CHUNK = 150;
const HISTORY_TIMEOUT_MS = 15_000;
const HISTORY_PARALLEL = 6;
/** Remembered keys per project; the oldest go first. */
const MAX_STORED = 5000;
/** Knowledge and docs are not code: a name only mentioned there does not exist. */
const NOT_CODE = [":(exclude)*.md", ":(exclude)*.mdx", ":(exclude).forge"];
const MAGIC_PATHSPECS = { GIT_LITERAL_PATHSPECS: "0" };

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function extOf(name: string): string {
  const m = /^[^.].*(\.[A-Za-z0-9]+)$/.exec(name);
  return m ? m[1]! : "";
}

/** .js in an import usually means the .ts source next to it. */
function alternatives(p: string): string[] {
  const m = /^(.*)\.(js|jsx|mjs|cjs)$/i.exec(p);
  if (!m) return [p];
  return [p, `${m[1]}.ts`, `${m[1]}.tsx`, `${m[1]}.mts`, `${m[1]}.cts`];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Checks references against the project; results are cached per entry text and project state. */
export class RefChecker {
  private readonly indexes = new Map<string, TreeIndex>();
  private readonly building = new Map<string, Promise<TreeIndex>>();
  private readonly results = new Map<string, Map<string, { sig: string; state: string; result: RefCheck }>>();
  private persisted: Record<string, StoredRoot> | null = null;
  private dirty = false;

  /** `stateFile`: where history results and seen names survive a restart; null keeps them in memory only */
  constructor(
    private readonly git: GitEngine,
    private readonly stateFile: string | null = null,
  ) {}

  async check(root: string, useGit: boolean, entries: CheckInput[], refresh = false): Promise<{ git: boolean; results: Map<string, RefCheck> }> {
    if (refresh) {
      this.indexes.delete(root);
      this.results.delete(root);
    }
    const index = await this.index(root, useGit);
    const cache = this.results.get(root) ?? new Map<string, { sig: string; state: string; result: RefCheck }>();
    this.results.set(root, cache);
    const out = new Map<string, RefCheck>();
    const todo: Array<{ e: CheckInput; sig: string; refs: KnowledgeRef[] }> = [];
    for (const e of entries) {
      const sig = hash(`${e.content}\n${e.verified.join("\n")}`);
      const hit = cache.get(e.id);
      if (hit && hit.sig === sig && hit.state === index.state) out.set(e.id, hit.result);
      else todo.push({ e, sig, refs: extractRefs(e.content).filter((r) => !e.verified.includes(r.ref)) });
    }
    if (todo.length) {
      const refs = todo.flatMap((t) => t.refs);
      await this.lookupNames(index, [...new Set(refs.filter((r) => r.kind === "name").flatMap((r) => r.lookup))]);
      const present = new Set<string>();
      const gone = new Set<string>();
      for (const r of refs) {
        if (r.kind === "name") {
          const whole = index.found.get(r.lookup[0]!);
          for (const n of codeParts(r)) (whole || index.found.get(n) ? present : gone).add(`name:${n}`);
        } else if (r.bare) {
          const k = `file:${r.lookup[0]}`;
          if (this.hasBare(index, r.lookup[0]!)) present.add(k);
          else if (!r.lookup[0]!.includes("[")) gone.add(k);
        }
      }
      const history = index.git ? await this.histories(index, [...gone]) : this.remembered(root, present, gone);
      this.save();
      for (const t of todo) {
        const missing: KnowledgeMissingRef[] = [];
        for (const r of t.refs) {
          const m = r.kind === "path" ? this.missingPath(index, r, history) : this.missingName(index, r, history);
          if (m) missing.push(m);
        }
        const result = { missing, checked: t.refs.length };
        cache.set(t.e.id, { sig: t.sig, state: index.state, result });
        out.set(t.e.id, result);
      }
    }
    return { git: index.git, results: out };
  }

  /** Background for Claude when it corrects an entry: what the removing commit changed, files with the same name. */
  async details(root: string, useGit: boolean, missing: KnowledgeMissingRef[]): Promise<string> {
    const index = await this.index(root, useGit);
    const parts: string[] = [];
    let budget = 12_000;
    for (const m of missing) {
      const lines = [`- ${m.kind === "path" ? tr().core.knowledge.refPath : tr().core.knowledge.refName}\`${m.ref}\`${m.hint ? `: ${m.hint}` : ""}`];
      if (m.kind === "name" && index.git) {
        const r = nameRef(m.ref);
        const name = r ? codeParts(r).find((n) => !index.found.get(n)) : undefined;
        const hit = name ? this.stored(root).history[`name:${name}`]?.hit : null;
        if (name && hit) {
          const patch = await this.git.exec(root, ["show", "--format=", "-U2", "--no-color", hit.hash, "--", ".", ...NOT_CODE], undefined, 20_000, MAGIC_PATHSPECS).catch(() => null);
          const excerpt = patch ? hunksWith(patch.stdout, name, Math.min(3000, budget)) : "";
          if (excerpt) lines.push(`  ${tr().core.knowledge.changesIn(hit.hash)}`, "```diff", excerpt, "```");
          // Where things went shows in the files of that commit, even when the new code does not mention the old name.
          const files = await this.git.exec(root, ["show", "--format=", "--name-status", "-M", hit.hash, "--", ".", ...NOT_CODE], undefined, 20_000, MAGIC_PATHSPECS).catch(() => null);
          const list = files?.stdout.trim().split("\n").filter(Boolean) ?? [];
          if (list.length) lines.push(`  ${tr().core.knowledge.filesIn(hit.hash)} ${list.slice(0, 20).map((l) => l.replace(/\t/g, " ")).join("; ")}${list.length > 20 ? " …" : ""}`);
        }
      }
      const text = lines.join("\n");
      if (budget - text.length < 0) break;
      budget -= text.length;
      parts.push(text);
    }
    return parts.join("\n");
  }

  private hasBare(index: TreeIndex, name: string): boolean {
    return alternatives(name).some((alt) => index.byBase.get(alt.toLowerCase())?.some((f) => index.files.has(f)));
  }

  private missingPath(index: TreeIndex, r: KnowledgeRef, history: Map<string, HistoryHit["hit"]>): KnowledgeMissingRef | null {
    const p = r.lookup[0]!;
    if (r.bare) {
      if (this.hasBare(index, p)) return null;
      // Only names of files that once were here: a bare name may as well be a library's file.
      const hit = history.get(`file:${p}`);
      return hit ? { ref: r.ref, kind: "path", hint: gone(hit) } : null;
    }
    for (const alt of alternatives(p)) if (this.hasPath(index, alt, r.dir === true)) return null;
    const segs = p.split("/");
    // A hidden folder that does not exist is local or temporary (.preview, .idea), not part of the project.
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i]!.startsWith(".") && !index.dirNames.has(segs[i]!.toLowerCase())) return null;
    }
    // Anchor: the first folder must exist somewhere, otherwise the path may be outside (another repo, a branch, a MIME type).
    if (!index.dirNames.has(segs[0]!.toLowerCase())) return null;
    const same = (index.byBase.get(segs[segs.length - 1]!.toLowerCase()) ?? []).filter((f) => r.dir ? index.dirs.has(f) : index.files.has(f));
    return { ref: r.ref, kind: "path", ...(same.length ? { hint: tr().core.knowledge.sameName(`${same.slice(0, 3).join(", ")}${same.length > 3 ? " …" : ""}`) } : {}) };
  }

  private hasPath(index: TreeIndex, p: string, dir: boolean): boolean {
    if (index.files.has(p) || index.dirs.has(p)) return true;
    if (existsSync(path.join(index.root, p))) return true;
    const segs = p.split("/");
    const base = segs[segs.length - 1]!.toLowerCase();
    const suffix = `/${p.toLowerCase()}`;
    const ends = (f: string) => f.toLowerCase() === p.toLowerCase() || f.toLowerCase().endsWith(suffix);
    if ((index.byBase.get(base) ?? []).some(ends)) return true;
    // An import specifier (lib/utils, @/lib/context-menu) names a file without its extension.
    if (dir) {
      const stems = index.byStem.get(base) ?? [];
      if (stems.some((f) => ends(f.slice(0, f.length - extOf(f.split("/").pop()!).length)))) return true;
    }
    return false;
  }

  private missingName(index: TreeIndex, r: KnowledgeRef, history: Map<string, HistoryHit["hit"]>): KnowledgeMissingRef | null {
    if (index.found.get(r.lookup[0]!)) return null;
    for (const n of codeParts(r)) {
      if (index.found.get(n)) continue;
      const hit = history.get(`name:${n}`);
      if (hit) return { ref: r.ref, kind: "name", hint: gone(hit) };
    }
    return null;
  }

  /**
   * Without git there is no history: names and files count as removed once an earlier check found them in
   * the project. The first check of a project therefore reports no names, only paths.
   */
  private remembered(root: string, present: Set<string>, gone: Set<string>): Map<string, HistoryHit["hit"]> {
    const state = this.stored(root);
    for (const k of present) if (!state.seen.includes(k)) state.seen.push(k);
    if (state.seen.length > MAX_STORED) state.seen.splice(0, state.seen.length - MAX_STORED);
    this.dirty ||= present.size > 0;
    const out = new Map<string, HistoryHit["hit"]>();
    for (const k of gone) if (state.seen.includes(k)) out.set(k, { hash: "", subject: "" });
    return out;
  }

  private stored(root: string): StoredRoot {
    if (!this.persisted) {
      this.persisted = {};
      if (this.stateFile) {
        try {
          const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, StoredRoot>;
          for (const [k, v] of Object.entries(raw)) if (Array.isArray(v?.seen) && v.history && typeof v.history === "object") this.persisted[k] = v;
        } catch {
          /* first run or unreadable: start empty */
        }
      }
    }
    return (this.persisted[root] ??= { seen: [], history: {} });
  }

  /** Keeps history results and seen names across restarts, so a new start does not search the history again. */
  private save() {
    if (!this.dirty || !this.stateFile || !this.persisted) return;
    this.dirty = false;
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.persisted));
    } catch {
      /* only a cache */
    }
  }

  private async index(root: string, useGit: boolean): Promise<TreeIndex> {
    const state = await this.state(root, useGit);
    const known = this.indexes.get(root);
    if (known && known.state === state.state) return known;
    const pending = this.building.get(`${root}\n${state.state}`);
    if (pending) return pending;
    const work = this.build(root, state).finally(() => this.building.delete(`${root}\n${state.state}`));
    this.building.set(`${root}\n${state.state}`, work);
    const index = await work;
    this.indexes.set(root, index);
    return index;
  }

  /** HEAD plus the working tree status with git; without git a time slot, so a walk runs at most every few minutes. */
  private async state(root: string, useGit: boolean): Promise<{ state: string; head: string | null }> {
    if (useGit) {
      const head = await this.git.exec(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => null);
      if (head?.code === 0 && head.stdout.trim()) {
        const status = await this.git.exec(root, ["status", "--porcelain"]).catch(() => null);
        if (status?.code === 0) return { state: `git:${head.stdout.trim()}:${hash(status.stdout)}`, head: head.stdout.trim() };
      }
    }
    return { state: `walk:${Math.floor(Date.now() / WALK_TTL_MS)}`, head: null };
  }

  private async build(root: string, s: { state: string; head: string | null }): Promise<TreeIndex> {
    let files: string[] | null = null;
    if (s.head) {
      const r = await this.git.exec(root, ["ls-files", "-co", "--exclude-standard", "-z"], undefined, 60_000).catch(() => null);
      if (r?.code === 0) files = r.stdout.split("\0").filter(Boolean);
    }
    const git = files !== null;
    const index: TreeIndex = {
      state: s.state,
      head: git ? s.head : null,
      git,
      root,
      files: new Set(),
      dirs: new Set(),
      byBase: new Map(),
      byStem: new Map(),
      dirNames: new Set(),
      found: new Map(),
      words: null,
    };
    for (const f of files ?? walk(root)) {
      if (f.split("/").some((seg) => SKIP_DIRS.has(seg))) continue;
      index.files.add(f);
      const segs = f.split("/");
      const name = segs[segs.length - 1]!;
      push(index.byBase, name.toLowerCase(), f);
      const ext = extOf(name);
      if (ext) push(index.byStem, name.slice(0, -ext.length).toLowerCase(), f);
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join("/");
        if (index.dirs.has(dir)) continue;
        index.dirs.add(dir);
        index.dirNames.add(segs[i - 1]!.toLowerCase());
        push(index.byBase, segs[i - 1]!.toLowerCase(), dir);
      }
    }
    if (!git) index.words = readWords(root, [...index.files]);
    return index;
  }

  /** Marks which names occur in the code: git grep with git, the collected words without. */
  private async lookupNames(index: TreeIndex, names: string[]) {
    const open = names.filter((n) => !index.found.has(n));
    if (!open.length) return;
    if (!index.git) {
      for (const n of open) index.found.set(n, n.split(".").every((part) => index.words!.has(part)));
      return;
    }
    const grep = async (list: string[]) => {
      const seen = new Set<string>();
      for (let i = 0; i < list.length; i += GREP_CHUNK) {
        const chunk = list.slice(i, i + GREP_CHUNK);
        const args = ["grep", "-I", "-F", "-w", "-o", "-h", "--untracked", ...chunk.flatMap((n) => ["-e", n]), "--", ".", ...NOT_CODE];
        const r = await this.git.exec(index.root, args, undefined, 60_000, MAGIC_PATHSPECS);
        // 1: nothing found; anything else is an error, and an error must not turn into "missing".
        if (r.code !== 0 && r.code !== 1) throw new Error(r.stderr.trim() || tr().core.knowledge.gitGrepFailed(r.code));
        for (const line of r.stdout.split("\n")) if (line) seen.add(line.trim());
      }
      return seen;
    };
    try {
      let seen = await grep(open);
      // -o prints one match per spot, so a name inside a longer one on the same line (useUi in useUi.openFile) needs a second look.
      const second = open.filter((n) => !seen.has(n));
      if (second.length && second.length < open.length) seen = new Set([...seen, ...(await grep(second))]);
      for (const n of open) index.found.set(n, seen.has(n));
    } catch {
      for (const n of open) index.found.set(n, true);
    }
  }

  /**
   * The commit that last touched each name (`name:x`) or file name (`file:x`), if the code ever had it.
   * Without such a commit it never was in the project (a library function, a proposal) and is no missing
   * reference. Results stay valid across commits: a later check only searches the commits since.
   */
  private async histories(index: TreeIndex, keys: string[]): Promise<Map<string, HistoryHit["hit"]>> {
    const cache = this.stored(index.root).history;
    const out = new Map<string, HistoryHit["hit"]>();
    const queue = [...keys];
    const worker = async () => {
      for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
        const known = cache[k];
        if (known?.head === index.head) {
          out.set(k, known.hit);
          continue;
        }
        const value = k.slice(k.indexOf(":") + 1);
        const search = (range: string) => {
          const query = k.startsWith("name:")
            ? [`-G(^|[^A-Za-z0-9_$])${escapeRegex(value)}([^A-Za-z0-9_$]|$)`, range, "--", ".", ...NOT_CODE]
            : [range, "--", `:(glob)**/${value}`];
          return this.git.exec(index.root, ["log", "-n", "1", "--format=%h%x09%s", ...query], undefined, HISTORY_TIMEOUT_MS, MAGIC_PATHSPECS).catch(() => null);
        };
        let r = await search(known ? `${known.head}..${index.head}` : index.head!);
        // The HEAD searched last time may be gone (rebase, gc): then the whole history again.
        if (known && r && r.code !== 0 && !r.timedOut) r = await search(index.head!);
        if (!r || r.code !== 0 || r.timedOut) {
          out.set(k, null);
          continue;
        }
        const [h, ...subject] = r.stdout.trim().split("\t");
        // Nothing newer since the last search: the earlier hit (or none) stays.
        const hit = h ? { hash: h, subject: subject.join("\t") } : (known?.hit ?? null);
        cache[k] = { head: index.head!, hit };
        this.dirty = true;
        out.set(k, hit);
      }
    };
    await Promise.all(Array.from({ length: Math.min(HISTORY_PARALLEL, queue.length) }, worker));
    return out;
  }
}

/** Hunks of a patch that mention the name, with their file header, at most `max` characters. */
export function hunksWith(patch: string, name: string, max: number): string {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegex(name)}([^A-Za-z0-9_$]|$)`);
  const out: string[] = [];
  let file = "";
  let hunk: string[] = [];
  let len = 0;
  const flush = () => {
    if (hunk.length && hunk.some((l) => /^[+-]/.test(l) && re.test(l))) {
      const text = [file, ...hunk].filter(Boolean).join("\n");
      if (len + text.length <= max) {
        out.push(text);
        len += text.length + 1;
        file = "";
      }
    }
    hunk = [];
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      flush();
      file = line.replace(/^diff --git a\/(\S+) b\/.*$/, "--- $1");
    } else if (line.startsWith("@@")) {
      flush();
      hunk = [line];
    } else if (hunk.length) hunk.push(line);
  }
  flush();
  return out.join("\n");
}

/** Project files without git, breadth first, skipping generated folders; capped. */
function walk(root: string): string[] {
  const files: string[] = [];
  const queue = [""];
  while (queue.length && files.length < MAX_WALK_FILES) {
    const rel = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(path.join(root, rel));
    } catch {
      continue;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n)) continue;
      const child = rel ? `${rel}/${n}` : n;
      let dir: boolean;
      try {
        dir = statSync(path.join(root, child)).isDirectory();
      } catch {
        continue;
      }
      if (dir) queue.push(child);
      else files.push(child);
    }
  }
  return files;
}

/** Every word of the project's source and config files (not docs, not the knowledge); capped. */
function readWords(root: string, files: string[]): Set<string> {
  const words = new Set<string>();
  let read = 0;
  for (const f of files) {
    if (read >= MAX_READ_FILES) break;
    if (f.startsWith(".forge/")) continue;
    const ext = extOf(f.split("/").pop()!).slice(1).toLowerCase();
    if (!CODE_EXT.has(ext) && !["json", "jsonc", "toml", "yaml", "yml", "html", "xml", "prisma", "graphql"].includes(ext)) continue;
    try {
      const full = path.join(root, f);
      if (statSync(full).size > MAX_READ_BYTES) continue;
      read++;
      for (const w of readFileSync(full, "utf8").match(/[A-Za-z_$][\w$]*/g) ?? []) words.add(w);
    } catch {
      /* unreadable: skipped */
    }
  }
  return words;
}
