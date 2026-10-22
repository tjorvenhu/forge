import { describe, expect, it } from "vitest";
import type { ModelTokens, PlanUsage, UsageWindow } from "@forge/protocol";
import { sessionShare, sessionUsage, type UsageCall } from "../src/claude/session-usage.js";
import type { UsageSample } from "../src/claude/usage-forecast.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const RESET = Date.parse("2026-10-22T15:00:00Z");
const START = RESET - 5 * HOUR;
const at = (minutes: number) => START + minutes * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

const window: UsageWindow = { key: "five_hour", label: "5 Stunden", utilization: 30, resetsAt: iso(RESET) };

function sample(minutes: number, utilization: number, key = "five_hour"): UsageSample {
  return { key, resetsAt: RESET, at: at(minutes), utilization };
}

function model(costUsd: number, tokens = 1000): ModelTokens {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: tokens, cacheWriteTokens: 0, costUsd };
}

function call(minutes: number, sessionId: string | null, models: Record<string, ModelTokens>, durationMinutes = 0): UsageCall {
  return { at: at(minutes), sessionId, durationMs: durationMinutes * MIN, models, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

describe("sessionShare", () => {
  it("shares each rise by the cost of the calls since the previous one", () => {
    const samples = [sample(10, 10), sample(20, 30)];
    const calls = [call(5, "a", { "claude-opus-5-5": model(3) }), call(6, "b", { "claude-opus-5-5": model(1) }), call(15, "a", { "claude-opus-5-5": model(2) })];
    // 0 → 10 by a (3) and b (1); 10 → 30 by a alone
    expect(sessionShare(window, samples, calls, "a", at(30)).share).toBe(27.5);
    expect(sessionShare(window, samples, calls, "b", at(30)).share).toBe(2.5);
  });

  it("leaves a rise without FORGE calls to the rest of the account", () => {
    const samples = [sample(10, 10), sample(20, 25)];
    const calls = [call(5, "a", { "claude-opus-5-5": model(1) })];
    expect(sessionShare(window, samples, calls, "a", at(30)).share).toBe(10);
  });

  it("carries calls over a reading without a rise to the next one", () => {
    const samples = [sample(10, 0), sample(20, 4)];
    const calls = [call(5, "a", { "claude-opus-5-5": model(1) }), call(15, "b", { "claude-opus-5-5": model(1) })];
    expect(sessionShare(window, samples, calls, "a", at(30)).share).toBe(2);
  });

  it("counts calls after the last reading at the window's rate so far", () => {
    const samples = [sample(10, 10)];
    const calls = [call(5, "b", { "claude-opus-5-5": model(2) }), call(20, "a", { "claude-opus-5-5": model(1) })];
    expect(sessionShare(window, samples, calls, "a", at(30)).share).toBe(5);
  });

  it("ignores readings and calls of other windows and from before the window", () => {
    const samples = [sample(10, 10), { ...sample(20, 50), resetsAt: RESET + HOUR }, sample(20, 80, "seven_day")];
    const calls = [call(-10, "a", { "claude-opus-5-5": model(5) }), call(5, "a", { "claude-opus-5-5": model(1) })];
    expect(sessionShare(window, samples, calls, "a", at(30))).toEqual({ share: 10, tokens: 1000 });
  });

  it("counts only the window's model in a model window", () => {
    const opus: UsageWindow = { key: "seven_day_opus", label: "Woche Opus", utilization: 10, resetsAt: iso(RESET) };
    const samples = [sample(10, 10, "seven_day_opus")];
    const calls = [call(5, "a", { "claude-sonnet-5-5": model(9, 500) }), call(6, "b", { "claude-opus-5-5": model(1) }), call(7, "a", { "claude-opus-5-5": model(1, 200) })];
    expect(sessionShare(opus, samples, calls, "a", at(30))).toEqual({ share: 5, tokens: 200 });
  });

  it("spreads a long turn over the readings it ran through", () => {
    // a ran from minute 0 to 40 and was written at its end; b only between 10 and 20
    const samples = [sample(10, 10), sample(20, 30), sample(30, 40), sample(40, 50)];
    const calls = [call(40, "a", { "claude-opus-5-5": model(4) }, 40), call(20, "b", { "claude-opus-5-5": model(1) })];
    expect(sessionShare(window, samples, calls, "a", at(45)).share).toBe(40);
    expect(sessionShare(window, samples, calls, "b", at(45)).share).toBe(10);
  });

  it("leaves the part of a turn before the window to the previous one", () => {
    const samples = [sample(10, 10)];
    const calls = [call(10, "a", { "claude-opus-5-5": model(2) }, 20), call(10, "b", { "claude-opus-5-5": model(1) })];
    // a: half of its cost falls into the window
    expect(sessionShare(window, samples, calls, "a", at(30)).share).toBe(5);
  });

  it("weighs rows without model costs by their tokens", () => {
    const samples = [sample(10, 12)];
    const calls: UsageCall[] = [
      { at: at(5), sessionId: "a", durationMs: 0, models: null, inputTokens: 0, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { at: at(6), sessionId: "b", durationMs: 0, models: null, inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ];
    expect(sessionShare(window, samples, calls, "a", at(30)).share).toBe(10);
  });
});

describe("sessionUsage", () => {
  const totals = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5, turns: 2 };

  it("adds the windows with a reset time", () => {
    const plan: PlanUsage = { available: true, subscriptionType: "max", windows: [window, { key: "x", label: "X", utilization: 1, resetsAt: null }], fetchedAt: iso(at(30)), error: null };
    const u = sessionUsage(totals, plan, [sample(10, 10)], [call(5, "a", { "claude-opus-5-5": model(1) })], "a", at(30));
    expect(u.totalTokens).toBe(10);
    expect(u.windows).toEqual([{ key: "five_hour", label: "5 Stunden", utilization: 30, resetsAt: iso(RESET), share: 10, tokens: 1000 }]);
    expect(u.planError).toBeNull();
  });

  it("names why there are no windows without plan usage", () => {
    const plan: PlanUsage = { available: false, subscriptionType: null, windows: [], fetchedAt: iso(at(30)), error: "kein Abo" };
    expect(sessionUsage(totals, plan, [], [], "a", at(30))).toMatchObject({ windows: [], planError: "kein Abo" });
  });
});
