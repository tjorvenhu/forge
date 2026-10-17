import { describe, expect, it } from "vitest";
import { formatCount, formatHours } from "./format";

// Intl puts a no-break space between number and unit.
const norm = (s: string) => s.replace(/ /g, " ");

describe("formatCount", () => {
  it("writes small numbers in full with German separators", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12345)).toBe("12.345");
  });

  it("abbreviates from a million", () => {
    expect(norm(formatCount(1_234_567))).toBe("1,2 Mio.");
    expect(norm(formatCount(1_200_000_000))).toBe("1,2 Mrd.");
    expect(norm(formatCount(3e12))).toBe("3 Bio.");
  });
});

describe("formatHours", () => {
  it("converts milliseconds to hours", () => {
    expect(formatHours(5_400_000)).toBe("1,5");
    expect(formatHours(36_000_000 * 123.4)).toBe("1.234");
  });
});
