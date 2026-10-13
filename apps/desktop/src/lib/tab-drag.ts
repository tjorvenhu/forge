import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Movement before a press on a tab counts as dragging (and no longer as a click). */
export const DRAG_START_PX = 6;
/** Distance from the tab strip at which a dragged tab tears off into its own window. */
export const TEAR_OFF_PX = 40;
/** Where the new window's top-left corner lands relative to the pointer: the cursor ends up on its title bar. */
export const WINDOW_GRAB = { x: 120, y: 16 };

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function movedEnough(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_START_PX;
}

/**
 * Like a browser: a tab tears off once the pointer is clearly above or below the strip, or outside
 * the window. Sideways inside the strip it stays a tab.
 */
export function isTornOff(strip: Box, x: number, y: number, viewport: { width: number; height: number }): boolean {
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return true;
  return y < strip.top - TEAR_OFF_PX || y > strip.bottom + TEAR_OFF_PX;
}

/** Top-left corner of the new window for a drop at this screen position. */
export function windowPositionFor(screenX: number, screenY: number): { x: number; y: number } {
  return { x: Math.max(0, Math.round(screenX - WINDOW_GRAB.x)), y: Math.max(0, Math.round(screenY - WINDOW_GRAB.y)) };
}

export interface TabDrag {
  id: string;
  label: string;
  x: number;
  y: number;
  tornOff: boolean;
}

interface Pending {
  id: string;
  label: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
}

/**
 * Drag a tab out of a strip into its own window. Pointer capture keeps the moves coming while the
 * pointer is outside the window. `onTearOff` gets the screen position for the new window; a press
 * that turned into a drag does not count as a click afterwards (`consumeClick`).
 */
export function useTabTearOff(stripRef: React.RefObject<HTMLElement | null>, onTearOff: (id: string, position: { x: number; y: number }) => void) {
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const pending = useRef<Pending | null>(null);
  const swallowClick = useRef(false);

  const reset = useCallback(() => {
    pending.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag, reset]);

  const handlers = (id: string, label: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || e.pointerType === "touch") return;
      swallowClick.current = false;
      pending.current = { id, label, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dragging: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const p = pending.current;
      if (!p || p.pointerId !== e.pointerId) return;
      if (!p.dragging) {
        if (!movedEnough(e.clientX - p.startX, e.clientY - p.startY)) return;
        p.dragging = true;
        // Keeps the moves coming outside the strip and outside the window.
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      const rect = stripRef.current?.getBoundingClientRect();
      const tornOff = !!rect && isTornOff(rect, e.clientX, e.clientY, { width: window.innerWidth, height: window.innerHeight });
      setDrag({ id: p.id, label: p.label, x: e.clientX, y: e.clientY, tornOff });
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const p = pending.current;
      if (!p || p.pointerId !== e.pointerId) return;
      if (p.dragging) {
        swallowClick.current = true;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        const rect = stripRef.current?.getBoundingClientRect();
        if (rect && isTornOff(rect, e.clientX, e.clientY, { width: window.innerWidth, height: window.innerHeight })) {
          onTearOff(p.id, windowPositionFor(e.screenX, e.screenY));
        }
      }
      reset();
    },
    onPointerCancel: reset,
    onLostPointerCapture: () => {
      if (pending.current?.dragging) reset();
    },
  });

  /** True once for the click that follows a drag; the caller skips it. */
  const consumeClick = () => {
    const v = swallowClick.current;
    swallowClick.current = false;
    return v;
  };

  return { drag, handlers, consumeClick };
}
