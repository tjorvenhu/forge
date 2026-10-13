/** More chats than this do not stay readable even on a large screen. */
export const MAX_PANES = 6;
/** Below this a chat's composer and tool cards no longer fit. */
export const MIN_PANE_WIDTH = 560;
export const MIN_PANE_HEIGHT = 380;
/** The shape a chat reads best in; the grid that keeps every chat closest to it wins. */
const COMFORT_WIDTH = 600;
const COMFORT_HEIGHT = 480;

/** How many chats fit into an area of this size, at least the main chat. */
export function paneCapacity(width: number, height: number): number {
  const cols = Math.max(1, Math.floor(width / MIN_PANE_WIDTH));
  const rows = Math.max(1, Math.floor(height / MIN_PANE_HEIGHT));
  return Math.min(MAX_PANES, cols * rows);
}

/**
 * Chats per row for `count` chats in an area of this size, e.g. [2, 2] for two above two. Among the
 * grids in which every chat keeps its minimum size, the one whose smallest chat is largest wins; the
 * last row may hold fewer chats, which then share its width.
 */
export function paneRows(count: number, width: number, height: number): number[] {
  if (count <= 1) return [1];
  let best: { cols: number; score: number; fits: boolean } | null = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // An empty row: the same grid with fewer columns does it better.
    if (rows * cols - count >= cols) continue;
    const w = width / cols;
    const h = height / rows;
    const fits = w >= MIN_PANE_WIDTH && h >= MIN_PANE_HEIGHT;
    const score = Math.min(w / COMFORT_WIDTH, h / COMFORT_HEIGHT);
    if (!best || (fits && !best.fits) || (fits === best.fits && score > best.score)) best = { cols, score, fits };
  }
  const cols = best!.cols;
  const rows: number[] = [];
  for (let left = count; left > 0; left -= cols) rows.push(Math.min(cols, left));
  return rows;
}
