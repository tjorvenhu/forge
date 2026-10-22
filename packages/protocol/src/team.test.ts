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
