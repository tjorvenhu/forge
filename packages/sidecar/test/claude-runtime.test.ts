import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSink } from "../src/claude/runtime.js";

/** No CLI is spawned here: query() is replaced by fakes that never answer unless told to. */
const sdk = vi.hoisted(() => ({
  calls: [] as Array<{ options: Options; q: FakeQuery }>,
  extra: {} as Record<string, unknown>,
}));

interface FakeQuery {
  closed: number;
  close(): void;
  [key: string]: unknown;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Options }) => {
    const never = () => new Promise(() => {});
    const q: FakeQuery = {
      closed: 0,
      close() {
        this.closed++;
      },
      initializationResult: never,
      supportedCommands: never,
      [Symbol.asyncIterator]: () => ({ next: never }),
      ...sdk.extra,
    };
    sdk.calls.push({ options, q });
    return q;
  },
  listSessions: vi.fn(),
  deleteSession: vi.fn(),
  getSessionMessages: vi.fn(),
}));

const { AgentSdkRuntime, REMOTE_UNAVAILABLE, USAGE_UNAVAILABLE, REPLAY_FLAG } = await import("../src/claude/runtime.js");

const opts = { cwd: process.cwd(), env: {}, claudePath: "claude" };
const last = () => sdk.calls.at(-1)!;

beforeEach(() => {
  sdk.calls.length = 0;
  sdk.extra = {};
});

describe("one-shot CLI calls", () => {
  it("abort and close a probe that does not answer in time", async () => {
    const rt = new AgentSdkRuntime({ oneShotTimeoutMs: 30 });
    await expect(rt.probe(opts)).rejects.toThrow(/Claude-Code-Abfrage: Claude Code hat nicht innerhalb von/);
    expect(last().q.closed).toBe(1);
    expect(last().options.abortController?.signal.aborted).toBe(true);
  });

  it("time out completions, slash command lookups and usage the same way", async () => {
    const rt = new AgentSdkRuntime({ oneShotTimeoutMs: 30 });
    await expect(rt.complete("hi", { ...opts, model: "haiku" })).rejects.toThrow(/nicht innerhalb von/);
    expect(last().q.closed).toBe(1);
    await expect(rt.commands(opts)).rejects.toThrow(/Slash-Commands laden/);
    sdk.extra = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) };
    await expect(rt.planUsage(opts)).rejects.toThrow(/Plan-Auslastung/);
    expect(sdk.calls.every((c) => c.q.closed === 1)).toBe(true);
  });

  it("return the answer and close the process when the CLI is quick", async () => {
    sdk.extra = { supportedCommands: async () => [{ name: "review", description: "Code prüfen" }] };
    const rt = new AgentSdkRuntime({ oneShotTimeoutMs: 1_000 });
    await expect(rt.commands(opts)).resolves.toEqual([{ name: "review", description: "Code prüfen", argumentHint: "" }]);
    expect(last().q.closed).toBe(1);
    expect(last().options.abortController?.signal.aborted).toBe(false);
  });

  it("report plan usage as unavailable when the CLI lacks the experimental call", async () => {
    const rt = new AgentSdkRuntime();
    await expect(rt.planUsage(opts)).rejects.toThrow(USAGE_UNAVAILABLE);
    expect(last().q.closed).toBe(1);
  });
});

describe("session hooks", () => {
  const sink = (over: Partial<SessionSink>): SessionSink => ({
    onMessage: () => {},
    onApproval: async () => ({ behavior: "allow", scope: "once" }),
    preToolUse: async () => null,
    onEnd: () => {},
    ...over,
  });
  const start = (s: SessionSink) =>
    new AgentSdkRuntime().startSession({ cwd: process.cwd(), model: null, effort: null, permissionMode: "default", resume: null, disallowedTools: [], env: {}, claudePath: "claude", firstMessage: null }, s);
  const hookOf = () => last().options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
  const preToolUse = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s", transcript_path: "", cwd: "" };

  it("deny the tool call when the policy check throws", async () => {
    start(sink({ preToolUse: () => Promise.reject(new Error("DB gesperrt")) }));
    const out = await hookOf()(preToolUse as never, "t1", { signal: new AbortController().signal });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("guard-error") } });
  });

  it("let the call through only when the check passes", async () => {
    start(sink({}));
    expect(await hookOf()(preToolUse as never, "t1", { signal: new AbortController().signal })).toEqual({});
  });

  it("deny an approval whose handling throws", async () => {
    start(sink({ onApproval: () => Promise.reject(new Error("kaputt")) }));
    const canUseTool = last().options.canUseTool!;
    const r = await canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1" } as never);
    expect(r).toMatchObject({ behavior: "deny" });
  });

  it("feature-detects Remote Control instead of crashing on a CLI without it", async () => {
    const rs = start(sink({}));
    await expect(rs.setRemoteControl(true, "FORGE")).rejects.toThrow(REMOTE_UNAVAILABLE);
    sdk.extra = { enableRemoteControl: async () => ({ session_url: "https://claude.ai/code/x" }) };
    const rs2 = start(sink({}));
    await expect(rs2.setRemoteControl(true, "FORGE")).resolves.toBe("https://claude.ai/code/x");
  });

  it("asks the CLI to echo user messages for Remote Control", () => {
    start(sink({}));
    expect(last().options.extraArgs).toEqual({ [REPLAY_FLAG]: null });
  });
});
