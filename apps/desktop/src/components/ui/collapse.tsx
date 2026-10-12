import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** length of the open/close transition of .collapsible (styles.css) */
const COLLAPSE_MS = 180;

/**
 * Opens and closes its content with a height transition (grid rows 0fr <-> 1fr, no measuring). The
 * content is mounted only while open or closing: in a long chat the closed details of hundreds of
 * cards are not rendered at all.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // One frame closed, then open: the transition needs a start state.
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className="collapsible" data-open={shown}>
      <div className={cn(className)}>{children}</div>
    </div>
  );
}
