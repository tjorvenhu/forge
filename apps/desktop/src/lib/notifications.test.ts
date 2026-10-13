import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEventBody } from "@forge/protocol";
import { notifyKind, shouldNotify } from "./notifications";

const turn = (isError: boolean, subtype: string, text: string | null): SessionEventBody =>
  ({ type: "turn.result", subtype, isError, text, durationMs: 1, numTurns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null }) as SessionEventBody;

describe("notifyKind", () => {
  it("announces approvals and errors, but neither stopped turns nor finished ones (session.done does that)", () => {
    expect(notifyKind({ type: "error", message: "kaputt", retryable: false } as SessionEventBody)).toBe("error");
    expect(notifyKind(turn(false, "success", "ok"))).toBeNull();
    expect(notifyKind(turn(true, "error_max_turns", "Limit"))).toBe("error");
    expect(notifyKind(turn(true, "error_during_execution", "Request interrupted by user"))).toBeNull();
    expect(notifyKind({ type: "user.message", text: "hi" })).toBeNull();
  });
});

describe("shouldNotify", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("signals once per session and kind within three seconds", () => {
    vi.setSystemTime(new Date("2026-10-11T10:00:00Z"));
    expect(shouldNotify("n1", "error")).toBe(true);
    expect(shouldNotify("n1", "error")).toBe(false);
    expect(shouldNotify("n1", "done")).toBe(true);
    expect(shouldNotify("n2", "error")).toBe(true);
    vi.setSystemTime(new Date("2026-10-11T10:00:04Z"));
    expect(shouldNotify("n1", "error")).toBe(true);
  });

  it("keeps a burst of replayed results quiet as long as it lasts", () => {
    vi.setSystemTime(new Date("2026-10-11T11:00:00Z"));
    expect(shouldNotify("n3", "done")).toBe(true);
    vi.setSystemTime(new Date("2026-10-11T11:00:02Z"));
    expect(shouldNotify("n3", "done")).toBe(false);
    vi.setSystemTime(new Date("2026-10-11T11:00:04Z"));
    expect(shouldNotify("n3", "done")).toBe(false);
  });
});
