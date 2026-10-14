import type { MouseEvent as ReactMouseEvent } from "react";
import type { MenuItem } from "@/components/ui/dropdown";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";

/** Copies text for a menu entry; only a failure is worth a word. */
export function copyText(text: string) {
  navigator.clipboard.writeText(text).catch((e: unknown) => toast.error("Nicht kopiert", errorMessage(e)));
}

/** Entries a component offers for a right click on it, shown above the general ones (copy, paste, links). */
export type ContextGroup = MenuItem[];

const offered = new WeakMap<Event, ContextGroup[]>();

/**
 * Adds entries to the FORGE context menu of this right click. Call it from onContextMenu; the
 * innermost element's entries come first. Leaves the event alone, so outer elements add theirs too.
 */
export function addContextItems(e: ReactMouseEvent | MouseEvent, items: ContextGroup) {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  const visible = items.filter(Boolean);
  if (!visible.length) return;
  offered.set(native, [...(offered.get(native) ?? []), visible]);
}

/** The groups components added for this event, innermost first. */
export function offeredGroups(e: Event): ContextGroup[] {
  return offered.get(e) ?? [];
}

/** A handler for onContextMenu that offers `items` (built at the moment of the click). */
export function contextItems(build: () => ContextGroup) {
  return (e: ReactMouseEvent) => addContextItems(e, build());
}
