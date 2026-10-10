import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, type Project, type ProjectRemovalInfo } from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import { githubRepoFromRemote, type GitHubService } from "../github/github.js";
import type { SessionService } from "../sessions/session-service.js";
import type { WorktreeService } from "../automation/worktrees.js";
import { isInside, pathKey } from "../util/paths.js";
import type { ProjectManager } from "./project-manager.js";

export interface RemovalDeps {
  projects: ProjectManager;
  git: GitEngine;
  github: GitHubService;
  sessions: SessionService;
  worktrees: WorktreeService;
  dataDir: string;
}

const HOME_FOLDERS = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "OneDrive", "Dokumente", "Bilder", "Musik"];

/** Why a project folder must never be deleted from FORGE, or null if it may be. */
export function folderDeleteBlocker(dir: string, others: string[], protectedDirs: string[], home = os.homedir()): string | null {
  const abs = path.resolve(dir);
  if (path.parse(abs).root === abs || path.dirname(abs) === abs) return "Ein Laufwerk kann nicht gelöscht werden.";
  if (pathKey(abs) === pathKey(home) || isInside(home, abs)) return "Das Benutzerverzeichnis kann nicht gelöscht werden.";
  if (pathKey(path.dirname(abs)) === pathKey(home) && HOME_FOLDERS.some((f) => f.toLowerCase() === path.basename(abs).toLowerCase())) {
    return `Der Ordner ${path.basename(abs)} kann nicht gelöscht werden.`;
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
 * Removes a project from FORGE and, if asked, its GitHub repository and local folder. Order matters:
 * GitHub first (most likely to fail, nothing is lost then), then the folder, then the entry.
 */
export async function removeProject(projectId: string, opts: { deleteFolder: boolean; deleteGitHubRepo: boolean }, d: RemovalDeps) {
  const project = d.projects.get(projectId);
  const info = await removalInfo(projectId, d);
  if (opts.deleteFolder && info.folderBlocker) throw new ForgeError("POLICY_DENIED", info.folderBlocker);
  if (opts.deleteGitHubRepo && !info.githubRepo) throw new ForgeError("VALIDATION", "Das Projekt hat kein GitHub-Repository als origin.");

  const children = d.projects.all().filter((p) => p.parentId === project.id);
  await d.sessions.closeProject([project.id, ...(opts.deleteFolder ? children.map((c) => c.id) : [])]);

  let githubDeleted = false;
  if (opts.deleteGitHubRepo && info.githubRepo) {
    await d.github.deleteRepo(info.githubRepo);
    githubDeleted = true;
  }

  let folderDeleted = false;
  if (opts.deleteFolder && info.folderExists) {
    for (const c of children) await d.worktrees.remove(c, true);
    try {
      if (project.parentId) await d.worktrees.remove(project, true);
      else await rm(project.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new ForgeError(
        "PATH_NOT_ACCESSIBLE",
        `${githubDeleted ? "Das GitHub-Repository wurde gelöscht, der Ordner aber nicht vollständig. " : ""}Ist er noch in einem Terminal oder Editor geöffnet? (${why})`,
      );
    }
    folderDeleted = true;
  }

  if (d.projects.all().some((p) => p.id === project.id)) d.projects.remove(project.id);
  return { removed: true, folderDeleted, githubDeleted };
}
