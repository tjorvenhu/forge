import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ForgeError, GIT_TAGS, type Project, type ProjectWithStatus } from "@forge/protocol";
import type { Db, ProjectRecord } from "../persistence/db.js";
import { repoNameFromUrl, validateCloneUrl, type GitEngine } from "../git/git.js";
import { canonicalize, isInside, pathKey, validateDirName } from "../util/paths.js";
import { SANDBOX_ONLY_TAG } from "../policy/profiles.js";
import { AUTO_MERGE_TAG } from "../automation/agent-auto-merge.js";
import { detectTechnologies, detectTestCommand } from "./tech.js";

export interface CreateProjectInput {
  name: string;
  parentDir: string;
  gitInit: boolean;
  /** false: project without git (no git init, no git areas) */
  gitEnabled?: boolean;
}

const MAX_FILE_BYTES = 512 * 1024;
/** Folders allFiles does not descend into: generated or installed, rarely what one looks for. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", "__pycache__", ".git", ".next", ".turbo", ".venv", ".cache"]);
/** Dot folders that hold project files worth finding. */
const DOT_DIRS = new Set([".github", ".claude", ".forge", ".vscode"]);
/** Worktrees of Claude Code subagents: copies of the project, every name would match twice. */
const SKIP_PATHS = new Set([".claude/worktrees"]);
const MAX_LISTED_FILES = 50_000;
const MAX_LISTED_DIRS = 10_000;

/** Real path of `p`, or of its nearest existing ancestor with the missing rest appended. */
async function canonicalizeExisting(p: string): Promise<string> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(await canonicalize(cur), ...rest);
    } catch (e) {
      const parent = path.dirname(cur);
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || parent === cur) throw e;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export class ProjectManager {
  constructor(
    private readonly db: Db,
    private readonly git: GitEngine,
    private readonly defaultProfile: () => Project["profile"],
  ) {}

  private withExists(p: ProjectRecord): Project {
    return { ...p, exists: existsSync(p.path) };
  }

  get(id: string): Project {
    const p = this.db.getProject(id);
    if (!p) throw new ForgeError("NOT_FOUND", "Projekt nicht gefunden.");
    return this.withExists(p);
  }

  /** Same as requireExisting() but fails for a project set to work without git. */
  requireGit(id: string): Project {
    const p = this.requireExisting(id);
    if (!p.gitEnabled) throw new ForgeError("GIT_DISABLED", `${p.name} ist ohne Git eingerichtet. Git lässt sich in den Projekt-Einstellungen einschalten.`);
    return p;
  }

  /** Same as get() but fails if the folder vanished. */
  requireExisting(id: string): Project {
    const p = this.get(id);
    if (!p.exists) throw new ForgeError("PATH_NOT_ACCESSIBLE", `Projektordner existiert nicht mehr: ${p.path}`);
    return p;
  }

  async withStatus(p: Project): Promise<ProjectWithStatus> {
    const git = p.exists && p.gitEnabled ? await this.git.summary(p.path).catch(() => null) : null;
    const s = this.db.latestSession(p.id);
    return {
      ...p,
      git,
      lastSession: s ? { id: s.id, title: s.title, updatedAt: s.updatedAt, status: s.status } : null,
    };
  }

  /** All projects without git status (cheap). */
  all(): Project[] {
    return this.db.listProjects().map((p) => this.withExists(p));
  }

  async list(): Promise<ProjectWithStatus[]> {
    const all = this.all();
    return Promise.all(all.map((p) => this.withStatus(p)));
  }

  private async assertAccessibleDir(p: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await canonicalize(p);
    } catch {
      throw new ForgeError("PATH_INVALID", `Ordner nicht gefunden: ${p}`);
    }
    const s = await stat(canonical);
    if (!s.isDirectory()) throw new ForgeError("PATH_INVALID", `Kein Ordner: ${canonical}`);
    try {
      await access(canonical, constants.R_OK | constants.W_OK);
    } catch {
      throw new ForgeError("PATH_NOT_ACCESSIBLE", `Keine Lese-/Schreibrechte für ${canonical}`);
    }
    return canonical;
  }

  /** Whether the folder already is a repository (.git folder, or .git file of a worktree or submodule). */
  async inspectFolder(rawPath: string): Promise<{ hasGit: boolean }> {
    try {
      return { hasGit: existsSync(path.join(await canonicalize(rawPath), ".git")) };
    } catch {
      return { hasGit: false };
    }
  }

  /** A folder that already has a .git is always imported with git, whatever `gitEnabled` says. */
  async import(rawPath: string, parentId: string | null = null, gitEnabled = true): Promise<Project> {
    const canonical = await this.assertAccessibleDir(rawPath);
    if (existsSync(path.join(canonical, ".git"))) gitEnabled = true;
    const key = pathKey(canonical);
    const dup = this.db.findProjectByKey(key);
    if (dup) throw new ForgeError("DUPLICATE_PROJECT", `Projekt ist bereits vorhanden: ${dup.name}`, { projectId: dup.id });
    const rec: ProjectRecord = {
      id: randomUUID(),
      name: path.basename(canonical) || canonical,
      path: canonical,
      favorite: false,
      // Finished parallel agents go back on their own, as Claude Code does with its subagents; a
      // worktree copies its tags from the main project, the main project decides.
      tags: gitEnabled && !parentId ? [AUTO_MERGE_TAG] : [],
      technologies: await detectTechnologies(canonical),
      profile: this.defaultProfile(),
      defaultModel: null,
      defaultEffort: null,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      testCommand: await detectTestCommand(canonical),
      devCommand: null,
      parentId,
      gitEnabled,
    };
    this.db.insertProject(rec, key);
    return this.withExists(rec);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const nameErr = validateDirName(input.name);
    if (nameErr) throw new ForgeError("VALIDATION", nameErr);
    const parent = await this.assertAccessibleDir(input.parentDir);
    const target = path.join(parent, input.name.trim());
    if (existsSync(target)) throw new ForgeError("CONFLICT", `Ordner existiert bereits: ${target}`);
    if (this.db.findProjectByKey(pathKey(target))) throw new ForgeError("DUPLICATE_PROJECT", "Projekt ist bereits vorhanden.");

    // Only an empty folder (plus git): the project structure is Claude's job, not a template's.
    await mkdir(target);
    const gitEnabled = input.gitEnabled !== false;
    if (gitEnabled && input.gitInit) await this.git.init(target);
    return this.import(target, null, gitEnabled);
  }

  async clone(url: string, parentDir: string, dirName?: string): Promise<Project> {
    const urlErr = validateCloneUrl(url);
    if (urlErr) throw new ForgeError("VALIDATION", urlErr);
    const parent = await this.assertAccessibleDir(parentDir);
    const name = (dirName?.trim() || repoNameFromUrl(url)).trim();
    const nameErr = validateDirName(name);
    if (nameErr) throw new ForgeError("VALIDATION", nameErr);
    const target = path.join(parent, name);
    if (existsSync(target)) throw new ForgeError("CONFLICT", `Ordner existiert bereits: ${target}`);
    await this.git.clone(url.trim(), name, parent);
    return this.import(target);
  }

  update(
    id: string,
    patch: Partial<Pick<ProjectRecord, "name" | "favorite" | "tags" | "profile" | "defaultModel" | "defaultEffort" | "testCommand" | "devCommand" | "gitEnabled">>,
  ): Project {
    const cur = this.get(id);
    if (patch.gitEnabled === false && cur.gitEnabled) {
      if (cur.parentId) throw new ForgeError("CONFLICT", "Ein Agent-Worktree arbeitet immer mit Git.");
      if (this.db.listProjects().some((p) => p.parentId === id)) {
        throw new ForgeError("CONFLICT", "Das Projekt hat noch Agenten. Erst die Agenten abschließen, dann Git ausschalten.");
      }
    }
    const sandboxOnly = (patch.tags ?? cur.tags).includes(SANDBOX_ONLY_TAG);
    if (patch.profile === "autonomous" && sandboxOnly) {
      throw new ForgeError("POLICY_DENIED", "Das Tag sandbox-only verbietet Autonomous in diesem Projekt.");
    }
    const next: Partial<ProjectRecord> = { ...patch };
    // Without git, auto-commit, auto-push, auto-merge and review-required have nothing to act on.
    if (!(patch.gitEnabled ?? cur.gitEnabled)) {
      const tags = (patch.tags ?? cur.tags).filter((t) => !GIT_TAGS.includes(t));
      if (patch.tags || tags.length !== cur.tags.length) next.tags = tags;
    }
    // Setting sandbox-only on an autonomous project falls back to Balanced instead of failing.
    if (sandboxOnly && !patch.profile && cur.profile === "autonomous") next.profile = "balanced";
    this.db.updateProject(id, next);
    return this.get(id);
  }

  async touch(id: string): Promise<Project> {
    const p = this.get(id);
    const patch: Partial<ProjectRecord> = { lastOpenedAt: new Date().toISOString() };
    if (p.exists) patch.technologies = await detectTechnologies(p.path);
    this.db.updateProject(id, patch);
    return this.get(id);
  }

  remove(id: string): boolean {
    this.db.detachChildProjects(id);
    return this.db.deleteProject(id);
  }

  /**
   * Resolves a project-relative path and checks it after following symlinks: a committed link like
   * docs/x -> ~/.ssh/id_rsa must not be readable through FORGE. Paths that do not exist yet are
   * checked via their nearest existing ancestor.
   */
  private async resolveInside(p: Project, rel: string): Promise<string> {
    const abs = path.resolve(p.path, rel);
    const outside = () => new ForgeError("PATH_INVALID", "Pfad liegt außerhalb des Projekts.");
    if (!isInside(abs, p.path)) throw outside();
    const root = await canonicalize(p.path).catch(() => p.path);
    const real = await canonicalizeExisting(abs);
    if (!isInside(real, root)) throw outside();
    return real;
  }

  async readClaudeMd(id: string) {
    const p = this.requireExisting(id);
    const file = path.join(p.path, "CLAUDE.md");
    if (!existsSync(file)) return { exists: false, content: "", path: file };
    return { exists: true, content: await readFile(file, "utf8"), path: file };
  }

  async listFiles(id: string, dir: string) {
    const p = this.requireExisting(id);
    const abs = await this.resolveInside(p, dir || ".");
    const root = await canonicalize(p.path).catch(() => p.path);
    const entries = await readdir(abs, { withFileTypes: true });
    const out = await Promise.all(
      entries
        .filter((e) => e.name !== ".git")
        .map(async (e) => {
          const full = path.join(abs, e.name);
          const size = e.isFile() ? (await stat(full).catch(() => null))?.size ?? 0 : 0;
          return { name: e.name, path: path.relative(root, full).replace(/\\/g, "/"), isDir: e.isDirectory(), size };
        }),
    );
    return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }

  /**
   * Every file of the project in one call (file links in the chat, palette file search), breadth first,
   * so shallow files come first when the cap is reached. Junctions and symlinks are not followed.
   */
  async allFiles(id: string) {
    const p = this.requireExisting(id);
    const root = await canonicalize(p.path).catch(() => p.path);
    const files: Array<{ name: string; path: string }> = [];
    let queue = [""];
    let dirs = 0;
    while (queue.length && files.length < MAX_LISTED_FILES && dirs < MAX_LISTED_DIRS) {
      const level = queue.splice(0, MAX_LISTED_DIRS - dirs);
      dirs += level.length;
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 32) {
        const listed = await Promise.all(
          level.slice(i, i + 32).map(async (rel) => ({ rel, entries: await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []) })),
        );
        for (const { rel, entries } of listed) {
          for (const e of entries) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            if (e.isFile()) files.push({ name: e.name, path: child });
            else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && (!e.name.startsWith(".") || DOT_DIRS.has(e.name)) && !SKIP_PATHS.has(child)) next.push(child);
          }
        }
      }
      queue = queue.concat(next);
    }
    return { files: files.slice(0, MAX_LISTED_FILES), truncated: files.length > MAX_LISTED_FILES || queue.length > 0 };
  }

  async readFile(id: string, rel: string) {
    const p = this.requireExisting(id);
    const abs = await this.resolveInside(p, rel);
    const fh = await open(abs, "r");
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const binary = buf.subarray(0, 8000).includes(0);
      return { path: rel, content: binary ? "" : buf.toString("utf8"), truncated: size > MAX_FILE_BYTES, binary };
    } finally {
      await fh.close();
    }
  }
}
