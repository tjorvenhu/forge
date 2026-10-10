import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRuntime, RuntimeSession, SessionSink, StartOptions } from "../src/claude/runtime.js";
import { AgentSdkRuntime } from "../src/claude/runtime.js";
import { GitEngine } from "../src/git/git.js";
import { GitHubService } from "../src/github/github.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { SessionService } from "../src/sessions/session-service.js";
import { isDue, isoWeekday } from "../src/automation/schedules.js";
import { slugify, WorktreeService } from "../src/automation/worktrees.js";
import { WorkflowService } from "../src/automation/workflows.js";
import { git, initRepo, tempDir } from "./helpers.js";

describe("schedule timing", () => {
  const monday9 = new Date(2026, 9, 12, 9, 3);
  it("is due within 10 minutes after the slot, once", () => {
    expect(isoWeekday(monday9)).toBe(1);
    const s = { enabled: true, time: "09:00", weekdays: [1, 2, 3, 4, 5], lastRunAt: null };
    expect(isDue(s, monday9)).toBe(true);
    expect(isDue({ ...s, lastRunAt: new Date(2026, 9, 12, 9, 0, 30).toISOString() }, monday9)).toBe(false);
    expect(isDue({ ...s, lastRunAt: new Date(2026, 9, 9, 9, 1).toISOString() }, monday9)).toBe(true);
    expect(isDue(s, new Date(2026, 9, 12, 8, 59))).toBe(false);
    expect(isDue(s, new Date(2026, 9, 12, 9, 20))).toBe(false);
    expect(isDue({ ...s, weekdays: [6, 7] }, monday9)).toBe(false);
    expect(isDue({ ...s, enabled: false }, monday9)).toBe(false);
  });

  it("slugifies titles for branch names", () => {
    expect(slugify("Login mit Passkeys & Größe!")).toBe("login-mit-passkeys-groesse".replace("groesse", "grosse"));
    expect(slugify("")).toBe("aufgabe");
  });
});

/** Answers every turn: writes a file into the session cwd, then reports success. */
class ScriptedRuntime implements ClaudeRuntime {
  readonly id = "scripted";
  capabilities = new AgentSdkRuntime().capabilities;
  turns = 0;
  async listSessions() {
    return [];
  }
  async sessionHistory() {
    return [];
  }
  async probe(): Promise<never> {
    throw new Error("no probe");
  }
  async planUsage(): Promise<never> {
    throw new Error("no usage");
  }
  async commands() {
    return [];
  }
  async complete() {
    return "feat: Funktion umgesetzt";
  }
  resumeSession(id: string, o: Omit<StartOptions, "resume">, sink: SessionSink) {
    return this.startSession({ ...o, resume: id }, sink);
  }
  startSession(opts: StartOptions, sink: SessionSink): RuntimeSession {
    const answer = () => {
      this.turns++;
      setTimeout(() => {
        if (opts.permissionMode !== "plan") writeFileSync(path.join(opts.cwd, `feature-${this.turns}.txt`), "umgesetzt\n");
        sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
      }, 20);
    };
    if (opts.firstMessage) answer();
    return {
      sendMessage: () => answer(),
      rewindFiles: async () => ({ canRewind: false, error: null, filesChanged: [], insertions: 0, deletions: 0 }),
      supportedCommands: async () => [],
      interrupt: async () => {},
      close: () => sink.onEnd(null),
      setModel: async () => {},
      setPermissionMode: async (m) => {
        opts.permissionMode = m;
      },
      initialization: () => new Promise(() => {}),
    };
  }
}

describe("worktrees and feature workflow", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let sessions: SessionService;
  let worktrees: WorktreeService;
  let workflows: WorkflowService;
  let repo: string;
  const engine = new GitEngine();

  beforeEach(async () => {
    t = tempDir("forge-auto-");
    repo = path.join(t.dir, "app");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    writeFileSync(path.join(repo, "README.md"), "# app\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    db = new Db(path.join(t.dir, "forge.db"));
    db.updateSettings({ claudePath: process.execPath });
    projects = new ProjectManager(db, engine, () => "balanced");
    sessions = new SessionService(db, projects, engine, new ScriptedRuntime(), () => {});
    worktrees = new WorktreeService(engine, projects);
    workflows = new WorkflowService(db, projects, engine, new GitHubService(() => {}), sessions, worktrees, () => {});
  });
  afterEach(async () => {
    await sessions.drain();
    sessions.shutdown();
    db.close();
    t.cleanup();
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

  async function waitFor(id: string, pred: (s: string) => boolean) {
    for (let i = 0; i < 200; i++) {
      const r = workflows.get(id);
      if (pred(r.status)) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`timeout, status ${workflows.get(id).status}`);
  }

  it("runs plan approval, implementation, tests and commit on a feature branch", async () => {
    const parent = await projects.import(repo);
    projects.update(parent.id, { testCommand: 'node -e "process.exit(0)"' });
    const run = workflows.start({
      projectId: parent.id,
      title: "Export als CSV",
      requirement: "Daten als CSV exportieren",
      options: { useWorktree: false, approvePlan: true, runTests: true, review: true, push: false, createPr: false, draftPr: false },
    });
    expect(run.branch).toBe("feature/export-als-csv");
    let r = await waitFor(run.id, (s) => s === "waiting");
    expect(r.step).toBe("approve");
    await workflows.approvePlan(run.id, true);
    r = await waitFor(run.id, (s) => s === "waiting");
    expect(r.step).toBe("review");
    workflows.continueReview(run.id);
    r = await waitFor(run.id, (s) => s === "done" || s === "failed");
    expect(r.error).toBeNull();
    expect(r.status).toBe("done");
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ["branch", "done"],
      ["plan", "done"],
      ["approve", "done"],
      ["implement", "done"],
      ["test", "done"],
      ["review", "done"],
      ["commit", "done"],
      ["push", "skipped"],
      ["pr", "skipped"],
    ]);
    expect((await git(repo, "log", "--format=%s", "-1")).trim()).toBe("feat: Funktion umgesetzt");
    expect((await engine.status(repo)).summary.branch).toBe("feature/export-als-csv");
  });

  it("stops with a visible failure instead of committing when tests fail", async () => {
    const parent = await projects.import(repo);
    projects.update(parent.id, { testCommand: 'node -e "process.exit(1)"' });
    const run = workflows.start({
      projectId: parent.id,
      title: "Kaputt",
      requirement: "x",
      options: { useWorktree: true, approvePlan: false, runTests: true, review: false, push: false, createPr: false, draftPr: false },
    });
    const r = await waitFor(run.id, (s) => s === "waiting" || s === "failed");
    expect(r.step).toBe("test");
    expect(r.steps.find((s) => s.step === "test")?.message).toMatch(/fehlgeschlagen/);
    expect(r.workProjectId).not.toBe(parent.id);
    expect((await git(repo, "log", "--format=%s", "-1")).trim()).toBe("init");
    workflows.cancel(run.id);
    expect(workflows.get(run.id).status).toBe("cancelled");
  });

  it("refuses to branch a dirty working copy without worktree", async () => {
    const parent = await projects.import(repo);
    writeFileSync(path.join(repo, "fremd.txt"), "x\n");
    const run = workflows.start({
      projectId: parent.id,
      title: "Dirty",
      requirement: "x",
      options: { useWorktree: false, approvePlan: false, runTests: false, review: false, push: false, createPr: false, draftPr: false },
    });
    const r = await waitFor(run.id, (s) => s === "failed" || s === "done");
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/nicht committete/);
  });
});
