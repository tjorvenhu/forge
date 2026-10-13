import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanUsage, ServerEvent, SessionEventBody } from "@forge/protocol";
import type { ClaudeRuntime, RuntimeSession, SessionSink, StartOptions } from "../src/claude/runtime.js";
import { AgentSdkRuntime, REMOTE_UNAVAILABLE } from "../src/claude/runtime.js";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { SessionService } from "../src/sessions/session-service.js";
import {
  AUTO_CONTINUE_PROMPT,
  CHECK_INTERVAL_MS,
  MAX_AUTO_CONTINUES,
  PROBE_INTERVAL_MS,
  RESET_BUFFER_MS,
  STARTUP_CHECK_MS,
  isUsageLimitText,
  resetFromText,
} from "../src/sessions/auto-continue.js";
import { TITLE_DEBOUNCE_MS, TITLE_MIN_INTERVAL_MS, TITLE_TIMEOUT_MS, isTitleWorthy } from "../src/sessions/titles.js";
import { git, initRepo, tempDir } from "./helpers.js";
import { existsSync, writeFileSync } from "node:fs";
import { WorktreeService } from "../src/automation/worktrees.js";
import { AgentFinisher } from "../src/automation/agent-finish.js";
import { KnowledgeStore } from "../src/knowledge/knowledge.js";
import type { DevEnvironment } from "../src/devtools/environment.js";

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
  /** session = index of the started CLI process */
  remoteCalls: Array<{ enabled: boolean; name: string; session: number }> = [];
  efforts: Array<string | null> = [];
  modes: string[] = [];
  /** close() does not end the process right away; the test calls onEnd itself */
  deferEnd = false;
  remoteError: Error | null = null;
  capabilities = new AgentSdkRuntime().capabilities;
  async listSessions() {
    return [];
  }
  async commands() {
    return [];
  }
  completions: string[] = [];
  completeResult: string | Error = "feat: neue Datei";
  async complete(prompt: string) {
    this.completions.push(prompt);
    if (this.completeResult instanceof Error) throw this.completeResult;
    return this.completeResult;
  }
  /** structured answers; an Error like a CLI without structured output */
  completeJsonResult: unknown = new Error("no structured output in tests");
  async completeJson(prompt: string) {
    this.completions.push(prompt);
    if (this.completeJsonResult instanceof Error) throw this.completeJsonResult;
    return this.completeJsonResult;
  }
  /** what generateTitle of a running session answers; null like a CLI without the call */
  generatedTitle: string | null | Error | Promise<string | null> = null;
  titleRequests: string[] = [];
  renameError: Error | null = null;
  renames: Array<{ title: string; claudeSessionId: string | null; session: number }> = [];
  transcriptRenames: Array<{ claudeSessionId: string; title: string; dir: string }> = [];
  async renameTranscript(claudeSessionId: string, title: string, dir: string) {
    this.transcriptRenames.push({ claudeSessionId, title, dir });
  }
  usage: PlanUsage | null = null;
  async planUsage(): Promise<PlanUsage> {
    if (!this.usage) throw new Error("no usage in tests");
    return this.usage;
  }
  /** transcript entries for sessionHistory (only uuid matters for branching) */
  history: Array<{ uuid: string }> = [];
  async sessionHistory() {
    return this.history;
  }
  forks: Array<{ claudeSessionId: string; upTo: string | null; title: string }> = [];
  stoppedTasks: string[] = [];
  backgrounded: string[] = [];
  async forkTranscript(claudeSessionId: string, _dir: string, upTo: string | null, title: string) {
    this.forks.push({ claudeSessionId, upTo, title });
    return `fork-${this.forks.length}`;
  }
  deletedTranscripts: string[] = [];
  async deleteTranscript(id: string) {
    this.deletedTranscripts.push(id);
  }
  async probe(): Promise<never> {
    throw new Error("no probe in tests");
  }
  startSession(opts: StartOptions, sink: SessionSink): RuntimeSession {
    const session = this.started.length;
    this.started.push(opts);
    this.sinks.push(sink);
    return {
      sendMessage: (m) => {
        this.sent.push(m.text);
        this.sentUuids.push(m.uuid);
      },
      rewindFiles: async () => ({ canRewind: true, error: null, filesChanged: ["a.txt"], insertions: 1, deletions: 0 }),
      supportedCommands: async () => [],
      stopTask: async (taskId) => {
        this.stoppedTasks.push(taskId);
      },
      taskOutput: async (taskId) => ({ output: `Ausgabe von ${taskId}`, totalBytes: 14, truncated: false }),
      toBackground: async (toolUseId) => {
        this.backgrounded.push(toolUseId ?? "*");
        return true;
      },
      interrupt: async () => {
        this.interrupted++;
        sink.onMessage({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
      },
      close: () => {
        this.closed++;
        if (!this.deferEnd) sink.onEnd(null);
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
        if (this.remoteError) throw this.remoteError;
        this.remoteCalls.push({ enabled, name, session });
        return enabled ? "https://claude.ai/code/session_test" : null;
      },
      generateTitle: async (description) => {
        this.titleRequests.push(description);
        if (this.generatedTitle instanceof Error) throw this.generatedTitle;
        return this.generatedTitle;
      },
      rename: async (title, claudeSessionId) => {
        if (this.renameError) throw this.renameError;
        this.renames.push({ title, claudeSessionId, session });
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

  it("branches the conversation before a prompt: new session with the history before it, original untouched", async () => {
    const s = await svc.start({ projectId, prompt: "Lies a.txt" });
    rt.replay();
    await svc.send(s.id, "Jetzt b.txt");
    rt.replay(rt.sinks.length - 1);
    const prompts = db.listEvents(s.id).filter((e) => e.body.type === "user.message");
    const second = prompts[1]!;
    const secondUuid = second.body.type === "user.message" ? second.body.uuid! : "";
    rt.history = [{ uuid: "x1" }, { uuid: "x2" }, { uuid: secondUuid }, { uuid: "x4" }];
    const before = db.listEvents(s.id).length;

    const r = await svc.fork(s.id, { beforeSeq: second.seq, rewindFiles: true });
    expect(r.prompt).toBe("Jetzt b.txt");
    expect(r.filesChanged).toEqual(["a.txt"]);
    expect(rt.forks).toEqual([{ claudeSessionId: "d69118dc-ef0c-4925-9945-3091ab75cb15", upTo: "x2", title: "Lies a.txt (Zweig)" }]);
    expect(r.session).toMatchObject({ claudeSessionId: "fork-1", status: "stopped", projectId, title: "Lies a.txt (Zweig)" });
    const copied = db.listEvents(r.session!.id);
    expect(copied.every((e) => e.seq < second.seq)).toBe(true);
    expect(copied.length).toBe(db.listEvents(s.id).filter((e) => e.seq < second.seq).length);
    // The original keeps everything (plus the record of the rewound files).
    expect(db.listEvents(s.id).length).toBe(before + 1);

    // Before the first prompt there is no history: a fresh start, no fork.
    const first = prompts[0]!;
    rt.history = [{ uuid: first.body.type === "user.message" ? first.body.uuid! : "" }];
    expect(await svc.fork(s.id, { beforeSeq: first.seq })).toEqual({ session: null, prompt: "Lies a.txt", filesChanged: null });
    await expect(svc.fork(s.id, { beforeSeq: 9999 })).rejects.toThrow(/nicht verzweigen/);
  });

  it("gives sessions FORGE tools: start parallel agents in worktrees, follow them, notify the user", async () => {
    const repo = projects.get(projectId).path;
    await initRepo(repo);
    writeFileSync(path.join(repo, "a.txt"), "a");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    const s = await svc.start({ projectId, prompt: "Plane den Export" });
    const tools = rt.started[0]!.tools!;
    expect(tools.map((t) => [t.name, t.autoAllow])).toEqual([
      ["start_agent", false],
      ["agent_status", true],
      ["message_agent", false],
      ["notify", true],
    ]);
    expect(rt.started[0]!.context).toMatch(/start_agent/);
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    expect(await tool("agent_status").run({})).toBe("Diese Session hat keine Agenten gestartet.");
    const out = await tool("start_agent").run({ task: "Baue den CSV-Export in src/export.ts", name: "csv export" });
    expect(out).toMatch(/^Agent [0-9a-f]{8} gestartet, Branch agent\/csv-export-[a-z0-9]+/);
    const child = rt.started[1]!;
    expect(child.cwd).toContain(".forge-worktrees");
    expect(child.firstMessage?.text).toBe("Baue den CSV-Export in src/export.ts");
    // Agents get no start_agent: one level, no chains.
    expect(child.tools!.map((t) => t.name)).toEqual(["notify"]);
    expect(child.context).toMatch(/paralleler Agent/);

    const status = await tool("agent_status").run({});
    expect(status).toMatch(/arbeitet/);
    const agentId = /^([0-9a-f]{8})/.exec(status)![1]!;
    rt.replay(1);
    expect(await tool("message_agent").run({ agent: agentId, text: "Auch JSON bitte" })).toBe(`An Agent ${agentId} gesendet.`);
    expect(rt.sent.at(-1)).toBe("Auch JSON bitte");
    await expect(tool("message_agent").run({ agent: "zzzz", text: "x" })).rejects.toThrow(/Keinen Agenten/);

    expect(await tool("notify").run({ message: "Export fertig, bitte prüfen", urgent: true })).toMatch(/dringend/);
    expect(db.listEvents(s.id).at(-1)?.body).toEqual({ type: "notify", message: "Export fertig, bitte prüfen", urgent: true });

    // After a restart the agent still belongs to its session.
    rt.replay(0);
    await svc.drain();
    svc.shutdown();
    svc = new SessionService(db, projects, new GitEngine(), rt, (e) => emitted.push(e));
    await svc.send(s.id, "Wie weit ist der Agent?");
    const resumed = rt.started.at(-1)!;
    expect(resumed.tools!.map((t) => t.name)).toContain("agent_status");
    expect(await resumed.tools!.find((t) => t.name === "agent_status")!.run({})).toMatch(new RegExp(`^${agentId}`));
    // Real git worktrees plus a restart: slow on Windows while the other test files run alongside.
  }, 20_000);

  it("branches agents from where the starting session stands and removes the worktree again when the start fails", async () => {
    const repo = projects.get(projectId).path;
    await initRepo(repo);
    writeFileSync(path.join(repo, "a.txt"), "a");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    // The session works in a worktree of its own with a commit the main checkout does not have.
    const own = await new WorktreeService(new GitEngine(), projects).create(projects.get(projectId), "feature/eigen");
    writeFileSync(path.join(own.path, "eigen.txt"), "nur hier");
    await git(own.path, "add", ".");
    await git(own.path, "commit", "-m", "eigen");
    svc.useProjectTools({ knowledge: new KnowledgeStore(projects, () => {}), dev: {} as DevEnvironment });
    svc.useAgentFinisher(
      new AgentFinisher({ db, git: new GitEngine(), projects, sessions: svc, worktrees: new WorktreeService(new GitEngine(), projects), devServers: { forget: async () => {} }, notifyProject: () => {} }),
    );
    await svc.start({ projectId: own.id, prompt: "Plane" });
    const first = rt.started[0]!;
    // Knowledge of a worktree lives in the main project's folder.
    expect(first.context).toContain(`Das Projektwissen liegt im Ordner des Hauptprojekts: ${path.join(repo, ".forge", "knowledge")}`);
    const tool = (name: string) => first.tools!.find((t) => t.name === name)!;
    expect(await tool("knowledge_save").run({ title: "Deploy mit Coolify", summary: "Wie wir deployen", content: "Coolify" })).toBe(
      `Gespeichert: deploy-mit-coolify (${path.join(repo, ".forge", "knowledge", "deploy-mit-coolify.md")}).`,
    );

    expect(await tool("start_agent").run({ task: "Baue den CSV-Export in src/export.ts", name: "csv" })).toMatch(/^Agent [0-9a-f]{8} gestartet, Branch agent\/csv-/);
    const child = rt.started[1]!;
    expect(existsSync(path.join(child.cwd, "eigen.txt"))).toBe(true);
    expect(await tool("agent_status").run({})).toMatch(/arbeitet, Branch agent\/csv-[a-z0-9]+, Ordner/);
    expect(tool("message_agent").shape.agent!.safeParse("").success).toBe(false);
    // The agent's commit goes back into the worktree the session works in.
    expect(first.tools!.map((t) => [t.name, t.autoAllow])).toContainEqual(["finish_agent", false]);
    expect(first.context).toMatch(/finish_agent/);
    // Agents themselves cannot finish other agents.
    expect(child.tools!.map((t) => t.name)).not.toContain("finish_agent");
    writeFileSync(path.join(child.cwd, "export.ts"), "export {};\n");
    await git(child.cwd, "add", ".");
    await git(child.cwd, "commit", "-m", "CSV-Export");
    rt.replay(1);
    const agentId = /^([0-9a-f]{8})/.exec(await tool("agent_status").run({}))![1]!;
    expect(await tool("finish_agent").run({ agent: agentId, action: "merge" })).toMatch(/^1 Commit von agent\/csv-[a-z0-9]+ in feature\/eigen übernommen/);
    expect((await git(own.path, "log", "-1", "--format=%s")).trim()).toBe("CSV-Export");
    expect(existsSync(child.cwd)).toBe(false);

    // Agents the session did not start (Agents tab, phone) show up and can be finished by branch.
    const foreign = await new WorktreeService(new GitEngine(), projects).create(projects.get(projectId), "agent/fremd");
    expect(await tool("agent_status").run({})).toMatch(/Weitere Agenten dieses Projekts \(finish_agent mit dem Branch\):\n- agent\/fremd: ohne Session/);
    expect(await tool("finish_agent").run({ agent: "fremd", action: "discard" })).toBe("Agent verworfen, Branch agent/fremd gelöscht.");
    expect(existsSync(foreign.path)).toBe(false);
    expect(projects.all().some((p) => p.id === foreign.id)).toBe(false);
    await expect(tool("finish_agent").run({ agent: "gibtsnicht", action: "discard" })).rejects.toThrow("In diesem Projekt gibt es keine Agenten.");

    rt.startSession = () => {
      throw new Error("kaputt");
    };
    await expect(tool("start_agent").run({ task: "Baue den JSON-Export in src/json.ts", name: "json" })).rejects.toThrow(/kaputt/);
    expect(projects.all().filter((p) => p.name.includes("agent/json"))).toEqual([]);
    expect(await git(repo, "branch", "--list", "agent/json-*")).toBe("");
    expect(await git(repo, "worktree", "list")).not.toContain("agent-json");
  }, 30_000);

  it("records why a session got no knowledge and dev tools", async () => {
    svc.useProjectTools({
      knowledge: {
        owner: () => {
          throw new Error("Index kaputt");
        },
      } as unknown as KnowledgeStore,
      dev: {} as DevEnvironment,
    });
    const s = await svc.start({ projectId, prompt: "x" });
    expect(rt.started[0]!.tools!.map((t) => t.name)).toContain("notify");
    expect(db.listEvents(s.id).map((e) => e.body)).toContainEqual({ type: "status", status: "starting", detail: "Projektwissen und Dev-Werkzeuge nicht verfügbar: Index kaputt" });
  });

  it("tracks subagent progress, stops single tasks and moves work into the background", async () => {
    const s = await svc.start({ projectId, prompt: "Analysiere das Projekt" });
    const sink = rt.sinks[0]!;
    sink.onMessage({ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "tu1", description: "Auth prüfen", subagent_type: "general-purpose", task_type: "local_agent" });
    // A shell command in the foreground is no subagent.
    sink.onMessage({ type: "system", subtype: "task_started", task_id: "k2", description: "npm test", task_type: "local_bash" });
    expect(svc.get(s.id).subagents).toMatchObject([{ taskId: "k1", toolUseId: "tu1", description: "Auth prüfen", agentType: "general-purpose", summary: null }]);
    sink.onMessage({ type: "system", subtype: "task_progress", task_id: "k1", description: "Auth prüfen", usage: { total_tokens: 10, tool_uses: 3, duration_ms: 1 }, last_tool_name: "Grep", summary: "Liest die Login-Routen" });
    expect(svc.get(s.id).subagents[0]).toMatchObject({ summary: "Liest die Login-Routen", lastTool: "Grep", toolUses: 3 });
    sink.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "dev server" }] });
    sink.onMessage({ type: "system", subtype: "task_progress", task_id: "b1", description: "dev server", usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 }, summary: "läuft auf Port 5173" });
    expect(svc.get(s.id).background).toMatchObject([{ taskId: "b1", summary: "läuft auf Port 5173" }]);
    await svc.stopTask(s.id, "b1");
    await svc.toBackground(s.id, "tu1");
    expect(rt.stoppedTasks).toEqual(["b1"]);
    expect(rt.backgrounded).toEqual(["tu1"]);
    sink.onMessage({ type: "system", subtype: "task_notification", task_id: "k1", status: "completed" });
    expect(svc.get(s.id).subagents).toEqual([]);
  });

  it("names the tool call of a background task, also when the list comes before task_started, and reads its output", async () => {
    const s = await svc.start({ projectId, prompt: "Baue im Hintergrund" });
    const sink = rt.sinks[0]!;
    sink.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "build" }] });
    expect(svc.get(s.id).background).toMatchObject([{ taskId: "b1", toolUseId: null }]);
    sink.onMessage({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "tb1", description: "build", task_type: "local_bash", is_backgrounded: true });
    expect(svc.get(s.id).background).toMatchObject([{ taskId: "b1", toolUseId: "tb1" }]);
    sink.onMessage({ type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "ta1", description: "Recherche", task_type: "local_agent", is_backgrounded: true });
    sink.onMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "build" }, { task_id: "a1", task_type: "local_agent", description: "Recherche" }] });
    expect(svc.get(s.id).background).toMatchObject([{ taskId: "b1", toolUseId: "tb1" }, { taskId: "a1", toolUseId: "ta1" }]);
    expect(await svc.taskOutput(s.id, "b1")).toEqual({ output: "Ausgabe von b1", totalBytes: 14, truncated: false });
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
  it("runs tests and commits only files changed during the turn", async () => {
    const repo = projects.get(projectId).path;
    await initRepo(repo);
    writeFileSync(path.join(repo, "alt.txt"), "fremd\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init", "--allow-empty");
    writeFileSync(path.join(repo, "fremd.txt"), "war schon vorher geändert\n");
    projects.update(projectId, { tags: ["auto-test", "auto-commit"], testCommand: "node -e \"process.exit(0)\"" });

    const s = await svc.start({ projectId, prompt: "mach was" });
    writeFileSync(path.join(repo, "neu.txt"), "von Claude\n");
    rt.sinks[0]!.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    await svc.drain();

    const types = db.listEvents(s.id).map((e) => e.body);
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
    rt.sinks[0]!.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    await svc.drain();
    const bodies = db.listEvents(s.id).map((e) => e.body);
    expect(bodies.find((b) => b.type === "check.result")).toMatchObject({ ok: false, exitCode: 3 });
    expect(bodies.find((b) => b.type === "automation")).toMatchObject({ action: "skip", ok: false });
  });

  it("merges an agent after its turn when the main project has auto-merge, not after failed tests", async () => {
    const repo = projects.get(projectId).path;
    await initRepo(repo);
    await git(repo, "commit", "-m", "init", "--allow-empty");
    const engine = new GitEngine();
    const worktrees = new WorktreeService(engine, projects);
    svc.useAgentFinisher(new AgentFinisher({ db, git: engine, projects, sessions: svc, worktrees, devServers: { forget: async () => {} }, notifyProject: () => {} }));
    projects.update(projectId, { tags: ["auto-merge", "auto-test"], testCommand: "node -e \"process.exit(3)\"" });
    const wt = await worktrees.create(projects.get(projectId), "agent/auto");
    const s = await svc.start({ projectId: wt.id, prompt: "Baue X" });
    expect(rt.started[0]!.context).toContain("Rückfragen deshalb nur mit AskUserQuestion");
    writeFileSync(path.join(wt.path, "x.ts"), "export {};\n");
    rt.sinks[0]!.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    await svc.drain();
    expect(db.listEvents(s.id).map((e) => e.body)).toContainEqual(expect.objectContaining({ type: "automation", action: "skip", message: expect.stringContaining("Tests") }));
    expect(existsSync(wt.path)).toBe(true);

    projects.update(projectId, { testCommand: "node -e \"process.exit(0)\"" });
    projects.update(wt.id, { testCommand: "node -e \"process.exit(0)\"" });
    rt.sinks[0]!.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
    await svc.drain();
    expect(emitted.filter((e) => e.event === "agent.autoMerge").map((e) => (e.event === "agent.autoMerge" ? e.payload.outcome : null))).toEqual(["skipped", "merged"]);
    expect((await git(repo, "log", "-1", "--format=%s")).trim()).toBe("Restliche Änderungen von agent/auto");
    expect(existsSync(wt.path)).toBe(false);
  }, 30_000);

  it("connects open sessions to the Claude app and shows messages typed there", async () => {
    const s = await svc.start({ projectId, prompt: "Lies a.txt" });
    rt.replay();
    const state = await svc.remoteStart();
    expect(rt.remoteCalls).toEqual([{ enabled: true, name: "FORGE · proj: Lies a.txt", session: 0 }]);
    expect(state.sessions[0]).toMatchObject({ sessionId: s.id, projectId, projectName: "proj", url: "https://claude.ai/code/session_test", state: "connecting" });
    const sink = rt.sinks[0]!;
    sink.onMessage({ type: "system", subtype: "bridge_state", state: "connected" });
    expect(svc.remoteState().sessions[0]!.state).toBe("connected");

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

    await svc.remoteStop();
    expect(rt.remoteCalls.at(-1)?.enabled).toBe(false);
    expect(svc.remoteState()).toEqual({ enabled: false, sessions: [] });
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

  it("deletes all sessions at once, live ones included", async () => {
    const a = await svc.start({ projectId, prompt: "a" });
    rt.replay();
    const b = await svc.start({ projectId, prompt: "b" });
    const r = await svc.deleteAll(false);
    expect(r.deleted.sort()).toEqual([a.id, b.id].sort());
    expect(r).toMatchObject({ failed: 0, error: null });
    expect(svc.listAll()).toEqual([]);
    expect(rt.deletedTranscripts).toEqual([]);
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
    // Ended sessions keep the last value measured.
    svc.close(s.id);
    expect(svc.get(s.id)).toMatchObject({ live: false, context: { percentage: 31 } });
    expect(await svc.contextUsage(s.id)).toMatchObject({ percentage: 31 });
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

const remoteFixture = readFileSync(path.join(import.meta.dirname, "fixtures", "remote-control.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, unknown>);

const FORCE_PUSH = "git push --force";
const success = (sink: SessionSink) => sink.onMessage({ type: "result", subtype: "success", is_error: false, result: "ok", usage: {} });
const userTexts = (id: string) => db.listEvents(id).flatMap((e) => (e.body.type === "user.message" ? [e.body.text] : []));

/** A stored session with a Claude session id and no running process. */
async function storedSession() {
  const s = await svc.start({ projectId, prompt: "Lies a.txt" });
  rt.replay();
  svc.close(s.id);
  expect(svc.get(s.id).live).toBe(false);
  return s;
}

describe("concurrency and lifecycle", () => {
  it("starts only one CLI process for overlapping resume and send", async () => {
    const s = await storedSession();
    const before = rt.started.length;
    await Promise.all([svc.resume(s.id, "eins"), svc.send(s.id, "zwei"), svc.resume(s.id, "drei")]);
    expect(rt.started.length).toBe(before + 1);
    expect(rt.started.at(-1)!.firstMessage?.text).toBe("eins");
    expect([...rt.sent].sort()).toEqual(["drei", "zwei"]);
    expect(userTexts(s.id).slice(1).sort()).toEqual(["drei", "eins", "zwei"]);
  });

  it("ignores the end and the output of a process that was already replaced", async () => {
    const s = await storedSession();
    const oldSink = rt.sinks[0]!;
    await svc.resume(s.id, "weiter");
    oldSink.onEnd(null);
    expect(svc.get(s.id)).toMatchObject({ live: true, status: "running" });
    success(oldSink);
    expect(svc.get(s.id).status).toBe("running");
  });

  it("waits for a closing process before sending instead of losing the message", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.replay();
    rt.deferEnd = true;
    svc.close(s.id);
    const sending = svc.send(s.id, "danach");
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.sent).toEqual([]);
    expect(userTexts(s.id)).not.toContain("danach");
    rt.sinks[0]!.onEnd(null);
    await sending;
    expect(rt.started).toHaveLength(2);
    expect(rt.started[1]!.firstMessage?.text).toBe("danach");
    expect(userTexts(s.id).filter((t) => t === "danach")).toHaveLength(1);
  });

  it("ignores stop on an idle session and does not carry it into the next turn", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    success(rt.sinks[0]!);
    await svc.stop(s.id);
    expect(svc.get(s.id).status).toBe("idle");
    expect(rt.interrupted).toBe(0);
    await svc.send(s.id, "nächster");
    rt.sinks[0]!.onMessage({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["kaputt"] });
    expect(svc.get(s.id)).toMatchObject({ status: "idle", lastError: "kaputt" });
    const lastStatus = db.listEvents(s.id).filter((e) => e.body.type === "status").at(-1)?.body;
    expect(lastStatus).toMatchObject({ status: "idle", detail: null });
  });

  it("marks open sessions as interrupted on shutdown so they can be resumed", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    svc.shutdown();
    expect(svc.get(s.id)).toMatchObject({ status: "interrupted", live: false });
  });

  it("asks to update Claude Code when the CLI does not know a flag FORGE needs", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.sinks[0]!.onEnd(new Error("error: unknown option '--replay-user-messages'"));
    expect(svc.get(s.id).lastError).toMatch(/zu alt/);
  });

  it("points to the in-app sign-in when Claude Code is not logged in", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.sinks[0]!.onEnd(new Error("Not logged in · Please run /login"));
    expect(svc.get(s.id).lastError).toMatch(/Einstellungen/);
    expect(svc.get(s.id).lastError).not.toMatch(/Terminal/);
  });
});

describe("policy inside the session", () => {
  it("resolves ~ against the home folder in the hook the session installs", async () => {
    projects.update(projectId, { profile: "autonomous" });
    await svc.start({ projectId, prompt: "x" });
    const sink = rt.sinks[0]!;
    expect((await sink.preToolUse("Write", { file_path: "~/.claude/settings.json", content: "{}" }, "t1"))?.rule).toBe("write-outside-project");
    expect((await sink.preToolUse("Read", { file_path: "~/.npmrc" }, "t2"))?.rule).toBe("sensitive-path");
    expect((await sink.preToolUse("Grep", { pattern: "KEY", path: os.homedir(), glob: ".ssh/*" }, "t3"))?.rule).toBe("sensitive-path");
    expect((await sink.preToolUse("Glob", { pattern: path.join(os.homedir(), ".ssh", "*") }, "t4"))?.rule).toBe("sensitive-path");
    expect(await sink.preToolUse("Write", { file_path: "src/a.ts", content: "" }, "t5")).toBeNull();
  });

  it("denies the tool call even when logging the violation fails", async () => {
    await svc.start({ projectId, prompt: "x" });
    vi.spyOn(db, "recordApproval").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect((await rt.sinks[0]!.preToolUse("Bash", { command: FORCE_PUSH }, "t1"))?.rule).toBe("git-force-push");
  });

  it("denies when the check itself throws", async () => {
    await svc.start({ projectId, prompt: "x" });
    const input = Object.defineProperty({}, "command", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    }) as Record<string, unknown>;
    expect((await rt.sinks[0]!.preToolUse("Bash", input, "t1"))?.rule).toBe("guard-error");
  });

  it("resets a permission mode above the profile that Claude Code reports", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    rt.sinks[0]!.onMessage({ type: "system", subtype: "status", status: null, permissionMode: "bypassPermissions" });
    expect(svc.get(s.id).permissionMode).toBe("acceptEdits");
    expect(rt.modes).toEqual(["acceptEdits"]);
    expect(db.listEvents(s.id).find((e) => e.body.type === "policy.blocked")?.body).toMatchObject({ rule: "permission-mode", toolName: "PermissionMode" });
    rt.sinks[0]!.onMessage({ type: "system", subtype: "status", status: null, permissionMode: "default" });
    expect(svc.get(s.id).permissionMode).toBe("default");
  });

  it("stores a large tool input shortened but approves the full input", async () => {
    const s = await svc.start({ projectId, prompt: "x" });
    const content = "x".repeat(50_000);
    const pending = rt.sinks[0]!.onApproval(
      { requestId: "big", toolUseId: "tb", toolName: "Write", input: { file_path: "a.txt", content }, title: null, description: null, reason: null, suppressAlwaysAllow: false },
      new AbortController().signal,
    );
    const req = db.listEvents(s.id).find((e) => e.body.type === "approval.request")?.body as Extract<SessionEventBody, { type: "approval.request" }>;
    expect(req).toMatchObject({ inputTruncated: true, input: { file_path: "a.txt" } });
    expect((req.input.content as string).length).toBeLessThan(21_000);
    svc.respondApproval(s.id, "big", "allow", "once");
    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "once" });
    const audit = db.sql.prepare("SELECT input FROM approvals").get() as { input: string };
    expect(audit.input.length).toBeLessThan(21_000);
  });
});

describe("Remote Control wire messages", () => {
  it("handles recorded Remote Control messages and ignores unknown or malformed ones", async () => {
    const s = await svc.start({ projectId, prompt: "Lies a.txt" });
    rt.replay();
    await svc.remoteStart();
    const sink = rt.sinks[0]!;
    const states: string[] = [];
    for (const m of remoteFixture) {
      sink.onMessage(m);
      states.push(svc.remoteState().sessions[0]!.state);
    }
    expect(states.slice(0, 2)).toEqual(["connecting", "connected"]);
    expect(svc.remoteState().sessions[0]).toMatchObject({ state: "error", message: "Verbindung zur Claude-App verloren" });
    const users = db.listEvents(s.id).flatMap((e) => (e.body.type === "user.message" ? [e.body] : []));
    expect(users.map((u) => [u.text, u.source ?? "forge"])).toEqual([
      ["Lies a.txt", "forge"],
      ["Vom Handy: bitte README lesen", "remote"],
    ]);
    expect(users[1]!.attachments).toEqual([{ name: "Bild 1", mediaType: "image/png", size: expect.any(Number) }]);
    expect(svc.get(s.id).status).toBe("idle");
  });

  it("reports Remote Control the CLI does not offer as an error instead of crashing", async () => {
    await svc.start({ projectId, prompt: "x" });
    rt.remoteError = new Error(REMOTE_UNAVAILABLE);
    const state = await svc.remoteStart();
    expect(state.sessions[0]).toMatchObject({ state: "error", message: REMOTE_UNAVAILABLE });
    // switching on again retries the failed session
    rt.remoteError = null;
    expect((await svc.remoteStart()).sessions[0]).toMatchObject({ state: "connecting", url: "https://claude.ai/code/session_test", message: null });
  });
});

describe("Remote Control for all running sessions", () => {
  const remoteEvents = () => emitted.flatMap((e) => (e.event === "remote.updated" ? [e.payload] : []));

  it("starts no session when Remote is switched on without a running one", async () => {
    await storedSession();
    const calls = rt.remoteCalls.length;
    const state = await svc.remoteStart();
    expect(state).toEqual({ enabled: true, sessions: [] });
    expect(rt.started).toHaveLength(1);
    expect(rt.remoteCalls).toHaveLength(calls);
    expect(svc.listAll()).toHaveLength(1);
    expect(remoteEvents().at(-1)).toEqual({ enabled: true, sessions: [] });
  });

  it("connects every running session of every project under its own name", async () => {
    mkdirSync(path.join(t.dir, "proj2"), { recursive: true });
    const other = (await projects.import(path.join(t.dir, "proj2"))).id;
    const a = await svc.start({ projectId, prompt: "Lies a.txt" });
    const b = await svc.start({ projectId, prompt: "Lies a.txt" });
    const c = await svc.start({ projectId: other, prompt: "Fix den Login" });
    const stored = await storedSession();
    const state = await svc.remoteStart();
    expect(rt.remoteCalls.map((r) => [r.session, r.name])).toEqual([
      [0, "FORGE · proj: Lies a.txt"],
      [1, "FORGE · proj: Lies a.txt (2)"],
      [2, "FORGE · proj2: Fix den Login"],
    ]);
    expect(state.sessions.map((s) => [s.sessionId, s.projectName])).toEqual([
      [a.id, "proj"],
      [b.id, "proj"],
      [c.id, "proj2"],
    ]);
    expect(state.sessions.some((s) => s.sessionId === stored.id)).toBe(false);
    // switching on again keeps connected sessions as they are
    await svc.remoteStart();
    expect(rt.remoteCalls).toHaveLength(3);
  });

  it("connects sessions that start or resume while Remote is on", async () => {
    const stored = await storedSession();
    await svc.remoteStart();
    const s = await svc.start({ projectId, prompt: "Neue Aufgabe" });
    await vi.waitFor(() => expect(svc.remoteState().sessions.map((x) => x.sessionId)).toEqual([s.id]));
    expect(rt.remoteCalls.at(-1)).toEqual({ enabled: true, name: "FORGE · proj: Neue Aufgabe", session: 1 });
    await svc.resume(stored.id, "weiter");
    await vi.waitFor(() => expect(svc.remoteState().sessions).toHaveLength(2));
    expect(rt.remoteCalls.at(-1)).toEqual({ enabled: true, name: "FORGE · proj: Lies a.txt", session: 2 });
  });

  it("removes a session from Remote when it ends or is deleted", async () => {
    const a = await svc.start({ projectId, prompt: "eins" });
    const b = await svc.start({ projectId, prompt: "zwei" });
    await svc.remoteStart();
    svc.close(a.id);
    expect(svc.remoteState().sessions.map((s) => s.sessionId)).toEqual([b.id]);
    await svc.delete(b.id, false);
    expect(svc.remoteState()).toEqual({ enabled: true, sessions: [] });
    expect(remoteEvents().at(-1)).toEqual({ enabled: true, sessions: [] });
  });

  it("disconnects all sessions when switched off and connects no new ones", async () => {
    await svc.start({ projectId, prompt: "eins" });
    await svc.start({ projectId, prompt: "zwei" });
    await svc.remoteStart();
    const state = await svc.remoteStop();
    expect(state).toEqual({ enabled: false, sessions: [] });
    expect(rt.remoteCalls.filter((r) => !r.enabled).map((r) => r.session).sort()).toEqual([0, 1]);
    expect(svc.listLive()).toHaveLength(2);
    await svc.start({ projectId, prompt: "drei" });
    await new Promise((r) => setTimeout(r, 10));
    expect(rt.remoteCalls.filter((r) => r.enabled)).toHaveLength(2);
    expect(svc.remoteState().sessions).toEqual([]);
  });

  it("gives a session started without a prompt the title of its first message", async () => {
    await svc.remoteStart();
    const s = await svc.start({ projectId, prompt: "" });
    await vi.waitFor(() => expect(svc.remoteState().sessions).toHaveLength(1));
    rt.sinks[0]!.onMessage({ type: "user", isReplay: true, uuid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000001", message: { role: "user", content: "Baue einen Login" } });
    expect(svc.get(s.id).title).toBe("Baue einen Login");
    expect(svc.remoteState().sessions[0]!.title).toBe("Baue einen Login");
  });
});

describe("turn automation holds the next turn", () => {
  async function repoWithTags(testCommand: string) {
    const repo = projects.get(projectId).path;
    await initRepo(repo);
    await git(repo, "commit", "-m", "init", "--allow-empty");
    projects.update(projectId, { tags: ["auto-test", "auto-commit"], testCommand });
    return repo;
  }

  it("holds a new message until tests and auto-commit of the last turn are done", async () => {
    const repo = await repoWithTags('node -e "setTimeout(() => {}, 400)"');
    const s = await svc.start({ projectId, prompt: "mach was" });
    writeFileSync(path.join(repo, "neu.txt"), "von Claude\n");
    success(rt.sinks[0]!);
    await svc.send(s.id, "weiter");
    expect(rt.sent).toEqual([]);
    expect(svc.get(s.id).status).toBe("running");
    expect(userTexts(s.id)).toContain("weiter");
    await svc.drain();
    expect(rt.sent).toEqual(["weiter"]);
    const bodies = db.listEvents(s.id).map((e) => e.body);
    expect(bodies.find((b) => b.type === "automation")).toMatchObject({ action: "commit", ok: true, files: ["neu.txt"] });
  });

  it("drops a held message when the user stops", async () => {
    const repo = await repoWithTags('node -e "setTimeout(() => {}, 400)"');
    const s = await svc.start({ projectId, prompt: "mach was" });
    writeFileSync(path.join(repo, "neu.txt"), "von Claude\n");
    success(rt.sinks[0]!);
    await svc.send(s.id, "weiter");
    await svc.stop(s.id);
    expect(svc.get(s.id).status).toBe("idle");
    expect(rt.interrupted).toBe(0);
    await svc.drain();
    expect(rt.sent).toEqual([]);
    expect(db.listEvents(s.id).some((e) => e.body.type === "error" && /nicht gesendet: Gestoppt/.test(e.body.message))).toBe(true);
  });

  it("skips the auto-commit when files change after the turn", async () => {
    const repo = await repoWithTags("node -e \"require('fs').appendFileSync('neu.txt', 'mehr')\"");
    const s = await svc.start({ projectId, prompt: "mach was" });
    writeFileSync(path.join(repo, "neu.txt"), "von Claude\n");
    success(rt.sinks[0]!);
    await svc.drain();
    expect(db.listEvents(s.id).find((e) => e.body.type === "automation")?.body).toMatchObject({ action: "skip" });
    expect((await git(repo, "log", "--format=%s")).trim()).toBe("init");
  });

  it("skips the auto-commit when a turn from the Claude app started meanwhile", async () => {
    const repo = await repoWithTags('node -e "setTimeout(() => {}, 300)"');
    const s = await svc.start({ projectId, prompt: "mach was" });
    writeFileSync(path.join(repo, "neu.txt"), "von Claude\n");
    success(rt.sinks[0]!);
    rt.sinks[0]!.onMessage({ type: "command_lifecycle", command_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-000000000009", state: "started" });
    await svc.drain();
    expect(db.listEvents(s.id).find((e) => e.body.type === "automation")?.body).toMatchObject({ action: "skip" });
  });
});

describe("automatic continuation after a usage limit", () => {
  const START = Date.parse("2026-10-11T12:00:00.000Z");
  const RESET_S = START / 1000 + 3600;
  const DUE = new Date(RESET_S * 1000 + RESET_BUFFER_MS).toISOString();
  let clock: number;
  let svc2: SessionService;

  beforeEach(() => {
    clock = START;
    svc2 = new SessionService(db, projects, new GitEngine(), rt, (e) => emitted.push(e), () => clock);
  });
  afterEach(async () => {
    await svc2.drain();
    svc2.shutdown();
  });

  const limitHit = (sink: SessionSink, opts: { resetsAt?: number | null; text?: string } = {}) => {
    if (opts.resetsAt !== null) sink.onMessage({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: opts.resetsAt ?? RESET_S, rateLimitType: "five_hour" } });
    sink.onMessage({ type: "result", subtype: "success", is_error: true, result: opts.text ?? "You've hit your limit · resets 2pm" });
  };
  const autoEvents = (id: string) => db.listEvents(id).flatMap((e) => (e.body.type === "auto_continue" ? [e.body] : []));

  /** A session with a claude session id (needed to resume) whose second turn ran into the limit. */
  async function limited(opts: { resetsAt?: number | null; text?: string } = {}) {
    const s = await svc2.start({ projectId, prompt: "Lies a.txt" });
    rt.replay();
    await svc2.send(s.id, "Bau das Feature");
    limitHit(rt.sinks.at(-1)!, opts);
    await svc2.drain();
    return s;
  }

  it("plans the continuation at the reported reset plus a buffer and stores it", async () => {
    const s = await limited();
    expect(db.getAutoContinue(s.id)).toMatchObject({ dueAt: DUE, resetsAt: new Date(RESET_S * 1000).toISOString(), attempts: 0 });
    expect(svc2.get(s.id).autoContinueAt).toBe(DUE);
    expect(autoEvents(s.id)).toEqual([{ type: "auto_continue", state: "scheduled", scheduledFor: DUE, resetKnown: true, attempt: 1, message: null }]);
    expect(emitted.some((e) => e.event === "session.updated" && e.payload.id === s.id && e.payload.autoContinueAt === DUE)).toBe(true);
  });

  it("sends the continuation prompt once due, marked as automatic", async () => {
    const s = await limited();
    clock = Date.parse(DUE) - 1000;
    await svc2.checkAutoContinue();
    expect(rt.sent).toEqual(["Bau das Feature"]);
    clock = Date.parse(DUE);
    await svc2.checkAutoContinue();
    expect(rt.sent).toEqual(["Bau das Feature", AUTO_CONTINUE_PROMPT]);
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "resumed", scheduledFor: DUE, attempt: 1 });
    expect(db.listEvents(s.id).find((e) => e.body.type === "user.message" && e.body.text === AUTO_CONTINUE_PROMPT)?.body).toMatchObject({ source: "auto" });
    expect(svc2.get(s.id)).toMatchObject({ autoContinueAt: null, status: "running" });
  });

  it("resumes the session first when its process is gone", async () => {
    const s = await limited();
    svc2.close(s.id);
    expect(svc2.get(s.id).live).toBe(false);
    clock = Date.parse(DUE) + 5000;
    await svc2.checkAutoContinue();
    expect(rt.started.at(-1)).toMatchObject({ resume: "d69118dc-ef0c-4925-9945-3091ab75cb15", firstMessage: expect.objectContaining({ text: AUTO_CONTINUE_PROMPT }) });
  });

  it("runs an overdue plan on the first check after the computer slept, driven by the wall clock", async () => {
    const s = await limited();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    try {
      svc2.startBackgroundChecks();
      await vi.advanceTimersByTimeAsync(STARTUP_CHECK_MS + CHECK_INTERVAL_MS);
      expect(autoEvents(s.id).some((b) => b.state === "resumed")).toBe(false);
      // Asleep: no timer ran, but the wall clock moved on by hours. The next tick sees the plan as overdue.
      clock = Date.parse(DUE) + 3 * 60 * 60_000;
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    } finally {
      vi.useRealTimers();
    }
    // Sending captures a git baseline (a real child process), so wait in real time.
    await vi.waitFor(() => expect(rt.sent.at(-1)).toBe(AUTO_CONTINUE_PROMPT));
    await svc2.checkAutoContinue();
    expect(autoEvents(s.id).filter((b) => b.state === "resumed")).toHaveLength(1);
    expect(rt.sent.filter((t) => t === AUTO_CONTINUE_PROMPT)).toHaveLength(1);
  });

  it("drops the plan when the user writes before the reset", async () => {
    const s = await limited();
    await svc2.send(s.id, "Ich mach selbst weiter");
    expect(svc2.get(s.id).autoContinueAt).toBeNull();
    expect(db.getAutoContinue(s.id)).toBeNull();
    clock = Date.parse(DUE) + 1000;
    await svc2.checkAutoContinue();
    expect(rt.sent).not.toContain(AUTO_CONTINUE_PROMPT);
  });

  it("drops the plan when a message comes in from the Claude app", async () => {
    const s = await limited();
    svc2["core"].record(s.id, { type: "user.message", text: "vom Handy", source: "remote" });
    expect(svc2.get(s.id).autoContinueAt).toBeNull();
  });

  it("cancels on request and records it in the timeline", async () => {
    const s = await limited();
    expect(svc2.cancelAutoContinue(s.id).autoContinueAt).toBeNull();
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "cancelled", scheduledFor: DUE });
    clock = Date.parse(DUE) + 1000;
    await svc2.checkAutoContinue();
    expect(rt.sent).not.toContain(AUTO_CONTINUE_PROMPT);
  });

  it("cancels when the user stops the session", async () => {
    const s = await limited();
    await svc2.stop(s.id);
    expect(svc2.get(s.id).autoContinueAt).toBeNull();
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "cancelled", message: "Session gestoppt." });
  });

  it("plans nothing when the setting is off, and switching it off drops pending plans", async () => {
    db.updateSettings({ autoContinueAfterLimit: false });
    const s = await limited();
    expect(db.getAutoContinue(s.id)).toBeNull();
    expect(autoEvents(s.id)).toEqual([]);
    db.updateSettings({ autoContinueAfterLimit: true });
    await svc2.send(s.id, "nochmal");
    limitHit(rt.sinks.at(-1)!);
    await svc2.drain();
    expect(svc2.get(s.id).autoContinueAt).toBe(DUE);
    db.updateSettings({ autoContinueAfterLimit: false });
    svc2.settingsChanged();
    expect(svc2.get(s.id).autoContinueAt).toBeNull();
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "cancelled" });
  });

  it("does not plan for an ordinary error", async () => {
    const s = await svc2.start({ projectId, prompt: "x" });
    rt.sinks[0]!.onMessage({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 500"] });
    await svc2.drain();
    expect(db.getAutoContinue(s.id)).toBeNull();
  });

  it("re-arms the plan from the database after a restart", async () => {
    const s = await limited();
    svc2.shutdown();
    expect(db.markOrphanedSessions()).toBe(0);
    const svc3 = new SessionService(db, projects, new GitEngine(), rt, () => {}, () => clock);
    try {
      expect(svc3.get(s.id)).toMatchObject({ live: false, autoContinueAt: DUE });
      clock = Date.parse(DUE) + 60_000;
      await svc3.checkAutoContinue();
      expect(rt.started.at(-1)).toMatchObject({ resume: "d69118dc-ef0c-4925-9945-3091ab75cb15", firstMessage: expect.objectContaining({ text: AUTO_CONTINUE_PROMPT }) });
    } finally {
      await svc3.drain();
      svc3.shutdown();
    }
  });

  it("stops after three automatic continuations without user input", async () => {
    const s = await limited();
    for (let i = 1; i <= MAX_AUTO_CONTINUES; i++) {
      clock = Date.parse(db.getAutoContinue(s.id)!.dueAt!) + 1000;
      await svc2.checkAutoContinue();
      expect(rt.sent.filter((t) => t === AUTO_CONTINUE_PROMPT)).toHaveLength(i);
      limitHit(rt.sinks.at(-1)!, { resetsAt: clock / 1000 + 600 });
      await svc2.drain();
    }
    expect(svc2.get(s.id).autoContinueAt).toBeNull();
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "exhausted", attempt: MAX_AUTO_CONTINUES });
    // The next own message starts the count over.
    await svc2.send(s.id, "weiter");
    limitHit(rt.sinks.at(-1)!, { resetsAt: clock / 1000 + 600 });
    await svc2.drain();
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "scheduled", attempt: 1 });
  });

  it("checks the plan usage periodically while the reset time is unknown", async () => {
    const s = await limited({ resetsAt: null, text: "You've hit your limit" });
    const probeAt = new Date(START + PROBE_INTERVAL_MS).toISOString();
    expect(db.getAutoContinue(s.id)).toMatchObject({ dueAt: probeAt, resetsAt: null });
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "scheduled", resetKnown: false });
    const reset = new Date(START + 2 * 60 * 60_000).toISOString();
    rt.usage = { available: true, subscriptionType: "max", windows: [{ key: "five_hour", label: "5 Stunden", utilization: 100, resetsAt: reset }], fetchedAt: reset, error: null };
    clock = Date.parse(probeAt);
    await svc2.checkAutoContinue();
    const due = new Date(Date.parse(reset) + RESET_BUFFER_MS).toISOString();
    expect(db.getAutoContinue(s.id)).toMatchObject({ dueAt: due, resetsAt: reset });
    expect(autoEvents(s.id).at(-1)).toMatchObject({ state: "scheduled", resetKnown: true, scheduledFor: due });
    expect(rt.sent).not.toContain(AUTO_CONTINUE_PROMPT);
  });

  it("takes the reset time from the plan usage when the limit event has none", async () => {
    const reset = new Date(START + 90 * 60_000).toISOString();
    rt.usage = { available: true, subscriptionType: "max", windows: [{ key: "seven_day", label: "Woche", utilization: 100, resetsAt: reset }], fetchedAt: reset, error: null };
    const s = await limited({ resetsAt: null, text: "You've reached your weekly limit" });
    expect(db.getAutoContinue(s.id)).toMatchObject({ resetsAt: reset });
  });
});

describe("account rate limit state", () => {
  it("keeps the latest warning, reports changes once and clears it after the reset or when allowed", async () => {
    let clock = Date.parse("2026-10-11T12:00:00.000Z");
    const svc2 = new SessionService(db, projects, new GitEngine(), rt, (e) => emitted.push(e), () => clock);
    try {
      expect(svc2.rateLimit().status).toBe("ok");
      await svc2.start({ projectId, prompt: "x" });
      const warn = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: clock / 1000 + 1800, rateLimitType: "five_hour", utilization: 0.9 } };
      rt.sinks[0]!.onMessage(warn);
      rt.sinks[0]!.onMessage(warn);
      const resetsAt = new Date(clock + 1800_000).toISOString();
      expect(svc2.rateLimit()).toMatchObject({ status: "warning", limitType: "five_hour", resetsAt, utilization: 90 });
      expect(emitted.filter((e) => e.event === "ratelimit.updated")).toHaveLength(1);
      clock += 1800_000;
      expect(svc2.rateLimit()).toMatchObject({ status: "ok", resetsAt: null });
      rt.sinks[0]!.onMessage({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: clock / 1000 + 600, rateLimitType: "seven_day" } });
      expect(svc2.rateLimit()).toMatchObject({ status: "reached", limitType: "seven_day" });
      rt.sinks[0]!.onMessage({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: clock / 1000 + 600, rateLimitType: "seven_day" } });
      expect(svc2.rateLimit().status).toBe("ok");
    } finally {
      await svc2.drain();
      svc2.shutdown();
    }
  });
});

describe("session titles follow the newest prompts", () => {
  const CLAUDE_ID = "d69118dc-ef0c-4925-9945-3091ab75cb15";
  let clock: number;
  let svc2: SessionService;
  const settle = () => new Promise((r) => setImmediate(r));
  async function tick(ms: number) {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  }
  /** a session that finished its first turn, so it has a Claude session id and is idle */
  async function idleSession(prompt = "Baue eine Login-Seite mit Formular") {
    const s = await svc2.start({ projectId, prompt });
    rt.replay();
    return s;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    clock = Date.parse("2026-10-11T12:00:00.000Z");
    svc2 = new SessionService(db, projects, new GitEngine(), rt, (e) => emitted.push(e), () => clock);
  });
  afterEach(() => {
    svc2.shutdown();
    vi.useRealTimers();
  });

  it("asks Claude Code for a title from the newest prompts and applies it everywhere", async () => {
    rt.generatedTitle = "„Fehlermeldungen übersetzen.“";
    const s = await idleSession();
    await svc2.send(s.id, "Jetzt bitte die Fehlermeldungen auf Deutsch übersetzen");
    await tick(TITLE_DEBOUNCE_MS);
    expect(svc2.get(s.id).title).toBe("Fehlermeldungen übersetzen");
    // start and send within the debounce: one request
    expect(rt.titleRequests).toHaveLength(1);
    expect(rt.titleRequests[0]).toMatch(/Neueste Anfrage: Jetzt bitte die Fehlermeldungen[\s\S]*Davor: Baue eine Login-Seite/);
    expect(rt.renames).toEqual([{ title: "Fehlermeldungen übersetzen", claudeSessionId: CLAUDE_ID, session: 0 }]);
    expect(rt.completions).toEqual([]);
    expect(emitted.some((e) => e.event === "session.updated" && e.payload.title === "Fehlermeldungen übersetzen")).toBe(true);
  });

  it("falls back to the small model and then to the prompt itself", async () => {
    rt.completeResult = "Titel: Login-Seite bauen";
    const s = await idleSession();
    await tick(TITLE_DEBOUNCE_MS);
    expect(svc2.get(s.id).title).toBe("Login-Seite bauen");
    expect(rt.titleRequests).toHaveLength(1);
    expect(rt.completions[0]).toMatch(/höchstens 6 Wörter/);

    rt.generatedTitle = new Error("unknown control request");
    rt.completeResult = new Error("offline");
    await tick(TITLE_MIN_INTERVAL_MS);
    await svc2.send(s.id, "Danach die README um einen Abschnitt erweitern");
    await tick(TITLE_DEBOUNCE_MS);
    expect(svc2.get(s.id).title).toBe("Danach die README um einen Abschnitt erweitern");
  });

  it("keeps the title for automatic, slash and filler messages", async () => {
    rt.generatedTitle = "Neuer Titel";
    const s = await idleSession("kurz");
    for (const text of ["/compact", "ok danke", "Ja, mach weiter!", "weiter bitte", "Danke, das passt so."]) {
      await svc2.send(s.id, text);
      success(rt.sinks[0]!);
    }
    await tick(TITLE_MIN_INTERVAL_MS);
    expect(rt.titleRequests).toEqual([]);
    expect(rt.completions).toEqual([]);
    expect(svc2.get(s.id).title).toBe("kurz");
    expect(isTitleWorthy(AUTO_CONTINUE_PROMPT, "auto")).toBe(false);
  });

  it("refreshes at most once a minute and then uses the newest prompt", async () => {
    rt.generatedTitle = "Menü bauen";
    const s = await idleSession("Erste Aufgabe für die Session");
    await tick(1_000);
    await svc2.send(s.id, "Zweite Aufgabe: das Menü bauen");
    await tick(TITLE_DEBOUNCE_MS - 1);
    expect(rt.titleRequests).toHaveLength(0);
    await tick(1);
    expect(rt.titleRequests).toHaveLength(1);
    expect(svc2.get(s.id).title).toBe("Menü bauen");

    rt.generatedTitle = "Doku ergänzen";
    await svc2.send(s.id, "Dritte Aufgabe: Tests schreiben");
    await tick(TITLE_DEBOUNCE_MS);
    await svc2.send(s.id, "Vierte Aufgabe: die Doku ergänzen");
    await tick(TITLE_DEBOUNCE_MS);
    expect(rt.titleRequests).toHaveLength(1);
    await tick(TITLE_MIN_INTERVAL_MS - 2 * TITLE_DEBOUNCE_MS);
    expect(rt.titleRequests).toHaveLength(2);
    expect(rt.titleRequests[1]).toMatch(/^Neueste Anfrage: Vierte Aufgabe/m);
    expect(svc2.get(s.id).title).toBe("Doku ergänzen");
  });

  it("never runs two refreshes of a session at once", async () => {
    let answer: (t: string) => void = () => {};
    rt.generatedTitle = new Promise<string>((r) => (answer = r));
    const s = await idleSession();
    await tick(TITLE_DEBOUNCE_MS);
    expect(rt.titleRequests).toHaveLength(1);
    await svc2.send(s.id, "Noch eine Aufgabe: das Logo tauschen");
    await tick(TITLE_TIMEOUT_MS - 1);
    expect(rt.titleRequests).toHaveLength(1);
    answer("Login-Seite bauen");
    await settle();
    expect(svc2.get(s.id).title).toBe("Login-Seite bauen");
    // the message that came in meanwhile gets its refresh once the minute is over
    rt.generatedTitle = "Logo tauschen";
    await tick(TITLE_MIN_INTERVAL_MS - TITLE_TIMEOUT_MS);
    expect(rt.titleRequests).toHaveLength(1);
    await tick(1);
    expect(rt.titleRequests).toHaveLength(2);
    expect(svc2.get(s.id).title).toBe("Logo tauschen");
  });

  it("moves on to the small model when Claude Code does not answer", async () => {
    rt.generatedTitle = new Promise<string>(() => {});
    rt.completeResult = "Login-Seite bauen";
    const s = await idleSession();
    await tick(TITLE_DEBOUNCE_MS);
    expect(svc2.get(s.id).title).toBe("Baue eine Login-Seite mit Formular");
    await tick(TITLE_TIMEOUT_MS);
    expect(svc2.get(s.id).title).toBe("Login-Seite bauen");
  });

  it("names the Remote entry and the Claude app session after the new title", async () => {
    rt.generatedTitle = "Login bauen";
    const s = await idleSession();
    await svc2.remoteStart();
    expect(svc2.remoteState().sessions[0]!.name).toBe("FORGE · proj: Baue eine Login-Seite mit Formular");
    await tick(TITLE_DEBOUNCE_MS);
    expect(svc2.remoteState().sessions[0]).toMatchObject({ sessionId: s.id, title: "Login bauen", name: "FORGE · proj: Login bauen" });
    expect(rt.renames.at(-1)).toEqual({ title: "FORGE · proj: Login bauen", claudeSessionId: CLAUDE_ID, session: 0 });
    expect(emitted.some((e) => e.event === "remote.updated" && e.payload.sessions[0]?.name === "FORGE · proj: Login bauen")).toBe(true);
  });

  it("writes the title into the transcript when the process ended meanwhile", async () => {
    rt.completeResult = "Login-Seite bauen";
    const s = await idleSession();
    svc2.close(s.id);
    await tick(TITLE_DEBOUNCE_MS);
    expect(svc2.get(s.id).title).toBe("Login-Seite bauen");
    expect(rt.titleRequests).toEqual([]);
    expect(rt.renames).toEqual([]);
    expect(rt.transcriptRenames).toEqual([{ claudeSessionId: CLAUDE_ID, title: "Login-Seite bauen", dir: s.cwd }]);
  });

  it("never lets a failing title break the session", async () => {
    rt.generatedTitle = new Error("kaputt");
    rt.completeResult = new Error("offline");
    rt.renameError = new Error("rename refused");
    const s = await idleSession();
    await svc2.send(s.id, "Bitte die Startseite schneller machen");
    expect(rt.sent).toEqual(["Bitte die Startseite schneller machen"]);
    await tick(TITLE_DEBOUNCE_MS);
    expect(svc2.get(s.id)).toMatchObject({ title: "Bitte die Startseite schneller machen", status: "running", lastError: null });
    expect(persistedTypes(s.id)).not.toContain("error");
    success(rt.sinks[0]!);
    await svc2.send(s.id, "Und danach den Footer anpassen");
    expect(rt.sent).toHaveLength(2);
  });

  it("stops refreshing on shutdown and for deleted sessions", async () => {
    rt.generatedTitle = "Neuer Titel";
    const a = await idleSession();
    const b = await idleSession("Zweite Session mit eigener Aufgabe");
    await svc2.delete(b.id, false);
    svc2.shutdown();
    await tick(TITLE_DEBOUNCE_MS);
    expect(rt.titleRequests).toEqual([]);
    expect(db.getSession(a.id)?.title).toBe("Baue eine Login-Seite mit Formular");
  });
});

describe("reset time from limit messages", () => {
  const now = new Date(2026, 9, 11, 12, 0, 0).getTime();
  it("reads clock times, dates and the old unix suffix", () => {
    expect(resetFromText("You've hit your limit · resets 3pm (Europe/Berlin)", now)).toBe(new Date(2026, 9, 11, 15, 0).getTime());
    expect(resetFromText("5-hour limit reached · resets 9:30am", now)).toBe(new Date(2026, 9, 12, 9, 30).getTime());
    expect(resetFromText("You've hit your weekly limit · resets Oct 14, 6pm", now)).toBe(new Date(2026, 9, 14, 18, 0).getTime());
    expect(resetFromText("Claude AI usage limit reached|1791661200", now)).toBe(1791661200_000);
    expect(resetFromText("resets 15:00", now)).toBe(new Date(2026, 9, 11, 15, 0).getTime());
    expect(resetFromText("You've hit your limit", now)).toBeNull();
    expect(resetFromText("resets 3", now)).toBeNull();
  });

  it("recognises limit texts but not ordinary errors", () => {
    expect(isUsageLimitText("You've hit your limit · resets 3pm")).toBe(true);
    expect(isUsageLimitText("Claude AI usage limit reached|1791661200")).toBe(true);
    expect(isUsageLimitText("API Error: 529 Overloaded")).toBe(false);
    expect(isUsageLimitText(null)).toBe(false);
  });
});
