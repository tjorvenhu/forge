import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, type Project, type ProjectRemovalInfo } from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import { githubRepoFromRemote, type GitHubService } from "../github/github.js";
import type { SessionService } from "../sessions/session-service.js";
import type { WorktreeService } from "../automation/worktrees.js";
import type { DevServerService } from "../devserver/dev-server.js";
import { isInside, pathKey, sensitivePaths } from "../util/paths.js";
import type { ProjectManager } from "./project-manager.js";

export interface RemovalDeps {
  projects: ProjectManager;
  git: GitEngine;
  github: GitHubService;
  sessions: SessionService;
  worktrees: WorktreeService;
  devServers: Pick<DevServerService, "forget">;
  dataDir: string;
}

/** Folders directly under the home directory (or a OneDrive root) that are never a project. */
const KNOWN_FOLDERS = new Set(
  [
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Music",
    "Videos",
    "OneDrive",
    "Dokumente",
    "Bilder",
    "Musik",
    "Schreibtisch",
    "AppData",
    "Favorites",
    "Favoriten",
    "Links",
    "Contacts",
    "Kontakte",
    "Searches",
    "Saved Games",
    "3D Objects",
    "Public",
    "Templates",
    "Vorlagen",
  ].map((f) => f.toLowerCase()),
);

/** Folders that belong to the operating system, installed programs, Claude or credentials. */
export function systemDirs(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const list = [...sensitivePaths(home), env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")];
  for (const k of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "SystemRoot", "windir", "APPDATA", "LOCALAPPDATA"]) {
    const v = env[k];
    if (v) list.push(v);
  }
  list.push(path.join(home, "AppData"));
  return list;
}

function oneDriveRoots(env: NodeJS.ProcessEnv): string[] {
  return ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].map((k) => env[k]).filter((v): v is string => !!v);
}

/** Why a project folder must never be deleted from FORGE, or null if it may be. */
export function folderDeleteBlocker(dir: string, others: string[], protectedDirs: string[], home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  const abs = path.resolve(dir);
  if (path.parse(abs).root === abs || path.dirname(abs) === abs) return "Ein Laufwerk kann nicht gelöscht werden.";
  if (pathKey(abs) === pathKey(home) || isInside(home, abs)) return "Das Benutzerverzeichnis kann nicht gelöscht werden.";

  const name = path.basename(abs);
  const lower = name.toLowerCase();
  const oneDrive = oneDriveRoots(env);
  const parentKey = pathKey(path.dirname(abs));
  const underHome = parentKey === pathKey(home);
  const underRoot = underHome || oneDrive.some((r) => pathKey(r) === parentKey);
  if (underRoot && (KNOWN_FOLDERS.has(lower) || name.startsWith(".")) || (underHome && lower.startsWith("onedrive"))) {
    return `Der Ordner ${name} kann nicht gelöscht werden.`;
  }
  if (oneDrive.some((r) => isInside(r, abs))) return "Der Ordner enthält den OneDrive-Ordner.";

  // Projects in the temp folder stay deletable although it lies inside AppData on Windows.
  const tmp = os.tmpdir();
  const inTemp = isInside(abs, tmp) && pathKey(abs) !== pathKey(tmp);
  for (const sys of systemDirs(home, env)) {
    if (isInside(sys, abs)) return "Der Ordner enthält System-, Programm- oder Zugangsdaten und kann nicht gelöscht werden.";
    if (isInside(abs, sys) && !(inTemp && isInside(tmp, sys))) {
      return "Der Ordner gehört zum System, zu einem Programm oder zu Claude und kann nicht gelöscht werden.";
    }
  }

  if (protectedDirs.some((p) => isInside(p, abs))) return "Der Ordner enthält Daten von FORGE.";
  const nested = others.filter((o) => isInside(o, abs));
  if (nested.length) return `Der Ordner enthält ${nested.length === 1 ? "ein weiteres Projekt" : `${nested.length} weitere Projekte`}.`;
  return null;
}

function blockerFor(project: Project, d: RemovalDeps): string | null {
  const all = d.projects.all();
  // Worktrees of this project live elsewhere and are removed along with it.
  const others = all.filter((p) => p.id !== project.id && p.parentId !== project.id).map((p) => p.path);
  return folderDeleteBlocker(project.path, others, [d.dataDir, path.dirname(process.execPath)]);
}

export async function removalInfo(projectId: string, d: RemovalDeps): Promise<ProjectRemovalInfo> {
  const project = d.projects.get(projectId);
  const folderExists = existsSync(project.path);
  let githubRepo: string | null = null;
  if (folderExists && !project.parentId) {
    try {
      githubRepo = githubRepoFromRemote(await d.git.remoteUrl(project.path));
    } catch {
      githubRepo = null;
    }
  }
  const scopes = githubRepo ? await d.github.scopes().catch(() => null) : null;
  return {
    path: project.path,
    folderExists,
    folderBlocker: folderExists ? blockerFor(project, d) : null,
    isWorktree: !!project.parentId,
    worktrees: d.projects.all().filter((p) => p.parentId === project.id).length,
    githubRepo,
    githubSignedIn: scopes !== null,
    githubCanDelete: !!scopes?.includes("delete_repo"),
  };
}

/**
 * Removes a parallel agent: its worktree folder and FORGE entry; the branch stays. The agent's
 * Claude process and dev server run inside the folder, so they end first; otherwise Windows refuses
 * the deletion ("Permission denied"). A refused removal (uncommitted changes) leaves them running.
 */
export async function removeWorktree(projectId: string, force: boolean, d: Pick<RemovalDeps, "projects" | "sessions" | "worktrees" | "devServers">) {
  const worktree = d.projects.get(projectId);
  await d.worktrees.assertRemovable(worktree, force);
  await d.sessions.closeProject([worktree.id]);
  await d.devServers.forget(worktree.id);
  await d.worktrees.remove(worktree, force);
}

/**
 * Removes a project from FORGE and, if asked, its GitHub repository and local folder. Order matters:
 * GitHub first (most likely to fail, nothing is lost then), then the folder, then the entry.
 * Without deleteFolder, worktrees of the project stay as standalone projects.
 */
export async function removeProject(projectId: string, opts: { deleteFolder: boolean; deleteGitHubRepo: boolean }, d: RemovalDeps) {
  const project = d.projects.get(projectId);
  const info = await removalInfo(projectId, d);
  if (opts.deleteFolder && info.folderBlocker) throw new ForgeError("POLICY_DENIED", info.folderBlocker);
  if (opts.deleteGitHubRepo && !info.githubRepo) throw new ForgeError("VALIDATION", "Das Projekt hat kein GitHub-Repository als origin.");

  const children = opts.deleteFolder ? d.projects.all().filter((p) => p.parentId === project.id) : [];
  const affected = [project.id, ...children.map((c) => c.id)];
  await d.sessions.closeProject(affected);
  for (const id of affected) await d.devServers.forget(id);

  let githubDeleted = false;
  if (opts.deleteGitHubRepo && info.githubRepo) {
    await d.github.deleteRepo(info.githubRepo);
    githubDeleted = true;
  }

  let folderDeleted = false;
  if (opts.deleteFolder && info.folderExists) {
    const prefix = githubDeleted ? "Das GitHub-Repository wurde gelöscht, der Ordner aber nicht vollständig. " : "";
    try {
      for (const c of children) await d.worktrees.remove(c, true);
      if (project.parentId) await d.worktrees.remove(project, true);
      else if (!(await d.worktrees.removeIfWorktree(project.path))) {
        await rm(project.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    } catch (e) {
      if (e instanceof ForgeError) throw new ForgeError(e.code, prefix + e.message, e.details);
      const why = e instanceof Error ? e.message : String(e);
      throw new ForgeError("PATH_NOT_ACCESSIBLE", `${prefix}Ist er noch in einem Terminal oder Editor geöffnet? (${why})`);
    }
    folderDeleted = true;
  }

  if (d.projects.all().some((p) => p.id === project.id)) d.projects.remove(project.id);
  return { removed: true, folderDeleted, githubDeleted };
}
