import { describe, expect, it } from "vitest";
import { formats } from "./format";

// Intl puts a no-break space between number and unit.
const norm = (s: string) => s.replace(/ /g, " ");
const de = formats("de");
const en = formats("en");

describe("count", () => {
  it("writes small numbers in full with the separators of the language", () => {
    expect(de.count(0)).toBe("0");
    expect(de.count(12345)).toBe("12.345");
    expect(en.count(12345)).toBe("12,345");
  });

  it("abbreviates from a million", () => {
    expect(norm(de.count(1_234_567))).toBe("1,2 Mio.");
    expect(norm(de.count(1_200_000_000))).toBe("1,2 Mrd.");
    expect(norm(de.count(3e12))).toBe("3 Bio.");
    expect(en.count(1_234_567)).toBe("1.2M");
    expect(en.count(1_200_000_000)).toBe("1.2B");
    expect(en.count(3e12)).toBe("3T");
  });
});

describe("hours", () => {
  it("converts milliseconds to hours", () => {
    expect(de.hours(5_400_000)).toBe("1,5");
    expect(de.hours(36_000_000 * 123.4)).toBe("1.234");
    expect(en.hours(5_400_000)).toBe("1.5");
  });
});

describe("usd", () => {
  it("writes cents as dollars", () => {
    expect(norm(de.usd(345))).toBe("3,45 $");
    expect(norm(de.usd(240_000))).toBe("2.400 $");
    expect(norm(de.usd(123_456_789))).toBe("1,2 Mio. $");
    expect(en.usd(345)).toBe("$3.45");
    expect(en.usd(240_000)).toBe("$2,400");
    expect(en.usd(123_456_789)).toBe("$1.2M");
  });
});

describe("percent", () => {
  it("rounds the share", () => {
    expect(norm(de.percent(45, 100))).toBe("45 %");
    expect(en.percent(45, 100)).toBe("45%");
    expect(en.percent(1, 0)).toBe("0%");
  });
});

describe("day labels", () => {
  it("formats UTC days", () => {
    expect(de.dayShort("2026-10-18")).toBe("18.10.");
    expect(de.dayLong("2026-10-18")).toBe("So., 18. Okt.");
    expect(en.dayShort("2026-10-18")).toBe("10/18");
    expect(en.dayLong("2026-10-18")).toBe("Sun, Oct 18");
  });

  it("names the time zone only in English", () => {
    expect(de.dateTime("2026-10-18T12:30:00Z")).toBe("18.10.2026, 14:30");
    expect(norm(en.dateTime("2026-10-18T12:30:00Z"))).toBe("Oct 18, 2026, 2:30 PM GMT+2");
  });
});
