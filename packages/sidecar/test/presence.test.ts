import { describe, expect, it } from "vitest";
import { IDLE_AFTER_MS, Presence } from "../src/util/presence.js";

describe("presence", () => {
  it("counts the user as there only with the window active and recent input", () => {
    let now = 1_000_000;
    const p = new Presence(() => now);
    expect(p.isPresent()).toBe(false);
    p.report("main", true, true);
    expect(p.isPresent()).toBe(true);
    // Away from the desk with FORGE still in front: calls are wanted again.
    now += IDLE_AFTER_MS;
    expect(p.isPresent()).toBe(false);
    p.report("main", true, true);
    p.report("main", false, false);
    expect(p.isPresent()).toBe(false);
  });

  it("stays present while any window has the focus, whatever order blur and focus arrive in", () => {
    const p = new Presence(() => 1_000_000);
    p.report("main", true, true);
    // Into the chat window: its focus arrives before the main window's blur.
    p.report("chat-a", true, true);
    p.report("main", false, false);
    expect(p.isPresent()).toBe(true);
    // The chat window closes: the shell reports it unfocused.
    p.report("chat-a", false, false);
    expect(p.isPresent()).toBe(false);
  });
});
