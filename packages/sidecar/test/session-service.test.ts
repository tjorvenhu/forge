import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent, SessionEventBody } from "@forge/protocol";
import type { ClaudeRuntime, RuntimeSession, SessionSink, StartOptions } from "../src/claude/runtime.js";
import { AgentSdkRuntime } from "../src/claude/runtime.js";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { SessionService } from "../src/sessions/session-service.js";
import { git, initRepo, tempDir } from "./helpers.js";
import { writeFileSync } from "node:fs";

const fixture = readFileSync(path.join(import.meta.dirname, "fixtures", "stream-read-tool.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, unknown>);

/** Replays recorded CLI output and lets tests drive approvals/hooks like the real CLI would. */
class FakeRuntime implements ClaudeRuntime {
  readonly id = "fake";
  started: StartOptions[] = [];
  sinks: SessionSink[] = [];
  interrupted = 0;
  closed = 0;
  sent: string[] = [];
  sentUuids: string[] = [];
  remoteCalls: Array<{ enabled: boolean; name: string }> = [];
  efforts: Array<string | null> = [];
  modes: string[] = [];
  capabilities = new AgentSdkRuntime().capabilities;
  async listSessions() {
    return [];
  }
  async commands() {
    return [];
  }
  async complete() {
    return "feat: neue Datei";
  }
  async planUsage(): Promise<never> {
    throw new Error("no usage in tests");
  }
  async sessionHistory() {
    return [];
  }
  deletedTranscripts: string[] = [];
  async deleteTranscript(id: string) {
    this.deletedTranscripts.push(id);
  }
  async probe(): Promise<never> {
    throw new Error("no probe in tests");
  }
  resumeSession(id: string, opts: Omit<StartOptions, "resume">, sink: SessionSink) {
    return this.startSession({ ...opts, resume: id }, sink);
  }
  startSession(opts: StartOptions, sink: SessionSink): RuntimeSession {
    this.started.push(opts);
    this.sinks.push(sink);
    return {
      sendMessage: (m) => {
        this.sent.push(m.text);
        this.sentUuids.push(m.uuid);
      },
      rewindFiles: async () => ({ canRewind: true, error: null, filesChanged: ["a.txt"], insertions: 1, deletions: 0 }),
      supportedCommands: async () => [],
      interrupt: async () => {
        this.interrupted++;
        sink.onMessage({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
      },
      close: () => {
        this.closed++;
        sink.onEnd(null);
      },
      setModel: async () => {},
      setPermissionMode: async (mode) => {
        this.modes.push(mode);
      },
      setEffort: async (e) => {
        this.efforts.push(e);
      },
      contextUsage: async () => ({ totalTokens: 62_000, maxTokens: 200_000, percentage: 31, categories: [{ name: "Messages", tokens: 40_000, kind: "used" as const }], updatedAt: new Date().toISOString() }),
      setRemoteControl: async (enabled, name) => {
        this.remoteCalls.push({ enabled, name });
        return enabled ? "https://claude.ai/code/session_test" : null;
      },
      initialization: () => new Promise(() => {}),
    };
  }
  replay(i = this.sinks.length - 1) {
    for (const m of fixture) this.sinks[i]!.onMessage(m);
  }
}

let t: ReturnType<typeof tempDir>;
let db: Db;
let rt: FakeRuntime;
let svc: SessionService;
let projects: ProjectManager;
let emitted: ServerEvent[];
let projectId: string;

beforeEach(async () => {
  t = tempDir();
  mkdirSync(path.join(t.dir, "proj"), { recursive: true });
  db = new Db(path.join(t.dir, "forge.db"));
  // A fake claude binary path keeps locateClaude() deterministic in CI.
  db.updateSettings({ claudePath: process.execPath });
  const git = new GitEngine();
  projects = new ProjectManager(db, git, () => "balanced");
  rt = new FakeRuntime();
  emitted = [];
  svc = new SessionService(db, projects, git, rt, (e) => emitted.push(e));
  projectId = (await projects.import(path.join(t.dir, "proj"))).id;
});
afterEach(async () => {
  await svc.drain();
  svc.shutdown();
  db.close();
  t.cleanup();
});

const persistedTypes = (id: string) => db.listEvents(id).map((e) => e.body.type);

describe("SessionService", () => {
  it("starts in the project cwd with the profile's permission mode and persists the stream", async () => {
    const s = await svc.start({ projectId, prompt: "Lies a.txt" });
    expect(rt.started[0]).toMatchObject({ cwd: projects.get(projectId).path, permissionMode: "acceptEdits", firstMessage: expect.objectContaining({ text: "Lies a.txt" }), resume: null });
    expect(s.status).toBe("running");
    rt.replay();
    const after = svc.get(s.id);
    expect(after).toMatchObject({ status: "idle", claudeSessionId: "d69118dc-ef0c-4925-9945-3091ab75cb15", model: "claude-haiku-5-5" });
    const types = persistedTypes(s.id);
    expect(types).toEqual(expect.arrayContaining(["user.message", "session.init", "tool.use", "tool.result", "assistant.text", "turn.result"]));
    expect(types).not.toContain("assistant.delta");
    expect(emitted.some((e) => e.event === "session.event" && e.payload.body.type === "assistant.delta")).toBe(true);
  });

  it("uses the Safe profile for real: default mode and disabled network tools", async () => {
    projects.update(projectId, { profile: "safe" });
    await svc.start({ projectId, prompt: "x" });
    expect(rt.started[0]).toMatchObject({ permissionMode: "default", disallowedTools: ["WebFetch", "WebSearch"] });
  });

  it("passes bypass for autonomous and refuses it while sandbox-only is set", async () => {
    projects.update(projectId, { profile: "autonomous" });
    await svc.start({ projectId, prompt: "x" });
    expect(rt.started[0]?.permissionMode).toBe("bypassPermissions");
    db.sql.prepare("UPDATE projects SET tags = '[\"sandbox-only\"]' WHERE id = ?").run(projectId);
    await expect(svc.start({ projectId, prompt: "x" })).rejects.toThrow(/sandbox-only/);
  });

  it("routes approvals through the UI and records the audit trail", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    const ac = new AbortController();
    const pending = rt.sinks[0]!.onApproval(
      { requestId: "r1", toolUseId: "t1", toolName: "Bash", input: { command: "pnpm test" }, title: "Run pnpm test", description: null, reason: null, suppressAlwaysAllow: false },
      ac.signal,
    );
    expect(svc.get(s.id).status).toBe("waiting_approval");
    await expect(svc.send(s.id, "noch was")).rejects.toThrow(/Freigabeanfrage/);
    svc.respondApproval(s.id, "r1", "allow", "session");
    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
    expect(svc.get(s.id).status).toBe("running");
    const audit = db.sql.prepare("SELECT tool_name, decision, scope, source FROM approvals").all();
    expect(audit).toEqual([{ tool_name: "Bash", decision: "allow", scope: "session", source: "user" }]);
    expect(() => svc.respondApproval(s.id, "r1", "allow", "once")).toThrow(/nicht mehr offen/);
  });

  it("does not offer session-wide approval in Safe", async () => {
    projects.update(projectId, { profile: "safe" });
    const s = await svc.start({ projectId, prompt: "x" });
    void rt.sinks[0]!.onApproval(
      { requestId: "r2", toolUseId: "t2", toolName: "Bash", input: { command: "ls" }, title: null, description: null, reason: null, suppressAlwaysAllow: false },
      new AbortController().signal,
    );
    const req = db.listEvents(s.id).find((e) => e.body.type === "approval.request")?.body as Extract<SessionEventBody, { type: "approval.request" }>;
    expect(req.allowSessionScope).toBe(false);
    expect(() => svc.respondApproval(s.id, "r2", "allow", "session")).toThrow(/keine Freigabe für die ganze Session/);
  });

  it("enforces the hard guard via the PreToolUse hook and logs it", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    const v = await rt.sinks[0]!.preToolUse("Bash", { command: "git push --force" }, "t9");
    expect(v?.rule).toBe("git-force-push");
    expect(persistedTypes(s.id)).toContain("policy.blocked");
    expect(await rt.sinks[0]!.preToolUse("Bash", { command: "pnpm test" }, "t10")).toBeNull();
  });

  it("stops a running turn via interrupt, denies open approvals and stays resumable", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    const pending = rt.sinks[0]!.onApproval(
      { requestId: "r3", toolUseId: "t3", toolName: "Write", input: { file_path: "a.txt" }, title: null, description: null, reason: null, suppressAlwaysAllow: false },
      new AbortController().signal,
    );
    await svc.stop(s.id);
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    expect(rt.interrupted).toBe(1);
    const after = svc.get(s.id);
    expect(after.status).toBe("idle");
    expect(after.lastError).toBeNull();
    await svc.send(s.id, "weiter");
    expect(rt.sent).toEqual(["weiter"]);
  });

  it("marks live sessions as interrupted after a restart and resumes with the stored claude session id", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.replay();
    db.updateSession(s.id, { status: "running" });
    // simulate crash: new process, same DB
    expect(db.markOrphanedSessions()).toBe(1);
    const svc2 = new SessionService(db, projects, new GitEngine(), rt, () => {});
    expect(svc2.get(s.id)).toMatchObject({ status: "interrupted", live: false });
    await svc2.resume(s.id, "weiter bitte");
    expect(rt.started.at(-1)).toMatchObject({ resume: "d69118dc-ef0c-4925-9945-3091ab75cb15", cwd: s.cwd, firstMessage: expect.objectContaining({ text: "weiter bitte" }) });
    svc2.shutdown();
  });

  it("reports runtime crashes as errors instead of success", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.sinks[0]!.onEnd(new Error("Invalid API key · Please run /login"));
    const after = svc.get(s.id);
    expect(after.status).toBe("error");
    expect(after.lastError).toMatch(/nicht angemeldet/);
  });

  it("redacts secrets before persisting", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.sinks[0]!.onMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" }] },
    });
    const ev = db.listEvents(s.id).find((e) => e.body.type === "tool.result");
    expect(JSON.stringify(ev)).not.toContain("ghp_abc");
  });
});

describe("turn automation via project tags", () => {
  it("runs tests, commits only files changed during the turn and records a checkpoint", async () => {
    const repo = projects.get(projectId).path;
    await initRepo(repo);
    writeFileSync(path.join(repo, "alt.txt"), "fremd\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init", "--allow-empty");
    writeFileSync(path.join(repo, "fremd.txt"), "war schon vorher geändert\n");
    projects.update(projectId, { tags: ["auto-test", "auto-commit"], testCommand: "node -e \"process.exit(0)\"" });

    const s = await svc.start({ projectId, prompt: "mach was" });
    writeFileSync(path.join(repo, "neu.txt"), "von Claude\n");
    const done = svc.waitForTurn(s.id);
    rt.sinks[0]!.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    expect(await done).toBeNull();

    const types = db.listEvents(s.id).map((e) => e.body);
    expect(types.find((b) => b.type === "git.checkpoint")).toBeTruthy();
    expect(types.find((b) => b.type === "check.result")).toMatchObject({ ok: true });
    expect(types.find((b) => b.type === "automation")).toMatchObject({ action: "commit", ok: true, files: ["neu.txt"] });
    const log = await git(repo, "log", "--format=%s", "-1");
    expect(log.trim()).toBe("feat: neue Datei");
    const st = await git(repo, "status", "--porcelain");
    expect(st).toContain("fremd.txt");
  });

  it("does not auto-commit when tests fail or review is required", async () => {
    const repo = projects.get(projectId).path;
    await initRepo(repo);
    await git(repo, "commit", "-m", "init", "--allow-empty");
    projects.update(projectId, { tags: ["auto-test", "auto-commit"], testCommand: "node -e \"process.exit(3)\"" });
    const s = await svc.start({ projectId, prompt: "x" });
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    const done = svc.waitForTurn(s.id);
    rt.sinks[0]!.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    await done;
    const bodies = db.listEvents(s.id).map((e) => e.body);
    expect(bodies.find((b) => b.type === "check.result")).toMatchObject({ ok: false, exitCode: 3 });
    expect(bodies.find((b) => b.type === "automation")).toMatchObject({ action: "skip", ok: false });
  });

  it("connects open sessions to the Claude app and shows messages typed there", async () => {
    const s = await svc.start({ projectId, prompt: "Lies a.txt" });
    rt.replay();
    const state = await svc.remoteStart(projectId);
    expect(rt.remoteCalls).toEqual([{ enabled: true, name: `FORGE · proj · Lies a.txt` }]);
    expect(state.sessions[0]).toMatchObject({ sessionId: s.id, url: "https://claude.ai/code/session_test", state: "connecting" });
    const sink = rt.sinks[0]!;
    sink.onMessage({ type: "system", subtype: "bridge_state", state: "connected" });
    expect(svc.remoteState(projectId).sessions[0]!.state).toBe("connected");

    // own message: the echo must not show up twice
    await svc.send(s.id, "weiter");
    const own = rt.sentUuids[0]!;
    sink.onMessage({ type: "command_lifecycle", command_uuid: own, state: "started" });
    sink.onMessage({ type: "user", isReplay: true, uuid: own, message: { role: "user", content: "weiter" } });
    sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });

    // message from the phone while idle: starts a turn and lands in the timeline
    expect(svc.get(s.id).status).toBe("idle");
    const phone = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    sink.onMessage({ type: "command_lifecycle", command_uuid: phone, state: "started" });
    expect(svc.get(s.id).status).toBe("running");
    sink.onMessage({ type: "user", isReplay: true, uuid: phone, message: { role: "user", content: [{ type: "text", text: "Vom Handy" }] } });
    sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });

    const users = db.listEvents(s.id).flatMap((e) => (e.body.type === "user.message" ? [e.body] : []));
    expect(users.map((u) => [u.text, u.source ?? "forge"])).toEqual([
      ["Lies a.txt", "forge"],
      ["weiter", "forge"],
      ["Vom Handy", "remote"],
    ]);

    await svc.remoteStop(projectId);
    expect(rt.remoteCalls.at(-1)?.enabled).toBe(false);
    expect(svc.remoteState(projectId)).toEqual({ enabled: false, sessions: [] });
  });

  it("opens an empty session for the Claude app when none is open and titles it from the first message", async () => {
    await svc.remoteStart(projectId);
    expect(rt.started).toHaveLength(1);
    expect(rt.started[0]!.firstMessage).toBeNull();
    const [s] = svc.listAll();
    expect(s).toMatchObject({ title: "Remote-Session", status: "idle" });
    expect(rt.remoteCalls[0]!.name).toBe("FORGE · proj");
    rt.sinks[0]!.onMessage({ type: "user", isReplay: true, uuid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", message: { role: "user", content: "Baue einen Login" } });
    expect(svc.get(s!.id).title).toBe("Baue einen Login");
  });

  it("starts with the project's effort and changes it live", async () => {
    db.updateSettings({ defaultEffort: "medium" });
    expect((await svc.start({ projectId, prompt: "a" })).effort).toBe("medium");
    expect(rt.started[0]!.effort).toBe("medium");
    projects.update(projectId, { defaultEffort: "xhigh" });
    const s = await svc.start({ projectId, prompt: "b" });
    expect(rt.started[1]!.effort).toBe("xhigh");
    expect((await svc.start({ projectId, prompt: "c", effort: "low" })).effort).toBe("low");
    const changed = await svc.setEffort(s.id, "max");
    expect(changed.effort).toBe("max");
    expect(rt.efforts).toEqual(["max"]);
    const reset = await svc.setEffort(s.id, null);
    expect(reset.effort).toBeNull();
  });

  it("accepts a message while Claude works and keeps the session running until the CLI is done", async () => {
    const s = await svc.start({ projectId, prompt: "erst das" });
    await svc.send(s.id, "und noch das");
    expect(rt.sent).toEqual(["und noch das"]);
    expect(svc.get(s.id).status).toBe("running");
    expect(persistedTypes(s.id).filter((t) => t === "status").length).toBe(1);

    // The turn ended before the CLI folded the message in: it starts its own turn.
    const sink = rt.sinks[0]!;
    sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    expect(svc.get(s.id).status).toBe("idle");
    sink.onMessage({ type: "command_lifecycle", command_uuid: rt.sentUuids[0], state: "started" });
    expect(svc.get(s.id).status).toBe("running");
    sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    expect(svc.get(s.id).status).toBe("idle");
    expect(svc.listLive().map((x) => [x.id, x.projectName])).toEqual([[s.id, "proj"]]);
  });

  it("tracks background tasks and follows the turn Claude starts on its own when one finishes", async () => {
    const s = await svc.start({ projectId, prompt: "Build im Hintergrund" });
    const sink = rt.sinks[0]!;
    const task = { task_id: "b2kzcbhw6", run_id: "r1", task_type: "local_bash", description: "Build release" };
    sink.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [task] });
    sink.onMessage({ type: "system", subtype: "task_started", ...task, tool_use_id: "toolu_1", is_backgrounded: true });
    sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "STARTED", usage: {} });
    expect(svc.get(s.id)).toMatchObject({ status: "idle", background: [{ taskId: "b2kzcbhw6", description: "Build release", taskType: "local_bash" }] });
    expect(svc.listLive()[0]!.background).toHaveLength(1);

    sink.onMessage({ type: "system", subtype: "task_notification", task_id: "b2kzcbhw6", status: "completed", summary: "Background command finished" });
    sink.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(svc.get(s.id).background).toEqual([]);
    sink.onMessage({ type: "stream_event", event: { type: "message_start", message: { id: "msg_2" } } });
    expect(svc.get(s.id).status).toBe("running");
    sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "COMPLETE", usage: {} });
    expect(svc.get(s.id).status).toBe("idle");

    const notices = db.listEvents(s.id).flatMap((e) => (e.body.type === "background.task" ? [[e.body.state, e.body.description]] : []));
    expect(notices).toEqual([
      ["started", "Build release"],
      ["completed", "Build release"],
    ]);
  });

  it("ignores task events of foreground tool calls", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    const sink = rt.sinks[0]!;
    sink.onMessage({ type: "system", subtype: "task_started", task_id: "fg1", description: "Sleep", task_type: "local_bash", is_backgrounded: false });
    sink.onMessage({ type: "system", subtype: "task_notification", task_id: "fg1", status: "completed" });
    expect(persistedTypes(s.id)).not.toContain("background.task");
  });

  it("deletes a session: ends the process, removes timeline and transcript, keeps the audit log", async () => {
    const s = await svc.start({ projectId, prompt: "Lies a.txt" });
    rt.replay();
    db.recordApproval({ sessionId: s.id, requestId: "r", toolName: "Bash", input: {}, decision: "allow", scope: "once", source: "user", reason: null });
    expect(svc.get(s.id).live).toBe(true);
    const r = await svc.delete(s.id, true);
    expect(r).toEqual({ deleted: true, transcriptDeleted: true });
    expect(rt.closed).toBe(1);
    expect(rt.deletedTranscripts).toEqual(["d69118dc-ef0c-4925-9945-3091ab75cb15"]);
    expect(() => svc.get(s.id)).toThrow(/nicht gefunden/);
    expect(db.listEvents(s.id)).toEqual([]);
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM approvals WHERE session_id = ?").get(s.id)).toEqual({ n: 1 });

    const keep = await svc.start({ projectId, prompt: "b" });
    await svc.delete(keep.id, false);
    expect(rt.deletedTranscripts).toHaveLength(1);
  });

  it("passes answers to a question back to Claude and keeps them in the timeline", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    const input = { questions: [{ question: "Welche Farbe?", header: "Farbe", multiSelect: false, options: [{ label: "Rot", description: "" }, { label: "Blau", description: "" }] }] };
    const pending = rt.sinks[0]!.onApproval(
      { requestId: "q1", toolUseId: "tq", toolName: "AskUserQuestion", input, title: null, description: null, reason: null, suppressAlwaysAllow: false },
      new AbortController().signal,
    );
    const req = db.listEvents(s.id).find((e) => e.body.type === "approval.request")?.body as Extract<SessionEventBody, { type: "approval.request" }>;
    expect(req.allowSessionScope).toBe(false);
    expect(() => svc.respondApproval(s.id, "q1", "allow", "once", undefined, { "Welche Farbe?": "  " })).toThrow(/mindestens eine Frage/);
    svc.respondApproval(s.id, "q1", "allow", "once", undefined, { "Welche Farbe?": "Blau" });
    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "once", updatedInput: { ...input, answers: { "Welche Farbe?": "Blau" } } });
    const resolved = db.listEvents(s.id).find((e) => e.body.type === "approval.resolved")?.body;
    expect(resolved).toMatchObject({ decision: "allow", answers: { "Welche Farbe?": "Blau" } });
  });

  it("tells Claude when a question is skipped", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    const pending = rt.sinks[0]!.onApproval(
      { requestId: "q2", toolUseId: "tq2", toolName: "AskUserQuestion", input: { questions: [] }, title: null, description: null, reason: null, suppressAlwaysAllow: false },
      new AbortController().signal,
    );
    svc.respondApproval(s.id, "q2", "deny", "once");
    await expect(pending).resolves.toEqual({ behavior: "deny", message: "Der Nutzer möchte die Rückfrage nicht beantworten." });
  });

  it("leaves plan mode for the profile's mode when the plan is accepted, and keeps it on feedback", async () => {
    const s = await svc.start({ projectId, prompt: "x", planOnly: true });
    expect(svc.get(s.id).permissionMode).toBe("plan");
    const input = { plan: "1. Datei anlegen", planFilePath: "C:/x/plan.md" };
    const first = rt.sinks[0]!.onApproval(
      { requestId: "p1", toolUseId: "tp1", toolName: "ExitPlanMode", input, title: null, description: null, reason: null, suppressAlwaysAllow: false },
      new AbortController().signal,
    );
    svc.respondApproval(s.id, "p1", "deny", "once", "Bitte mit Tests");
    await expect(first).resolves.toEqual({ behavior: "deny", message: "Bitte mit Tests" });
    expect(svc.get(s.id).permissionMode).toBe("plan");

    const second = rt.sinks[0]!.onApproval(
      { requestId: "p2", toolUseId: "tp2", toolName: "ExitPlanMode", input, title: null, description: null, reason: null, suppressAlwaysAllow: false },
      new AbortController().signal,
    );
    svc.respondApproval(s.id, "p2", "allow", "once");
    await expect(second).resolves.toEqual({ behavior: "allow", scope: "once", mode: "acceptEdits" });
    expect(svc.get(s.id).permissionMode).toBe("acceptEdits");
  });

  it("follows mode changes reported by Claude Code", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.sinks[0]!.onMessage({ type: "system", subtype: "status", status: null, permissionMode: "plan" });
    expect(svc.get(s.id).permissionMode).toBe("plan");
    rt.sinks[0]!.onMessage({ type: "system", subtype: "status", status: null, permissionMode: "nonsense" });
    expect(svc.get(s.id).permissionMode).toBe("plan");
  });

  it("reports context usage after each turn and records compaction", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    expect(svc.get(s.id).context).toBeNull();
    rt.replay();
    await svc.drain();
    expect(svc.get(s.id).context).toMatchObject({ percentage: 31, maxTokens: 200_000 });
    rt.sinks[0]!.onMessage({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 150_000, post_tokens: 9_000 } });
    expect(db.listEvents(s.id).at(-1)?.body).toEqual({ type: "context.compacted", trigger: "manual", preTokens: 150_000, postTokens: 9_000 });
    svc.close(s.id);
    expect(svc.get(s.id).context).toBeNull();
    expect(await svc.contextUsage(s.id)).toBeNull();
  });

  it("applies a profile change to running sessions right away", async () => {
    const a = await svc.start({ projectId, prompt: "a" });
    const b = await svc.start({ projectId, prompt: "b", planOnly: true });
    projects.update(projectId, { profile: "autonomous" });
    await svc.applyProjectProfile(projectId);
    expect(rt.modes).toEqual(["bypassPermissions", "plan"]);
    expect(svc.get(a.id)).toMatchObject({ profile: "autonomous", permissionMode: "bypassPermissions" });
    expect(svc.get(b.id)).toMatchObject({ profile: "autonomous", permissionMode: "plan" });

    // Safe disables web tools; the running process got its tool list at start, so the hook enforces it.
    projects.update(projectId, { profile: "safe" });
    await svc.applyProjectProfile(projectId);
    expect(svc.get(a.id).permissionMode).toBe("default");
    expect((await rt.sinks[0]!.preToolUse("WebFetch", { url: "https://example.com" }, "t1"))?.rule).toBe("profile-tool");
  });
});
