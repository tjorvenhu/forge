/**
 * The idle time is compared with the wall clock on every check instead of one timer per session:
 * a timer does not count while Windows sleeps.
 */
export const IDLE_CHECK_MS = 60_000;

export interface IdleCloseHost {
  /** minutes without activity until the process ends; 0 never */
  minutes(): number;
  /** sessions with a running CLI process */
  liveIds(): string[];
  /** something still needs the process (a turn, an approval, background work, a planned continuation, a call) */
  inUse(sessionId: string): boolean;
  /** ends the process; the session stays and resumes with its next message */
  close(sessionId: string): void;
}

/** Ends the CLI processes of sessions nobody used for a while, like a restart of FORGE would. */
export class IdleClose {
  /** last activity per session with a running process */
  private readonly last = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: IdleCloseHost,
    private readonly now: () => number = Date.now,
  ) {}

  touch(sessionId: string) {
    this.last.set(sessionId, this.now());
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.check(), IDLE_CHECK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Closes the sessions idle for longer than the setting; returns their ids. Runs synchronously, so a
   * message sent at the same moment either counts as use or finds the process closing and resumes.
   */
  check(): string[] {
    const live = new Set(this.host.liveIds());
    for (const id of this.last.keys()) if (!live.has(id)) this.last.delete(id);
    const minutes = this.host.minutes();
    if (!(minutes > 0)) return [];
    const now = this.now();
    const closed: string[] = [];
    for (const id of live) {
      const since = this.last.get(id);
      // Work in progress counts as activity: the full idle time starts when it is over.
      if (since === undefined || this.host.inUse(id)) {
        this.last.set(id, now);
        continue;
      }
      if (now - since < minutes * 60_000) continue;
      this.last.delete(id);
      this.host.close(id);
      closed.push(id);
    }
    return closed;
  }
}
