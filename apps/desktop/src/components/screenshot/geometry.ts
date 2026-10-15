/** Geometry of the snipping overlay. Everything is in physical pixels of the frame (the whole virtual screen). */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the shell sends with every capture (screenshot.rs, FrameInfo). */
export interface FrameInfo {
  id: number;
  width: number;
  height: number;
  monitors: Rect[];
  /** visible top-level windows, the front one first */
  windows: Rect[];
  cursorX: number;
  cursorY: number;
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Smaller selections are a slip of the mouse, not a snip. */
export const MIN_SNIP = 4;

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/** The part of `r` inside `bounds`, in whole pixels; null when nothing is left. */
export function clampRect(r: Rect, bounds: Rect): Rect | null {
  const x0 = Math.max(bounds.x, Math.round(r.x));
  const y0 = Math.max(bounds.y, Math.round(r.y));
  const x1 = Math.min(bounds.x + bounds.width, Math.round(r.x + r.width));
  const y1 = Math.min(bounds.y + bounds.height, Math.round(r.y + r.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export function bigEnough(r: Rect | null): r is Rect {
  return !!r && r.width >= MIN_SNIP && r.height >= MIN_SNIP;
}

/** The monitor under the point, else the nearest one. */
export function monitorAt(monitors: Rect[], p: Point): Rect | null {
  if (!monitors.length) return null;
  const hit = monitors.find((m) => contains(m, p));
  if (hit) return hit;
  const dist = (m: Rect) => Math.hypot(Math.max(m.x - p.x, 0, p.x - (m.x + m.width)), Math.max(m.y - p.y, 0, p.y - (m.y + m.height)));
  return monitors.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

/** The front-most window under the point, cut to the frame (maximized windows reach a little past the screen). */
export function windowAt(windows: Rect[], p: Point, frame: Rect): Rect | null {
  for (const w of windows) if (contains(w, p)) return clampRect(w, frame);
  return null;
}

export function boundsOf(points: Point[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0) };
}

/** `start` with one edge or corner dragged by (dx, dy); flips over cleanly when dragged past the opposite side. */
export function resize(start: Rect, handle: Handle, dx: number, dy: number): Rect {
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.width;
  let y1 = start.y + start.height;
  if (handle.includes("w")) x0 += dx;
  if (handle.includes("e")) x1 += dx;
  if (handle.includes("n")) y0 += dy;
  if (handle.includes("s")) y1 += dy;
  return rectFromPoints({ x: x0, y: y0 }, { x: x1, y: y1 });
}

/** `r` moved by (dx, dy) but kept inside `bounds`. */
export function moveWithin(r: Rect, dx: number, dy: number, bounds: Rect): Rect {
  return {
    ...r,
    x: Math.min(Math.max(bounds.x, r.x + dx), bounds.x + bounds.width - r.width),
    y: Math.min(Math.max(bounds.y, r.y + dy), bounds.y + bounds.height - r.height),
  };
}

/**
 * Where the tool bar of a selection goes, in the same units as its arguments: centred below it, above
 * it when there is no room below, inside its bottom edge when neither fits (a full-screen snip).
 */
export function toolbarSpot(sel: Rect, bar: { width: number; height: number }, screen: Rect, gap: number): Point {
  const x = Math.min(Math.max(screen.x + gap, sel.x + sel.width / 2 - bar.width / 2), screen.x + screen.width - bar.width - gap);
  const below = sel.y + sel.height + gap;
  if (below + bar.height <= screen.y + screen.height - gap) return { x, y: below };
  const above = sel.y - gap - bar.height;
  if (above >= screen.y + gap) return { x, y: above };
  return { x, y: Math.max(screen.y + gap, sel.y + sel.height - gap - bar.height) };
}
