import { describe, expect, it } from "vitest";
import { planLabel, sortPlans } from "./plans";

describe("planLabel", () => {
  it("names the plans", () => {
    expect(planLabel("max_20x")).toBe("Max 20x");
    expect(planLabel("max_5x")).toBe("Max 5x");
    expect(planLabel("max")).toBe("Max");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("team_premium")).toBe("Team Premium");
    expect(planLabel(null)).toBe("Unbekannt");
  });
});

describe("sortPlans", () => {
  it("puts the unknown plan last", () => {
    expect(
      sortPlans([
        { plan: null, installs: 9, online: 1 },
        { plan: "pro", installs: 2, online: 0 },
        { plan: "max_20x", installs: 5, online: 2 },
      ]).map((p) => p.plan),
    ).toEqual(["max_20x", "pro", null]);
  });
});
