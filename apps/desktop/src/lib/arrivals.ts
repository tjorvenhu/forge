import { useState } from "react";

/**
 * Which list entries just arrived, to animate them once. Entries that were there when the list was
 * first shown (loaded history) never count as new. A new one stays "new" for `windowMs` from the first
 * time it is seen, so its enter animation is not cut off by the re-renders that follow (streaming
 * re-renders every frame), and a row that scrolls back into view later does not animate again.
 */
export class Arrivals {
  private seen = new Map<string, number>();
  private primed = false;

  constructor(private readonly windowMs = 250) {}

  /** The entries already there on the first show. Later calls do nothing. */
  prime(keys: Iterable<string>) {
    if (this.primed) return;
    this.primed = true;
    for (const k of keys) this.seen.set(k, -Infinity);
  }

  get isPrimed(): boolean {
    return this.primed;
  }

  isNew(key: string, now = Date.now()): boolean {
    if (!this.primed) return false;
    let at = this.seen.get(key);
    if (at === undefined) {
      at = now;
      this.seen.set(key, at);
    }
    return now - at < this.windowMs;
  }
}

/**
 * Arrivals of a list in a component: primed with the first keys that are defined (loaded), so only
 * entries added afterwards animate.
 */
export function useArrivals(keys: readonly string[] | undefined): (key: string) => boolean {
  const [arrivals] = useState(() => new Arrivals());
  if (keys && !arrivals.isPrimed) arrivals.prime(keys);
  return (key) => arrivals.isNew(key);
}
