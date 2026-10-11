import { describe, expect, it } from "vitest";
import { isBusy, isInterrupted, isWorking } from "./working";

describe("session working state", () => {
  it("counts stopping as working, but not waiting for an approval", () => {
    expect(isWorking("starting")).toBe(true);
    expect(isWorking("running")).toBe(true);
    expect(isWorking("stopping")).toBe(true);
    expect(isWorking("waiting_approval")).toBe(false);
    expect(isWorking("idle")).toBe(false);
    expect(isWorking(null)).toBe(false);
    expect(isWorking(undefined)).toBe(false);
  });

  it("treats waiting for the user as busy", () => {
    expect(isBusy("waiting_approval")).toBe(true);
    expect(isBusy("stopping")).toBe(true);
    expect(isBusy("idle")).toBe(false);
    expect(isBusy("error")).toBe(false);
  });
});

describe("interrupted turns", () => {
  it("recognises stops in English and German, only for failed turns", () => {
    expect(isInterrupted({ isError: true, subtype: "error_during_execution", text: "Request interrupted by user" })).toBe(true);
    expect(isInterrupted({ isError: true, subtype: "aborted", text: null })).toBe(true);
    expect(isInterrupted({ isError: true, subtype: "error", text: "Von FORGE abgebrochen" })).toBe(true);
    expect(isInterrupted({ isError: true, subtype: "error_max_turns", text: "Limit erreicht" })).toBe(false);
    expect(isInterrupted({ isError: false, subtype: "success", text: "interrupt handler added" })).toBe(false);
  });
});
