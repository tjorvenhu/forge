import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DEFAULT_DISABLED_POLICY_RULES, SEARCH_MARK_END, SEARCH_MARK_START, type ContextUsage, type EffortLevel, type PermissionMode, type ProfileId, type Project, type PhoneCallRecord, type SearchHit, type Session, type SessionEvent, type SessionEventBody, type SessionStatus, type Settings } from "@forge/protocol";

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL UNIQUE,
    favorite INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    technologies TEXT NOT NULL DEFAULT '[]',
    profile TEXT NOT NULL DEFAULT 'balanced',
    autonomous_confirmed INTEGER NOT NULL DEFAULT 0,
    default_model TEXT,
    created_at TEXT NOT NULL,
    last_opened_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    claude_session_id TEXT,
    cwd TEXT NOT NULL,
    title TEXT,
    model TEXT,
    profile TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    api_key_source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT
  );
  CREATE INDEX sessions_project ON sessions(project_id, updated_at DESC);
  CREATE INDEX sessions_claude ON sessions(claude_session_id);
  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL,
    decision TEXT NOT NULL,
    scope TEXT NOT NULL,
    source TEXT NOT NULL,
    reason TEXT,
    ts TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE projects ADD COLUMN test_command TEXT;
  ALTER TABLE projects ADD COLUMN parent_id TEXT;
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    requirement TEXT NOT NULL,
    options TEXT NOT NULL,
    status TEXT NOT NULL,
    step TEXT NOT NULL,
    steps TEXT NOT NULL,
    branch TEXT,
    session_id TEXT,
    work_project_id TEXT,
    pr_url TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    time TEXT NOT NULL,
    weekdays TEXT NOT NULL,
    plan_only INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_session_id TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // Feature workflows and schedules were removed again.
  `
  DROP TABLE IF EXISTS workflows;
  DROP TABLE IF EXISTS schedules;
  `,
  `
  ALTER TABLE projects ADD COLUMN default_effort TEXT;
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  `,
  // Autonomous no longer needs a global unlock or a per-project confirmation.
  `
  ALTER TABLE projects DROP COLUMN autonomous_confirmed;
  DELETE FROM settings WHERE key = 'autonomousUnlocked';
  `,
  // Dev server command per project; full-text index over prompts and answers (rowid = events.rowid).
  `
  ALTER TABLE projects ADD COLUMN dev_command TEXT;
  CREATE VIRTUAL TABLE events_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
  INSERT INTO events_fts(rowid, text)
    SELECT rowid, json_extract(body, '$.text') FROM events
    WHERE type IN ('user.message', 'assistant.text') AND json_extract(body, '$.text') IS NOT NULL;
  CREATE TRIGGER events_fts_insert AFTER INSERT ON events
    WHEN new.type IN ('user.message', 'assistant.text') BEGIN
      INSERT INTO events_fts(rowid, text) VALUES (new.rowid, json_extract(new.body, '$.text'));
    END;
  CREATE TRIGGER events_fts_delete AFTER DELETE ON events
    WHEN old.type IN ('user.message', 'assistant.text') BEGIN
      DELETE FROM events_fts WHERE rowid = old.rowid;
    END;
  `,
  // Phone calls with their transcript (the phone settings live in the settings table under "phone").
  `
  CREATE TABLE phone_calls (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    number TEXT NOT NULL,
    reason TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    result TEXT NOT NULL,
    detail TEXT,
    transcript TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX phone_calls_started ON phone_calls(started_at DESC);
  `,
  // Automatic continuation after a usage limit. due_at NULL: nothing planned, the row only keeps the
  // count of continuations without user input. resets_at NULL: reset time unknown, due_at is the next check.
  `
  CREATE TABLE auto_continue (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    due_at TEXT,
    resets_at TEXT,
    after_seq INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    probes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX auto_continue_due ON auto_continue(due_at);
  `,
  // Push to main/master is allowed by default now. Existing installs get the rule switched off once;
  // without a stored list the new default applies. Switching it back on afterwards sticks.
  `
  UPDATE settings SET value = json_insert(value, '$[#]', 'git-push-protected')
  WHERE key = 'disabledPolicyRules'
    AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value = 'git-push-protected');
  `,
  // Last context usage, so ended sessions still show it; the session that started an agent (survives
  // restarts); tool calls and their results in the full-text index (tool calls: name plus every
  // string in the input).
  `
  ALTER TABLE sessions ADD COLUMN context TEXT;
  ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
  CREATE INDEX sessions_parent ON sessions(parent_session_id);
  DROP TRIGGER events_fts_insert;
  DROP TRIGGER events_fts_delete;
  INSERT INTO events_fts(rowid, text)
    SELECT rowid, CASE type
      WHEN 'tool.use' THEN json_extract(body, '$.name') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_tree(body, '$.input') WHERE json_tree.type = 'text'), '')
      ELSE json_extract(body, '$.content.text') END
    FROM events WHERE type IN ('tool.use', 'tool.result');
  CREATE TRIGGER events_fts_insert AFTER INSERT ON events
    WHEN new.type IN ('user.message', 'assistant.text', 'tool.use', 'tool.result') BEGIN
      INSERT INTO events_fts(rowid, text) VALUES (new.rowid, CASE new.type
        WHEN 'tool.use' THEN json_extract(new.body, '$.name') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_tree(new.body, '$.input') WHERE json_tree.type = 'text'), '')
        WHEN 'tool.result' THEN json_extract(new.body, '$.content.text')
        ELSE json_extract(new.body, '$.text') END);
    END;
  CREATE TRIGGER events_fts_delete AFTER DELETE ON events
    WHEN old.type IN ('user.message', 'assistant.text', 'tool.use', 'tool.result') BEGIN
      DELETE FROM events_fts WHERE rowid = old.rowid;
    END;
  `,
];

export const DEFAULT_SETTINGS: Settings = {
  claudePath: null,
  defaultModel: null,
  defaultEffort: null,
  defaultProfile: "autonomous",
  stripApiKey: true,
  enterToSend: true,
  sounds: true,
  debugLogs: false,
  defaultProjectDir: null,
  autoContinueAfterLimit: true,
  updateChecks: true,
  desktopNotifications: true,
  disabledPolicyRules: [...DEFAULT_DISABLED_POLICY_RULES],
};

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  path_key: string;
  favorite: number;
  tags: string;
  technologies: string;
  profile: string;
  default_model: string | null;
  default_effort: string | null;
  created_at: string;
  last_opened_at: string | null;
  test_command: string | null;
  dev_command: string | null;
  parent_id: string | null;
}

interface SessionRow {
  id: string;
  project_id: string;
  claude_session_id: string | null;
  cwd: string;
  title: string | null;
  model: string | null;
  effort: string | null;
  profile: string;
  permission_mode: string;
  status: string;
  api_key_source: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

export type ProjectRecord = Omit<Project, "exists">;
export type SessionRecord = Omit<Session, "live" | "background" | "subagents" | "context" | "autoContinueAt">;

export interface AutoContinueRecord {
  sessionId: string;
  /** ISO; null when nothing is planned */
  dueAt: string | null;
  /** ISO; null when the reset time is unknown */
  resetsAt: string | null;
  /** last event of the session when the limit stopped it; later user messages or results make the plan stale */
  afterSeq: number;
  /** automatic continuations without user input */
  attempts: number;
  /** plan usage checks while the reset time is unknown */
  probes: number;
}

interface AutoContinueRow {
  session_id: string;
  due_at: string | null;
  resets_at: string | null;
  after_seq: number;
  attempts: number;
  probes: number;
}

function toAutoContinue(r: AutoContinueRow): AutoContinueRecord {
  return { sessionId: r.session_id, dueAt: r.due_at, resetsAt: r.resets_at, afterSeq: r.after_seq, attempts: r.attempts, probes: r.probes };
}

const now = () => new Date().toISOString();

/** Events per sessions.events call; the newest ones, older ones via beforeSeq. */
export const EVENT_PAGE_LIMIT = 20_000;
/**
 * Page size for the chat (sessions.events). Opening a long session used to load, parse and render up
 * to 20,000 events at once; older pages load when the user scrolls up or a search hit needs them.
 */
export const HISTORY_PAGE_LIMIT = 2_000;

function toProject(r: ProjectRow): ProjectRecord {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    favorite: !!r.favorite,
    tags: JSON.parse(r.tags) as string[],
    technologies: JSON.parse(r.technologies) as string[],
    profile: r.profile as ProfileId,
    defaultModel: r.default_model,
    defaultEffort: (r.default_effort as EffortLevel | null) ?? null,
    createdAt: r.created_at,
    lastOpenedAt: r.last_opened_at,
    testCommand: r.test_command,
    devCommand: r.dev_command,
    parentId: r.parent_id,
  };
}

function toSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    claudeSessionId: r.claude_session_id,
    cwd: r.cwd,
    title: r.title,
    model: r.model,
    effort: (r.effort as EffortLevel | null) ?? null,
    profile: r.profile as ProfileId,
    permissionMode: r.permission_mode as PermissionMode,
    status: r.status as SessionStatus,
    apiKeySource: r.api_key_source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastError: r.last_error,
  };
}

export class Db {
  readonly sql: DatabaseSync;
  private seqCache = new Map<string, number>();
  private stmts = new Map<string, StatementSync>();

  /** Prepared once per SQL text; used on the hot paths (every stream event hits them). */
  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.sql.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate() {
    const row = this.sql.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.sql.exec("BEGIN");
      try {
        this.sql.exec(MIGRATIONS[v]!);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
        this.sql.exec("COMMIT");
      } catch (e) {
        this.sql.exec("ROLLBACK");
        throw e;
      }
    }
  }

  close() {
    this.sql.close();
  }

  // ---- settings

  getSettings(): Settings {
    const rows = this.sql.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value);
    return out as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.sql.prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !(k in DEFAULT_SETTINGS)) continue;
      stmt.run(k, JSON.stringify(v));
    }
    return this.getSettings();
  }

  /** Every stored setting as raw JSON text (the phone settings included), for backups. */
  rawSettings(): Record<string, string> {
    const rows = this.sql.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Replaces the stored settings with the given ones; `keep` stays as it is. */
  replaceRawSettings(values: Record<string, string>, keep: string[] = []) {
    this.sql.exec("BEGIN");
    try {
      const keys = Object.keys(this.rawSettings()).filter((k) => !keep.includes(k));
      const del = this.sql.prepare("DELETE FROM settings WHERE key = ?");
      for (const k of keys) del.run(k);
      const ins = this.sql.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      for (const [k, v] of Object.entries(values)) if (!keep.includes(k)) ins.run(k, v);
      this.sql.exec("COMMIT");
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- projects

  listProjects(): ProjectRecord[] {
    const rows = this.sql
      .prepare("SELECT * FROM projects ORDER BY favorite DESC, COALESCE(last_opened_at, created_at) DESC")
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  getProject(id: string): ProjectRecord | null {
    const r = this.sql.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  findProjectByKey(pathKey: string): ProjectRecord | null {
    const r = this.sql.prepare("SELECT * FROM projects WHERE path_key = ?").get(pathKey) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  insertProject(p: ProjectRecord, pathKey: string) {
    this.sql
      .prepare(
        `INSERT INTO projects(id, name, path, path_key, favorite, tags, technologies, profile, default_model, default_effort, created_at, last_opened_at, test_command, dev_command, parent_id)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.name,
        p.path,
        pathKey,
        p.favorite ? 1 : 0,
        JSON.stringify(p.tags),
        JSON.stringify(p.technologies),
        p.profile,
        p.defaultModel,
        p.defaultEffort,
        p.createdAt,
        p.lastOpenedAt,
        p.testCommand,
        p.devCommand,
        p.parentId,
      );
  }

  updateProject(id: string, patch: Partial<ProjectRecord>) {
    const cols: Record<string, unknown> = {};
    if (patch.name !== undefined) cols.name = patch.name;
    if (patch.favorite !== undefined) cols.favorite = patch.favorite ? 1 : 0;
    if (patch.tags !== undefined) cols.tags = JSON.stringify(patch.tags);
    if (patch.technologies !== undefined) cols.technologies = JSON.stringify(patch.technologies);
    if (patch.profile !== undefined) cols.profile = patch.profile;
    if (patch.defaultModel !== undefined) cols.default_model = patch.defaultModel;
    if (patch.defaultEffort !== undefined) cols.default_effort = patch.defaultEffort;
    if (patch.lastOpenedAt !== undefined) cols.last_opened_at = patch.lastOpenedAt;
    if (patch.testCommand !== undefined) cols.test_command = patch.testCommand;
    if (patch.devCommand !== undefined) cols.dev_command = patch.devCommand;
    const keys = Object.keys(cols);
    if (!keys.length) return;
    this.sql
      .prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...(Object.values(cols) as Array<string | number | null>), id);
  }

  deleteProject(id: string): boolean {
    return this.sql.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }

  /** parent_id has no foreign key: worktrees of a removed project become standalone projects. */
  detachChildProjects(parentId: string) {
    this.sql.prepare("UPDATE projects SET parent_id = NULL WHERE parent_id = ?").run(parentId);
  }

  // ---- sessions

  insertSession(s: SessionRecord) {
    this.sql
      .prepare(
        `INSERT INTO sessions(id, project_id, claude_session_id, cwd, title, model, effort, profile, permission_mode, status, api_key_source, created_at, updated_at, last_error)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.projectId,
        s.claudeSessionId,
        s.cwd,
        s.title,
        s.model,
        s.effort,
        s.profile,
        s.permissionMode,
        s.status,
        s.apiKeySource,
        s.createdAt,
        s.updatedAt,
        s.lastError,
      );
  }

  updateSession(id: string, patch: Partial<SessionRecord>): SessionRecord | null {
    const map: Record<string, string> = {
      claudeSessionId: "claude_session_id",
      title: "title",
      model: "model",
      effort: "effort",
      profile: "profile",
      permissionMode: "permission_mode",
      status: "status",
      apiKeySource: "api_key_source",
      lastError: "last_error",
    };
    const sets: string[] = ["updated_at = ?"];
    const vals: Array<string | null> = [now()];
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(v as string | null);
      }
    }
    this.stmt(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getSession(id);
  }

  /** Events go with the session (ON DELETE CASCADE); approvals stay as audit log. */
  deleteSession(id: string): boolean {
    return this.sql.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  }

  getSession(id: string): SessionRecord | null {
    const r = this.stmt("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return r ? toSession(r) : null;
  }

  getSessionContext(id: string): ContextUsage | null {
    const r = this.stmt("SELECT context FROM sessions WHERE id = ?").get(id) as { context: string | null } | undefined;
    return r?.context ? (JSON.parse(r.context) as ContextUsage) : null;
  }

  /** Not via updateSession: a new context value is no activity and must not move the session up the list. */
  setSessionContext(id: string, context: ContextUsage | null) {
    this.stmt("UPDATE sessions SET context = ? WHERE id = ?").run(context ? JSON.stringify(context) : null, id);
  }

  /** The session that started this one as an agent. */
  getSessionParent(id: string): string | null {
    const r = this.stmt("SELECT parent_session_id FROM sessions WHERE id = ?").get(id) as { parent_session_id: string | null } | undefined;
    return r?.parent_session_id ?? null;
  }

  setSessionParent(id: string, parentId: string | null) {
    this.stmt("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run(parentId, id);
  }

  /** Agents started by this session, oldest first. */
  listSessionChildren(parentId: string): string[] {
    const rows = this.stmt("SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY created_at").all(parentId) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  listSessions(projectId: string): SessionRecord[] {
    const rows = this.sql
      .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  listAllSessions(query?: string, status?: string): Array<SessionRecord & { projectName: string }> {
    const where: string[] = [];
    const vals: string[] = [];
    if (query) {
      where.push("(s.title LIKE ? OR p.name LIKE ? OR s.claude_session_id LIKE ?)");
      const q = `%${query}%`;
      vals.push(q, q, q);
    }
    if (status) {
      where.push("s.status = ?");
      vals.push(status);
    }
    const rows = this.sql
      .prepare(
        `SELECT s.*, p.name AS project_name FROM sessions s JOIN projects p ON p.id = s.project_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY s.updated_at DESC LIMIT 500`,
      )
      .all(...vals) as unknown as Array<SessionRow & { project_name: string }>;
    return rows.map((r) => ({ ...toSession(r), projectName: r.project_name }));
  }

  latestSession(projectId: string): SessionRecord | null {
    const r = this.sql
      .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(projectId) as SessionRow | undefined;
    return r ? toSession(r) : null;
  }

  /** On startup: sessions that were live when the app died can't be live anymore. */
  markOrphanedSessions(): number {
    return Number(
      this.sql
        .prepare(
          `UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE status IN ('starting','running','waiting_approval','stopping','idle')`,
        )
        .run(now()).changes,
    );
  }

  // ---- automatic continuation after a usage limit

  getAutoContinue(sessionId: string): AutoContinueRecord | null {
    const r = this.stmt("SELECT * FROM auto_continue WHERE session_id = ?").get(sessionId) as AutoContinueRow | undefined;
    return r ? toAutoContinue(r) : null;
  }

  setAutoContinue(a: AutoContinueRecord) {
    this.stmt(
      `INSERT INTO auto_continue(session_id, due_at, resets_at, after_seq, attempts, probes, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET due_at = excluded.due_at, resets_at = excluded.resets_at, after_seq = excluded.after_seq,
         attempts = excluded.attempts, probes = excluded.probes, updated_at = excluded.updated_at`,
    ).run(a.sessionId, a.dueAt, a.resetsAt, a.afterSeq, a.attempts, a.probes, now());
  }

  clearAutoContinue(sessionId: string): boolean {
    return this.stmt("DELETE FROM auto_continue WHERE session_id = ?").run(sessionId).changes > 0;
  }

  /** Plans due at or before `at` (ISO strings of the same format compare chronologically). */
  listDueAutoContinue(at: string): AutoContinueRecord[] {
    const rows = this.stmt("SELECT * FROM auto_continue WHERE due_at IS NOT NULL AND due_at <= ? ORDER BY due_at").all(at) as unknown as AutoContinueRow[];
    return rows.map(toAutoContinue);
  }

  listPendingAutoContinue(): AutoContinueRecord[] {
    const rows = this.stmt("SELECT * FROM auto_continue WHERE due_at IS NOT NULL").all() as unknown as AutoContinueRow[];
    return rows.map(toAutoContinue);
  }

  /** Types of the session's events after afterSeq that a plan cares about. */
  hasEventsAfter(sessionId: string, afterSeq: number, types: string[]): boolean {
    const r = this.sql
      .prepare(`SELECT 1 AS x FROM events WHERE session_id = ? AND seq > ? AND type IN (${types.map(() => "?").join(", ")}) LIMIT 1`)
      .get(sessionId, afterSeq, ...types);
    return !!r;
  }

  lastEventSeq(sessionId: string): number {
    const r = this.stmt("SELECT MAX(seq) AS m FROM events WHERE session_id = ?").get(sessionId) as { m: number | null };
    return r.m ?? 0;
  }

  // ---- events

  private nextSeq(sessionId: string): number {
    let cur = this.seqCache.get(sessionId);
    if (cur === undefined) {
      const r = this.stmt("SELECT MAX(seq) AS m FROM events WHERE session_id = ?").get(sessionId) as { m: number | null };
      cur = r.m ?? 0;
    }
    cur += 1;
    this.seqCache.set(sessionId, cur);
    return cur;
  }

  /** Copies the events before `beforeSeq` (all without it) of one session into another (branches). */
  copyEvents(fromSessionId: string, toSessionId: string, beforeSeq = Number.MAX_SAFE_INTEGER) {
    this.stmt("INSERT INTO events(session_id, seq, ts, type, body) SELECT ?, seq, ts, type, body FROM events WHERE session_id = ? AND seq < ?").run(toSessionId, fromSessionId, beforeSeq);
  }

  /** One event by its number, or null. */
  getEvent(sessionId: string, seq: number): SessionEvent | null {
    const r = this.stmt("SELECT seq, ts, body FROM events WHERE session_id = ? AND seq = ?").get(sessionId, seq) as { seq: number; ts: string; body: string } | undefined;
    return r ? { seq: r.seq, sessionId, ts: r.ts, body: JSON.parse(r.body) as SessionEventBody } : null;
  }

  appendEvent(sessionId: string, body: SessionEventBody): SessionEvent {
    const ev: SessionEvent = { seq: this.nextSeq(sessionId), sessionId, ts: now(), body };
    this.stmt("INSERT INTO events(session_id, seq, ts, type, body) VALUES(?, ?, ?, ?, ?)").run(sessionId, ev.seq, ev.ts, body.type, JSON.stringify(body));
    return ev;
  }

  /**
   * The newest `limit` events with afterSeq < seq < beforeSeq, in ascending order. A long session
   * thus always shows its latest state; older events are paged with beforeSeq.
   */
  listEvents(sessionId: string, afterSeq = 0, opts: { beforeSeq?: number; limit?: number } = {}): SessionEvent[] {
    const rows = this.stmt(
      `SELECT seq, ts, body FROM (
         SELECT seq, ts, body FROM events WHERE session_id = ? AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
    ).all(sessionId, afterSeq, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, opts.limit ?? EVENT_PAGE_LIMIT) as Array<{ seq: number; ts: string; body: string }>;
    return rows.map((r) => ({ seq: r.seq, sessionId, ts: r.ts, body: JSON.parse(r.body) as SessionEventBody }));
  }

  /** Ids of all user messages of a session (own sends, imports, remote echoes), however long it is. */
  listUserMessageUuids(sessionId: string): string[] {
    const rows = this.stmt(
      "SELECT json_extract(body, '$.uuid') AS uuid FROM events WHERE session_id = ? AND type = 'user.message' AND json_extract(body, '$.uuid') IS NOT NULL",
    ).all(sessionId) as Array<{ uuid: string }>;
    return rows.map((r) => r.uuid);
  }

  /** The newest user messages of a session, newest first. */
  listRecentUserMessages(sessionId: string, limit: number): Array<Extract<SessionEventBody, { type: "user.message" }>> {
    const rows = this.stmt("SELECT body FROM events WHERE session_id = ? AND type = 'user.message' ORDER BY seq DESC LIMIT ?").all(sessionId, limit) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body) as Extract<SessionEventBody, { type: "user.message" }>);
  }

  // ---- full-text search

  /**
   * Prompts, answers, tool calls and tool results matching all words of the query (prefix match, case and accents ignored),
   * best matches first. Prompts and answers come before tool hits: tool output is plentiful and would push them out. The query is reduced to plain words, so FTS syntax in it has no effect.
   */
  searchEvents(query: string, limit: number): SearchHit[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
    if (!words.length) return [];
    const match = words.map((w) => `"${w}"*`).join(" ");
    const rows = this.sql
      .prepare(
        `SELECT e.session_id, e.seq, e.ts, e.type, s.project_id, s.title, p.name AS project_name,
                snippet(events_fts, 0, '${SEARCH_MARK_START}', '${SEARCH_MARK_END}', '…', 16) AS snippet
         FROM events_fts f
         JOIN events e ON e.rowid = f.rowid
         JOIN sessions s ON s.id = e.session_id
         JOIN projects p ON p.id = s.project_id
         WHERE events_fts MATCH ?
         ORDER BY e.type IN ('tool.use', 'tool.result'), f.rank, e.ts DESC
         LIMIT ?`,
      )
      .all(match, limit) as Array<{ session_id: string; seq: number; ts: string; type: string; project_id: string; title: string | null; project_name: string; snippet: string }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      projectId: r.project_id,
      projectName: r.project_name,
      sessionTitle: r.title,
      seq: r.seq,
      ts: r.ts,
      role: r.type === "user.message" ? "user" : r.type === "assistant.text" ? "assistant" : "tool",
      snippet: r.snippet,
    }));
  }

  // ---- phone

  /** Raw stored phone settings; the phone service fills in defaults. */
  getPhoneSettings(): Record<string, unknown> {
    const r = this.sql.prepare("SELECT value FROM settings WHERE key = 'phone'").get() as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  setPhoneSettings(value: Record<string, unknown>) {
    this.sql
      .prepare("INSERT INTO settings(key, value) VALUES('phone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(value));
  }

  savePhoneCall(c: PhoneCallRecord) {
    this.sql
      .prepare(
        `INSERT INTO phone_calls(id, direction, number, reason, started_at, ended_at, result, detail, transcript) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, result = excluded.result, detail = excluded.detail, transcript = excluded.transcript`,
      )
      .run(c.id, c.direction, c.number, c.reason, c.startedAt, c.endedAt, c.result, c.detail, JSON.stringify(c.transcript));
  }

  listPhoneCalls(limit: number): PhoneCallRecord[] {
    const rows = this.sql.prepare("SELECT * FROM phone_calls ORDER BY started_at DESC LIMIT ?").all(limit) as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: r.id!,
      direction: r.direction as PhoneCallRecord["direction"],
      number: r.number!,
      reason: r.reason ?? null,
      startedAt: r.started_at!,
      endedAt: r.ended_at ?? null,
      result: r.result as PhoneCallRecord["result"],
      detail: r.detail ?? null,
      transcript: JSON.parse(r.transcript ?? "[]") as PhoneCallRecord["transcript"],
    }));
  }

  // ---- approvals audit

  recordApproval(a: {
    sessionId: string;
    requestId: string;
    toolName: string;
    input: unknown;
    decision: string;
    scope: string;
    source: string;
    reason: string | null;
  }) {
    this.stmt("INSERT INTO approvals(session_id, request_id, tool_name, input, decision, scope, source, reason, ts) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)").run(a.sessionId, a.requestId, a.toolName, JSON.stringify(a.input), a.decision, a.scope, a.source, a.reason, now());
  }
}
