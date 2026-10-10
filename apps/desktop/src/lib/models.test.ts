import { describe, expect, it } from "vitest";
import { findModel, modelLabel, prettyModel } from "./models";

const models = [
  { value: "default", displayName: "Default (recommended)" },
  { value: "opus", displayName: "Opus 5.5" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];

describe("model names", () => {
  it("uses Claude Code's display names for aliases", () => {
    expect(modelLabel("opus", models)).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-5-5", models)).toBe("Sonnet 5.5");
    expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("finds the model entry for aliases, resolved IDs and the default", () => {
    expect(findModel("claude-opus-5-5", models)?.value).toBe("opus");
    expect(findModel(null, models)?.value).toBe("default");
    expect(findModel("claude-unknown-9", models)).toBeUndefined();
  });
});
