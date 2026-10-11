import { describe, expect, it } from "vitest";
import { anchoredScrollTop, captureAnchor } from "./scroll-anchor";

const rows = (sizes: number[], keys: string[], paddingStart = 0) => {
  let start = paddingStart;
  return sizes.map((size, i) => {
    const r = { key: keys[i]!, start, end: start + size };
    start += size;
    return r;
  });
};
const byKey = (rs: ReturnType<typeof rows>, key: string) => rs.find((r) => r.key === key);

describe("scroll anchor", () => {
  it("keeps the top row in place when rows are added above it", () => {
    const before = rows([100, 50, 80], ["c", "d", "e"], 44);
    // Scrolled 20px into row "d".
    const anchor = captureAnchor(before, 164);
    expect(anchor).toEqual({ key: "d", offset: -20 });

    const after = rows([72, 72, 100, 50, 80], ["a", "b", "c", "d", "e"], 44);
    expect(anchoredScrollTop(anchor!, byKey(after, "d"))).toBe(164 + 144);
  });

  it("accounts for the button room going away with the last page", () => {
    const anchor = captureAnchor(rows([100, 50], ["c", "d"], 44), 0);
    expect(anchor).toEqual({ key: "c", offset: 44 });
    // Row "c" shows 44px below the top again.
    expect(anchoredScrollTop(anchor!, byKey(rows([72, 100, 50], ["b", "c", "d"], 0), "c"))).toBe(28);
  });

  it("gives up when the row is gone or nothing is shown", () => {
    expect(captureAnchor([], 0)).toBeNull();
    expect(anchoredScrollTop({ key: "x", offset: 0 }, undefined)).toBeNull();
  });
});
