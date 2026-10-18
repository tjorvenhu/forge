import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ForgeError, Project, PromptTemplate, type BackupInfo, type BackupPart } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import { claudeHome, writeAtomic } from "../config/claude-config.js";
import { claudeJsonPath, pathKey } from "../util/paths.js";
import { tr } from "../i18n/index.js";

/** Backups kept in the data folder; older ones are deleted. */
export const MAX_BACKUPS = 40;
export const MAX_FILE_BYTES = 512 * 1024;
const MAX_CLAUDE_BYTES = 20 * 1024 * 1024;
export const TEXT_FILE = /\.(md|txt|json|ya?ml|toml|py|js|mjs|cjs|ts|sh|ps1|bat|cmd)$/i;
const ID_RE = /^[\w.-]{1,120}$/;

/** Folders under ~/.claude that hold configuration the user wrote (not caches, transcripts or credentials). */
export const CLAUDE_DIRS = ["agents", "commands", "skills", "rules", "output-styles"];
const CLAUDE_FILES = ["CLAUDE.md", "settings.json"];
/** Settings that came after the first backups; a backup without them leaves them alone. */
const KEEP_UNLESS_IN_BACKUP = ["setupDone", "syncEnabled", "syncAsked"];

/** Path relative to the Claude folder that a snapshot would take (see readClaudeFiles). */
function isClaudeConfigFile(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === "") || path.isAbsolute(rel)) return false;
  if (parts.length === 1) return CLAUDE_FILES.includes(parts[0]!);
  return CLAUDE_DIRS.includes(parts[0]!) && TEXT_FILE.test(parts[parts.length - 1]!);
}

// Backups from before projects without git lack gitEnabled; those projects all used git.
const ProjectEntry = Project.omit({ exists: true }).extend({ gitEnabled: z.boolean().default(true) });

const BackupData = z.object({
  format: z.literal("forge-backup"),
  version: z.literal(1),
  createdAt: z.string(),
  reason: z.enum(["start", "manual", "before-restore", "import"]),
  appVersion: z.string(),
  /** raw rows of the settings table, without the phone */
  settings: z.record(z.string(), z.string()),
  /** phone settings (raw JSON) and the DPAPI-encrypted secret files */
  phone: z.object({ settings: z.string().nullable(), secrets: z.record(z.string(), z.string()) }),
  projects: z.array(ProjectEntry),
  git: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
  /** files below the Claude config folder (forward slashes) and the user's MCP servers from .claude.json */
  claude: z.object({ files: z.record(z.string(), z.string()), mcpServers: z.record(z.string(), z.unknown()).nullable() }),
  /** prompt templates; backups from before them have none */
  templates: z.array(PromptTemplate).default([]),
});
type BackupData = z.infer<typeof BackupData>;

export interface BackupDeps {
  dir: string;
  db: Db;
  appVersion: string;
  git: { identity(): Promise<{ name: string | null; email: string | null }>; setIdentity(name: string, email: string): Promise<void> };
  secrets: { encrypted(): Record<string, string>; restoreEncrypted(files: Record<string, string>): void };
  /** runs after a restore, with the parts that were restored (reload the phone, tell sessions …) */
  afterRestore(parts: BackupPart[]): Promise<void>;
  log(message: string): void;
  claudeDir?: string;
  claudeJson?: string;
}

/** Backup file names sort chronologically: ISO time with ":" and "." replaced. */
function backupId(createdAt: string, reason: BackupData["reason"]): string {
  return `${createdAt.replace(/[:.]/g, "-")}-${reason}`;
}

/** Only the content: two backups with the same settings compare equal whatever their time. */
function contentKey(d: BackupData): string {
  const { createdAt: _c, reason: _r, appVersion: _a, ...rest } = d;
  return JSON.stringify(rest);
}

/**
 * Backups of FORGE's configuration: settings, projects, phone (secrets stay encrypted for this
 * Windows user), the global git identity and the Claude Code configuration the user edits in FORGE
 * (CLAUDE.md, settings.json with hooks, agents, commands, skills, user MCP servers) and the prompt
 * templates. Chat histories, project files and logins (Claude, GitHub) are not part of it.
 */
export class BackupService {
  constructor(private readonly d: BackupDeps) {}

  private get claudeDir() {
    return this.d.claudeDir ?? claudeHome();
  }

  private get claudeJson() {
    return this.d.claudeJson ?? claudeJsonPath();
  }

  private file(id: string) {
    if (!ID_RE.test(id)) throw new ForgeError("VALIDATION", tr().system.backup.invalidId);
    return path.join(this.d.dir, `${id}.json`);
  }

  async snapshot(reason: BackupData["reason"]): Promise<BackupData> {
    const { phone, ...settings } = this.d.db.rawSettings();
    return {
      format: "forge-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      reason,
      appVersion: this.d.appVersion,
      settings,
      phone: { settings: phone ?? null, secrets: this.d.secrets.encrypted() },
      projects: this.d.db.listProjects(),
      git: await this.d.git.identity().catch(() => ({ name: null, email: null })),
      claude: { files: await this.readClaudeFiles(), mcpServers: await this.readMcpServers() },
      templates: this.d.db.listTemplates("all"),
    };
  }

  private async readClaudeFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let total = 0;
    const add = async (rel: string) => {
      const full = path.join(this.claudeDir, rel);
      const s = await stat(full).catch(() => null);
      if (!s?.isFile() || s.size > MAX_FILE_BYTES || total + s.size > MAX_CLAUDE_BYTES) return;
      out[rel.split(path.sep).join("/")] = await readFile(full, "utf8");
      total += s.size;
    };
    for (const f of CLAUDE_FILES) await add(f);
    for (const dir of CLAUDE_DIRS) {
      const entries = await readdir(path.join(this.claudeDir, dir), { recursive: true, withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isFile() || !TEXT_FILE.test(e.name)) continue;
        await add(path.relative(this.claudeDir, path.join(e.parentPath, e.name)));
      }
    }
    return out;
  }

  private async readMcpServers(): Promise<Record<string, unknown> | null> {
    try {
      const j = JSON.parse(await readFile(this.claudeJson, "utf8")) as { mcpServers?: Record<string, unknown> };
      return j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : null;
    } catch {
      return null;
    }
  }

  private info(d: BackupData, id: string | null, size: number): BackupInfo {
    const m = tr().system.backup;
    const parts: BackupInfo["parts"] = [
      { part: "settings", label: m.partSettings(Object.keys(d.settings).length) },
      { part: "projects", label: m.partProjects(d.projects.length) },
    ];
    if (d.phone.settings) parts.push({ part: "phone", label: m.partPhone });
    const files = Object.keys(d.claude.files).length;
    const mcp = Object.keys(d.claude.mcpServers ?? {}).length;
    if (files || mcp) parts.push({ part: "claude", label: m.partClaude(files, mcp) });
    if (d.git.name || d.git.email) parts.push({ part: "git", label: m.partGit });
    if (d.templates.length) parts.push({ part: "templates", label: m.partTemplates(d.templates.length) });
    return { id, createdAt: d.createdAt, reason: d.reason, appVersion: d.appVersion, size, parts };
  }

  private async write(d: BackupData): Promise<BackupInfo> {
    await mkdir(this.d.dir, { recursive: true });
    const id = backupId(d.createdAt, d.reason);
    const text = JSON.stringify(d, null, 2);
    await writeFile(this.file(id), text, "utf8");
    await this.prune();
    return this.info(d, id, Buffer.byteLength(text));
  }

  private async prune() {
    const ids = await this.ids();
    for (const id of ids.slice(MAX_BACKUPS)) await rm(this.file(id), { force: true });
  }

  /** Stored backup ids, newest first. */
  private async ids(): Promise<string[]> {
    const names = await readdir(this.d.dir).catch(() => [] as string[]);
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5))
      .filter((id) => ID_RE.test(id))
      .sort()
      .reverse();
  }

  private async readFileData(file: string): Promise<{ data: BackupData; size: number }> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new ForgeError("NOT_FOUND", tr().system.backup.fileNotFound);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ForgeError("VALIDATION", tr().system.backup.notJson);
    }
    const parsed = BackupData.safeParse(raw);
    if (!parsed.success) throw new ForgeError("VALIDATION", tr().system.backup.notBackup);
    return { data: parsed.data, size: Buffer.byteLength(text) };
  }

  async list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    for (const id of await this.ids()) {
      try {
        const { data, size } = await this.readFileData(this.file(id));
        out.push(this.info(data, id, size));
      } catch {
        // A damaged file is left out of the list rather than breaking it.
      }
    }
    return out;
  }

  async create(reason: BackupData["reason"] = "manual"): Promise<BackupInfo> {
    return this.write(await this.snapshot(reason));
  }

  /** The backup on app start; skipped when nothing changed since the newest backup. */
  async createOnStart(): Promise<BackupInfo | null> {
    const snap = await this.snapshot("start");
    const newest = (await this.ids())[0];
    if (newest) {
      const prev = await this.readFileData(this.file(newest)).catch(() => null);
      if (prev && contentKey(prev.data) === contentKey(snap)) return null;
    }
    const info = await this.write(snap);
    this.d.log(`Backup beim Start angelegt: ${info.id}`);
    return info;
  }

  async exportTo(target: string, id?: string): Promise<{ path: string }> {
    const data = id ? (await this.readFileData(this.file(id))).data : await this.snapshot("manual");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(data, null, 2), "utf8");
    return { path: target };
  }

  async inspect(file: string): Promise<BackupInfo> {
    const { data, size } = await this.readFileData(file);
    return this.info(data, null, size);
  }

  /**
   * Restores the chosen parts. The current state is saved first. Projects, MCP servers and Claude
   * files that were added after the backup stay; only what the backup contains is set back.
   */
  async restore(source: { id?: string; path?: string }, parts: BackupPart[]) {
    const file = source.id ? this.file(source.id) : source.path;
    if (!file) throw new ForgeError("VALIDATION", tr().system.backup.noneGiven);
    const { data } = await this.readFileData(file);
    const want = new Set(parts);
    // Read before anything changes: a .claude.json FORGE cannot read stops the restore as a whole.
    const claudeJson = want.has("claude") && data.claude.mcpServers ? await this.readClaudeJson() : null;
    const safety = await this.create("before-restore");
    const notes: string[] = [];
    const restored: BackupPart[] = [];

    if (want.has("settings")) {
      // Older backups lack these; without them the setup assistant would come back.
      const keep = ["phone", ...KEEP_UNLESS_IN_BACKUP.filter((k) => !(k in data.settings))];
      const skipped = this.d.db.replaceRawSettings(data.settings, keep);
      if (skipped.length) notes.push(tr().system.backup.skippedSettings(skipped));
      restored.push("settings");
    }
    if (want.has("projects")) {
      const missing = this.restoreProjects(data);
      if (missing) notes.push(tr().system.backup.missingFolders(missing));
      restored.push("projects");
    }
    if (want.has("phone") && data.phone.settings) {
      this.d.db.setPhoneSettings(JSON.parse(data.phone.settings) as Record<string, unknown>);
      this.d.secrets.restoreEncrypted(data.phone.secrets);
      if (Object.keys(data.phone.secrets).length) notes.push(tr().system.backup.phoneSecrets);
      restored.push("phone");
    }
    if (want.has("claude")) {
      await this.restoreClaude(data, claudeJson);
      notes.push(tr().system.backup.restartSessions);
      restored.push("claude");
    }
    if (want.has("git") && data.git.name && data.git.email) {
      await this.d.git.setIdentity(data.git.name, data.git.email);
      restored.push("git");
    }

    if (want.has("templates") && data.templates.length) {
      // Templates of a project that is not in FORGE (any more) have nowhere to go.
      const homeless = data.templates.filter((t) => t.projectId && !this.d.db.getProject(t.projectId));
      for (const t of data.templates) if (!homeless.includes(t)) this.d.db.putTemplate(t);
      if (homeless.length) notes.push(tr().system.backup.homelessTemplates(homeless.length));
      restored.push("templates");
    }

    await this.d.afterRestore(restored);
    this.d.log(`Backup wiederhergestellt (${restored.join(", ")}) aus ${source.id ?? "Datei"}`);
    return { restored, safety, notes };
  }

  /** Puts the projects of the backup back with their settings; returns how many folders are missing. */
  private restoreProjects(data: BackupData): number {
    let missing = 0;
    for (const p of data.projects) {
      const key = pathKey(p.path);
      const existing = this.d.db.getProject(p.id) ?? this.d.db.findProjectByKey(key);
      if (existing) {
        const { id: _id, path: _path, createdAt: _created, parentId: _parent, ...patch } = p;
        this.d.db.updateProject(existing.id, patch);
      } else {
        this.d.db.insertProject(p, key, true);
      }
      if (!existsSync(p.path)) missing++;
    }
    return missing;
  }

  /**
   * The current ~/.claude.json, or {} if there is none yet. Anything else that cannot be read stops
   * the restore: writing it back with only the MCP servers would lose the rest of Claude's settings.
   */
  private async readClaudeJson(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.claudeJson, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new ForgeError("PATH_NOT_ACCESSIBLE", tr().system.backup.claudeJsonUnreadable(this.claudeJson, e instanceof Error ? e.message : String(e)));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ForgeError("VALIDATION", tr().system.backup.claudeJsonInvalid(this.claudeJson));
    }
    return parsed as Record<string, unknown>;
  }

  private async restoreClaude(data: BackupData, claudeJson: Record<string, unknown> | null) {
    const root = path.resolve(this.claudeDir);
    for (const [rel, content] of Object.entries(data.claude.files)) {
      const target = path.resolve(root, rel);
      // Only what a snapshot takes: a crafted backup must not write credentials, transcripts or
      // plugin code, or anywhere outside the Claude folder.
      if (!isClaudeConfigFile(path.relative(root, target))) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomic(target, content);
    }
    if (data.claude.mcpServers && claudeJson) {
      const current = claudeJson.mcpServers && typeof claudeJson.mcpServers === "object" ? (claudeJson.mcpServers as Record<string, unknown>) : {};
      await writeAtomic(this.claudeJson, JSON.stringify({ ...claudeJson, mcpServers: { ...current, ...data.claude.mcpServers } }, null, 2));
    }
  }
}
