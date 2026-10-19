import { describe, expect, it } from "vitest";
import { COUNTER_KEYS, COUNTER_LIMITS, MAX_BODY_BYTES, MAX_MODELS, MODEL_LIMITS, parseReport, readBodyLimited } from "./report";

const ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

function body(overrides: Record<string, unknown> = {}, counters: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: 1,
    installId: ID,
    appVersion: "0.1.80",
    os: "Windows 10.0.26200",
    counters: { tokensInput: 100, tokensOutput: 50, sessions: 3, ...counters },
    ...overrides,
  });
}

function expectError(raw: string, status = 400) {
  const r = parseReport(raw);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.status).toBe(status);
}

describe("parseReport", () => {
  it("accepts a valid report and fills missing counters with 0", () => {
    const r = parseReport(body());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.installId).toBe(ID);
    expect(Object.keys(r.report.counters).sort()).toEqual([...COUNTER_KEYS].sort());
    expect(r.report.counters.tokensInput).toBe(100);
    expect(r.report.counters.phoneCalls).toBe(0);
  });

  it("ignores unknown counters and unknown top-level keys", () => {
    const r = parseReport(body({ extra: "x" }, { futureCounter: 5, weird: "text" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.counters).not.toHaveProperty("futureCounter");
    expect(r.report).not.toHaveProperty("extra");
  });

  it("normalizes the install ID to lower case", () => {
    const r = parseReport(body({ installId: ID.toUpperCase() }));
    expect(r.ok && r.report.installId).toBe(ID);
  });

  it("rejects malformed JSON and wrong schema versions", () => {
    expectError("{not json");
    expectError(body({ schema: 2 }));
    expectError(JSON.stringify({ installId: ID }));
  });

  it("rejects install IDs that are not UUID v4", () => {
    expectError(body({ installId: "not-a-uuid" }));
    expectError(body({ installId: "3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b" }));
  });

  it("checks appVersion and os", () => {
    expect(parseReport(body({ appVersion: "1.2.3-beta.1+build.5" })).ok).toBe(true);
    expectError(body({ appVersion: "" }));
    expectError(body({ appVersion: "1".repeat(33) }));
    expectError(body({ appVersion: "1.0 beta" }));
    expectError(body({ appVersion: "<script>" }));
    expect(parseReport(body({ os: "x".repeat(64) })).ok).toBe(true);
    expectError(body({ os: "x".repeat(65) }));
    expectError(body({ os: "Windows\n10" }));
  });

  it("rejects negative, fractional and non-numeric counters", () => {
    expectError(body({}, { sessions: -1 }));
    expectError(body({}, { sessions: 1.5 }));
    expectError(body({}, { sessions: "3" }));
    expectError(body({}, { sessions: null }));
  });

  it("enforces the per-installation ceilings", () => {
    for (const key of COUNTER_KEYS) {
      const max = COUNTER_LIMITS[key];
      expect(parseReport(body({}, { [key]: max })).ok, key).toBe(true);
      expectError(body({}, { [key]: max + 1 }));
    }
    expect(COUNTER_LIMITS.tokensInput).toBe(1e12);
    expect(COUNTER_LIMITS.claudeWorkMs).toBe(1e11);
    expect(COUNTER_LIMITS.phoneCalls).toBe(1e7);
    expect(COUNTER_LIMITS.userTurns).toBe(1e7);
    expect(COUNTER_LIMITS.costUsdCents).toBe(1e10);
  });

  it("accepts the counters userTurns and costUsdCents", () => {
    const r = parseReport(body({}, { userTurns: 12, costUsdCents: 240_000 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.counters.userTurns).toBe(12);
    expect(r.report.counters.costUsdCents).toBe(240_000);
  });

  it("accepts reports of older app versions without the new fields", () => {
    const r = parseReport(body());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.counters.userTurns).toBe(0);
    expect(r.report.counters.costUsdCents).toBe(0);
    expect(r.report.models).toEqual({});
  });

  it("accepts models per model ID", () => {
    const models = { "claude-opus-4-7": { tokens: 123, costUsdCents: 45 }, "claude-sonnet-4-5[1m]": { tokens: 0, costUsdCents: 0 }, "us.anthropic.claude-haiku-4-5-20251001-v1:0": { tokens: 1, costUsdCents: 0 } };
    const r = parseReport(body({ models }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.models).toEqual(models);
  });

  it("checks model IDs and values", () => {
    const m = (id: string, v: unknown = { tokens: 1, costUsdCents: 1 }) => body({ models: { [id]: v } });
    expect(parseReport(m("x".repeat(64))).ok).toBe(true);
    expectError(m("x".repeat(65)));
    expectError(m(""));
    expectError(m("claude opus"));
    expectError(m("<script>"));
    expectError(m("claude-opus-4-7", { tokens: -1, costUsdCents: 0 }));
    expectError(m("claude-opus-4-7", { tokens: 1.5, costUsdCents: 0 }));
    expectError(m("claude-opus-4-7", { tokens: 1 }));
    expectError(m("claude-opus-4-7", { tokens: MODEL_LIMITS.tokens + 1, costUsdCents: 0 }));
    expectError(m("claude-opus-4-7", { tokens: 0, costUsdCents: MODEL_LIMITS.costUsdCents + 1 }));
    expect(parseReport(m("claude-opus-4-7", { tokens: MODEL_LIMITS.tokens, costUsdCents: MODEL_LIMITS.costUsdCents })).ok).toBe(true);
    expectError(body({ models: [] }));
    expectError(body({ models: "x" }));
  });

  it("allows at most 20 models", () => {
    const models = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, { tokens: 1, costUsdCents: 1 }]));
    expect(MAX_MODELS).toBe(20);
    expect(parseReport(body({ models: models(20) })).ok).toBe(true);
    expectError(body({ models: models(21) }));
  });

  it("takes the plan as a short lowercase name, null when missing", () => {
    const plan = (v: unknown) => parseReport(body({ plan: v }));
    const ok = plan("max_20x");
    expect(ok.ok && ok.report.plan).toBe("max_20x");
    const missing = parseReport(body({}));
    expect(missing.ok && missing.report.plan).toBeNull();
    expect(plan(null).ok).toBe(true);
    expectError(body({ plan: "Max 20x" }));
    expectError(body({ plan: "x".repeat(25) }));
    expectError(body({ plan: 5 }));
  });

  it("takes the interface language as two lowercase letters, null when missing", () => {
    const ok = parseReport(body({ language: "de" }));
    expect(ok.ok && ok.report.language).toBe("de");
    const missing = parseReport(body({}));
    expect(missing.ok && missing.report.language).toBeNull();
    expect(parseReport(body({ language: null })).ok).toBe(true);
    expectError(body({ language: "DE" }));
    expectError(body({ language: "deu" }));
  });

  it("fits the largest valid report into the body limit", () => {
    const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, COUNTER_LIMITS[k]]));
    const models = Object.fromEntries(Array.from({ length: MAX_MODELS }, (_, i) => [`m${i}`.padEnd(64, "x"), { tokens: MODEL_LIMITS.tokens, costUsdCents: MODEL_LIMITS.costUsdCents }]));
    const raw = body({ appVersion: "1".repeat(32), os: "x".repeat(64), counters, models, plan: "x".repeat(24), language: "xx" });
    expect(parseReport(raw).ok).toBe(true);
  });

  it("rejects bodies over 4 KB with 413", () => {
    expectError(body({ os: "x" }) + " ".repeat(MAX_BODY_BYTES), 413);
  });
});

describe("readBodyLimited", () => {
  it("returns the body when it fits", async () => {
    const req = new Request("http://x", { method: "POST", body: "hello" });
    expect(await readBodyLimited(req)).toBe("hello");
  });

  it("returns null for an oversized body", async () => {
    const req = new Request("http://x", { method: "POST", body: "a".repeat(MAX_BODY_BYTES + 1) });
    expect(await readBodyLimited(req)).toBeNull();
  });

  it("trusts a too-large Content-Length without reading", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: "small",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    });
    expect(await readBodyLimited(req)).toBeNull();
  });
});
