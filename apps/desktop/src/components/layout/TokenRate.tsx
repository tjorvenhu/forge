import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useTokenRate } from "@/stores/token-rate";
import { BASELINE_POINTS, createSparkline, sparklineActive, sparklineIdle, sparklinePoints, stepSparkline } from "./token-sparkline";
import { locale, t } from "@/i18n";

/** Without motion the line moves in whole seconds, like the rate itself arrives. */
const REDUCED_TICK_MS = 1000;

/**
 * Draws the sparkline straight into the polyline once per frame, without rendering React, and
 * sleeps once everything is back at zero. Returns the ref for the polyline and whether there is
 * output to show.
 */
function useSparkline() {
  const line = useRef<SVGPolylineElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const reducedMotion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const spark = createSparkline(performance.now());
    let cancel: (() => void) | null = null;

    const frame = () => {
      cancel = null;
      const now = performance.now();
      const target = useTokenRate.getState().perSecond;
      const reduced = reducedMotion?.matches ?? false;
      stepSparkline(spark, target, now, reduced);
      line.current?.setAttribute("points", sparklinePoints(spark, now));
      setActive(sparklineActive(spark, target));
      if (!sparklineIdle(spark, target)) schedule(reduced);
    };
    const schedule = (reduced: boolean) => {
      if (cancel) return;
      if (reduced || typeof requestAnimationFrame !== "function") {
        const timer = setTimeout(frame, REDUCED_TICK_MS);
        cancel = () => clearTimeout(timer);
      } else {
        const id = requestAnimationFrame(frame);
        cancel = () => cancelAnimationFrame(id);
      }
    };

    const unsubscribe = useTokenRate.subscribe(() => {
      if (!(reducedMotion?.matches ?? false)) return schedule(false);
      cancel?.();
      frame();
    });
    frame();
    return () => {
      unsubscribe();
      cancel?.();
    };
  }, []);
  return { line, active };
}

/** A pause between two answers stays on screen; only a longer quiet hides the output. */
const HIDE_AFTER_MS = 2000;
/** Slower than the default .collapsible, so the card grows calmly instead of popping. */
const REVEAL_MS = 320;

/** Whether tokens flow now or did less than HIDE_AFTER_MS ago. */
export function useTokensFlowing(perSecond: number): boolean {
  const [shown, setShown] = useState(perSecond > 0);
  useEffect(() => {
    if (perSecond > 0) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [perSecond]);
  return shown;
}

/**
 * Output tokens per second of everything FORGE runs with Claude: sessions, subagents, agents, phone.
 * Only shown while tokens flow. It stays mounted while hidden, so the sparkline keeps its history.
 * The -mt-2 cancels the gap-2 of the status card while closed; the pt-2 inside brings it back when open.
 */
export function TokenRate() {
  const perSecond = useTokenRate((s) => s.perSecond);
  const shown = useTokensFlowing(perSecond);
  const { line, active } = useSparkline();
  return (
    <div className="collapsible -mt-2 w-full" data-open={shown} style={{ transitionDuration: `${REVEAL_MS}ms` }} aria-hidden={!shown}>
      <div>
        <div
          className={cn("pt-2 transition-transform ease-snappy", shown ? "translate-y-0" : "translate-y-1.5")}
          style={{ transitionDuration: `${REVEAL_MS}ms` }}
          title={t.layout.tokenRate.title}
        >
          <div className="mb-0.5 flex justify-between text-caption">
            <span className="text-muted">{t.layout.tokenRate.output}</span>
            <span className={cn("tabular-nums transition-colors duration-300", perSecond > 0 ? "text-fg" : "text-subtle")}>{t.layout.tokenRate.perSecond(perSecond.toLocaleString(locale))}</span>
          </div>
          <div className={cn("transition-opacity duration-300", active || perSecond > 0 ? "opacity-100" : "opacity-30")}>
            <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-4 w-full text-accent" aria-hidden>
              <polyline
                ref={line}
                points={BASELINE_POINTS}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
