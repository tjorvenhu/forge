/** Closer than this to the end counts as "at the end" and follows new content again. */
export const PIN_DISTANCE = 40;
/** Scroll events this long after a wheel, key or touch input count as the user's. WebView2 animates wheel scrolling. */
const USER_WINDOW_MS = 400;
/** keys that scroll a focused scroll area */
export const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export type FollowHint = "pinned" | "far" | null;

/**
 * Whether the chat follows new content. Only the user unpins it, by scrolling up. Scroll events
 * the user did not cause (the virtualizer correcting row heights, a smooth jump to the end that
 * new content overtakes) never unpin: judging those by the distance to the end stopped the chat
 * mid-answer whenever content had grown by more than a few lines since the last follow.
 */
export class FollowState {
  private userUntil = 0;
  private dragging = false;
  private lastTop = 0;

  constructor(public pinned = true) {}

  /** wheel, key or touch input inside the thread */
  userInput(now: number) {
    this.userUntil = now + USER_WINDOW_MS;
  }

  wheel(deltaY: number, now: number) {
    this.userInput(now);
    if (deltaY < 0) this.pinned = false;
  }

  /** pointer held on the scrollbar */
  setDragging(dragging: boolean) {
    this.dragging = dragging;
  }

  pin() {
    this.pinned = true;
  }

  unpin() {
    this.pinned = false;
  }

  /** "pinned": at the end, hide the jump button; "far": a screen or more above the end while not following */
  scrolled(top: number, scrollHeight: number, clientHeight: number, now: number): FollowHint {
    const fromEnd = scrollHeight - top - clientHeight;
    const byUser = this.dragging || now < this.userUntil;
    const up = top < this.lastTop;
    this.lastTop = top;
    if (fromEnd < PIN_DISTANCE) {
      this.pinned = true;
      return "pinned";
    }
    if (byUser && up) this.pinned = false;
    return !this.pinned && fromEnd > clientHeight ? "far" : null;
  }
}
