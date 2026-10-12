import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, TOAST_EXIT_MS, useToasts } from "./toast";

const toasts = () => useToasts.getState().toasts;

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("plays the exit before it is removed", () => {
    useToasts.getState().push({ tone: "info", title: "A" });
    const id = toasts()[0]!.id;
    useToasts.getState().dismiss(id);
    expect(toasts()[0]).toMatchObject({ id, leaving: true });
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(toasts()).toEqual([]);
  });

  it("stays while the pointer is on it and closes a moment after it leaves", () => {
    useToasts.getState().push({ tone: "success", title: "B", duration: 1000 });
    const id = toasts()[0]!.id;
    vi.advanceTimersByTime(600);
    useToasts.getState().pause(id);
    vi.advanceTimersByTime(10_000);
    expect(toasts()[0]?.leaving).toBeFalsy();
    useToasts.getState().resume(id);
    vi.advanceTimersByTime(1400);
    expect(toasts()[0]?.leaving).toBeFalsy();
    vi.advanceTimersByTime(100 + TOAST_EXIT_MS);
    expect(toasts()).toEqual([]);
  });

  it("shows one \"Automatisch gespeichert\" for a burst of saves and keeps it up while they go on", () => {
    toast.saved();
    vi.advanceTimersByTime(1500);
    toast.saved();
    toast.saved();
    expect(toasts().filter((t) => t.title === "Automatisch gespeichert")).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(toasts()[0]?.leaving).toBeFalsy();
    vi.advanceTimersByTime(600 + TOAST_EXIT_MS);
    expect(toasts()).toEqual([]);
    toast.saved();
    expect(toasts()).toHaveLength(1);
  });
});
