import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { freeDir, slugify, WorktreeService } from "../src/automation/worktrees.js";
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
    // Eight git calls; under the full suite on Windows that passes the 5 s default.
  }, 20_000);

  it("also deletes the worktree's branch on request, even with unmerged commits", async () => {
    const parent = await projects.import(repo);
    const wt = await worktrees.create(parent, "agent/versuch");
    writeFileSync(path.join(wt.path, "idee.txt"), "nie gemergt\n");
    await git(wt.path, "add", ".");
    await git(wt.path, "commit", "-m", "Versuch");
    const r = await worktrees.remove(wt, false, { deleteBranch: true });
    expect(r).toEqual({ deletedBranch: "agent/versuch", branchError: null });
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "branch", "--list", "agent/versuch")).toBe("");
  });

  it("starts a new branch where another working tree stands and takes over the project defaults", async () => {
    const parent = projects.update((await projects.import(repo)).id, { defaultModel: "opus", defaultEffort: "high" });
    const first = await worktrees.create(parent, "feature/basis");
    writeFileSync(path.join(first.path, "basis.txt"), "nur auf feature/basis\n");
    await git(first.path, "add", ".");
    await git(first.path, "commit", "-m", "Basis");
    const wt = await worktrees.create(parent, "agent/weiter", { fromDir: first.path });
    expect(existsSync(path.join(wt.path, "basis.txt"))).toBe(true);
    expect(wt).toMatchObject({ defaultModel: "opus", defaultEffort: "high" });
    expect(await worktrees.branchOf(wt.path)).toBe("agent/weiter");
    // Without fromDir the parent's HEAD, as before.
    const plain = await worktrees.create(parent, "agent/neu");
    expect(existsSync(path.join(plain.path, "basis.txt"))).toBe(false);
  });

  it("numbers colliding folders from a fixed base", () => {
    const taken = new Set(["/x/a", "/x/a-2", "/x/a-3"]);
    expect(freeDir("/x/a", (p) => taken.has(p))).toBe("/x/a-4");
    expect(freeDir("/x/b", (p) => taken.has(p))).toBe("/x/b");
  });

  it("removes the new worktree again when registering it as project fails", async () => {
    const parent = await projects.import(repo);
    const failing = Object.create(projects) as ProjectManager;
    failing.import = async () => {
      throw new Error("kaputt");
    };
    const svc = new WorktreeService(engine, failing);
    await expect(svc.create(parent, "feature/fail")).rejects.toThrow(/kaputt/);
    const dir = path.join(path.dirname(repo), ".forge-worktrees", "app", "feature-fail");
    expect(existsSync(dir)).toBe(false);
    expect(await git(repo, "worktree", "list")).not.toContain("feature-fail");
  });
});
