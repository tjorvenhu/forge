import { ForgeError, type ServerEvent, type Session, type SessionEventBody, type SessionStatus } from "@forge/protocol";
import type { Db, SessionRecord } from "../persistence/db.js";
import { redact } from "../policy/redact.js";
import type { LiveSession } from "./live-session.js";

/** What all session modules share: the running CLI processes and the writers for events and status. */
export class SessionCore {
  /** sessions with a running CLI process in this app instance */
  readonly live = new Map<string, LiveSession>();

  constructor(
    readonly db: Db,
    readonly emit: (e: ServerEvent) => void,
  ) {}

  toSession(r: SessionRecord): Session {
    const live = this.live.get(r.id);
    return { ...r, live: !!live, background: live ? [...live.background.values()] : [], context: live?.context ?? null };
  }

  get(id: string): Session {
    const r = this.db.getSession(id);
    if (!r) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    return this.toSession(r);
  }

  /** Broadcasts a stored session after it changed. */
  publish(rec: SessionRecord | null) {
    if (rec) this.emit({ event: "session.updated", payload: this.toSession(rec) });
  }

  /** Persists (redacted) and broadcasts one event. Deltas are broadcast only. */
  record(id: string, body: SessionEventBody) {
    if (body.type === "assistant.delta") {
      this.emit({ event: "session.event", payload: { seq: 0, sessionId: id, ts: new Date().toISOString(), body } });
      return;
    }
    const ev = this.db.appendEvent(id, redact(body));
    this.emit({ event: "session.event", payload: ev });
  }

  setStatus(id: string, status: SessionStatus, detail: string | null = null, extra: Partial<SessionRecord> = {}) {
    const rec = this.db.updateSession(id, { status, ...extra });
    this.record(id, { type: "status", status, detail });
    this.publish(rec);
  }
}
