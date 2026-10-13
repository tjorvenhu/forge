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
  fit = false,
}: {
  value: V;
  onChange: (v: V) => void;
  tabs: TabDef<V>[];
  className?: string;
  children?: ReactNode;
  /** lg: the main tabs of the workspace and its side panel */
  size?: "md" | "lg";
  /**
   * The bar takes the free width of its row; when the labels do not fit, the tabs show only their
   * icons and the label as tooltip. The caller puts no spacer next to it.
   */
  fit?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);
  /** the first position is set without sliding in from the left */
  const [settled, setSettled] = useState(false);
  const inset = size === "lg" ? 4 : 8;
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);
  /** Width the tabs need with labels, from the last time the labels were shown. */
  const fullWidth = useRef(0);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      if (fit) {
        if (!compactRef.current) fullWidth.current = contentWidth(el);
        const next = fullWidth.current > el.clientWidth;
        if (next !== compactRef.current) {
          compactRef.current = next;
          setCompact(next);
          return;
        }
      }
      const active = el.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      const next = active ? { x: active.offsetLeft + inset, w: Math.max(0, active.offsetWidth - 2 * inset) } : null;
      setBar((prev) => (prev && next && prev.x === next.x && prev.w === next.w ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // With fit the bar keeps the width of its row, so a tab that grows later (the web font loads, a badge
    // appears) does not resize it, and the indicator would stay under the old position.
    for (const tab of Array.from(el.querySelectorAll('[role="tab"]'))) ro.observe(tab);
    return () => ro.disconnect();
  }, [value, tabs, inset, fit, compact]);

  useLayoutEffect(() => {
    if (!bar || settled) return;
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, [bar, settled]);

  return (
    <T.Root value={value} onValueChange={(v) => onChange(v as V)} className="contents">
      <T.List ref={list} className={cn("relative flex items-center gap-1", fit && "min-w-0 flex-1 overflow-hidden", className)}>
        {tabs.map((t) => (
          <Fragment key={t.value}>
            <T.Trigger
              value={t.value}
              // A clicked tab would keep the focus, and the next shortcut or a dialog closed with Escape
              // turns that into a visible focus ring. detail is 0 for clicks from the keyboard.
              onClick={(e) => e.detail > 0 && e.currentTarget.blur()}
              title={compact ? t.label : undefined}
              aria-label={compact ? t.label : undefined}
              className={cn(
                "group relative inline-flex shrink-0 items-center whitespace-nowrap rounded-md text-muted transition-[color,transform] duration-120 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg focus-visible:outline-none active:scale-[0.97] data-[state=active]:text-fg",
                size === "lg" ? "h-12 gap-2 px-3.5 text-ui" : "h-9 gap-1.5 px-3 text-body",
                t.onClose && "pr-1",
              )}
            >
              {t.icon}
              {compact && t.icon ? null : size === "lg" ? (
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
                className="-ml-1 mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-subtle transition-[color,background-color,transform] duration-120 hover:bg-surface-3 hover:text-fg active:scale-90"
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
            data-tab-indicator
            className={cn("pointer-events-none absolute -bottom-px left-0 origin-left rounded-full bg-accent", size === "lg" ? "h-0.75" : "h-0.5", settled && "transition-transform duration-200 ease-snappy")}
            style={{ width: INDICATOR_BASE, transform: `translateX(${bar.x}px) scaleX(${bar.w / INDICATOR_BASE})` }}
          />
        )}
      </T.List>
    </T.Root>
  );
}

/** Right edge of the last entry: what the tabs need, also while they overflow the bar. */
function contentWidth(list: HTMLElement): number {
  let right = 0;
  for (const c of Array.from(list.children)) {
    if (c instanceof HTMLElement && c.dataset.tabIndicator === undefined) right = Math.max(right, c.offsetLeft + c.offsetWidth);
  }
  return Math.ceil(right);
}
