import { describe, expect, it } from "vitest";
import { groupModels, modelLabel } from "./models";
import { compareVersions, newestVersion } from "./versions";

describe("modelLabel", () => {
  it("names current model IDs", () => {
    expect(modelLabel("claude-opus-4-7")).toBe("Opus 4.7");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-opus-4-7[1m]")).toBe("Opus 4.7");
    expect(modelLabel("claude-opus-5-5[1M]")).toBe("Opus 5.5");
  });

  it("names legacy and provider-prefixed IDs", () => {
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelLabel("claude-3-opus-20240229")).toBe("Opus 3");
    expect(modelLabel("us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe("Opus 4.1");
  });

  it("keeps unknown IDs as they are", () => {
    expect(modelLabel("gpt-5")).toBe("gpt-5");
    expect(modelLabel("claude-opusx-4")).toBe("claude-opusx-4");
    expect(modelLabel("<synthetic>")).toBe("<synthetic>");
  });
});

describe("groupModels", () => {
  it("merges IDs of one model and sorts by tokens", () => {
    expect(
      groupModels({
        "claude-haiku-4-5": { tokens: 5, costUsdCents: 1 },
        "claude-sonnet-4-5": { tokens: 10, costUsdCents: 2 },
        "claude-sonnet-4-5-20250929": { tokens: 3, costUsdCents: 4 },
        "claude-sonnet-4-5[1m]": { tokens: 2, costUsdCents: 1 },
        "claude-opus-4-7": { tokens: 0, costUsdCents: 0 },
      }),
    ).toEqual([
      { label: "Sonnet 4.5", tokens: 15, costUsdCents: 7 },
      { label: "Haiku 4.5", tokens: 5, costUsdCents: 1 },
    ]);
  });
});

describe("compareVersions", () => {
  it("orders numerically and puts releases above pre-releases", () => {
    expect(compareVersions("0.1.80", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(compareVersions("0.1.80+build.1", "0.1.80")).toBe(0);
  });

  it("finds the newest version independent of the order", () => {
    expect(newestVersion([{ version: "0.1.79", installs: 9 }, { version: "0.1.81", installs: 1 }, { version: "0.1.80", installs: 4 }])).toBe("0.1.81");
    expect(newestVersion([])).toBeNull();
  });
});
