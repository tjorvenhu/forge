import { describe, expect, it } from "vitest";
import { IDLE_AFTER_MS, Presence } from "../src/util/presence.js";

describe("presence", () => {
  it("counts the user as there only with the window active and recent input", () => {
    let now = 1_000_000;
    const p = new Presence(() => now);
    expect(p.isPresent()).toBe(false);
    p.report(true, true);
    expect(p.isPresent()).toBe(true);
    // Away from the desk with FORGE still in front: calls are wanted again.
    now += IDLE_AFTER_MS;
    expect(p.isPresent()).toBe(false);
    p.report(true, true);
    p.report(false, false);
    expect(p.isPresent()).toBe(false);
  });
});
