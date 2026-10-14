import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, ServerEvent, SessionEventBody } from "@forge/protocol";
import { AgentAutoMerge, AUTO_MERGE_TAG, MAX_CONFLICT_ROUNDS } from "../src/automation/agent-auto-merge.js";
import { AgentFinisher } from "../src/automation/agent-finish.js";
import { WorktreeService } from "../src/automation/worktrees.js";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import type { SessionService } from "../src/sessions/session-service.js";
import { git, initRepo, tempDir } from "./helpers.js";

describe("AgentAutoMerge", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let worktrees: WorktreeService;
  let auto: AgentAutoMerge;
  let repo: string;
  let parent: Project;
  let records: Array<{ sessionId: string; body: SessionEventBody }>;
  let events: ServerEvent[];
  let background: boolean;
  let live: Array<{ id: string; cwd: string; status: string }>;
  const engine = new GitEngine();

  const commitFile = async (dir: string, file: string, content: string, message: string) => {
    writeFileSync(path.join(dir, file), content);
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", message);
  };
  const session = (id: string, projectId: string, cwd: string) => {
    const now = new Date().toISOString();
    db.insertSession({ id, projectId, claudeSessionId: null, cwd, title: null, model: null, effort: null, profile: "balanced", permissionMode: "default", status: "idle", apiKeySource: null, createdAt: now, updatedAt: now, lastError: null });
  };
  /** an agent worktree with one commit and its session, started by the session "main" */
  const agent = async (branch: string, file = "feature.ts") => {
    const wt = await worktrees.create(parent, branch, { fromDir: repo });
    await commitFile(wt.path, file, "export {};\n", `Arbeit auf ${branch}`);
    session(`s-${branch}`, wt.id, wt.path);
    db.setSessionParent(`s-${branch}`, "main");
    return wt;
  };
  const outcomes = () => events.flatMap((e) => (e.event === "agent.autoMerge" ? [e.payload.outcome] : []));

  beforeEach(async () => {
    t = tempDir("forge-automerge-");
    repo = path.join(t.dir, "app");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await commitFile(repo, "README.md", "# app\n", "init");
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, engine, () => "balanced");
    worktrees = new WorktreeService(engine, projects);
    parent = await projects.import(repo);
    parent = projects.update(parent.id, { tags: [AUTO_MERGE_TAG] });
    session("main", parent.id, repo);
    records = [];
    events = [];
    background = false;
    live = [];
    const sessions = {
      listLive: () => live,
      closeProject: async () => {},
      start: async () => ({ id: "s-neu" }),
      send: async (id: string) => ({ id }),
    } as unknown as SessionService;
    const finisher = new AgentFinisher({ db, git: engine, projects, sessions, worktrees, devServers: { forget: async () => {} }, notifyProject: () => {} });
    auto = new AgentAutoMerge({
      db,
      projects,
      finisher,
      record: (sessionId, body) => records.push({ sessionId, body }),
      emit: (e) => events.push(e),
      parentOf: (id) => db.getSessionParent(id),
      hasBackground: () => background,
    });
  });
  afterEach(() => {
    auto.dispose();
    db.close();
    t.cleanup();
  });

  it("merges a finished agent into the branch it started from and tells the starting session", async () => {
    const wt = await agent("agent/csv");
    await auto.turnDone("s-agent/csv", true);
    expect(outcomes()).toEqual(["merged"]);
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("Arbeit auf agent/csv");
    expect(existsSync(wt.path)).toBe(false);
    expect(records.filter((r) => r.sessionId === "main").map((r) => r.body)).toEqual([expect.objectContaining({ type: "automation", action: "merge", ok: true })]);
  }, 30_000);

  it("does nothing without the tag on the main project, for plain sessions and while background work runs", async () => {
    const wt = await agent("agent/ohne");
    background = true;
    await auto.turnDone("s-agent/ohne", true);
    background = false;
    await auto.turnDone("main", true);
    projects.update(parent.id, { tags: [] });
    await auto.turnDone("s-agent/ohne", true);
    expect(events).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
  }, 20_000);

  it("clears away the remains of a merged agent whose folder would not go, without asking", async () => {
    const wt = await agent("agent/rest");
    // As after "Filename too long": git forgot the worktree, its files and FORGE's entry are still there.
    rmSync(path.join(wt.path, ".git"));
    await git(repo, "worktree", "prune");
    await auto.turnDone("s-agent/rest", true);
    expect(events).toEqual([]);
    expect(existsSync(wt.path)).toBe(false);
    expect(projects.all().some((p) => p.id === wt.id)).toBe(false);
  }, 30_000);

  it("merges the agent of a subfolder project instead of taking it for remains", async () => {
    const sub = path.join(repo, "packages", "web");
    mkdirSync(sub, { recursive: true });
    await commitFile(sub, "page.ts", "export {};\n", "Web");
    const web = projects.update((await projects.import(sub)).id, { tags: [AUTO_MERGE_TAG] });
    const wt = await worktrees.create(web, "agent/web", { fromDir: sub });
    await commitFile(wt.path, "neu.ts", "export {};\n", "Arbeit im Unterordner");
    session("s-web", wt.id, wt.path);
    await auto.turnDone("s-web", true);
    expect(outcomes()).toEqual(["merged"]);
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("Arbeit im Unterordner");
    expect(existsSync(path.join(sub, "neu.ts"))).toBe(true);
  }, 30_000);

  it("lets an agent wait while the main session works on the same files and merges it when that turn ends", async () => {
    const lines = (change: Record<number, string> = {}) => Array.from({ length: 12 }, (_, i) => change[i + 1] ?? `Zeile ${i + 1}`).join("\n") + "\n";
    await commitFile(repo, "notes.md", lines(), "Notizen");
    const wt = await worktrees.create(parent, "agent/notes", { fromDir: repo });
    await commitFile(wt.path, "notes.md", lines({ 1: "Agent" }), "Agent: Notizen");
    session("s-agent/notes", wt.id, wt.path);
    db.setSessionParent("s-agent/notes", "main");
    // The main session is mid-turn and has the same file open, uncommitted.
    writeFileSync(path.join(repo, "notes.md"), lines({ 11: "Hauptsession" }));
    live = [{ id: "main", cwd: repo, status: "running" }];

    await auto.turnDone("s-agent/notes", true);
    expect(outcomes()).toEqual(["waiting"]);
    expect(auto.waitingAgents()).toEqual([wt.id]);
    expect(events[0]).toMatchObject({ payload: { message: expect.stringMatching(/^Wartet aufs Zusammenführen: In main arbeitet gerade eine Session.*FORGE führt den Agenten selbst zusammen/) } });
    expect(records.map((r) => [r.sessionId, r.body.type === "automation" ? r.body.action : ""])).toEqual([
      ["s-agent/notes", "wait"],
      ["main", "wait"],
    ]);
    // Asked again while it still waits: no second notice.
    await auto.retryWaiting();
    expect(outcomes()).toEqual(["waiting"]);
    expect(existsSync(wt.path)).toBe(true);

    // The main session's turn is over: its end tries again, and now it fits.
    live = [{ id: "main", cwd: repo, status: "idle" }];
    await auto.turnDone("main", true);
    expect(outcomes()).toEqual(["waiting", "merged"]);
    expect(auto.waitingAgents()).toEqual([]);
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("Agent: Notizen");
    expect(existsSync(wt.path)).toBe(false);
  }, 40_000);

  it("leaves the agent to the user when its tests failed", async () => {
    const wt = await agent("agent/rot");
    await auto.turnDone("s-agent/rot", false);
    expect(outcomes()).toEqual(["skipped"]);
    expect(events[0]).toMatchObject({ payload: { worktreeId: wt.id, message: expect.stringContaining("Tests") } });
    expect(existsSync(wt.path)).toBe(true);
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("init");
  }, 20_000);

  it(`hands conflicts back to the agent, at most ${MAX_CONFLICT_ROUNDS} times`, async () => {
    const wt = await agent("agent/readme", "README.md");
    await commitFile(repo, "README.md", "# Main\n", "README auf main");
    for (let i = 0; i <= MAX_CONFLICT_ROUNDS; i++) await auto.turnDone("s-agent/readme", true);
    expect(outcomes()).toEqual([...Array<string>(MAX_CONFLICT_ROUNDS).fill("conflict"), "skipped"]);
    expect(existsSync(wt.path)).toBe(true);
  }, 60_000);
});
