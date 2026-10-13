import type { SessionEventBody } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import { describeRuntimeError } from "./live-session.js";

/** What Claude reads after the restart, sent as an automatic message. */
export const UPDATE_CONTINUE_PROMPT =
  "FORGE wurde gerade aktualisiert und neu gestartet. Dabei wurde dein letzter Durchlauf unterbrochen; laufende Befehle, Hintergrundaufgaben und Subagenten wurden beendet. " +
  "Mach bitte dort weiter, wo du aufgehört hast, und starte Unterbrochenes neu, soweit es noch gebraucht wird.";
/** prepare() holds this long; the shell ends the sidecar seconds after the click, not minutes. */
export const ARM_MS = 2 * 60_000;
/** Older marks are dropped: FORGE did not come back from the update right away (installer failed, started by hand later). */
export const MARK_MAX_AGE_MS = 30 * 60_000;
/** After the start, before the sessions open again: the app is still coming up. */
export const RESUME_DELAY_MS = 3_000;
/** While something holds the sessions back (second step of an update), asked again this often … */
export const HOLD_RETRY_MS = 2_000;
/** … but not longer than this. */
export const MAX_HOLD_MS = 5 * 60_000;

export interface UpdateResumeHost {
  /** sessions with a running CLI process; working: a turn, a background task or a subagent runs */
  live(): Array<{ id: string; working: boolean }>;
  isLive(id: string): boolean;
  record(id: string, body: SessionEventBody): void;
  /** opens the session again; with a prompt, sent as an automatic message */
  resume(id: string, prompt: string | null): Promise<unknown>;
  /** lets drain() wait for the sessions to open */
  track(p: Promise<unknown>): void;
  /** version of this FORGE; null when the desktop shell did not pass one */
  version: string | null;
}

/**
 * Sessions survive an update. The Claude processes cannot: they hang on the sidecar's pipes and its
 * in-process tools and approvals. So the sessions open at the time of the restart are noted, and the
 * new FORGE opens them again; those that were working get a message to carry on.
 */
export class UpdateResume {
  private armedAt: number | null = null;
  /** the installation was called off: nothing holds the sessions back any more */
  private released = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: Db,
    private readonly host: UpdateResumeHost,
    private readonly now: () => number = Date.now,
  ) {}

  private armed(): boolean {
    return this.armedAt !== null && this.now() - this.armedAt < ARM_MS;
  }

  /**
   * on: the next shutdown is the restart for an update. Marks still waiting from the last one (the
   * first step of a two-step update) start counting again. Returns what comes back after the restart.
   */
  prepare(on: boolean): { sessions: number; working: number } {
    this.armedAt = on ? this.now() : null;
    if (!on) this.released = true;
    const live = this.host.live();
    const waiting = on ? this.db.listResumeMarks().filter((m) => !live.some((l) => l.id === m.sessionId)) : [];
    if (on) this.db.touchResumeMarks(new Date(this.now()).toISOString());
    return {
      sessions: live.length + waiting.length,
      working: live.filter((l) => l.working).length + waiting.filter((m) => m.working).length,
    };
  }

  /** The sidecar ends: notes the open sessions if this is the restart for an update. */
  noteShutdown(): boolean {
    if (!this.armed()) return false;
    for (const l of this.host.live()) this.db.markForResume(l.id, l.working, this.host.version, new Date(this.now()).toISOString());
    return true;
  }

  /** After the start: opens the noted sessions, once nothing holds them back. */
  start(holds: () => boolean = () => false) {
    this.stop();
    const started = this.now();
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        // An installation is about to end FORGE again: the marks stay for the next start.
        const waiting = this.armed() || (!this.released && holds());
        if (waiting && this.now() - started < MAX_HOLD_MS) return tick(HOLD_RETRY_MS);
        this.host.track(this.resumeAll());
      }, delay);
      this.timer.unref?.();
    };
    tick(RESUME_DELAY_MS);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async resumeAll() {
    const now = this.now();
    for (const m of this.db.takeResumeMarks()) {
      if (now - Date.parse(m.markedAt) > MARK_MAX_AGE_MS) continue;
      // Deleted meanwhile, or the user went on with it already.
      if (!this.db.getSession(m.sessionId) || this.host.isLive(m.sessionId)) continue;
      try {
        if (m.working) this.host.record(m.sessionId, { type: "app.updated", from: m.fromVersion, to: this.host.version });
        await this.host.resume(m.sessionId, m.working ? UPDATE_CONTINUE_PROMPT : null);
      } catch (e) {
        // An idle session stays closed without a word; it opens again with the next message.
        if (m.working) this.host.record(m.sessionId, { type: "error", message: `Nach dem Update nicht fortgesetzt: ${describeRuntimeError(e)}`, retryable: true });
      }
    }
  }
}
