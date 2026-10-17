import { describe, expect, it } from "vitest";
import { COUNTER_KEYS, COUNTER_LIMITS, MAX_BODY_BYTES, parseReport, readBodyLimited } from "./report";

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
