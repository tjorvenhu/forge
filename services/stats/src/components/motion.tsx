"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** True once the element was on screen (and stays true); without IntersectionObserver at once. */
function useSeen<T extends Element>(ref: RefObject<T | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return seen;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A number that counts up from 0 once it is on screen and glides to a new value after a refresh. Screen
 * readers (and the server HTML) get the final value; the moving one is hidden from them.
 */
export function AnimatedNumber({ value, format, duration = 1400 }: { value: number; format: (n: number) => string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useSeen(ref);
  const [shown, setShown] = useState(0);
  const current = useRef(0);

  useEffect(() => {
    if (!seen) return;
    const from = current.current;
    if (from === value || reducedMotion()) {
      current.current = value;
      setShown(value);
      return;
    }
    // A refresh moves in half the time: it is a change, not an entrance.
    const ms = from === 0 ? duration : duration / 2;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 4);
      current.current = from + (value - from) * eased;
      setShown(p === 1 ? value : current.current);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [seen, value, duration]);

  return (
    <>
      <span ref={ref} aria-hidden className="count">
        {format(shown)}
      </span>
      <span className="sr-only">{format(value)}</span>
    </>
  );
}

/** Fades its content in and starts the bar animations inside once it scrolls into view. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  return (
    <div ref={ref} className={`reveal${seen ? " in-view" : ""}${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}
