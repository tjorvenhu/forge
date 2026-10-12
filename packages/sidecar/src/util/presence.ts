/**
 * Without input for this long the user counts as away even with FORGE in front: the window stays
 * active when someone leaves the desk, and that is when a call is wanted most.
 */
export const IDLE_AFTER_MS = 5 * 60_000;

/** Whether the user sits in front of FORGE: window active and recent input there (reported by the desktop). */
export class Presence {
  private focused = false;
  private lastActiveAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  report(focused: boolean, active: boolean) {
    this.focused = focused;
    if (active) this.lastActiveAt = this.now();
  }

  isPresent(): boolean {
    return this.focused && this.now() - this.lastActiveAt < IDLE_AFTER_MS;
  }
}
