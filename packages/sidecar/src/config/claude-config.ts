import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, type ConfigDoc, type ConfigDocKind, type ConfigScope, type MemoryFile, type MemoryScope } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import { dataDir } from "../util/paths.js";
import { run } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";

/**
 * Read/write access to Claude Code's own configuration files. Paths are always derived from
 * (scope, project, name) here; the UI never passes a path. Writes keep a .bak of the old content
 * and detect concurrent edits via mtime.
 */

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const MAX_DOC_BYTES = 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function memoryPath(scope: MemoryScope, projectDir: string | null): string {
  if (scope === "global") return path.join(claudeHome(), "CLAUDE.md");
  if (!projectDir) throw new ForgeError("VALIDATION", tr().system.claudeConfig.needsProjectFile);
  if (scope === "project") return path.join(projectDir, "CLAUDE.md");
  if (scope === "project-dir") return path.join(projectDir, ".claude", "CLAUDE.md");
  return path.join(projectDir, "CLAUDE.local.md");
}

function memoryLabel(scope: MemoryScope): string {
  const c = tr().system.claudeConfig;
  if (scope === "global") return c.memoryGlobal;
  if (scope === "project") return c.memoryProject;
  if (scope === "project-dir") return c.memoryProjectDir;
  return c.memoryLocal;
}

async function fileInfo(p: string) {
  try {
    const s = await stat(p);
    return { exists: true, size: s.size, mtimeMs: Math.round(s.mtimeMs) };
  } catch {
    return { exists: false, size: 0, mtimeMs: null };
  }
}

export async function listMemory(projectDir: string | null): Promise<MemoryFile[]> {
  const scopes: MemoryScope[] = projectDir ? ["global", "project", "project-dir", "local"] : ["global"];
  const out: MemoryFile[] = [];
  for (const scope of scopes) {
    const p = memoryPath(scope, projectDir);
    const info = await fileInfo(p);
    // .claude/CLAUDE.md is an alternative location; only show it when it is actually used.
    if (scope === "project-dir" && !info.exists) continue;
    out.push({ scope, label: memoryLabel(scope), path: p, ...info });
  }
  return out;
}

async function readText(p: string): Promise<{ content: string; mtimeMs: number | null }> {
  const info = await fileInfo(p);
  if (!info.exists) return { content: "", mtimeMs: null };
  if (info.size > MAX_DOC_BYTES) throw new ForgeError("VALIDATION", tr().system.claudeConfig.fileTooLarge);
  return { content: await readFile(p, "utf8"), mtimeMs: info.mtimeMs };
}

/** Windows refuses a rename over a file that another process (editor, virus scanner) has open for a moment. */
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 10 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** Writes via a temp file in the same folder: a crash never leaves a half-written settings.json behind. */
export async function writeAtomic(p: string, content: string) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(tmp, content, "utf8");
  try {
    await renameWithRetry(tmp, p);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function writeText(p: string, content: string, expectedMtimeMs: number | null): Promise<number> {
  if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw new ForgeError("VALIDATION", tr().system.claudeConfig.contentTooLarge);
  const info = await fileInfo(p);
  if (info.exists && expectedMtimeMs !== null && info.mtimeMs !== expectedMtimeMs) {
    throw new ForgeError("CONFLICT", tr().system.claudeConfig.changedOutside);
  }
  if (info.exists && expectedMtimeMs === null) {
    throw new ForgeError("CONFLICT", tr().system.claudeConfig.exists);
  }
  await mkdir(path.dirname(p), { recursive: true });
  if (info.exists) await copyFile(p, p + ".bak");
  await writeAtomic(p, content);
  return (await fileInfo(p)).mtimeMs ?? Date.now();
}

/**
 * CLAUDE.local.md must never be committed: exclude it locally without touching tracked files.
 * In worktrees and submodules `.git` is a file, so git itself names the exclude file.
 */
async function ensureLocalExcluded(projectDir: string) {
  const git = resolveTool("git")?.path ?? "git";
  const r = await run(git, ["rev-parse", "--git-path", "info/exclude"], { cwd: projectDir, timeoutMs: 15_000 });
  const rel = r.code === 0 ? r.stdout.trim() : "";
  if (!rel) return;
  const exclude = path.resolve(projectDir, rel);
  const cur = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (/^\/?CLAUDE\.local\.md$/m.test(cur)) return;
  await mkdir(path.dirname(exclude), { recursive: true });
  await appendFile(exclude, `${cur.endsWith("\n") || !cur ? "" : "\n"}CLAUDE.local.md\n`);
}

export async function readMemory(scope: MemoryScope, projectDir: string | null) {
  const p = memoryPath(scope, projectDir);
  return { path: p, ...(await readText(p)) };
}

export async function writeMemory(scope: MemoryScope, projectDir: string | null, content: string, expectedMtimeMs: number | null) {
  const p = memoryPath(scope, projectDir);
  // Before the write: the private file must not show up as committable, even for a moment.
  if (scope === "local" && projectDir) await ensureLocalExcluded(projectDir).catch(() => {});
  const mtimeMs = await writeText(p, content, expectedMtimeMs);
  return { path: p, mtimeMs };
}

// ---------- skills and subagents

function docRoot(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null): string {
  const base = scope === "user" ? claudeHome() : projectDir ? path.join(projectDir, ".claude") : null;
  if (!base) throw new ForgeError("VALIDATION", tr().system.claudeConfig.needsProjectArea);
  return path.join(base, kind === "skill" ? "skills" : "agents");
}

function docPath(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null, name: string): string {
  if (!NAME_RE.test(name)) throw new ForgeError("VALIDATION", tr().system.claudeConfig.nameRule);
  const root = docRoot(kind, scope, projectDir);
  return kind === "skill" ? path.join(root, name, "SKILL.md") : path.join(root, `${name}.md`);
}

/** Minimal YAML front matter reader for `name:` and `description:` lines. */
export function frontMatter(text: string): { name: string | null; description: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: null, description: null };
  const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1]!)?.[1]?.trim().replace(/^["']|["']$/g, "") || null;
  return { name: get("name"), description: get("description") };
}

export async function listDocs(kind: ConfigDocKind, projectDir: string | null): Promise<ConfigDoc[]> {
  const scopes: ConfigScope[] = projectDir ? ["user", "project"] : ["user"];
  const out: ConfigDoc[] = [];
  for (const scope of scopes) {
    const root = docRoot(kind, scope, projectDir);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const name = kind === "skill" ? e : e.replace(/\.md$/, "");
      if (kind === "agent" && !e.endsWith(".md")) continue;
      if (!NAME_RE.test(name)) continue;
      const p = docPath(kind, scope, projectDir, name);
      if (!existsSync(p)) continue;
      const head = (await readFile(p, "utf8")).slice(0, 4000);
      const fm = frontMatter(head);
      out.push({ kind, scope, name, description: fm.description, path: p });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readDoc(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null, name: string) {
  const p = docPath(kind, scope, projectDir, name);
  return { path: p, ...(await readText(p)) };
}

export async function writeDoc(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null, name: string, content: string, expectedMtimeMs: number | null) {
  const p = docPath(kind, scope, projectDir, name);
  return { path: p, mtimeMs: await writeText(p, content, expectedMtimeMs) };
}

export function docTemplate(kind: ConfigDocKind, name: string, description: string): string {
  const c = tr().system.claudeConfig;
  if (kind === "skill") {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${c.skillBody}\n`;
  }
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${c.agentBody}\n`;
}

/** Deleted skill folders are moved here, outside every folder Claude Code loads skills from. */
export function skillTrashDir(): string {
  return path.join(dataDir(), "trash", "skills");
}

/**
 * Deletes a skill or subagent and returns where the backup went. Skills are folders (SKILL.md plus
 * optional resources) and move as a whole to skillTrashDir(); subagents keep `<name>.md.bak` next
 * to the file. The trash is not inside .claude/ because project skills are usually committed.
 */
export async function deleteDoc(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null, name: string): Promise<{ backupPath: string | null }> {
  const p = docPath(kind, scope, projectDir, name);
  if (!existsSync(p)) return { backupPath: null };
  if (kind === "agent") {
    await renameWithRetry(p, p + ".bak");
    return { backupPath: p + ".bak" };
  }
  const folder = path.dirname(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(skillTrashDir(), `${scope}-${name}-${stamp}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await renameWithRetry(folder, target);
  } catch (e) {
    // Different drive than the FORGE data folder: copy, then delete.
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await cp(folder, target, { recursive: true });
    await rm(folder, { recursive: true, force: true });
  }
  return { backupPath: target };
}

// ---------- hooks in settings.json

export type SettingsScope = "user" | "project" | "local";

export function settingsPath(scope: SettingsScope, projectDir: string | null): string {
  if (scope === "user") return path.join(claudeHome(), "settings.json");
  if (!projectDir) throw new ForgeError("VALIDATION", tr().system.claudeConfig.needsProjectArea);
  return path.join(projectDir, ".claude", scope === "project" ? "settings.json" : "settings.local.json");
}

const HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "TaskCreated",
  "TaskCompleted",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "InstructionsLoaded",
  "WorktreeCreate",
  "WorktreeRemove",
]);

/** Structural check of a hooks object: { Event: [{ matcher?, hooks: [{ type, command|... }] }] }. */
export function validateHooks(value: unknown): string | null {
  const c = tr().system.claudeConfig;
  if (!value || typeof value !== "object" || Array.isArray(value)) return c.hooksObject;
  for (const [event, matchers] of Object.entries(value)) {
    if (!HOOK_EVENTS.has(event)) return c.unknownHook(event);
    if (!Array.isArray(matchers)) return c.hooksListExpected(event);
    for (const m of matchers) {
      if (!m || typeof m !== "object") return c.hookEntryObject(event);
      const hooks = (m as { hooks?: unknown }).hooks;
      if (!Array.isArray(hooks) || hooks.length === 0) return c.hooksList(event);
      for (const h of hooks) {
        const t = (h as { type?: unknown }).type;
        if (typeof t !== "string") return c.hookNeedsType(event);
        if (t === "command" && typeof (h as { command?: unknown }).command !== "string") return c.hookNeedsCommand(event);
      }
    }
  }
  return null;
}

async function readSettings(p: string): Promise<{ data: Record<string, unknown>; mtimeMs: number | null }> {
  const { content, mtimeMs } = await readText(p);
  if (!content.trim()) return { data: {}, mtimeMs };
  try {
    const data = JSON.parse(content) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(tr().system.claudeConfig.notObject);
    return { data: data as Record<string, unknown>, mtimeMs };
  } catch (e) {
    throw new ForgeError("VALIDATION", tr().system.claudeConfig.invalidJsonFile(p, e instanceof Error ? e.message : String(e)));
  }
}

export async function readHooks(scope: SettingsScope, projectDir: string | null) {
  const p = settingsPath(scope, projectDir);
  const { data, mtimeMs } = await readSettings(p);
  return { path: p, hooks: JSON.stringify(data.hooks ?? {}, null, 2), mtimeMs };
}

/** Replaces only the `hooks` key; every other setting in the file stays untouched. */
export async function writeHooks(scope: SettingsScope, projectDir: string | null, hooksJson: string, expectedMtimeMs: number | null) {
  let hooks: unknown;
  try {
    hooks = JSON.parse(hooksJson);
  } catch (e) {
    throw new ForgeError("VALIDATION", tr().system.claudeConfig.invalidJson(e instanceof Error ? e.message : String(e)));
  }
  const err = validateHooks(hooks);
  if (err) throw new ForgeError("VALIDATION", err);
  const p = settingsPath(scope, projectDir);
  const { data, mtimeMs } = await readSettings(p);
  if (mtimeMs !== expectedMtimeMs) throw new ForgeError("CONFLICT", tr().system.claudeConfig.settingsChanged);
  const next = { ...data };
  if (Object.keys(hooks as object).length === 0) delete next.hooks;
  else next.hooks = hooks;
  const written = await writeText(p, JSON.stringify(next, null, 2) + "\n", mtimeMs);
  return { path: p, mtimeMs: written };
}
