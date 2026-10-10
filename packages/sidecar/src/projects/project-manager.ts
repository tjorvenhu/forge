import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type Project, type ProjectTemplate, type ProjectWithStatus } from "@forge/protocol";
import type { Db, ProjectRecord } from "../persistence/db.js";
import { repoNameFromUrl, validateCloneUrl, type GitEngine } from "../git/git.js";
import { canonicalize, isInside, pathKey, validateDirName } from "../util/paths.js";
import { detectTechnologies } from "./tech.js";
import { claudeMdFor, gitignoreFor, readmeFor, starterFiles } from "./templates.js";

export interface CreateProjectInput {
  name: string;
  parentDir: string;
  gitInit: boolean;
  readme: boolean;
  gitignore: boolean;
  claudeMd: boolean;
  template: ProjectTemplate;
}

const MAX_FILE_BYTES = 512 * 1024;

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

  /** Same as get() but fails if the folder vanished. */
  requireExisting(id: string): Project {
    const p = this.get(id);
    if (!p.exists) throw new ForgeError("PATH_NOT_ACCESSIBLE", `Projektordner existiert nicht mehr: ${p.path}`);
    return p;
  }

  async withStatus(p: Project): Promise<ProjectWithStatus> {
    const git = p.exists ? await this.git.summary(p.path).catch(() => null) : null;
    const s = this.db.latestSession(p.id);
    return {
      ...p,
      git,
      lastSession: s ? { id: s.id, title: s.title, updatedAt: s.updatedAt, status: s.status } : null,
    };
  }

  async list(): Promise<ProjectWithStatus[]> {
    const all = this.db.listProjects().map((p) => this.withExists(p));
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

  async import(rawPath: string): Promise<Project> {
    const canonical = await this.assertAccessibleDir(rawPath);
    const key = pathKey(canonical);
    const dup = this.db.findProjectByKey(key);
    if (dup) throw new ForgeError("DUPLICATE_PROJECT", `Projekt ist bereits vorhanden: ${dup.name}`, { projectId: dup.id });
    const rec: ProjectRecord = {
      id: randomUUID(),
      name: path.basename(canonical) || canonical,
      path: canonical,
      favorite: false,
      tags: [],
      technologies: await detectTechnologies(canonical),
      profile: this.defaultProfile() === "autonomous" ? "balanced" : this.defaultProfile(),
      autonomousConfirmed: false,
      defaultModel: null,
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
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

    await mkdir(target);
    const files: Record<string, string> = { ...starterFiles(input.name, input.template) };
    if (input.readme) files["README.md"] = readmeFor(input.name);
    if (input.gitignore) files[".gitignore"] = gitignoreFor(input.template);
    if (input.claudeMd) files["CLAUDE.md"] = claudeMdFor(input.name, input.template);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(target, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, { flag: "wx" });
    }
    if (input.gitInit) await this.git.init(target);
    return this.import(target);
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

  update(id: string, patch: Partial<Pick<ProjectRecord, "name" | "favorite" | "tags" | "profile" | "defaultModel">>): Project {
    const cur = this.get(id);
    // Switching to autonomous needs the separate confirmation flow.
    if (patch.profile === "autonomous" && !cur.autonomousConfirmed) {
      throw new ForgeError("PROFILE_LOCKED", "Autonomous muss für dieses Projekt erst bestätigt werden.");
    }
    const next: Partial<ProjectRecord> = { ...patch };
    // Leaving autonomous revokes the confirmation so re-enabling asks again.
    if (patch.profile && patch.profile !== "autonomous" && cur.autonomousConfirmed) next.autonomousConfirmed = false;
    this.db.updateProject(id, next);
    return this.get(id);
  }

  confirmAutonomous(id: string, confirmName: string, globallyUnlocked: boolean): Project {
    const p = this.get(id);
    if (!globallyUnlocked) throw new ForgeError("PROFILE_LOCKED", "Autonomous ist global gesperrt. Erst in den Einstellungen freischalten.");
    if (confirmName.trim() !== p.name) throw new ForgeError("VALIDATION", "Der eingegebene Projektname stimmt nicht.");
    this.db.updateProject(id, { autonomousConfirmed: true, profile: "autonomous" });
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
    return this.db.deleteProject(id);
  }

  private resolveInside(p: Project, rel: string): string {
    const abs = path.resolve(p.path, rel);
    if (!isInside(abs, p.path)) throw new ForgeError("PATH_INVALID", "Pfad liegt außerhalb des Projekts.");
    return abs;
  }

  async readClaudeMd(id: string) {
    const p = this.requireExisting(id);
    const file = path.join(p.path, "CLAUDE.md");
    if (!existsSync(file)) return { exists: false, content: "", path: file };
    return { exists: true, content: await readFile(file, "utf8"), path: file };
  }

  async listFiles(id: string, dir: string) {
    const p = this.requireExisting(id);
    const abs = this.resolveInside(p, dir || ".");
    const entries = await readdir(abs, { withFileTypes: true });
    const out = await Promise.all(
      entries
        .filter((e) => e.name !== ".git")
        .map(async (e) => {
          const full = path.join(abs, e.name);
          const size = e.isFile() ? (await stat(full).catch(() => null))?.size ?? 0 : 0;
          return { name: e.name, path: path.relative(p.path, full).replace(/\\/g, "/"), isDir: e.isDirectory(), size };
        }),
    );
    return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }

  async readFile(id: string, rel: string) {
    const p = this.requireExisting(id);
    const abs = this.resolveInside(p, rel);
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
