/**
 * Without input for this long the user counts as away even with FORGE in front: the window stays
 * active when someone leaves the desk, and that is when a call is wanted most.
 */
export const IDLE_AFTER_MS = 5 * 60_000;

/**
 * Whether the user sits in front of FORGE: one of its windows active and recent input there (reported
 * by the desktop). Each window reports for itself, so moving from the main window to a chat window
 * counts as present no matter in which order the blur and the focus arrive.
 */
export class Presence {
  /** labels of the windows that reported the focus; a closed window is reported as unfocused by the shell */
  private readonly focused = new Set<string>();
  private lastActiveAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  report(window: string, focused: boolean, active: boolean) {
    if (focused) this.focused.add(window);
    else this.focused.delete(window);
    if (active) this.lastActiveAt = this.now();
  }

  isPresent(): boolean {
    return this.focused.size > 0 && this.now() - this.lastActiveAt < IDLE_AFTER_MS;
  }
}
