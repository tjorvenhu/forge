import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, type ConfigDoc, type ConfigDocKind, type ConfigScope, type MemoryFile, type MemoryScope } from "@forge/protocol";

/**
 * Read/write access to Claude Code's own configuration files. Paths are always derived from
 * (scope, project, name) here; the UI never passes a path. Writes keep a .bak of the old content
 * and detect concurrent edits via mtime.
 */

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const MAX_DOC_BYTES = 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function memoryPath(scope: MemoryScope, projectDir: string | null): string {
  if (scope === "global") return path.join(claudeHome(), "CLAUDE.md");
  if (!projectDir) throw new ForgeError("VALIDATION", "Für diese Datei wird ein Projekt benötigt.");
  if (scope === "project") return path.join(projectDir, "CLAUDE.md");
  if (scope === "project-dir") return path.join(projectDir, ".claude", "CLAUDE.md");
  return path.join(projectDir, "CLAUDE.local.md");
}

const MEMORY_LABELS: Record<MemoryScope, string> = {
  global: "Global (alle Projekte)",
  project: "Projekt (CLAUDE.md, wird committet)",
  "project-dir": "Projekt (.claude/CLAUDE.md)",
  local: "Nur für dich (CLAUDE.local.md, nicht im Git)",
};

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
    out.push({ scope, label: MEMORY_LABELS[scope], path: p, ...info });
  }
  return out;
}

async function readText(p: string): Promise<{ content: string; mtimeMs: number | null }> {
  const info = await fileInfo(p);
  if (!info.exists) return { content: "", mtimeMs: null };
  if (info.size > MAX_DOC_BYTES) throw new ForgeError("VALIDATION", "Datei ist größer als 1 MB.");
  return { content: await readFile(p, "utf8"), mtimeMs: info.mtimeMs };
}

async function writeText(p: string, content: string, expectedMtimeMs: number | null): Promise<number> {
  if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw new ForgeError("VALIDATION", "Inhalt ist größer als 1 MB.");
  const info = await fileInfo(p);
  if (info.exists && expectedMtimeMs !== null && info.mtimeMs !== expectedMtimeMs) {
    throw new ForgeError("CONFLICT", "Die Datei wurde inzwischen außerhalb von FORGE geändert. Bitte neu laden.");
  }
  if (info.exists && expectedMtimeMs === null) {
    throw new ForgeError("CONFLICT", "Die Datei existiert bereits. Bitte neu laden.");
  }
  await mkdir(path.dirname(p), { recursive: true });
  if (info.exists) await copyFile(p, p + ".bak");
  await writeFile(p, content, "utf8");
  return (await fileInfo(p)).mtimeMs ?? Date.now();
}

/** CLAUDE.local.md must never be committed: exclude it locally without touching tracked files. */
async function ensureLocalExcluded(projectDir: string) {
  const exclude = path.join(projectDir, ".git", "info", "exclude");
  if (!existsSync(path.join(projectDir, ".git"))) return;
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
  const mtimeMs = await writeText(p, content, expectedMtimeMs);
  if (scope === "local" && projectDir) await ensureLocalExcluded(projectDir);
  return { path: p, mtimeMs };
}

// ---------- skills and subagents

function docRoot(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null): string {
  const base = scope === "user" ? claudeHome() : projectDir ? path.join(projectDir, ".claude") : null;
  if (!base) throw new ForgeError("VALIDATION", "Für diesen Bereich wird ein Projekt benötigt.");
  return path.join(base, kind === "skill" ? "skills" : "agents");
}

function docPath(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null, name: string): string {
  if (!NAME_RE.test(name)) throw new ForgeError("VALIDATION", "Name: Kleinbuchstaben, Ziffern und Bindestriche, höchstens 64 Zeichen.");
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
  if (kind === "skill") {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nAnleitung für Claude: wann dieser Skill gilt und wie vorzugehen ist.\n`;
  }
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nDu bist ein spezialisierter Subagent. Beschreibe hier Rolle, Vorgehen und Grenzen.\n`;
}

export async function deleteDoc(kind: ConfigDocKind, scope: ConfigScope, projectDir: string | null, name: string) {
  const p = docPath(kind, scope, projectDir, name);
  if (!existsSync(p)) return;
  // Skills are folders (SKILL.md plus optional resources); keep a backup copy of the main file.
  await copyFile(p, p + ".bak");
  if (kind === "skill") await rm(path.dirname(p), { recursive: true, force: true });
  else await rm(p);
}

// ---------- hooks in settings.json

export type SettingsScope = "user" | "project" | "local";

export function settingsPath(scope: SettingsScope, projectDir: string | null): string {
  if (scope === "user") return path.join(claudeHome(), "settings.json");
  if (!projectDir) throw new ForgeError("VALIDATION", "Für diesen Bereich wird ein Projekt benötigt.");
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Hooks müssen ein JSON-Objekt sein.";
  for (const [event, matchers] of Object.entries(value)) {
    if (!HOOK_EVENTS.has(event)) return `Unbekanntes Hook-Ereignis: ${event}`;
    if (!Array.isArray(matchers)) return `${event}: erwartet wird eine Liste.`;
    for (const m of matchers) {
      if (!m || typeof m !== "object") return `${event}: Eintrag muss ein Objekt sein.`;
      const hooks = (m as { hooks?: unknown }).hooks;
      if (!Array.isArray(hooks) || hooks.length === 0) return `${event}: jeder Eintrag braucht eine nicht leere "hooks"-Liste.`;
      for (const h of hooks) {
        const t = (h as { type?: unknown }).type;
        if (typeof t !== "string") return `${event}: jeder Hook braucht einen "type" (z. B. "command").`;
        if (t === "command" && typeof (h as { command?: unknown }).command !== "string") return `${event}: Hook vom Typ "command" braucht "command".`;
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
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("kein Objekt");
    return { data: data as Record<string, unknown>, mtimeMs };
  } catch (e) {
    throw new ForgeError("VALIDATION", `${p} ist kein gültiges JSON: ${e instanceof Error ? e.message : e}`);
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
    throw new ForgeError("VALIDATION", `Kein gültiges JSON: ${e instanceof Error ? e.message : e}`);
  }
  const err = validateHooks(hooks);
  if (err) throw new ForgeError("VALIDATION", err);
  const p = settingsPath(scope, projectDir);
  const { data, mtimeMs } = await readSettings(p);
  if (mtimeMs !== expectedMtimeMs) throw new ForgeError("CONFLICT", "settings.json wurde inzwischen geändert. Bitte neu laden.");
  const next = { ...data };
  if (Object.keys(hooks as object).length === 0) delete next.hooks;
  else next.hooks = hooks;
  const written = await writeText(p, JSON.stringify(next, null, 2) + "\n", mtimeMs);
  return { path: p, mtimeMs: written };
}
