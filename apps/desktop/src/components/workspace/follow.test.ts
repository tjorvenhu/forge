import { describe, expect, it } from "vitest";
import { FollowState } from "./follow";

const VIEW = 500;

describe("FollowState", () => {
  it("keeps following when a scroll it did not cause lands far from the grown end", () => {
    const f = new FollowState();
    f.scrolled(1500, 2000, VIEW, 0);
    // A long tool output arrived; the virtualizer corrects a row height before the follow runs.
    expect(f.scrolled(1520, 2600, VIEW, 10)).toBeNull();
    expect(f.pinned).toBe(true);
  });

  it("keeps following while a smooth jump to the end is overtaken by new content", () => {
    const f = new FollowState(false);
    f.scrolled(0, 3000, VIEW, 0);
    f.pin();
    expect(f.scrolled(800, 3400, VIEW, 5000)).toBeNull();
    expect(f.pinned).toBe(true);
  });

  it("unpins at once on a wheel up and when the user scrolls up otherwise", () => {
    const f = new FollowState();
    f.wheel(-100, 0);
    expect(f.pinned).toBe(false);

    const g = new FollowState();
    g.scrolled(1500, 2000, VIEW, 0);
    g.userInput(100);
    g.scrolled(1300, 2000, VIEW, 150);
    expect(g.pinned).toBe(false);
  });

  it("does not unpin when the user scrolls down while content grows", () => {
    const f = new FollowState();
    f.scrolled(1500, 2000, VIEW, 0);
    f.wheel(100, 100);
    f.scrolled(1560, 2400, VIEW, 120);
    expect(f.pinned).toBe(true);
  });

  it("unpins when the scrollbar is dragged up, and pins again near the end", () => {
    const f = new FollowState();
    f.scrolled(1500, 2000, VIEW, 0);
    f.setDragging(true);
    expect(f.scrolled(200, 2000, VIEW, 10_000)).toBe("far");
    expect(f.pinned).toBe(false);
    expect(f.scrolled(1480, 2000, VIEW, 10_100)).toBe("pinned");
    expect(f.pinned).toBe(true);
  });

  it("ignores scrolls up outside the user's input window", () => {
    const f = new FollowState();
    f.scrolled(1500, 2000, VIEW, 0);
    f.userInput(0);
    f.scrolled(1400, 2000, VIEW, 1000);
    expect(f.pinned).toBe(true);
  });
});
