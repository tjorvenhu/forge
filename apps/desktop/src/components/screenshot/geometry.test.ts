import { describe, expect, it } from "vitest";
import { bigEnough, boundsOf, clampRect, monitorAt, moveWithin, rectFromPoints, resize, toolbarSpot, windowAt } from "./geometry";
import { arrowHead, isLight, isVisible, smoothPath } from "./marks";

const frame = { x: 0, y: 0, width: 3840, height: 1080 };
const left = { x: 0, y: 0, width: 1920, height: 1080 };
const right = { x: 1920, y: 0, width: 1920, height: 1080 };

describe("snipping geometry", () => {
  it("builds selections in any drag direction and cuts them to the frame", () => {
    expect(rectFromPoints({ x: 50, y: 40 }, { x: 10, y: 100 })).toEqual({ x: 10, y: 40, width: 40, height: 60 });
    expect(clampRect({ x: -20, y: 1000, width: 100, height: 200 }, frame)).toEqual({ x: 0, y: 1000, width: 80, height: 80 });
    expect(clampRect({ x: 4000, y: 0, width: 10, height: 10 }, frame)).toBeNull();
    expect(bigEnough({ x: 0, y: 0, width: 3, height: 50 })).toBe(false);
    expect(bigEnough({ x: 0, y: 0, width: 4, height: 4 })).toBe(true);
    expect(boundsOf([{ x: 5, y: 9 }, { x: 1.5, y: 20 }, { x: 8, y: 2 }])).toEqual({ x: 1, y: 2, width: 7, height: 18 });
  });

  it("finds the monitor and the front-most window under the mouse", () => {
    expect(monitorAt([left, right], { x: 2000, y: 10 })).toBe(right);
    // between monitors of different height: the nearest one
    expect(monitorAt([left, { x: 1920, y: 0, width: 1920, height: 600 }], { x: 2500, y: 900 })).toEqual({ x: 1920, y: 0, width: 1920, height: 600 });
    const front = { x: 100, y: 100, width: 400, height: 300 };
    const back = { x: -8, y: -8, width: 1936, height: 1096 };
    expect(windowAt([front, back], { x: 200, y: 200 }, frame)).toEqual(front);
    expect(windowAt([front, back], { x: 10, y: 10 }, frame)).toEqual({ x: 0, y: 0, width: 1928, height: 1080 });
    expect(windowAt([front], { x: 3000, y: 10 }, frame)).toBeNull();
  });

  it("resizes from any handle, flips past the opposite edge and moves only within the frame", () => {
    const r = { x: 100, y: 100, width: 200, height: 100 };
    expect(resize(r, "se", 50, 20)).toEqual({ x: 100, y: 100, width: 250, height: 120 });
    expect(resize(r, "w", 250, 0)).toEqual({ x: 300, y: 100, width: 50, height: 100 });
    expect(resize(r, "n", 0, -30)).toEqual({ x: 100, y: 70, width: 200, height: 130 });
    expect(moveWithin(r, -500, 5000, frame)).toEqual({ x: 0, y: 980, width: 200, height: 100 });
  });

  it("puts the tool bar below the selection, else above, else inside", () => {
    const bar = { width: 400, height: 44 };
    expect(toolbarSpot({ x: 100, y: 100, width: 600, height: 200 }, bar, left, 12)).toEqual({ x: 200, y: 312 });
    expect(toolbarSpot({ x: 100, y: 800, width: 600, height: 270 }, bar, left, 12)).toEqual({ x: 200, y: 744 });
    expect(toolbarSpot(left, bar, left, 12)).toEqual({ x: 760, y: 1024 });
    // near the right edge it stays on the screen
    expect(toolbarSpot({ x: 1800, y: 100, width: 100, height: 100 }, bar, left, 12).x).toBe(1508);
  });
});

describe("snipping marks", () => {
  it("draws smooth strokes and arrows and drops marks that are a mere click", () => {
    expect(smoothPath([{ x: 0, y: 0 }])).toBe("M0 0l0.01 0");
    expect(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }])).toBe("M0 0Q10 0 15 5L20 10");
    const { head } = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(head.startsWith("100,0 ")).toBe(true);
    expect(isVisible({ kind: "pen", color: "red", width: 3, points: [{ x: 1, y: 1 }] }, 4)).toBe(false);
    expect(isVisible({ kind: "arrow", color: "red", width: 3, from: { x: 0, y: 0 }, to: { x: 2, y: 2 } }, 4)).toBe(false);
    expect(isVisible({ kind: "box", color: "red", width: 3, rect: { x: 0, y: 0, width: 30, height: 20 } }, 4)).toBe(true);
    expect(isVisible({ kind: "text", color: "red", size: 20, at: { x: 0, y: 0 }, text: "  " }, 4)).toBe(false);
  });

  it("tells light from dark colours for the halo and the number", () => {
    expect(isLight("white")).toBe(true);
    // yellow carries dark text, red white text
    expect(isLight("#d9a23b")).toBe(true);
    expect(isLight("#f0605a")).toBe(false);
    expect(isLight("black")).toBe(false);
  });
});
