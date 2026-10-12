import { describe, expect, it } from "vitest";
import { Arrivals } from "./arrivals";

describe("arrivals (rows that slide in once)", () => {
  it("never animates what was there on the first show, nor anything before that", () => {
    const a = new Arrivals(250);
    expect(a.isNew("x", 0)).toBe(false);
    a.prime(["a", "b"]);
    expect(a.isNew("a", 10)).toBe(false);
    a.prime(["c"]);
    expect(a.isNew("c", 10)).toBe(true);
  });

  it("keeps a new row new for the window, across re-renders, and not after", () => {
    const a = new Arrivals(250);
    a.prime([]);
    expect(a.isNew("n", 1000)).toBe(true);
    expect(a.isNew("n", 1200)).toBe(true);
    expect(a.isNew("n", 1260)).toBe(false);
    // Scrolled away and back (virtualized): no second animation.
    expect(a.isNew("n", 5000)).toBe(false);
  });
});
