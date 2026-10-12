/**
 * Motion classes shared by the UI primitives (tokens and keyframes in styles.css). Radix keeps
 * closing content mounted until its exit animation has ended, so exits come for free.
 */

/** Menus, selects and tooltips: slide in from the side of their trigger, fade out. */
export const POPPER_MOTION =
  "not-data-[state=closed]:data-[side=bottom]:animate-drop-in not-data-[state=closed]:data-[side=top]:animate-rise-in not-data-[state=closed]:data-[side=left]:animate-fade-in not-data-[state=closed]:data-[side=right]:animate-fade-in data-[state=closed]:animate-menu-out";

/** Backdrop of dialogs and the command palette. */
export const OVERLAY_MOTION = "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out";

/** Dialog panels: a small scale up on open, a quick fade on close. */
export const DIALOG_MOTION = "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out";
