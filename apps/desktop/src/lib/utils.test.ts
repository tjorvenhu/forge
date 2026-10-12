import { describe, expect, it } from "vitest";
import { planLabel } from "./utils";

describe("planLabel", () => {
  it("names the Max tier when Claude Code knows it", () => {
    expect(planLabel({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })).toBe("Max 20x Abo");
    expect(planLabel({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })).toBe("Max 5x Abo");
  });

  it("falls back to the plan alone", () => {
    expect(planLabel({ subscriptionType: "max", rateLimitTier: null })).toBe("Max Abo");
    expect(planLabel({ subscriptionType: "pro", rateLimitTier: "default_claude_ai" })).toBe("Pro Abo");
    expect(planLabel({ subscriptionType: null, rateLimitTier: null })).toBeNull();
  });
});
