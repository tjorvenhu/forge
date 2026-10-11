import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One line of the chat column: a narrow gutter with a marker (dot, icon, prompt sign) and the content.
 * The gutter is one line high (1lh), so the marker sits on the first text line in any font size.
 */
export function ChatRow({ marker, children, className, markerClassName }: { marker?: ReactNode; children: ReactNode; className?: string; markerClassName?: string }) {
  return (
    <div className={cn("flex gap-2.5", className)}>
      <span className={cn("flex h-[1lh] w-4 shrink-0 items-center justify-center", markerClassName)}>{marker}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Round status marker. Without a label it is decoration and hidden from screen readers. */
export function Dot({ className, label }: { className?: string; label?: string }) {
  return <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("block h-2 w-2 shrink-0 rounded-full", className)} />;
}

/** Indented block under a row with a thin guide line on the left: tool output, details. */
export function Guide({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("ml-0.5 border-l border-border pl-3", className)}>{children}</div>;
}

/** Time of a row, visible while the row is hovered or focused. */
export function HoverTime({ time, className }: { time: string; className?: string }) {
  return <span className={cn("shrink-0 text-caption tabular-nums text-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100", className)}>{time}</span>;
}
