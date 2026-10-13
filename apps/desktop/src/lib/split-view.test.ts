import { describe, expect, it } from "vitest";
import { MAX_PANES, paneCapacity, paneRows } from "./split-view";

describe("paneCapacity", () => {
  it("fits two above two on a full HD window", () => {
    expect(paneCapacity(1600, 950)).toBe(4);
  });

  it("keeps a small window to the main chat", () => {
    expect(paneCapacity(800, 600)).toBe(1);
    expect(paneCapacity(300, 200)).toBe(1);
  });

  it("stops at the maximum on very large screens", () => {
    expect(paneCapacity(5000, 3000)).toBe(MAX_PANES);
  });
});

describe("paneRows", () => {
  it("puts two chats side by side on a wide area", () => {
    expect(paneRows(2, 1600, 950)).toEqual([2]);
  });

  it("stacks two chats when the area is tall and narrow", () => {
    expect(paneRows(2, 700, 1000)).toEqual([1, 1]);
  });

  it("arranges four chats two above two", () => {
    expect(paneRows(4, 1600, 950)).toEqual([2, 2]);
    expect(paneRows(4, 2250, 1200)).toEqual([2, 2]);
  });

  it("arranges six chats three above three on a large screen", () => {
    expect(paneRows(6, 2250, 1200)).toEqual([3, 3]);
  });

  it("lets the last row hold fewer chats", () => {
    expect(paneRows(3, 1200, 900)).toEqual([2, 1]);
  });

  it("keeps every chat at its minimum size when a grid allows it", () => {
    // Four in a row would be taller, but each chat narrower than the minimum.
    expect(paneRows(4, 1500, 900)).toEqual([2, 2]);
  });
});
