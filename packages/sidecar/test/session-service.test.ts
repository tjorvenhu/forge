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
import { tempDir } from "./helpers.js";

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
  capabilities = new AgentSdkRuntime().capabilities;
  async listSessions() {
    return [];
  }
  async sessionHistory() {
    return [];
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
      sendMessage: (t) => this.sent.push(t),
      interrupt: async () => {
        this.interrupted++;
        sink.onMessage({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
      },
      close: () => {
        this.closed++;
        sink.onEnd(null);
      },
      setModel: async () => {},
      setPermissionMode: async () => {},
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
afterEach(() => {
  svc.shutdown();
  db.close();
  t.cleanup();
});

const persistedTypes = (id: string) => db.listEvents(id).map((e) => e.body.type);

describe("SessionService", () => {
  it("starts in the project cwd with the profile's permission mode and persists the stream", async () => {
    const s = await svc.start({ projectId, prompt: "Lies a.txt" });
    expect(rt.started[0]).toMatchObject({ cwd: projects.get(projectId).path, permissionMode: "acceptEdits", firstPrompt: "Lies a.txt", resume: null });
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

  it("refuses autonomous without unlock and passes bypass only when unlocked+confirmed", async () => {
    db.sql.prepare("UPDATE projects SET profile = 'autonomous' WHERE id = ?").run(projectId);
    await expect(svc.start({ projectId, prompt: "x" })).rejects.toThrow(/gesperrt/);
    db.updateSettings({ autonomousUnlocked: true });
    projects.confirmAutonomous(projectId, "proj", true);
    await svc.start({ projectId, prompt: "x" });
    expect(rt.started[0]?.permissionMode).toBe("bypassPermissions");
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
    expect(rt.started.at(-1)).toMatchObject({ resume: "d69118dc-ef0c-4925-9945-3091ab75cb15", cwd: s.cwd, firstPrompt: "weiter bitte" });
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
