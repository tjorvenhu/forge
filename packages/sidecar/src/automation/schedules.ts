import { randomUUID } from "node:crypto";
import { ForgeError, type Schedule } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import type { SessionService } from "../sessions/session-service.js";

interface Row {
  id: string;
  project_id: string;
  name: string;
  prompt: string;
  time: string;
  weekdays: string;
  plan_only: number;
  enabled: number;
  last_run_at: string | null;
  last_session_id: string | null;
  created_at: string;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  prompt: r.prompt,
  time: r.time,
  weekdays: JSON.parse(r.weekdays) as number[],
  planOnly: !!r.plan_only,
  enabled: !!r.enabled,
  lastRunAt: r.last_run_at,
  lastSessionId: r.last_session_id,
  createdAt: r.created_at,
});

/** ISO weekday 1 (Mon) … 7 (Sun) in local time. */
export function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** True if the schedule is due at `now` and has not run in this minute slot yet. */
export function isDue(s: Pick<Schedule, "enabled" | "time" | "weekdays" | "lastRunAt">, now: Date): boolean {
  if (!s.enabled || !s.weekdays.includes(isoWeekday(now))) return false;
  const [h, m] = s.time.split(":").map(Number) as [number, number];
  const slot = new Date(now);
  slot.setHours(h, m, 0, 0);
  // Run within 10 minutes after the slot (covers sleep/missed ticks), once per slot.
  if (now < slot || now.getTime() - slot.getTime() > 10 * 60_000) return false;
  return !s.lastRunAt || new Date(s.lastRunAt) < slot;
}

/**
 * Local scheduled prompts. They run only while FORGE is open; approvals in Safe/Balanced still wait
 * for the user, so nothing runs unattended beyond the project's profile.
 */
export class ScheduleService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly emit: () => void,
  ) {}

  startTicking() {
    this.timer = setInterval(() => void this.tick(new Date()), 30_000);
  }

  list(projectId?: string): Schedule[] {
    const rows = (projectId
      ? this.db.sql.prepare("SELECT * FROM schedules WHERE project_id = ? ORDER BY time").all(projectId)
      : this.db.sql.prepare("SELECT * FROM schedules ORDER BY time").all()) as unknown as Row[];
    return rows.map(toSchedule);
  }

  get(id: string): Schedule {
    const r = this.db.sql.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new ForgeError("NOT_FOUND", "Automatisierung nicht gefunden.");
    return toSchedule(r);
  }

  save(input: Omit<Schedule, "id" | "lastRunAt" | "lastSessionId" | "createdAt"> & { id?: string }): Schedule {
    if (input.id) {
      this.db.sql
        .prepare("UPDATE schedules SET name = ?, prompt = ?, time = ?, weekdays = ?, plan_only = ?, enabled = ?, project_id = ? WHERE id = ?")
        .run(input.name, input.prompt, input.time, JSON.stringify(input.weekdays), input.planOnly ? 1 : 0, input.enabled ? 1 : 0, input.projectId, input.id);
      this.emit();
      return this.get(input.id);
    }
    const id = randomUUID();
    this.db.sql
      .prepare("INSERT INTO schedules(id, project_id, name, prompt, time, weekdays, plan_only, enabled, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.projectId, input.name, input.prompt, input.time, JSON.stringify(input.weekdays), input.planOnly ? 1 : 0, input.enabled ? 1 : 0, new Date().toISOString());
    this.emit();
    return this.get(id);
  }

  remove(id: string) {
    this.db.sql.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    this.emit();
  }

  async runNow(id: string): Promise<Schedule> {
    const s = this.get(id);
    const session = await this.sessions.start({ projectId: s.projectId, prompt: s.prompt, planOnly: s.planOnly });
    this.db.sql.prepare("UPDATE schedules SET last_run_at = ?, last_session_id = ? WHERE id = ?").run(new Date().toISOString(), session.id, id);
    this.emit();
    return this.get(id);
  }

  async tick(now: Date) {
    for (const s of this.list()) {
      if (!isDue(s, now)) continue;
      // Mark first so a slow start can't trigger the same slot twice.
      this.db.sql.prepare("UPDATE schedules SET last_run_at = ? WHERE id = ?").run(now.toISOString(), s.id);
      try {
        await this.runNow(s.id);
      } catch {
        /* the session error is visible in the session list */
      }
    }
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
