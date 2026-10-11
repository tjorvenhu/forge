/** The first row in view and how far its top sits from the top of the viewport. */
export interface ScrollAnchor {
  key: string;
  offset: number;
}

interface Row {
  key: string | number | bigint;
  start: number;
  end: number;
}

export function captureAnchor(rows: readonly Row[], scrollTop: number): ScrollAnchor | null {
  const row = rows.find((r) => r.end > scrollTop);
  return row ? { key: String(row.key), offset: row.start - scrollTop } : null;
}

/**
 * The scrollTop that puts the anchor row back where it was after rows were added above it, given
 * that row's new position; null when the row is gone.
 */
export function anchoredScrollTop(anchor: ScrollAnchor, row: { start: number } | undefined): number | null {
  return row ? Math.max(0, row.start - anchor.offset) : null;
}
