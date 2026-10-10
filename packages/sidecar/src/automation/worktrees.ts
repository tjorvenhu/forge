import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type Project } from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import type { ProjectManager } from "../projects/project-manager.js";

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

/**
 * Parallel agents work in git worktrees: a sibling folder with its own branch, registered as a
 * FORGE project linked to its parent. Nothing is merged automatically.
 */
export class WorktreeService {
  constructor(
    private readonly git: GitEngine,
    private readonly projects: ProjectManager,
  ) {}

  async create(parent: Project, branch: string): Promise<Project> {
    if (!(await this.git.isRepo(parent.path))) throw new ForgeError("GIT_NOT_REPO", "Worktrees brauchen ein Git-Repository.");
    if (!(await this.git.hasCommits(parent.path))) throw new ForgeError("GIT_FAILED", "Das Repository braucht mindestens einen Commit.");
    const check = await this.git.exec(parent.path, ["check-ref-format", "--branch", branch]);
    if (check.code !== 0 || branch.startsWith("-")) throw new ForgeError("VALIDATION", `Ungültiger Branch-Name: ${branch}`);
    const root = path.join(path.dirname(parent.path), ".forge-worktrees", path.basename(parent.path));
    await mkdir(root, { recursive: true });
    let dir = path.join(root, slugify(branch.replace(/\//g, "-"), 60));
    for (let i = 2; existsSync(dir); i++) dir = `${dir}-${i}`;
    const exists = (await this.git.exec(parent.path, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0;
    const r = await this.git.exec(parent.path, exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir], undefined, 120_000);
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", (r.stderr || r.stdout).trim() || "Worktree konnte nicht angelegt werden");
    const project = await this.projects.import(dir, parent.id);
    this.projects.update(project.id, { name: `${parent.name} · ${branch}`, profile: parent.profile === "autonomous" ? "balanced" : parent.profile, tags: parent.tags.filter((t) => t !== "sandbox-only"), testCommand: parent.testCommand });
    return this.projects.get(project.id);
  }

  /** Removes the worktree folder; the branch and its commits stay in the repository. */
  async remove(worktree: Project, force: boolean) {
    if (!worktree.parentId) throw new ForgeError("VALIDATION", "Das ist kein Worktree-Projekt.");
    const parent = this.projects.get(worktree.parentId);
    if (!force && existsSync(worktree.path)) {
      const st = await this.git.status(worktree.path);
      if (st.files.length) throw new ForgeError("CONFLICT", `Der Worktree hat ${st.files.length} nicht committete Änderungen.`, { dirty: st.files.length });
    }
    if (existsSync(worktree.path)) {
      const r = await this.git.exec(parent.path, ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path], undefined, 60_000);
      if (r.code !== 0) throw new ForgeError("GIT_FAILED", (r.stderr || r.stdout).trim());
    } else {
      await this.git.exec(parent.path, ["worktree", "prune"]);
    }
    this.projects.remove(worktree.id);
  }
}
