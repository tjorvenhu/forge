import { describe, expect, it } from "vitest";
import { RATE_WINDOW_MS, TokenMeter } from "../src/claude/token-meter.js";

const perWindow = (tokens: number) => tokens / (RATE_WINDOW_MS / 1000);
const stream = (event: Record<string, unknown>, parent: string | null = null) => ({ type: "stream_event", parent_tool_use_id: parent, event });
const textDelta = (text: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const messageDelta = (output: number) => ({ type: "message_delta", delta: {}, usage: { output_tokens: output } });

describe("TokenMeter", () => {
  it("estimates while a message streams and corrects to the reported count at its end", () => {
    const m = new TokenMeter();
    m.observe("s1", stream({ type: "message_start", message: {} }), 0);
    m.observe("s1", stream(textDelta("x".repeat(40))), 100);
    expect(m.rate(200)).toBeCloseTo(perWindow(10));
    m.observe("s1", stream(messageDelta(25)), 300);
    expect(m.rate(400)).toBeCloseTo(perWindow(25));
    // the full assistant message of a streamed answer is not counted again
    m.observe("s1", { type: "assistant", message: { id: "m1", usage: { output_tokens: 25 } } }, 500);
    expect(m.rate(600)).toBeCloseTo(perWindow(25));
  });

  it("adds parallel streams: subagents and other sessions", () => {
    const m = new TokenMeter();
    m.observe("s1", stream(messageDelta(30)), 0);
    m.observe("s1", stream(messageDelta(20), "task-1"), 0);
    m.observe("s2", stream(messageDelta(10)), 0);
    expect(m.rate(100)).toBeCloseTo(perWindow(60));
  });

  it("counts assistant messages once per id when nothing streams, and a bare result as a last resort", () => {
    const m = new TokenMeter();
    m.observe("c1", { type: "assistant", message: { id: "m1", usage: { output_tokens: 8 } } }, 0);
    m.observe("c1", { type: "assistant", message: { id: "m1", usage: { output_tokens: 12 } } }, 0);
    m.observe("c1", { type: "result", usage: { output_tokens: 12 } }, 0);
    m.observe("c2", { type: "result", usage: { output_tokens: 5 } }, 0);
    expect(m.rate(100)).toBeCloseTo(perWindow(17));
  });

  it("drops tokens older than the window", () => {
    const m = new TokenMeter();
    m.observe("s1", stream(messageDelta(40)), 0);
    expect(m.rate(RATE_WINDOW_MS + 1)).toBe(0);
  });
});
