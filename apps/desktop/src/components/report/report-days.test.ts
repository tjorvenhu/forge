import { describe, expect, it } from "vitest";
import { dayLabel, dayOptions, localDay, shiftDay } from "./report-days";

describe("report days", () => {
  it("counts days in local time, across months and years", () => {
    expect(localDay(new Date(2026, 9, 16, 23, 59))).toBe("2026-10-16");
    expect(shiftDay("2026-10-01", -1)).toBe("2026-09-30");
    expect(shiftDay("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("names today and yesterday, other days by weekday and date", () => {
    expect(dayLabel("2026-10-16", "2026-10-16")).toBe("Heute");
    expect(dayLabel("2026-10-15", "2026-10-16")).toBe("Gestern");
    expect(dayLabel("2026-10-14", "2026-10-16")).toBe("Mi., 14.10.");
    expect(dayLabel("2025-12-30", "2026-01-02")).toContain("2025");
  });

  it("offers the last days and keeps an older selected one", () => {
    const opts = dayOptions("2026-10-16", "2026-10-16", 3);
    expect(opts.map((o) => o.value)).toEqual(["2026-10-16", "2026-10-15", "2026-10-14"]);
    expect(dayOptions("2026-10-16", "2026-08-01", 3).at(-1)?.value).toBe("2026-08-01");
  });
});
