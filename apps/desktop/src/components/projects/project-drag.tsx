import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { FolderMinus, Folders } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { groupKey } from "@/lib/project-tree";
import { ProjectIcon } from "./ProjectIcon";
import { t } from "@/i18n";

/** Marks a drop target: the key of its group ("" = without group); its name in data-group-name. */
const DROP_ATTR = "data-project-drop";

interface DropTarget {
  key: string;
  /** null: out of the group */
  name: string | null;
}

interface ProjectDrag {
  /** the project being dragged, once the pointer moved far enough */
  project: { id: string; iconId: string; name: string; group: string | null } | null;
  over: DropTarget | null;
  x: number;
  y: number;
}

export const useProjectDrag = create<ProjectDrag>(() => ({ project: null, over: null, x: 0, y: 0 }));

/** Props for an element projects can be dropped on (a group section of the projects page). */
export function dropTargetProps(key: string, name: string | null) {
  return { [DROP_ATTR]: key, "data-group-name": name ?? "" };
}

/** "over": the pointer is above this group with a project of another group; "target": a drag is on and it could go here. */
export function useDropState(key: string): "over" | "target" | null {
  return useProjectDrag((s) => {
    if (!s.project || groupKey(s.project.group) === key) return null;
    return s.over?.key === key ? "over" : "target";
  });
}

function targetAt(x: number, y: number, from: string): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(`[${DROP_ATTR}]`);
  const key = el?.getAttribute(DROP_ATTR);
  if (!el || key == null || key === from) return null;
  return { key, name: el.dataset.groupName || null };
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

const EDGE = 48;

/**
 * Starts moving a project card into another group: with the pointer, not HTML drag and drop, which the
 * desktop window keeps for files (see SplitView). A plain click stays a click; only after a few pixels
 * it becomes a drag, and the click that ends it is swallowed. Escape cancels.
 */
export function startProjectDrag(e: ReactPointerEvent<HTMLElement>, p: ProjectWithStatus, onDrop: (p: ProjectWithStatus, group: string | null) => void) {
  if (e.button !== 0 || e.pointerType === "touch") return;
  // Menu triggers open on pointerdown; moving from there is not meant as a drag.
  if ((e.target as HTMLElement).closest("[aria-haspopup], input, textarea")) return;
  const from = groupKey(p.group);
  const start = { x: e.clientX, y: e.clientY };
  const scroller = scrollParent(e.currentTarget);
  let last = start;
  let moved = false;
  let frame = 0;

  const update = () => useProjectDrag.setState({ over: targetAt(last.x, last.y, from), x: last.x, y: last.y });
  // Near the top or bottom edge the page scrolls, so groups out of sight can be reached.
  const autoScroll = () => {
    frame = requestAnimationFrame(autoScroll);
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const speed = last.y < box.top + EDGE ? -(box.top + EDGE - last.y) : last.y > box.bottom - EDGE ? last.y - (box.bottom - EDGE) : 0;
    if (speed === 0) return;
    scroller.scrollTop += Math.max(-20, Math.min(20, speed / 2));
    update();
  };

  const onMove = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!moved) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
      moved = true;
      window.getSelection()?.removeAllRanges();
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      useProjectDrag.setState({ project: { id: p.id, iconId: p.parentId ?? p.id, name: p.name, group: p.group } });
      frame = requestAnimationFrame(autoScroll);
    }
    update();
  };
  const finish = (ev: PointerEvent | null) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(frame);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    useProjectDrag.setState({ project: null, over: null });
    if (!moved || !ev) return;
    swallowClick();
    const target = targetAt(ev.clientX, ev.clientY, from);
    if (target) onDrop(p, target.name);
  };
  const onUp = (ev: PointerEvent) => finish(ev);
  const onCancel = () => finish(null);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !moved) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(null);
    // The button is still down: its release would click whatever is under the pointer.
    window.addEventListener("pointerup", swallowClick, { once: true });
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}

/** The click that follows the release would open the project the card was dropped on. */
function swallowClick() {
  const stop = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

/** The dragged project next to the pointer, saying where it would go. */
export function ProjectDragGhost() {
  const d = useProjectDrag();
  if (!d.project) return null;
  const into = d.over ? (d.over.name ? t.projects.groups.moveTo(d.over.name) : t.projects.groups.removeFromGroup) : null;
  return createPortal(
    <div
      aria-hidden
      style={{ left: d.x + 14, top: d.y + 10 }}
      className="pointer-events-none fixed z-50 flex max-w-72 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-body shadow-lg"
    >
      <ProjectIcon id={d.project.iconId} name={d.project.name} size={18} />
      <span className="min-w-0 truncate font-medium text-fg">{d.project.name}</span>
      {into && (
        <span className="flex shrink-0 items-center gap-1 text-caption text-accent">
          {d.over?.name ? <Folders className="h-3 w-3" /> : <FolderMinus className="h-3 w-3" />}
          {into}
        </span>
      )}
    </div>,
    document.body,
  );
}
