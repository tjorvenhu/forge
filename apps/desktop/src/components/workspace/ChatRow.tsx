import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A marker that replaces the usual one of the outermost row inside the provider, e.g. Claude's mark on
 * the first entry of an answer. Rows nested in that row (tool output, subagent calls) do not get it.
 */
export const LeadMarker = createContext<ReactNode>(null);

/** Width of the gutter: room for an avatar, the dots and icons sit centred in it. */
const GUTTER = "w-6";

/**
 * One line of the chat column: a narrow gutter with a marker (avatar, dot, icon) and the content.
 * The gutter is one line high (1lh), so the marker sits on the first text line in any font size.
 */
export function ChatRow({ marker, children, className, markerClassName }: { marker?: ReactNode; children: ReactNode; className?: string; markerClassName?: string }) {
  const lead = useContext(LeadMarker);
  return (
    <div className={cn("flex gap-2.5", className)}>
      <span className={cn("flex h-[1lh] shrink-0 items-center justify-center", GUTTER, markerClassName)}>{lead ?? marker}</span>
      <div className="min-w-0 flex-1">
        <LeadMarker.Provider value={null}>{children}</LeadMarker.Provider>
      </div>
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
