import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_INPUT_STRING, Normalizer, truncateInput } from "../src/claude/normalize.js";

const fixture = readFileSync(path.join(import.meta.dirname, "fixtures", "stream-read-tool.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as unknown);

describe("Normalizer with real CLI stream-json fixture", () => {
  const n = new Normalizer();
  const events = fixture.flatMap((m) => n.normalize(m));
  const types = events.map((e) => e.type);

  it("emits init with session id, model and api key source", () => {
    const init = events.find((e) => e.type === "session.init");
    expect(init).toMatchObject({
      type: "session.init",
      claudeSessionId: "d69118dc-ef0c-4925-9945-3091ab75cb15",
      model: "claude-haiku-5-5",
      cwd: "C:\\fixture\\project",
    });
  });

  it("pairs tool.use with tool.result", () => {
    const use = events.find((e) => e.type === "tool.use");
    const result = events.find((e) => e.type === "tool.result");
    expect(use).toMatchObject({ name: "Read", parentToolUseId: null });
    expect(result).toMatchObject({ isError: false });
    if (use?.type === "tool.use" && result?.type === "tool.result") {
      expect(result.toolUseId).toBe(use.toolUseId);
      expect(result.content.text).toContain("hello");
    }
  });

  it("streams real text deltas whose concatenation equals the final text", () => {
    const final = events.find((e) => e.type === "assistant.text");
    expect(final?.type).toBe("assistant.text");
    if (final?.type !== "assistant.text") return;
    const streamed = events
      .filter((e) => e.type === "assistant.delta" && e.messageId === final.messageId && e.index === final.index)
      .map((e) => (e.type === "assistant.delta" ? e.text : ""))
      .join("");
    expect(streamed).toBe(final.text);
  });

  it("emits thinking once per message and a final turn result with usage", () => {
    expect(types.filter((t) => t === "assistant.thinking")).toHaveLength(1);
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "turn.result", subtype: "success", isError: false });
    if (result?.type === "turn.result") expect(result.outputTokens).toBeGreaterThan(0);
  });

  it("keeps rate limit info", () => {
    expect(events.find((e) => e.type === "rate_limit")).toMatchObject({ status: "allowed", limitType: "five_hour", utilization: 0 });
  });

  it("reads utilization as percent and marks requests served from extra usage", () => {
    const [ev] = new Normalizer().normalize({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1791661200, rateLimitType: "seven_day", isUsingOverage: true, unifiedWindows: { seven_day: { utilization: 0.97 } } },
    });
    expect(ev).toEqual({ type: "rate_limit", status: "rejected", resetsAt: 1791661200, limitType: "seven_day", utilization: 97, overageInUse: true });
  });
});

describe("Normalizer robustness", () => {
  it("ignores malformed and unknown messages", () => {
    const n = new Normalizer();
    expect(n.normalize(null)).toEqual([]);
    expect(n.normalize("garbage")).toEqual([]);
    expect(n.normalize({ type: "something_new", foo: 1 })).toEqual([]);
    expect(n.normalize({ type: "assistant", message: { content: "not-an-array" } })).toEqual([]);
    expect(n.normalize({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual([
      { type: "tool.result", toolUseId: "", isError: false, content: { text: "", truncated: false } },
    ]);
  });

  it("truncates huge tool results", () => {
    const n = new Normalizer();
    const [ev] = n.normalize({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(30_000) }] },
    });
    expect(ev).toMatchObject({ type: "tool.result", content: { truncated: true } });
    if (ev?.type === "tool.result") expect(ev.content.text.length).toBe(20_000);
  });

  it("shortens large string fields of tool inputs and flags it", () => {
    const n = new Normalizer();
    const [ev] = n.normalize({
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "big.txt", content: "y".repeat(50_000) } }] },
    });
    expect(ev).toMatchObject({ type: "tool.use", inputTruncated: true, input: { file_path: "big.txt" } });
    if (ev?.type === "tool.use") expect((ev.input.content as string).length).toBeLessThan(MAX_INPUT_STRING + 50);
    const [small] = n.normalize({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a" } }] } });
    expect(small).not.toHaveProperty("inputTruncated");
  });

  it("shortens nested strings, e.g. MultiEdit edits", () => {
    const { input, truncated } = truncateInput({ edits: [{ old_string: "a", new_string: "b".repeat(30_000) }] }, 100);
    expect(truncated).toBe(true);
    expect(((input.edits as Array<{ new_string: string }>)[0]!.new_string).length).toBeLessThan(150);
  });

  it("marks subagent text and tool uses with the Agent call they belong to", () => {
    const n = new Normalizer();
    const out = n.normalize({
      type: "assistant",
      parent_tool_use_id: "parent1",
      message: { id: "m1", content: [{ type: "text", text: "inner" }, { type: "tool_use", id: "t2", name: "Grep", input: {} }] },
    });
    expect(out).toEqual([
      { type: "assistant.text", messageId: "m1", index: 0, text: "inner", parentToolUseId: "parent1" },
      { type: "tool.use", toolUseId: "t2", name: "Grep", input: {}, parentToolUseId: "parent1" },
    ]);
    // Their deltas never stream into the main chat.
    expect(n.normalize({ type: "stream_event", parent_tool_use_id: "parent1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } })).toEqual([]);
  });

  it("reports error results", () => {
    const n = new Normalizer();
    const [ev] = n.normalize({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] });
    expect(ev).toMatchObject({ type: "turn.result", isError: true, text: "boom" });
  });
});

describe("Normalizer compaction", () => {
  it("turns a compact boundary into a context.compacted event", () => {
    const n = new Normalizer();
    expect(n.normalize({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 170000 } })).toEqual([
      { type: "context.compacted", trigger: "auto", preTokens: 170000, postTokens: null },
    ]);
  });
});
