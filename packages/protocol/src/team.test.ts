import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionEventBody } from "./models.js";
import { buildTeam, modelFamily, teamRoleOf } from "./team.js";

let seq = 0;
const ev = (body: SessionEventBody): SessionEvent => ({ seq: ++seq, sessionId: "s", ts: `2026-10-22T10:00:${String(seq).padStart(2, "0")}.000Z`, body });
const use = (toolUseId: string, name: string, input: Record<string, unknown>, parentToolUseId: string | null = null) => ev({ type: "tool.use", toolUseId, name, input, parentToolUseId });
const result = (toolUseId: string, text: string, isError = false) => ev({ type: "tool.result", toolUseId, isError, content: { text, truncated: false } });

describe("buildTeam", () => {
  it("follows members from their Agent call through their tools to their report", () => {
    const events = [
      use("t1", "TodoWrite", { todos: [{ content: "Suche verstehen", status: "completed" }, { content: "Index bauen", status: "in_progress", activeForm: "Baut den Index" }, { content: "Review", status: "pending" }] }),
      use("a1", "Agent", { subagent_type: "team-scout", description: "Suche finden", prompt: "Wo liegt die Suche?" }),
      use("x1", "Grep", { pattern: "search" }, "a1"),
      result("a1", "src/search.ts:10"),
      use("a2", "Agent", { subagent_type: "team-developer", description: "Index bauen", prompt: "Baue den Index", run_in_background: true }),
      result("a2", "Async agent launched"),
      ev({ type: "background.task", taskId: "k2", description: "Index bauen", state: "started", summary: null, toolUseId: "a2" }),
      use("x2", "Edit", { file_path: "C:\\repo\\src\\index.ts" }, "a2"),
      use("x3", "Write", { file_path: "C:\\repo\\src\\index.ts" }, "a2"),
      use("a3", "Agent", { subagent_type: "team-reviewer", description: "Review", prompt: "Prüfe", model: "fable", run_in_background: true }),
      ev({ type: "background.task", taskId: "k3", description: "Review", state: "completed", summary: "Keine Befunde", toolUseId: "a3" }),
      use("a4", "Agent", { subagent_type: "general-purpose", description: "Etwas anderes", prompt: "x" }),
      result("a4", "kaputt", true),
    ];
    const { members, tasks } = buildTeam(events, { live: true, cwd: "C:\\repo" });
    expect(tasks.map((t) => [t.subject, t.status])).toEqual([
      ["Suche verstehen", "completed"],
      ["Index bauen", "in_progress"],
      ["Review", "pending"],
    ]);
    expect(members.map((m) => [m.id, m.role, m.model, m.state, m.background])).toEqual([
      ["a1", "scout", "haiku", "done", false],
      ["a2", "developer", "sonnet", "working", true],
      ["a3", "reviewer", "fable", "done", true],
      ["a4", null, null, "failed", false],
    ]);
    expect(members[0]).toMatchObject({ toolUses: 1, activity: "Grep · search", result: "src/search.ts:10" });
    expect(members[1]).toMatchObject({ toolUses: 2, files: ["src/index.ts"], activity: "Write · src/index.ts", result: null, endedAt: null });
    expect(members[2]!.result).toBe("Keine Befunde");
  });

  it("counts members still at work in an ended session as stopped", () => {
    const { members } = buildTeam([use("a1", "Agent", { subagent_type: "team-developer", description: "x", prompt: "x" })], { live: false });
    expect(members[0]!.state).toBe("stopped");
  });

  it("keeps a plan made with the task tools", () => {
    const { tasks } = buildTeam(
      [use("c1", "TaskCreate", { subject: "A" }), result("c1", "Task #1 created"), use("c2", "TaskCreate", { subject: "B" }), result("c2", "Task #2 created"), use("u1", "TaskUpdate", { taskId: "2", status: "in_progress" })],
      { live: true },
    );
    expect(tasks.map((t) => [t.id, t.subject, t.status])).toEqual([
      ["1", "A", "pending"],
      ["2", "B", "in_progress"],
    ]);
  });
});

describe("buildTeam: approvals, tokens and models", () => {
  const tok = (input: number, output: number, costUsd: number) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
  const turn = (models: Record<string, ReturnType<typeof tok>>) =>
    ev({ type: "turn.result", subtype: "success", isError: false, durationMs: 1, numTurns: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, models, text: null });
  const init = () => ev({ type: "session.init", claudeSessionId: "c", model: "opus", permissionMode: "acceptEdits", cwd: "", tools: [], claudeCodeVersion: null, apiKeySource: null });
  const approval = (requestId: string, toolUseId: string, command: string) =>
    ev({ type: "approval.request", requestId, toolUseId, toolName: "Bash", input: { command }, title: null, description: null, reason: null, allowSessionScope: true, outsideProject: false });

  it("shows an open approval at the member whose tool call waits, until it is answered", () => {
    const base = [
      use("a1", "Agent", { subagent_type: "team-tester", description: "Tests", prompt: "x", run_in_background: true }),
      use("b1", "Bash", { command: "pnpm install" }, "a1"),
      approval("r1", "b1", "pnpm install"),
    ];
    expect(buildTeam(base, { live: true }).members[0]!.approval).toMatchObject({ requestId: "r1", toolName: "Bash", detail: "pnpm install", allowSessionScope: true });
    expect(buildTeam([...base, ev({ type: "approval.resolved", requestId: "r1", decision: "allow", scope: "once", source: "user", message: null })], { live: true }).members[0]!.approval).toBeNull();
    // a request of an ended process can no longer be answered
    expect(buildTeam(base, { live: false }).members[0]!.approval).toBeNull();
  });

  it("takes a member's tokens from its end, or live while it works, and sums the models over every process", () => {
    const events = [
      init(),
      use("a1", "Agent", { subagent_type: "team-scout", description: "s", prompt: "x" }),
      result("a1", "ok"),
      ev({ type: "task.usage", toolUseId: "a1", tokens: 12000, toolUses: 4, durationMs: 9000 }),
      use("a2", "Agent", { subagent_type: "team-developer", description: "d", prompt: "x", run_in_background: true }),
      turn({ "claude-opus-5-5": tok(100, 10, 1), "claude-haiku-5-5": tok(50, 5, 0.1) }),
      turn({ "claude-opus-5-5": tok(200, 20, 2), "claude-haiku-5-5": tok(50, 5, 0.1) }),
      init(),
      turn({ "claude-opus-5-5": tok(30, 3, 0.5) }),
    ];
    const { members, models } = buildTeam(events, { live: true, liveTokens: new Map([["a2", 3400], ["a1", 1]]) });
    expect(members.map((m) => m.tokens)).toEqual([12000, 3400]);
    expect(models).toEqual({ "claude-opus-5-5": tok(230, 23, 2.5), "claude-haiku-5-5": tok(50, 5, 0.1) });
  });

  it("names the model a role runs on in this team", () => {
    const { members } = buildTeam([use("a1", "Agent", { subagent_type: "team-reviewer", description: "r", prompt: "x" })], { live: true, roleModels: { reviewer: "sonnet" } });
    expect(members[0]!.model).toBe("sonnet");
  });
});

describe("team helpers", () => {
  it("maps agent types to roles and models to families", () => {
    expect(teamRoleOf("team-tester")).toBe("tester");
    expect(teamRoleOf("team-unknown")).toBeNull();
    expect(teamRoleOf("Explore")).toBe("scout");
    expect(modelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(modelFamily("opus[1m]")).toBe("opus");
    expect(modelFamily(null)).toBeNull();
  });
});

describe("role models from text", () => {
  it("reads roles in German or English and drops overrides set back to the default", async () => {
    const { parseTeamRoleModels, mergeTeamRoleModels } = await import("./team.js");
    const p = parseTeamRoleModels("Reviewer=Sonnet, spezialist: fable; scout standard, koch=opus, tester=gpt");
    expect(p.models).toEqual({ reviewer: "sonnet", specialist: "fable", scout: null });
    expect(p.invalid).toEqual(["koch=opus", "tester=gpt"]);
    expect(mergeTeamRoleModels({ scout: "sonnet", tester: "opus" }, { ...p.models, tester: "sonnet" })).toEqual({ reviewer: "sonnet", specialist: "fable" });
  });
});
