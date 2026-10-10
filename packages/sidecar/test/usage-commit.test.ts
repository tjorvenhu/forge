import { describe, expect, it } from "vitest";
import { toPlanUsage } from "../src/claude/usage.js";
import { buildCommitPrompt, cleanCommitMessage } from "../src/git/commit-message.js";

describe("toPlanUsage", () => {
  it("keeps documented windows and model-scoped rows, ignores unknown keys", () => {
    const u = toPlanUsage({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 17.4, resets_at: "2026-10-10T19:40:00Z" },
        seven_day: { utilization: 36, resets_at: "2026-10-12T05:00:00Z" },
        seven_day_opus: null,
        iguana_necktie: { utilization: 0, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 31, resets_at: "2026-10-12T05:00:00Z" }],
      },
    });
    expect(u.available).toBe(true);
    expect(u.subscriptionType).toBe("max");
    expect(u.windows.map((w) => [w.key, w.label, w.utilization])).toEqual([
      ["five_hour", "5 Stunden", 17],
      ["seven_day", "Woche", 36],
      ["model:Fable", "Woche Fable", 31],
    ]);
  });

  it("reports unavailable for API-key sessions or garbage", () => {
    expect(toPlanUsage({ rate_limits_available: false, rate_limits: null }).available).toBe(false);
    expect(toPlanUsage(null)).toMatchObject({ available: false, windows: [] });
  });
});

describe("commit message prompt", () => {
  const diff = {
    path: "src/a.ts",
    binary: false,
    additions: 1,
    deletions: 0,
    truncated: false,
    lines: [
      { kind: "hunk" as const, text: "@@ -1 +1,2 @@", oldNo: null, newNo: null },
      { kind: "add" as const, text: 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";', oldNo: null, newNo: 1 },
    ],
  };

  it("includes history style, skipped files and redacts secrets", () => {
    const p = buildCommitPrompt([diff], ["feat: login", "fix: typo"], [".env"]);
    expect(p).toContain("- feat: login");
    expect(p).toContain("Nicht mitgeschickt (sensible Dateien): .env");
    expect(p).toContain("--- src/a.ts");
    expect(p).not.toContain("ghp_abc");
  });

  it("falls back to conventional commits without history", () => {
    expect(buildCommitPrompt([diff], [], [])).toContain("Conventional Commits");
  });

  it("cleans fences, labels and quotes", () => {
    expect(cleanCommitMessage("```\nfeat: x\n```")).toBe("feat: x");
    expect(cleanCommitMessage('Commit-Nachricht: "fix: y"')).toBe("fix: y");
    expect(cleanCommitMessage("feat: z\n\n\n- a\n- b\n")).toBe("feat: z\n\n- a\n- b");
  });
});
