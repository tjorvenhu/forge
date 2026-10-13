import { describe, expect, it } from "vitest";
import { resetText } from "./Sidebar";

describe("usage reset tooltip", () => {
  const now = new Date("2026-10-13T10:00:00").getTime();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it("says when the limit will be reset, or that it was", () => {
    expect(resetText(at(180), now)).toMatch(/^Wird in 3 Stunden zurückgesetzt \(Di\.?,? 13:00\)$/);
    expect(resetText(at(0.5), now)).toMatch(/^Wird gleich zurückgesetzt/);
    expect(resetText(at(-5), now)).toMatch(/^Wurde vor 5 Minuten zurückgesetzt/);
  });
});
