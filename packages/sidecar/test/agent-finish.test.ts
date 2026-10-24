import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@forge/protocol";
import { AgentFinisher, conflictPrompt } from "../src/automation/agent-finish.js";
import { setLanguage } from "../src/i18n/index.js";
import { WorktreeService, worktreeRoot } from "../src/automation/worktrees.js";
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
  /** live sessions as SessionService.listLive reports them */
  let live: Array<{ id: string; cwd: string; status: string }>;
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
    live = [];
    const sessions = {
      listLive: () => live,
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
    // For the daily report: the agent outlives its worktree in agent_log, with the commits as main has them.
    const log = db.agentLogBetween("", "￿");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ worktreeId: wt.id, rootId: parent.id, rootName: parent.name, branch: "agent/csv", outcome: "merged", startedAt: wt.createdAt });
    const hashes = (await git(repo, "log", "-2", "--format=%H")).trim().split("\n");
    expect(log[0]!.commits.map((c) => [c.hash, c.subject])).toEqual([
      [hashes[0], "Restliche Änderungen von agent/csv"],
      [hashes[1], "CSV-Export"],
    ]);
  }, 30_000);

  it("hands rebase conflicts back to the agent and leaves everything in place", async () => {
    const wt = await worktrees.create(parent, "agent/readme", { fromDir: repo });
    await commitFile(wt.path, "README.md", "# Agent\n", "README vom Agenten");
    await commitFile(repo, "README.md", "# Main\n", "README auf main");

    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "conflict", files: ["README.md"], sessionId: "s-konflikt" });
    expect(started[0]).toMatchObject({ projectId: wt.id, prompt: expect.stringContaining("git merge main") });
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
    expect(db.agentLogBetween("", "￿").map((e) => [e.outcome, e.branch, e.commits.length])).toEqual([["discarded", "agent/weg", 0]]);
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

  it("merges into the branch the agent started from while the project has another one checked out", async () => {
    const wt = await worktrees.create(parent, "agent/main-weg", { fromDir: repo });
    await commitFile(wt.path, "a.txt", "a\n", "A");
    await git(repo, "checkout", "-b", "feature/x");
    await commitFile(repo, "x.txt", "x\n", "X");
    const review = await finisher.review(wt.id);
    expect(review).toMatchObject({ targetBranch: "main", mergeBlocker: null, ahead: 1, behind: 0 });
    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "merged", targetBranch: "main", commits: 1 });
    expect((await git(repo, "log", "-1", "--format=%s", "main")).trim()).toBe("A");
    // The project's own checkout stays as it was.
    expect((await git(repo, "branch", "--show-current")).trim()).toBe("feature/x");
    expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
    expect(existsSync(path.join(repo, "a.txt"))).toBe(false);
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "branch", "--list", "agent/main-weg")).toBe("");
  }, 30_000);

  it("merges into the worktree that has the agent's branch of origin checked out now", async () => {
    const wt = await worktrees.create(parent, "agent/dort", { fromDir: repo });
    await commitFile(wt.path, "a.txt", "a\n", "A");
    await git(repo, "checkout", "-b", "feature/x");
    const elsewhere = path.join(t.dir, "main-wt");
    await git(repo, "worktree", "add", elsewhere, "main");
    expect(await finisher.finish(wt.id, "merge")).toMatchObject({ outcome: "merged", targetBranch: "main" });
    expect(readFileSync(path.join(elsewhere, "a.txt"), "utf8").trim()).toBe("a");
    expect((await git(elsewhere, "status", "--porcelain")).trim()).toBe("");
  }, 30_000);

  it("blocks the merge when the branch the agent started from is gone", async () => {
    const wt = await worktrees.create(parent, "agent/waise", { fromDir: repo });
    await commitFile(wt.path, "a.txt", "a\n", "A");
    await git(repo, "checkout", "-b", "feature/x");
    await git(repo, "branch", "-D", "main");
    expect((await finisher.review(wt.id)).mergeBlocker).toMatch(/von main abgezweigt, diesen Branch gibt es nicht mehr/);
    await expect(finisher.finish(wt.id, "merge")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(existsSync(wt.path)).toBe(true);
  }, 20_000);

  it("completes a merge the agent left uncommitted after solving its conflicts", async () => {
    const wt = await worktrees.create(parent, "agent/halb", { fromDir: repo });
    await commitFile(wt.path, "README.md", "# Agent\n", "README vom Agenten");
    await commitFile(repo, "README.md", "# Main\n", "README auf main");
    await git(wt.path, "merge", "main").catch(() => "");
    writeFileSync(path.join(wt.path, "README.md"), "# Beide\n");
    await git(wt.path, "add", "README.md");
    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "merged", targetBranch: "main" });
    expect(readFileSync(path.join(repo, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe("# Beide\n");
    expect(existsSync(wt.path)).toBe(false);
  }, 30_000);

  it("clears the remains of a merged agent: folder, entry and its merged branch", async () => {
    const wt = await worktrees.create(parent, "agent/rest-gemergt", { fromDir: repo });
    await commitFile(wt.path, "a.txt", "a\n", "A");
    await git(repo, "merge", "--ff-only", "agent/rest-gemergt");
    // As after a git killed half way: the folder lost its .git, git still lists the worktree.
    rmSync(path.join(wt.path, ".git"));
    expect(finisher.isRemains(projects.get(wt.id))).toBe(true);
    await finisher.clearRemains(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(projects.all().map((p) => p.id)).toEqual([parent.id]);
    expect(await git(repo, "branch", "--list", "agent/rest-gemergt")).toBe("");
  }, 20_000);

  it("keeps the branch of remains whose work is not merged", async () => {
    const wt = await worktrees.create(parent, "agent/rest-offen", { fromDir: repo });
    await commitFile(wt.path, "a.txt", "a\n", "A");
    rmSync(path.join(wt.path, ".git"));
    await finisher.clearRemains(wt.id);
    expect(existsSync(wt.path)).toBe(false);
    expect((await git(repo, "branch", "--list", "agent/rest-offen")).trim()).toBe("agent/rest-offen");
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

  const lines = (n: number, change: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => change[i + 1] ?? `Zeile ${i + 1}`).join("\n") + "\n";
  /** git checks files out with CRLF on Windows */
  const read = (file: string) => readFileSync(path.join(repo, file), "utf8").replace(/\r\n/g, "\n");
  const stashes = async () => (await git(repo, "stash", "list")).trim();

  it("carries uncommitted changes in the project over the merge when they touch other lines of the agent's files", async () => {
    await commitFile(repo, "notes.md", lines(12), "Notizen");
    const wt = await worktrees.create(parent, "agent/notes", { fromDir: repo });
    await commitFile(wt.path, "notes.md", lines(12, { 1: "Agent oben" }), "Agent: Notizen");
    // The main session's work in progress: the same file, other lines, not committed.
    writeFileSync(path.join(repo, "notes.md"), lines(12, { 11: "Hauptsession unten" }));

    const r = await finisher.finish(wt.id, "merge");
    expect(r.outcome).toBe("merged");
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("Agent: Notizen");
    // Both are there; the main session's lines are still uncommitted, nothing left in the stash.
    expect(read("notes.md")).toBe(lines(12, { 1: "Agent oben", 11: "Hauptsession unten" }));
    expect((await git(repo, "status", "--porcelain")).trim()).toBe("M notes.md");
    expect(await stashes()).toBe("");
    expect(existsSync(wt.path)).toBe(false);
  }, 30_000);

  it("waits without touching anything when the uncommitted changes hit the same lines", async () => {
    const wt = await worktrees.create(parent, "agent/readme2", { fromDir: repo });
    await commitFile(wt.path, "README.md", "# Agent\n", "README");
    writeFileSync(path.join(repo, "README.md"), "# lokal\n");
    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "waiting", files: ["README.md"], message: expect.stringMatching(/^Noch nicht zusammengeführt: .*dieselben Stellen in README\.md/) });
    expect(readFileSync(path.join(repo, "README.md"), "utf8").trim()).toBe("# lokal");
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("init");
    expect(await stashes()).toBe("");
    expect(existsSync(wt.path)).toBe(true);

    // Once the project committed its work, the next try rebases the agent; the clash goes back to it.
    await git(repo, "commit", "-am", "lokal");
    expect((await finisher.finish(wt.id, "merge")).outcome).toBe("conflict");
  }, 30_000);

  it("waits while a session works in the project, also when the changes would fit, and for new files of the same name", async () => {
    await commitFile(repo, "notes.md", lines(12), "Notizen");
    const wt = await worktrees.create(parent, "agent/busy", { fromDir: repo });
    await commitFile(wt.path, "notes.md", lines(12, { 1: "Agent" }), "Agent: Notizen");
    await commitFile(wt.path, "neu.ts", "export const a = 1;\n", "Agent: neu");
    writeFileSync(path.join(repo, "notes.md"), lines(12, { 11: "Hauptsession" }));
    live = [{ id: "main", cwd: repo, status: "running" }];
    expect(await finisher.finish(wt.id, "merge")).toMatchObject({ outcome: "waiting", message: expect.stringMatching(/arbeitet gerade eine Session/) });

    live = [{ id: "main", cwd: repo, status: "idle" }];
    writeFileSync(path.join(repo, "neu.ts"), "export const b = 2;\n");
    expect(await finisher.finish(wt.id, "merge")).toMatchObject({ outcome: "waiting", message: expect.stringMatching(/neue, nicht committete Dateien, die der Agent ebenfalls angelegt hat: neu\.ts/) });
    expect(read("notes.md")).toBe(lines(12, { 11: "Hauptsession" }));

    rmSync(path.join(repo, "neu.ts"));
    expect((await finisher.finish(wt.id, "merge")).outcome).toBe("merged");
    expect(read("notes.md")).toBe(lines(12, { 1: "Agent", 11: "Hauptsession" }));
  }, 30_000);

  it("keeps a branch on discard that existed before the agent or that the agent switched to", async () => {
    await git(repo, "branch", "feature/kunde");
    const onExisting = await worktrees.create(parent, "feature/kunde");
    await commitFile(onExisting.path, "kunde.txt", "x\n", "Kundenarbeit");
    const r = await finisher.finish(onExisting.id, "discard");
    expect(r).toMatchObject({ outcome: "discarded", branch: "feature/kunde", branchError: null, message: expect.stringMatching(/feature\/kunde hat nicht FORGE .* bleibt erhalten/) });
    expect(existsSync(onExisting.path)).toBe(false);
    expect((await git(repo, "log", "-1", "--format=%s", "feature/kunde")).trim()).toBe("Kundenarbeit");

    const switched = await worktrees.create(parent, "agent/wechsel", { fromDir: repo });
    await git(switched.path, "checkout", "feature/kunde");
    await finisher.finish(switched.id, "discard");
    expect((await git(repo, "log", "-1", "--format=%s", "feature/kunde")).trim()).toBe("Kundenarbeit");
  }, 30_000);

  it("merges an existing branch but keeps its name afterwards", async () => {
    await git(repo, "branch", "feature/alt");
    const wt = await worktrees.create(parent, "feature/alt");
    await commitFile(wt.path, "alt.txt", "x\n", "Alt");
    const r = await finisher.finish(wt.id, "merge");
    expect(r).toMatchObject({ outcome: "merged", branchError: null, message: expect.stringMatching(/Worktree gelöscht\. Den Branch feature\/alt hat nicht FORGE/) });
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("Alt");
    expect(await git(repo, "branch", "--list", "feature/alt")).toContain("feature/alt");
  }, 30_000);

  it("deletes the branch of an older agent (no folder recorded) on discard only when it is merged", async () => {
    const wt = await worktrees.create(parent, "agent/aelter", { fromDir: repo });
    await git(repo, "config", "--unset", "branch.agent/aelter.forgeWorktree");
    await commitFile(wt.path, "idee.txt", "x\n", "Idee");
    const r = await finisher.finish(wt.id, "discard");
    expect(r.branchError).toMatch(/Commits, die in keinem anderen Branch sind/);
    expect(await git(repo, "branch", "--list", "agent/aelter")).toContain("agent/aelter");
  }, 30_000);

  describe("project in a subfolder of the repository", () => {
    let sub: string;
    let subProject: Project;
    beforeEach(async () => {
      sub = path.join(repo, "packages", "web");
      mkdirSync(sub, { recursive: true });
      await commitFile(sub, "page.ts", "export {};\n", "Web");
      subProject = await projects.import(sub);
    });

    it("waits for a new file of the same name, with paths relative to the project", async () => {
      const wt = await worktrees.create(subProject, "agent/sub-neu", { fromDir: sub });
      expect(wt.path).toBe(path.join(worktreeRoot(wt.path), "packages", "web"));
      await commitFile(wt.path, "neu.ts", "export const a = 1;\n", "Agent: neu");
      writeFileSync(path.join(sub, "neu.ts"), "export const b = 2;\n");
      expect(await finisher.finish(wt.id, "merge")).toMatchObject({ outcome: "waiting", message: expect.stringMatching(/die der Agent ebenfalls angelegt hat: neu\.ts/) });

      rmSync(path.join(sub, "neu.ts"));
      writeFileSync(path.join(wt.path, "..", "..", "daneben.txt"), "neben dem Projekt\n");
      const r = await finisher.finish(wt.id, "merge");
      expect(r).toMatchObject({ outcome: "merged", commits: 2 });
      expect(existsSync(path.join(repo, "daneben.txt"))).toBe(true);
      expect(existsSync(worktreeRoot(wt.path))).toBe(false);
      expect(await git(repo, "branch", "--list", "agent/sub-neu")).toBe("");
    }, 30_000);
  });
});

describe("conflictPrompt", () => {
  it("asks the agent in the language set", () => {
    expect(conflictPrompt("agent/x", "main", 2, ["a.ts"])).toMatch(/^Ich wollte deinen Branch agent\/x in main übernehmen/);
    setLanguage("en");
    try {
      const prompt = conflictPrompt("agent/x", "main", 1, ["a.ts"]);
      expect(prompt).toMatch(/^I wanted to take your branch agent\/x into main\. Since you started, main has 1 new commit that conflicts with your changes/);
      expect(prompt).toContain("- a.ts");
      expect(prompt).toContain("`git merge main`");
    } finally {
      setLanguage("de");
    }
  });
});
