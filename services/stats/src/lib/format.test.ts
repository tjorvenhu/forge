import { describe, expect, it } from "vitest";
import { formatCount, formatDayLong, formatDayShort, formatHours, formatUsd } from "./format";

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

describe("formatUsd", () => {
  it("writes cents as dollars", () => {
    expect(norm(formatUsd(345))).toBe("3,45 $");
    expect(norm(formatUsd(240_000))).toBe("2.400 $");
    expect(norm(formatUsd(123_456_789))).toBe("1,2 Mio. $");
  });
});

describe("day labels", () => {
  it("formats UTC days", () => {
    expect(formatDayShort("2026-10-18")).toBe("18.10.");
    expect(formatDayLong("2026-10-18")).toBe("So., 18. Okt.");
  });
});
