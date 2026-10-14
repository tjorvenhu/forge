import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type Project } from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { pathKey } from "../util/paths.js";

/** Branch-safe slug from free text. */
export function slugify(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "aufgabe"
  );
}

/** First of base, base-2, base-3, ... that does not exist yet. */
export function freeDir(base: string, exists: (p: string) => boolean = existsSync): string {
  if (!exists(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
}

const WORKTREES_DIR = ".forge-worktrees";

/**
 * Folder git checked a FORGE worktree out to. The worktree of a project in a subfolder of a larger
 * repository (monorepo) is registered at the same subfolder of that checkout.
 */
export function worktreeRoot(dir: string): string {
  const parts = path.resolve(dir).split(path.sep);
  const i = parts.lastIndexOf(WORKTREES_DIR);
  return i >= 0 && parts.length > i + 3 ? parts.slice(0, i + 3).join(path.sep) : dir;
}

/** Who made a worktree's branch: FORGE for exactly this worktree, FORGE for an older agent (no record of the folder), or someone else. */
export type BranchOwner = "worktree" | "forge" | null;

/**
 * Parallel agents work in git worktrees: a sibling folder with its own branch, registered as a
 * FORGE project linked to its parent. Merging back is AgentFinisher's job (by hand or with the auto-merge tag).
 */
export class WorktreeService {
  constructor(
    private readonly git: GitEngine,
    private readonly projects: ProjectManager,
  ) {}

  /**
   * `fromDir`: a new branch starts at the HEAD of this working tree (the project or one of its
   * worktrees) instead of the parent's HEAD, so an agent continues from where its starter stands.
   */
  async create(parent: Project, branch: string, opts: { fromDir?: string } = {}): Promise<Project> {
    if (!(await this.git.isRepo(parent.path))) throw new ForgeError("GIT_NOT_REPO", "Worktrees brauchen ein Git-Repository.");
    if (!(await this.git.hasCommits(parent.path))) throw new ForgeError("GIT_FAILED", "Das Repository braucht mindestens einen Commit.");
    const check = await this.git.exec(parent.path, ["check-ref-format", "--branch", branch]);
    if (check.code !== 0 || branch.startsWith("-")) throw new ForgeError("VALIDATION", `Ungültiger Branch-Name: ${branch}`);
    const exists = (await this.git.exec(parent.path, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
    const start: string[] = [];
    if (!exists && opts.fromDir) {
      const head = await this.git.exec(opts.fromDir, ["rev-parse", "--verify", "-q", "HEAD"]);
      if (head.code !== 0 || !head.stdout.trim()) throw new ForgeError("GIT_FAILED", "Der Ausgangsstand hat noch keinen Commit.");
      start.push(head.stdout.trim());
    }
    // A project in a subfolder of a larger repository: the checkout goes beside that repository, not
    // into its working tree, and the project is the same subfolder of the checkout.
    const loc = await this.git.exec(parent.path, ["rev-parse", "--show-toplevel", "--show-prefix"]);
    const [top = "", prefix = ""] = loc.code === 0 ? loc.stdout.split("\n").map((l) => l.trim()) : [];
    const repoDir = top && prefix ? path.resolve(top) : parent.path;
    const root = path.join(path.dirname(repoDir), WORKTREES_DIR, path.basename(repoDir));
    await mkdir(root, { recursive: true });
    const dir = freeDir(path.join(root, slugify(branch.replace(/\//g, "-"), 60)));
    const r = await this.git.exec(parent.path, exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, ...start], undefined, 120_000);
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", (r.stderr || r.stdout).trim() || "Worktree konnte nicht angelegt werden");
    if (!exists) await this.rememberOrigin(parent.path, branch, opts.fromDir ?? parent.path);
    // The branch was there before: it is not FORGE's, whatever an earlier agent on it left behind.
    else await this.git.exec(parent.path, ["config", "--unset", `branch.${branch}.forgeWorktree`]);
    let project: Project;
    try {
      project = await this.projects.import(top && prefix ? path.join(dir, prefix) : dir, parent.id);
    } catch (e) {
      // The branch stays (it may hold commits already); only the folder FORGE just created goes.
      await this.git.exec(parent.path, ["worktree", "remove", "--force", dir], undefined, 60_000).catch(() => null);
      throw e;
    }
    if (!exists) await this.git.exec(parent.path, ["config", `branch.${branch}.forgeWorktree`, worktreeRoot(project.path)]);
    this.projects.update(project.id, {
      name: `${parent.name} · ${branch}`,
      profile: parent.profile,
      tags: parent.tags,
      testCommand: parent.testCommand,
      devCommand: parent.devCommand,
      defaultModel: parent.defaultModel,
      defaultEffort: parent.defaultEffort,
    });
    return this.projects.get(project.id);
  }

  /**
   * Stored in the repository config under the branch, so it survives restarts and goes away with
   * `git branch -D`. Without it (older agents) the work goes back to the parent project.
   */
  private async rememberOrigin(repo: string, branch: string, fromDir: string) {
    const base = await this.git.currentBranch(fromDir).catch(() => null);
    await this.git.exec(repo, ["config", `branch.${branch}.forgeOriginDir`, fromDir]);
    if (base) await this.git.exec(repo, ["config", `branch.${branch}.forgeOriginBranch`, base]);
  }

  /** Working tree and branch a worktree's branch started from; null parts are unknown. */
  async origin(worktree: Project, branch: string): Promise<{ dir: string | null; branch: string | null }> {
    const read = async (key: string) => {
      const r = await this.git.exec(worktree.path, ["config", "--get", `branch.${branch}.${key}`]).catch(() => null);
      return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    };
    return { dir: await read("forgeOriginDir"), branch: await read("forgeOriginBranch") };
  }

  /**
   * Checked-out branch of a worktree folder; null when detached or unreadable. Without its `.git`
   * the folder is only leftover files, and git would answer for a repository further up instead.
   */
  async branchOf(dir: string): Promise<string | null> {
    if (!existsSync(path.join(worktreeRoot(dir), ".git"))) return null;
    return this.git.currentBranch(dir).catch(() => null);
  }

  /**
   * Whether FORGE made `branch` for this worktree. Only such a branch may go unmerged with the
   * worktree: a branch that existed before or that the agent switched to belongs to someone else.
   */
  async branchOwner(worktree: Project, branch: string, cwd = worktree.path): Promise<BranchOwner> {
    const read = async (key: string) => {
      const r = await this.git.exec(cwd, ["config", "--get", `branch.${branch}.${key}`]).catch(() => null);
      return r?.code === 0 ? r.stdout.trim() : null;
    };
    const made = await read("forgeWorktree");
    if (made !== null) return made && pathKey(made) === pathKey(worktreeRoot(worktree.path)) ? "worktree" : null;
    return (await read("forgeOriginDir")) ? "forge" : null;
  }

  /** Main working tree of `dir` if `dir` is the root of a linked worktree, else null. */
  async mainWorkingTree(dir: string): Promise<string | null> {
    if (!existsSync(dir)) return null;
    const r = await this.git.exec(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]).catch(() => null);
    if (!r || r.code !== 0) return null;
    const [top = "", gitDir = "", common = ""] = r.stdout.split("\n").map((l) => l.trim());
    if (!top || !gitDir || !common || pathKey(top) !== pathKey(dir) || pathKey(gitDir) === pathKey(common)) return null;
    return path.basename(common) === ".git" ? path.dirname(common) : common;
  }

  /**
   * Folder to run `git worktree` commands for a worktree from. Normally the parent project; if that
   * entry is gone, the main working tree. Never the worktree itself: Windows cannot delete a folder
   * that is the current directory of a process.
   */
  private async controlDir(worktree: Project): Promise<string | null> {
    const parent = this.projects.all().find((p) => p.id === worktree.parentId);
    if (parent?.exists) return parent.path;
    return this.mainWorkingTree(worktreeRoot(worktree.path));
  }

  /**
   * Deletes `dir` through git if it is a linked worktree, so the repository forgets it too (a
   * worktree whose parent entry was removed is a standalone project). False if it is none.
   */
  async removeIfWorktree(dir: string): Promise<boolean> {
    const main = await this.mainWorkingTree(dir);
    if (!main) return false;
    const r = await this.git.exec(main, ["worktree", "remove", "--force", dir], undefined, 60_000);
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", (r.stderr || r.stdout).trim() || "Worktree konnte nicht entfernt werden");
    return true;
  }

  /** Throws CONFLICT if the worktree has uncommitted changes and the removal is not forced. */
  async assertRemovable(worktree: Project, force: boolean) {
    if (!worktree.parentId) throw new ForgeError("VALIDATION", "Das ist kein Worktree-Projekt.");
    const root = worktreeRoot(worktree.path);
    if (force || !existsSync(path.join(root, ".git"))) return;
    // The whole checkout: with a monorepo project the agent may also have changed files beside it.
    const st = await this.git.status(root);
    if (st.files.length) throw new ForgeError("CONFLICT", `Der Worktree hat ${st.files.length} nicht committete Änderungen.`, { dirty: st.files.length });
  }

  /**
   * Removes the worktree folder; the branch and its commits stay in the repository. With
   * `deleteBranch` a branch FORGE made for this worktree goes too, merged or not; a branch of an
   * older agent only when merged, anyone else's stays. Processes running inside the folder
   * (sessions, dev server) must be ended first: Windows refuses to delete a folder that is the
   * current directory of a process.
   */
  async remove(worktree: Project, force: boolean, opts: { deleteBranch?: boolean } = {}): Promise<{ deletedBranch: string | null; branchError: string | null }> {
    await this.assertRemovable(worktree, force);
    const cwd = await this.controlDir(worktree);
    const root = worktreeRoot(worktree.path);
    const branch = opts.deleteBranch ? await this.branchOf(worktree.path) : null;
    const owner = branch && cwd ? await this.branchOwner(worktree, branch, cwd) : null;
    if (existsSync(root)) await this.deleteFolder(root, cwd, force);
    if (cwd) await this.git.exec(cwd, ["worktree", "prune"]);
    this.projects.remove(worktree.id);
    if (!opts.deleteBranch) return { deletedBranch: null, branchError: null };
    // The worktree is gone at this point; a failed branch deletion is reported, not thrown, so the
    // caller does not show the removal as failed.
    if (!branch || !cwd) return { deletedBranch: null, branchError: "Der Branch des Worktrees war nicht mehr zu ermitteln." };
    if (!owner) return { deletedBranch: null, branchError: foreignBranch(branch) };
    try {
      await this.git.deleteBranch(cwd, branch, owner === "worktree");
      return { deletedBranch: branch, branchError: null };
    } catch (e) {
      return { deletedBranch: null, branchError: e instanceof Error ? e.message : String(e) };
    }
  }

  private async deleteFolder(dir: string, cwd: string | null, force: boolean) {
    let last = "";
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, REMOVE_RETRY_MS));
      if (!existsSync(dir)) return;
      if (existsSync(path.join(dir, ".git"))) {
        if (!cwd) throw new ForgeError("GIT_FAILED", `Das Repository zu diesem Worktree wurde nicht gefunden: ${dir}`);
        const r = await this.git.exec(cwd, ["worktree", "remove", ...(force ? ["--force"] : []), dir], undefined, 60_000);
        if (r.code === 0) {
          // On Windows git can report success and still leave node_modules (pnpm junctions) behind.
          if (existsSync(dir)) await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
          return;
        }
        last = (r.stderr || r.stdout).trim();
        // Paths beyond 260 characters (node_modules of the worktree) stop git on Windows, Node
        // deletes them; `worktree prune` afterwards drops git's entry for the folder.
        if (LONG_PATH.test(last)) {
          try {
            await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            return;
          } catch (e) {
            last = e instanceof Error ? e.message : String(e);
            continue;
          }
        }
        if (!FOLDER_IN_USE.test(last)) throw new ForgeError("GIT_FAILED", last || "Worktree konnte nicht entfernt werden");
      } else {
        // An earlier attempt got as far as deleting the .git file: git no longer sees a worktree
        // here, only the leftover files of one.
        try {
          await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
          return;
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
      }
    }
    throw new ForgeError(
      "PATH_NOT_ACCESSIBLE",
      `Der Worktree-Ordner wird noch von einem anderen Programm benutzt, etwa einem Terminal, Editor oder Explorer-Fenster. Schließe es und versuche es noch einmal. (${last})`,
    );
  }
}

export function foreignBranch(branch: string): string {
  return `Den Branch ${branch} hat nicht FORGE für diesen Agenten angelegt, er bleibt erhalten.`;
}

/** git and Node messages for a folder that another process still holds open. */
const FOLDER_IN_USE = /permission denied|resource busy|directory not empty|used by another process|EPERM|EBUSY|ENOTEMPTY|EACCES/i;
const LONG_PATH = /filename too long|path too long|ENAMETOOLONG/i;
const REMOVE_ATTEMPTS = 6;
const REMOVE_RETRY_MS = 300;
