import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, SessionStatus } from "@forge/protocol";
import { GitEngine } from "../src/git/git.js";
import { Db, type SessionRecord } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { DailyReportService, dayRange, headMovedSince, localDate, reportText } from "../src/reports/daily-report.js";
import { git, initRepo, tempDir } from "./helpers.js";

describe("dayRange", () => {
  it("spans the local day, today without a date", () => {
    const now = new Date(2026, 9, 16, 14, 30);
    const r = dayRange(undefined, now);
    expect(r.date).toBe("2026-10-16");
    expect(r.from).toEqual(new Date(2026, 9, 16));
    expect(r.to).toEqual(new Date(2026, 9, 17));
    expect(dayRange("2026-03-01", now).from).toEqual(new Date(2026, 2, 1));
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("refuses days that do not exist", () => {
    expect(() => dayRange("2026-02-31", new Date())).toThrow(/gibt es nicht/);
    expect(() => dayRange("16.10.2026", new Date())).toThrow(/JJJJ-MM-TT/);
  });
});

describe("DailyReportService", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let repo: string;
  let app: Project;
  let other: Project;
  let prompts: Array<{ prompt: string; cwd: string }>;
  let service: DailyReportService;
  const engine = new GitEngine();

  const commit = async (file: string, message: string) => {
    writeFileSync(path.join(repo, file), `${message}\n`);
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", message);
    return (await git(repo, "rev-parse", "HEAD")).trim();
  };

  const session = (projectId: string, title: string, status: SessionStatus = "idle"): SessionRecord => {
    const ts = new Date().toISOString();
    const s: SessionRecord = {
      id: `s-${title}`,
      projectId,
      claudeSessionId: null,
      cwd: repo,
      title,
      model: null,
      effort: null,
      profile: "balanced",
      permissionMode: "default",
      status,
      apiKeySource: null,
      createdAt: ts,
      updatedAt: ts,
      lastError: status === "error" ? "Prozess abgestürzt\nDetails" : null,
    };
    db.insertSession(s);
    return s;
  };

  const turn = (sessionId: string, isError = false) => {
    db.appendEvent(sessionId, { type: "user.message", text: "Mach was" });
    db.appendEvent(sessionId, { type: "turn.result", subtype: isError ? "error" : "success", isError, durationMs: 1000, numTurns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, text: "fertig" });
  };

  beforeEach(async () => {
    t = tempDir("forge-report-");
    repo = path.join(t.dir, "app");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await commit("README.md", "init");
    const second = path.join(t.dir, "web");
    mkdirSync(second, { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, engine, () => "balanced");
    app = await projects.import(repo);
    other = await projects.import(second, null, false);
    prompts = [];
    service = new DailyReportService({
      db,
      git: engine,
      projects,
      dataDir: t.dir,
      summarize: async (prompt, cwd) => (prompts.push({ prompt, cwd }), { text: "- Viel geschafft\n", model: "haiku" }),
    });
  });
  afterEach(() => {
    db.close();
    t.cleanup();
  });

  it("collects sessions, commits, agents, open items and calls of today", async () => {
    const work = session(app.id, "Export");
    turn(work.id);
    turn(work.id, true);
    const hash = await commit("export.ts", "CSV-Export");
    db.appendEvent(work.id, { type: "automation", action: "commit", ok: true, message: "CSV-Export", hash, files: ["export.ts"] });
    const manual = await commit("notes.md", "Notizen von Hand");

    const asking = session(app.id, "Frage", "waiting_approval");
    db.appendEvent(asking.id, { type: "user.message", text: "Baue es" });
    const ask = (requestId: string, toolName: string, input: Record<string, unknown>) =>
      db.appendEvent(asking.id, { type: "approval.request", requestId, toolUseId: `t-${requestId}`, toolName, input, title: null, description: null, reason: null, allowSessionScope: false, outsideProject: false });
    ask("r1", "Bash", { command: "rm -rf dist" });
    db.appendEvent(asking.id, { type: "approval.resolved", requestId: "r1", decision: "allow", scope: "once", source: "user", message: null });
    ask("r2", "AskUserQuestion", { questions: [{ question: "Welches Format?", options: [{ label: "CSV" }] }] });

    const broken = session(other.id, "Kaputt", "error");
    turn(broken.id, true);
    const limited = session(other.id, "Limit");
    turn(limited.id);
    db.setAutoContinue({ sessionId: limited.id, dueAt: new Date(Date.now() + 3600_000).toISOString(), resetsAt: null, afterSeq: 2, attempts: 0, probes: 0 });

    // An agent that was merged today (its worktree is gone) and one that is still waiting.
    db.logAgent({ worktreeId: "wt-weg", rootId: app.id, rootName: app.name, branch: "agent/csv", title: "CSV bauen", sessionId: "s-alt", parentSessionId: work.id, startedAt: new Date().toISOString(), outcome: "merged", message: "1 Commit übernommen", commits: [{ hash: manual, subject: "Notizen von Hand", auto: true }] });
    const wtDir = path.join(t.dir, "wt");
    mkdirSync(wtDir);
    const wt = await projects.import(wtDir, app.id, false);
    db.updateProject(wt.id, { name: "app · agent/warten" });
    const agentSession = session(wt.id, "Agent wartet");
    turn(agentSession.id);
    db.logAgent({ worktreeId: wt.id, rootId: app.id, rootName: app.name, branch: "agent/warten", title: "Agent wartet", sessionId: agentSession.id, parentSessionId: null, startedAt: wt.createdAt, outcome: "waiting", message: "Wartet aufs Zusammenführen", commits: [] });
    // Waiting again a few minutes later is no second row.
    db.logAgent({ worktreeId: wt.id, rootId: app.id, rootName: app.name, branch: "agent/warten", title: null, sessionId: null, parentSessionId: null, startedAt: null, outcome: "waiting", message: "noch immer", commits: [] });

    db.savePhoneCall({ id: "c1", direction: "in", number: "0151", reason: null, startedAt: new Date().toISOString(), endedAt: null, result: "answered", detail: null, transcript: [{ role: "caller", text: "Hallo", ts: new Date().toISOString() }] });

    const r = await service.build();
    expect(r.date).toBe(localDate(new Date()));
    expect(r.projectId).toBeNull();
    expect(r.sessions.find((s) => s.id === work.id)).toMatchObject({ turns: 2, errors: 1, projectName: app.name, agent: false });
    expect(r.sessions.find((s) => s.id === agentSession.id)).toMatchObject({ agent: true, rootId: app.id });
    expect(r.sessions.map((s) => s.id).sort()).toEqual([work.id, asking.id, broken.id, limited.id, agentSession.id].sort());

    const byHash = new Map(r.commits.map((c) => [c.hash, c]));
    expect(byHash.get(hash)).toMatchObject({ subject: "CSV-Export", auto: true, sessionId: work.id, agentBranch: null, projectId: app.id });
    expect(byHash.get(manual)).toMatchObject({ auto: true, agentBranch: "agent/csv", sessionId: null });
    // The project without git costs no git call and has no commits.
    expect(r.commits.every((c) => c.projectId === app.id)).toBe(true);

    expect(r.agents.map((a) => [a.branch, a.state, a.exists])).toEqual(
      expect.arrayContaining([
        ["agent/csv", "merged", false],
        ["agent/warten", "waiting", true],
      ]),
    );
    expect(r.agents.find((a) => a.branch === "agent/warten")).toMatchObject({ sessionId: agentSession.id, message: "Wartet aufs Zusammenführen" });

    expect(r.open.map((o) => [o.kind, o.sessionId, o.text])).toEqual([
      ["question", asking.id, "Welches Format?"],
      ["error", broken.id, "Prozess abgestürzt"],
      ["autoContinue", limited.id, "Wartet aufs Nutzungslimit, FORGE prüft regelmäßig."],
    ]);
    expect(r.open[0]!.requestId).toBe("r2");
    expect(r.calls).toEqual([expect.objectContaining({ id: "c1", lines: 1 })]);
    expect(r.truncated).toBe(false);

    const text = reportText(r, { ref: (id) => (id === work.id ? "S1" : "S?") });
    expect(text).toMatch(/^Tagesbericht für heute, /);
    expect(text).toContain("S1 „Export“");
    expect(text).toContain("CSV-Export (Auto-Commit)");
    expect(text).toContain("agent/csv in app „CSV bauen“: zusammengeführt");
    expect(text).toContain("Rückfrage in S? „Frage“");
    expect(text).toContain("Telefonate: 1");
  }, 30_000);

  it("finds agent merges FORGE has no record of in the reflog", async () => {
    // Merged by a build before agent_log, or by hand: only git knows.
    await git(repo, "checkout", "-q", "-b", "agent/alt");
    const first = await commit("a.ts", "Teil eins");
    const second = await commit("b.ts", "Limit-Prognose");
    await git(repo, "checkout", "-q", "-");
    await git(repo, "merge", "--ff-only", "-q", "refs/heads/agent/alt");
    await git(repo, "branch", "-D", "agent/alt");
    await git(repo, "checkout", "-q", "-b", "feature/x");
    await commit("c.ts", "Kein Agent");
    await git(repo, "checkout", "-q", "-");
    await git(repo, "merge", "-q", "feature/x");
    // The same branch also in agent_log: listed once.
    await git(repo, "checkout", "-q", "-b", "agent/geloggt");
    const logged = await commit("d.ts", "Geloggt");
    await git(repo, "checkout", "-q", "-");
    await git(repo, "merge", "--ff-only", "-q", "agent/geloggt");
    db.logAgent({ worktreeId: "wt-g", rootId: app.id, rootName: app.name, branch: "agent/geloggt", title: "Mit Log", sessionId: null, parentSessionId: null, startedAt: null, outcome: "merged", message: "1 Commit übernommen", commits: [{ hash: logged, subject: "Geloggt", auto: true }] });

    const r = await service.build();
    expect(r.agents.map((a) => [a.branch, a.state, a.title, a.message])).toEqual([
      ["agent/geloggt", "merged", "Mit Log", "1 Commit übernommen"],
      ["agent/alt", "merged", "Limit-Prognose", "2 Commits übernommen"],
    ]);
    const byHash = new Map(r.commits.map((c) => [c.hash, c]));
    expect(byHash.get(first)?.agentBranch).toBe("agent/alt");
    expect(byHash.get(second)?.agentBranch).toBe("agent/alt");
    expect(byHash.get(logged)).toMatchObject({ agentBranch: "agent/geloggt", auto: true });
    expect(r.commits.find((c) => c.subject === "Kein Agent")?.agentBranch).toBeNull();
  }, 30_000);

  it("narrows to one project with its agents and leaves calls out", async () => {
    turn(session(app.id, "Hier").id);
    turn(session(other.id, "Dort").id);
    db.savePhoneCall({ id: "c1", direction: "out", number: "0151", reason: "fertig", startedAt: new Date().toISOString(), endedAt: null, result: "missed", detail: null, transcript: [] });
    const r = await service.build({ projectId: app.id });
    expect(r.projectName).toBe(app.name);
    expect(r.sessions.map((s) => s.title)).toEqual(["Hier"]);
    expect(r.calls).toBeNull();
    expect(reportText(r)).toContain(`Projekt ${app.name} mit seinen Agenten`);
  });

  it("finds nothing on another day", async () => {
    turn(session(app.id, "Heute").id);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const r = await service.build({ date: localDate(yesterday) });
    expect(r.sessions).toEqual([]);
    expect(r.commits).toEqual([]);
    expect(reportText(r)).toMatch(/^Tagesbericht für gestern, /);
    await expect(service.summarize({ date: localDate(yesterday) })).rejects.toThrow(/nichts zusammenzufassen/);
  });

  it("summarizes the report's facts with one Claude call in the project folder", async () => {
    turn(session(app.id, "Export").id);
    const r = await service.summarize({ projectId: app.id });
    expect(r).toEqual({ summary: "- Viel geschafft", model: "haiku" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cwd).toBe(app.path);
    expect(prompts[0]!.prompt).toContain("„Export“");
    expect(prompts[0]!.prompt).toContain("Nur Fakten aus dem Bericht");
  });

  it("tells from the reflog whether HEAD moved", async () => {
    expect(await headMovedSince(repo, 0)).toBe(true);
    expect(await headMovedSince(repo, Date.now() + 60_000)).toBe(false);
    expect(await headMovedSince(path.join(repo, "unterordner"), 0)).toBe(true);
  });
});
