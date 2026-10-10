import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { slugify, WorktreeService } from "../src/automation/worktrees.js";
import { git, initRepo, tempDir } from "./helpers.js";

describe("worktrees", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let worktrees: WorktreeService;
  let repo: string;
  const engine = new GitEngine();

  beforeEach(async () => {
    t = tempDir("forge-wt-");
    repo = path.join(t.dir, "app");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    writeFileSync(path.join(repo, "README.md"), "# app\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, engine, () => "balanced");
    worktrees = new WorktreeService(engine, projects);
  });
  afterEach(() => {
    db.close();
    t.cleanup();
  });

  it("slugifies titles for branch names", () => {
    expect(slugify("Login mit Passkeys & Größe!")).toBe("login-mit-passkeys-groesse".replace("groesse", "grosse"));
    expect(slugify("")).toBe("aufgabe");
  });

  it("creates a worktree as linked project and removes it again", async () => {
    const parent = await projects.import(repo);
    const wt = await worktrees.create(parent, "feature/parallel");
    expect(wt.parentId).toBe(parent.id);
    expect(existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect((await engine.status(wt.path)).summary.branch).toBe("feature/parallel");
    writeFileSync(path.join(wt.path, "dirty.txt"), "x\n");
    await expect(worktrees.remove(wt, false)).rejects.toThrow(/nicht committete/);
    await worktrees.remove(wt, true);
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "branch", "--list", "feature/parallel")).toContain("feature/parallel");
  });
});
