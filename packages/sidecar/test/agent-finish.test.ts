import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@forge/protocol";
import { AgentFinisher } from "../src/automation/agent-finish.js";
import { WorktreeService } from "../src/automation/worktrees.js";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import type { SessionService } from "../src/sessions/session-service.js";
import { git, initRepo, tempDir } from "./helpers.js";

describe("AgentFinisher", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let worktrees: WorktreeService;
  let finisher: AgentFinisher;
  let repo: string;
  let parent: Project;
  let started: Array<{ projectId: string; prompt: string }>;
  let closed: string[][];
  let notified: string[];
  const engine = new GitEngine();

  const commitFile = async (dir: string, file: string, content: string, message: string) => {
    writeFileSync(path.join(dir, file), content);
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", message);
  };

  beforeEach(async () => {
    t = tempDir("forge-agent-");
    repo = path.join(t.dir, "app");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await commitFile(repo, "README.md", "# app\n", "init");
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, engine, () => "balanced");
    worktrees = new WorktreeService(engine, projects);
    parent = await projects.import(repo);
    started = [];
    closed = [];
    notified = [];
    const sessions = {
      closeProject: async (ids: string[]) => void closed.push(ids),
      start: async (p: { projectId: string; prompt: string }) => (started.push(p), { id: "s-konflikt" }),
      send: async () => ({ id: "s-send" }),
    } as unknown as SessionService;
    finisher = new AgentFinisher({ db, git: engine, projects, sessions, worktrees, devServers: { forget: async () => {} }, notifyProject: (id) => notified.push(id) });
  });
  afterEach(() => {
    db.close();
    t.cleanup();
  });

  it("rebases the agent's commits onto new commits of its branch, fast-forwards and cleans up", async () => {
    const wt = await worktrees.create(parent, "agent/csv", { fromDir: repo });
    await commitFile(wt.path, "csv.ts", "export {};\n", "CSV-Export");
    await commitFile(repo, "other.ts", "export {};\n", "Anderes auf main");
    writeFileSync(path.join(wt.path, "rest.txt"), "nicht committet\n");

    const review = await finisher.review(wt.id);
    expect(review).toMatchObject({ branch: "agent/csv", targetBranch: "main", ahead: 1, behind: 1, filesChanged: 1, uncommitted: 1, busy: false, mergeBlocker: null });
    expect(review.commits.map((c) => c.subject)).toEqual(["CSV-Export"]);

    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "merged", branch: "agent/csv", targetBranch: "main", commits: 2, branchError: null });
    // Linear: the agent's work sits on top of main's newer commit.
    expect((await git(repo, "log", "--format=%s")).trim().split("\n")).toEqual(["Restliche Änderungen von agent/csv", "CSV-Export", "Anderes auf main", "init"]);
    expect(readFileSync(path.join(repo, "rest.txt"), "utf8").trim()).toBe("nicht committet");
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "branch", "--list", "agent/csv")).toBe("");
    expect(await git(repo, "config", "--get-regexp", "^branch\\.").catch(() => "")).not.toContain("agent/csv");
    expect(closed).toEqual([[wt.id]]);
    expect(projects.all().map((p) => p.id)).toEqual([parent.id]);
    expect(notified).toContain(parent.id);
  }, 30_000);

  it("hands rebase conflicts back to the agent and leaves everything in place", async () => {
    const wt = await worktrees.create(parent, "agent/readme", { fromDir: repo });
    await commitFile(wt.path, "README.md", "# Agent\n", "README vom Agenten");
    await commitFile(repo, "README.md", "# Main\n", "README auf main");

    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "conflict", files: ["README.md"], sessionId: "s-konflikt" });
    expect(started[0]).toMatchObject({ projectId: wt.id, prompt: expect.stringContaining("git rebase main") });
    expect(started[0]!.prompt).toContain("- README.md");
    expect(existsSync(wt.path)).toBe(true);
    expect((await git(wt.path, "status", "--porcelain")).trim()).toBe("");
    expect((await git(wt.path, "log", "-1", "--format=%s")).trim()).toBe("README vom Agenten");
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("README auf main");
  }, 30_000);

  it("discards worktree and branch without touching the target", async () => {
    const wt = await worktrees.create(parent, "agent/weg", { fromDir: repo });
    await commitFile(wt.path, "idee.txt", "x\n", "Idee");
    const r = await finisher.finish(wt.id, "discard");
    expect(r).toMatchObject({ outcome: "discarded", branch: "agent/weg", branchError: null });
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "branch", "--list", "agent/weg")).toBe("");
    expect((await git(repo, "log", "--format=%s")).trim()).toBe("init");
  }, 20_000);

  it("discards a half removed agent: branch gone, folder without .git", async () => {
    const wt = await worktrees.create(parent, "agent/rest", { fromDir: repo });
    rmSync(path.join(wt.path, ".git"));
    await git(repo, "worktree", "prune");
    await git(repo, "branch", "-D", "agent/rest");
    const r = await finisher.finish(wt.id, "discard");
    expect(r).toMatchObject({ outcome: "discarded", branch: null, branchError: null, message: "Agent verworfen." });
    expect(closed).toEqual([[wt.id]]);
    expect(existsSync(wt.path)).toBe(false);
    expect(projects.all().map((p) => p.id)).toEqual([parent.id]);
  }, 20_000);

  it("refuses to merge into another branch than the one the agent started from", async () => {
    const wt = await worktrees.create(parent, "agent/falsch", { fromDir: repo });
    await commitFile(wt.path, "a.txt", "a\n", "A");
    await git(repo, "checkout", "-b", "feature/x");
    const review = await finisher.review(wt.id);
    expect(review.mergeBlocker).toMatch(/von main abgezweigt, im Projekt ist jetzt feature\/x ausgecheckt/);
    await expect(finisher.finish(wt.id, "merge")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(existsSync(wt.path)).toBe(true);
  }, 20_000);

  it("merges into the worktree it started from and blocks agents without changes", async () => {
    const base = await worktrees.create(parent, "feature/basis");
    const wt = await worktrees.create(parent, "agent/weiter", { fromDir: base.path });
    expect((await finisher.review(wt.id)).mergeBlocker).toBe("Der Agent hat nichts geändert.");
    await commitFile(wt.path, "b.txt", "b\n", "B");
    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "merged", targetBranch: "feature/basis", commits: 1 });
    expect((await git(base.path, "log", "-1", "--format=%s")).trim()).toBe("B");
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("init");
  }, 30_000);

  it("stops a merge that would overwrite uncommitted changes in the project", async () => {
    const wt = await worktrees.create(parent, "agent/readme2", { fromDir: repo });
    await commitFile(wt.path, "README.md", "# Agent\n", "README");
    writeFileSync(path.join(repo, "README.md"), "# lokal\n");
    await expect(finisher.finish(wt.id, "merge")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/nicht committete Änderungen/) });
    expect(readFileSync(path.join(repo, "README.md"), "utf8").trim()).toBe("# lokal");
    expect(existsSync(wt.path)).toBe(true);
  }, 20_000);
});
