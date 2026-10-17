import { describe, expect, it } from "vitest";
import { REPORT_INTERVAL_MINUTES } from "./db";

describe("REPORT_INTERVAL_MINUTES", () => {
  // The app reports every 5 minutes; a lock as long as that would reject every second report
  // whenever a timer fires a little early.
  it("is 4 minutes, a minute below the app's interval", () => {
    expect(REPORT_INTERVAL_MINUTES).toBe(4);
    expect(REPORT_INTERVAL_MINUTES).toBeLessThan(5);
  });
});
