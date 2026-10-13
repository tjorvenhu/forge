import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Movement before a press on an entry counts as dragging (and no longer as a click). */
export const DRAG_START_PX = 6;
/** Distance from the list at which a dragged entry tears off into its own window. */
export const TEAR_OFF_PX = 40;

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
 * Like a browser tab: an entry tears off once the pointer is clearly outside the list it came from,
 * or outside the window.
 */
export function isTornOff(list: Box, x: number, y: number, viewport: { width: number; height: number }): boolean {
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return true;
  return x < list.left - TEAR_OFF_PX || x > list.right + TEAR_OFF_PX || y < list.top - TEAR_OFF_PX || y > list.bottom + TEAR_OFF_PX;
}

export interface TabDrag {
  id: string;
  label: string;
  x: number;
  y: number;
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
 * Drag an entry out of a list into its own window, like a browser tab: the moment it leaves the
 * list, `onTearOff` runs while the mouse button is still down, and the shell lets the new window
 * follow the cursor (chat_windows.rs). A press that turned into a drag is no click (`consumeClick`).
 */
export function useTabTearOff(listRef: React.RefObject<HTMLElement | null>, onTearOff: (id: string) => void) {
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
        swallowClick.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      const rect = listRef.current?.getBoundingClientRect();
      if (rect && isTornOff(rect, e.clientX, e.clientY, { width: window.innerWidth, height: window.innerHeight })) {
        // The webview lets go of the mouse; the new window takes the rest of the drag.
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        reset();
        onTearOff(p.id);
        return;
      }
      setDrag({ id: p.id, label: p.label, x: e.clientX, y: e.clientY });
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const p = pending.current;
      if (!p || p.pointerId !== e.pointerId) return;
      if (p.dragging) e.currentTarget.releasePointerCapture?.(e.pointerId);
      reset();
    },
    onPointerCancel: reset,
  });

  /** True once for the click that follows a drag; the caller skips it. */
  const consumeClick = () => {
    const v = swallowClick.current;
    swallowClick.current = false;
    return v;
  };

  return { drag, handlers, consumeClick };
}
