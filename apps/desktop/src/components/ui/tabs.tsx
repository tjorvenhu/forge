import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as T from "@radix-ui/react-tabs";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabDef<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Shows a close button next to the tab. It is a sibling of the trigger, so it never selects the tab. */
  onClose?: () => void;
  closeLabel?: string;
}

/** The indicator is 100px wide and scaled to the tab: it moves with transform only. */
const INDICATOR_BASE = 100;

export function TabBar<V extends string>({
  value,
  onChange,
  tabs,
  className,
  children,
  size = "md",
}: {
  value: V;
  onChange: (v: V) => void;
  tabs: TabDef<V>[];
  className?: string;
  children?: ReactNode;
  /** lg: the main tabs of the workspace and its side panel */
  size?: "md" | "lg";
}) {
  const list = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  /** the first position is set without sliding in from the left */
  const [settled, setSettled] = useState(false);
  const inset = size === "lg" ? 4 : 8;

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      const next = active ? { x: active.offsetLeft + inset, w: Math.max(0, active.offsetWidth - 2 * inset) } : null;
      setBar((prev) => (prev && next && prev.x === next.x && prev.w === next.w ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, tabs, inset]);

  useLayoutEffect(() => {
    if (!bar || settled) return;
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, [bar, settled]);

  return (
    <T.Root value={value} onValueChange={(v) => onChange(v as V)} className="contents">
      <T.List ref={list} className={cn("relative flex items-center gap-1", className)}>
        {tabs.map((t) => (
          <Fragment key={t.value}>
            <T.Trigger
              value={t.value}
              className={cn(
                "group relative inline-flex items-center rounded-md text-muted transition-[color,transform] duration-120 hover:text-fg focus-visible:outline-offset-[-2px] active:scale-[0.97] data-[state=active]:text-fg",
                size === "lg" ? "h-12 gap-2 px-3.5 text-ui" : "h-9 gap-1.5 px-3 text-body",
                t.onClose && "pr-1",
              )}
            >
              {t.icon}
              {size === "lg" ? (
                // The active tab is bold; an invisible bold copy keeps the width, so the neighbours do not move.
                <span className="inline-grid">
                  <span className="col-start-1 row-start-1 group-data-[state=active]:font-medium">{t.label}</span>
                  <span aria-hidden className="invisible col-start-1 row-start-1 font-medium">
                    {t.label}
                  </span>
                </span>
              ) : (
                t.label
              )}
              {t.badge}
            </T.Trigger>
            {t.onClose && (
              <button
                type="button"
                onClick={t.onClose}
                aria-label={t.closeLabel ?? `${t.label} schließen`}
                title={t.closeLabel ?? `${t.label} schließen`}
                className="-ml-1 mr-1 inline-flex h-5 w-5 items-center justify-center rounded text-subtle transition-[color,background-color,transform] duration-120 hover:bg-surface-3 hover:text-fg active:scale-90"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </Fragment>
        ))}
        {children}
        {bar && (
          <span
            aria-hidden
            className={cn("pointer-events-none absolute -bottom-px left-0 origin-left rounded-full bg-accent", size === "lg" ? "h-0.75" : "h-0.5", settled && "transition-transform duration-200 ease-snappy")}
            style={{ width: INDICATOR_BASE, transform: `translateX(${bar.x}px) scaleX(${bar.w / INDICATOR_BASE})` }}
          />
        )}
      </T.List>
    </T.Root>
  );
}
