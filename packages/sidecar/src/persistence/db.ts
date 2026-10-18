import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { UsageSample } from "../claude/usage-forecast.js";
import { DEFAULT_DISABLED_POLICY_RULES, SEARCH_MARK_END, SEARCH_MARK_START, type ContextUsage, type EffortLevel, type ModelTokens, type ForgeUsagePurpose, type PermissionMode, type ProfileId, type Project, type PhoneCallRecord, type PromptTemplate, type SearchFilter, type SearchHit, type Session, type SessionEvent, type SessionEventBody, type SessionStatus, type Settings } from "@forge/protocol";

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
  // Dev tools per project (test environment, test database). The test environment may hold secrets,
  // so it stays here and never goes into the project folder.
  `
  CREATE TABLE dev_tools (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    config TEXT NOT NULL
  );
  `,
  // Deleting local branches is allowed by default now, so Claude can remove the branches of finished
  // agents. Like the push rule above: switched off once, switching it back on afterwards sticks.
  `
  UPDATE settings SET value = json_insert(value, '$[#]', 'git-branch-delete')
  WHERE key = 'disabledPolicyRules'
    AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value = 'git-branch-delete');
  `,
  // Projects without git: no git areas, no agents, and Claude is told not to use git.
  `
  ALTER TABLE projects ADD COLUMN git_enabled INTEGER NOT NULL DEFAULT 1;
  `,
  // Sessions that were open when FORGE ended for an update; the next start opens them again and lets
  // the working ones continue. from_version: the version that wrote the row.
  `
  CREATE TABLE update_resume (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    working INTEGER NOT NULL,
    from_version TEXT,
    marked_at TEXT NOT NULL
  );
  `,
  // The setup assistant is for installations that were never used; one that already has projects,
  // sessions or settings counts as set up. A new database is still empty here.
  `
  INSERT INTO settings(key, value)
  SELECT 'setupDone', 'true'
  WHERE EXISTS (SELECT 1 FROM projects) OR EXISTS (SELECT 1 FROM sessions) OR EXISTS (SELECT 1 FROM settings WHERE key <> 'knownModels')
  ON CONFLICT(key) DO NOTHING;
  `,
  // Readings of the plan usage windows for the limit forecast; times in epoch milliseconds.
  `
  CREATE TABLE usage_samples (
    window_key TEXT NOT NULL,
    resets_at INTEGER NOT NULL,
    at INTEGER NOT NULL,
    utilization REAL NOT NULL
  );
  CREATE INDEX usage_samples_at ON usage_samples(at);
  `,
  // What became of parallel agents (merged, discarded, waiting ...), for the daily report: after a
  // merge their worktree project and sessions are gone. No foreign keys, the rows outlive both.
  // commits: JSON [{ hash, subject, auto }] that a merge brought into the target branch.
  `
  CREATE TABLE agent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worktree_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    root_name TEXT NOT NULL,
    branch TEXT,
    title TEXT,
    session_id TEXT,
    parent_session_id TEXT,
    started_at TEXT,
    outcome TEXT NOT NULL,
    message TEXT,
    commits TEXT NOT NULL DEFAULT '[]',
    ts TEXT NOT NULL
  );
  CREATE INDEX agent_log_ts ON agent_log(ts);
  CREATE INDEX agent_log_worktree ON agent_log(worktree_id, id);
  `,
  // Prompt templates; project_id NULL: global. sort_order counts within the globals and within each project.
  `
  CREATE TABLE prompt_templates (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    text TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX prompt_templates_project ON prompt_templates(project_id, sort_order);
  `,
  // Tokens and working time of every Claude call, for the statistics of the daily report. Session events
  // go with their session (an agent's after its merge); these rows stay. kind: session, assist (titles,
  // commit messages, summaries), phone. ts: end of the call; started = ts - duration_ms.
  `
  CREATE TABLE claude_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    project_id TEXT,
    root_id TEXT,
    root_name TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    is_error INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX claude_usage_ts ON claude_usage(ts);
  INSERT INTO claude_usage(ts, kind, session_id, project_id, root_id, root_name, duration_ms, input_tokens, output_tokens, cache_read_tokens, is_error)
    SELECT e.ts, 'session', e.session_id, s.project_id, COALESCE(p.parent_id, s.project_id), COALESCE(r.name, p.name),
           COALESCE(json_extract(e.body, '$.durationMs'), 0), COALESCE(json_extract(e.body, '$.inputTokens'), 0),
           COALESCE(json_extract(e.body, '$.outputTokens'), 0), COALESCE(json_extract(e.body, '$.cacheReadTokens'), 0),
           COALESCE(json_extract(e.body, '$.isError'), 0)
    FROM events e JOIN sessions s ON s.id = e.session_id JOIN projects p ON p.id = s.project_id LEFT JOIN projects r ON r.id = p.parent_id
    WHERE e.type = 'turn.result';
  `,
  // Requests to the API per call (numTurns of the result): the context read from the cache is per request.
  `
  ALTER TABLE claude_usage ADD COLUMN api_calls INTEGER NOT NULL DEFAULT 0;
  UPDATE claude_usage SET api_calls = COALESCE((SELECT json_extract(e.body, '$.numTurns') FROM events e
    WHERE e.session_id = claude_usage.session_id AND e.ts = claude_usage.ts AND e.type = 'turn.result' LIMIT 1), 0)
  WHERE kind = 'session';
  `,
  // What FORGE caused (ForgeUsagePurpose); NULL: the user's own turn. A session turn is "auto" when the
  // message that started it was sent by FORGE (source auto).
  `
  ALTER TABLE claude_usage ADD COLUMN purpose TEXT;
  UPDATE claude_usage SET purpose = 'phone' WHERE kind = 'phone';
  UPDATE claude_usage SET purpose = 'other' WHERE kind = 'assist';
  UPDATE claude_usage SET purpose = 'auto' WHERE kind = 'session' AND (
    SELECT json_extract(e.body, '$.source') FROM events e
    WHERE e.session_id = claude_usage.session_id AND e.type = 'user.message' AND e.ts <= claude_usage.ts ORDER BY e.seq DESC LIMIT 1) = 'auto';
  `,
  // auto-merge became the default (2026-10-17): main projects with git get it once; switching it off stays possible.
  `
  UPDATE projects SET tags = json_insert(tags, '$[#]', 'auto-merge')
  WHERE parent_id IS NULL AND git_enabled = 1 AND NOT EXISTS (SELECT 1 FROM json_each(projects.tags) WHERE value = 'auto-merge');
  `,
  // Counters for the usage statistics that no other table keeps: removed projects are gone from projects.
  // Starts with the projects there are now.
  `
  CREATE TABLE stats_counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO stats_counters(key, value) SELECT 'projectsCreated', COUNT(*) FROM projects WHERE parent_id IS NULL;
  `,
  // Tokens per model of a call (JSON {model: ModelTokens}) and its estimated cost from modelUsage, which also counts
  // subagents and compaction. NULL for calls recorded before.
  `
  ALTER TABLE claude_usage ADD COLUMN models TEXT;
  ALTER TABLE claude_usage ADD COLUMN cost_usd REAL;
  `,
  // The usage statistics count from their release (USAGE_STATS_SINCE): the project counter starts with the projects since then.
  `
  UPDATE stats_counters SET value = (SELECT COUNT(*) FROM projects WHERE parent_id IS NULL AND created_at >= '2026-10-17T00:00:00.000Z')
  WHERE key = 'projectsCreated';
  `,
  // Templates FORGE made from repeated messages (TemplateLearner); an edit by the user makes them theirs.
  `
  ALTER TABLE prompt_templates ADD COLUMN learned INTEGER NOT NULL DEFAULT 0;
  `,
];

/**
 * Start of the anonymous usage statistics (the day FORGE 0.1.81 shipped them, UTC): what happened before
 * was testing during development and is not sent. Also in the migration that resets the project counter.
 */
export const USAGE_STATS_SINCE = "2026-10-17T00:00:00.000Z";

/** Sum over the models of a modelUsage. */
export function sumModels(models: Record<string, ModelTokens>): ModelTokens & { total: number } {
  const s = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const m of Object.values(models)) {
    s.inputTokens += m.inputTokens;
    s.outputTokens += m.outputTokens;
    s.cacheReadTokens += m.cacheReadTokens;
    s.cacheWriteTokens += m.cacheWriteTokens;
    s.costUsd += m.costUsd;
  }
  return { ...s, total: s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens };
}

/**
 * Tokens of one turn from two cumulative modelUsage readings of the same session. A model whose total went down
 * (a new Claude process without saved totals, /clear) counts with its whole new value.
 */
export function modelDelta(cur: Record<string, ModelTokens>, prev: Record<string, ModelTokens> | null): Record<string, ModelTokens> {
  const out: Record<string, ModelTokens> = {};
  for (const [model, c] of Object.entries(cur)) {
    const p = prev?.[model];
    const total = (m: ModelTokens) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
    const d: ModelTokens =
      p && total(c) >= total(p)
        ? {
            inputTokens: Math.max(0, c.inputTokens - p.inputTokens),
            outputTokens: Math.max(0, c.outputTokens - p.outputTokens),
            cacheReadTokens: Math.max(0, c.cacheReadTokens - p.cacheReadTokens),
            cacheWriteTokens: Math.max(0, c.cacheWriteTokens - p.cacheWriteTokens),
            costUsd: Math.max(0, c.costUsd - p.costUsd),
          }
        : c;
    if (total(d) > 0) out[model] = d;
  }
  return out;
}

/** Cumulative counters of this installation that the usage statistics send (USAGE_STATS_URL). */
export interface UsageTotals {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** turns of sessions (not titles, commit messages and the like) */
  claudeTurns: number;
  claudeWorkMs: number;
  sessions: number;
  projectsCreated: number;
  agentsStarted: number;
  agentsMerged: number;
  phoneCalls: number;
  /** session turns the user started (not FORGE on its own) */
  userTurns: number;
  /** estimated API cost (modelUsage) in US cents, from the calls recorded with it */
  costUsdCents: number;
  /** tokens and estimated cost per model, from the calls recorded with modelUsage */
  models: Record<string, { tokens: number; costUsdCents: number }>;
}

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
  idleCloseMinutes: 60,
  longSessionTokens: 200_000,
  updateChecks: true,
  desktopNotifications: true,
  alwaysOnTop: false,
  screenshotKey: true,
  uiCompare: true,
  learnTemplates: true,
  disabledPolicyRules: [...DEFAULT_DISABLED_POLICY_RULES],
  setupDone: false,
  syncEnabled: false,
  syncAsked: false,
  usageStats: true,
  usageStatsAsked: false,
};

/** When FORGE last looked for repeated messages, and the learned templates the user deleted (normalized text). */
export interface TemplateLearningState {
  lastRunAt: string | null;
  dismissed: string[];
}

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
  git_enabled: number;
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

export interface ResumeMark {
  sessionId: string;
  /** a turn, a background task or a subagent was running */
  working: boolean;
  fromVersion: string | null;
  markedAt: string;
}

export type AgentOutcome = "merged" | "discarded" | "conflict" | "waiting" | "skipped";

export interface ClaudeUsageRow {
  ts: string;
  kind: "session" | "assist" | "phone";
  /** what FORGE caused; null: the user's own turn */
  purpose: ForgeUsagePurpose | null;
  projectId: string | null;
  rootId: string | null;
  rootName: string | null;
  durationMs: number;
  /** requests to the API within the call */
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentLogEntry {
  worktreeId: string;
  rootId: string;
  rootName: string;
  branch: string | null;
  title: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  startedAt: string | null;
  outcome: AgentOutcome;
  message: string | null;
  /** commits a merge brought into the target branch */
  commits: Array<{ hash: string; subject: string; auto: boolean }>;
  ts: string;
}

/** A session with events in a time range: how many turns ended in it and when it worked. */
export interface SessionActivity {
  session: SessionRecord;
  projectName: string;
  projectParentId: string | null;
  turns: number;
  errors: number;
  firstAt: string;
  lastAt: string;
  /** auto-commits of FORGE after its turns in the range */
  autoCommits: Array<{ hash: string; subject: string }>;
}

interface AgentLogRow {
  worktree_id: string;
  root_id: string;
  root_name: string;
  branch: string | null;
  title: string | null;
  session_id: string | null;
  parent_session_id: string | null;
  started_at: string | null;
  outcome: string;
  message: string | null;
  commits: string;
  ts: string;
}

function toAgentLog(r: AgentLogRow): AgentLogEntry {
  return {
    worktreeId: r.worktree_id,
    rootId: r.root_id,
    rootName: r.root_name,
    branch: r.branch,
    title: r.title,
    sessionId: r.session_id,
    parentSessionId: r.parent_session_id,
    startedAt: r.started_at,
    outcome: r.outcome as AgentOutcome,
    message: r.message,
    commits: JSON.parse(r.commits) as AgentLogEntry["commits"],
    ts: r.ts,
  };
}

interface TemplateRow {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  text: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  learned: number;
}

function toTemplate(r: TemplateRow): PromptTemplate {
  return { id: r.id, projectId: r.project_id, name: r.name, description: r.description, text: r.text, sortOrder: Number(r.sort_order), createdAt: r.created_at, updatedAt: r.updated_at, ...(r.learned ? { learned: true } : {}) };
}

function toPhoneCall(r: Record<string, string | null>): PhoneCallRecord {
  return {
    id: r.id!,
    direction: r.direction as PhoneCallRecord["direction"],
    number: r.number!,
    reason: r.reason ?? null,
    startedAt: r.started_at!,
    endedAt: r.ended_at ?? null,
    result: r.result as PhoneCallRecord["result"],
    detail: r.detail ?? null,
    transcript: JSON.parse(r.transcript ?? "[]") as PhoneCallRecord["transcript"],
  };
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
    gitEnabled: r.git_enabled !== 0,
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

  /** Model values Claude Code offered so far; null before the first look. Not a setting, so not in getSettings. */
  getKnownModels(): string[] | null {
    const r = this.stmt("SELECT value FROM settings WHERE key = 'knownModels'").get() as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as string[]) : null;
  }

  setKnownModels(values: string[]) {
    this.stmt("INSERT INTO settings(key, value) VALUES('knownModels', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(values));
  }

  /** State of the template learning (TemplateLearner); not a setting, so not in getSettings. */
  getTemplateLearning(): TemplateLearningState {
    const r = this.stmt("SELECT value FROM settings WHERE key = 'templateLearning'").get() as { value: string } | undefined;
    const v = r ? (JSON.parse(r.value) as Partial<TemplateLearningState>) : {};
    return { lastRunAt: v.lastRunAt ?? null, dismissed: Array.isArray(v.dismissed) ? v.dismissed : [] };
  }

  setTemplateLearning(state: TemplateLearningState) {
    this.stmt("INSERT INTO settings(key, value) VALUES('templateLearning', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(state));
  }

  /** The newest user messages of all sessions with their session's project, newest first. */
  recentUserMessages(limit: number): Array<{ projectId: string; ts: string; body: Extract<SessionEventBody, { type: "user.message" }> }> {
    const rows = this.stmt(
      `SELECT e.body AS body, e.ts AS ts, s.project_id AS project_id FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.type = 'user.message' ORDER BY e.ts DESC LIMIT ?`,
    ).all(limit) as Array<{ body: string; ts: string; project_id: string }>;
    return rows.map((r) => ({ projectId: r.project_id, ts: r.ts, body: JSON.parse(r.body) as Extract<SessionEventBody, { type: "user.message" }> }));
  }

  countUserMessagesSince(ts: string | null): number {
    const r = (ts === null
      ? this.stmt("SELECT COUNT(*) AS n FROM events WHERE type = 'user.message'").get()
      : this.stmt("SELECT COUNT(*) AS n FROM events WHERE type = 'user.message' AND ts > ?").get(ts)) as { n: number };
    return Number(r.n);
  }

  /** Every stored setting as raw JSON text (the phone settings included), for backups. */
  rawSettings(): Record<string, string> {
    const rows = this.sql.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /**
   * Replaces the stored settings with the given ones; `keep` stays as it is, and so does every key
   * whose new value is no JSON (getSettings would fail on it). Returns the keys skipped for that.
   */
  replaceRawSettings(values: Record<string, string>, keep: string[] = []): string[] {
    const invalid = Object.entries(values)
      .filter(([, v]) => {
        try {
          JSON.parse(v);
          return false;
        } catch {
          return true;
        }
      })
      .map(([k]) => k);
    const stays = new Set([...keep, ...invalid]);
    this.sql.exec("BEGIN");
    try {
      const keys = Object.keys(this.rawSettings()).filter((k) => !stays.has(k));
      const del = this.sql.prepare("DELETE FROM settings WHERE key = ?");
      for (const k of keys) del.run(k);
      const ins = this.sql.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      for (const [k, v] of Object.entries(values)) if (!stays.has(k)) ins.run(k, v);
      this.sql.exec("COMMIT");
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
    return invalid;
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

  /** `restored`: back from a backup, no new project for the usage statistics */
  insertProject(p: ProjectRecord, pathKey: string, restored = false) {
    this.sql
      .prepare(
        `INSERT INTO projects(id, name, path, path_key, favorite, tags, technologies, profile, default_model, default_effort, created_at, last_opened_at, test_command, dev_command, parent_id, git_enabled)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        p.gitEnabled ? 1 : 0,
      );
    // Agent worktrees are projects too, but they count as agents.
    if (!p.parentId && !restored) this.bumpCounter("projectsCreated");
  }

  // ---- usage statistics

  private bumpCounter(key: string) {
    this.sql.prepare("INSERT INTO stats_counters(key, value) VALUES(?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1").run(key);
  }

  /** Totals since USAGE_STATS_SINCE for the anonymous usage statistics; only from rows that outlive deletions. */
  usageTotals(since = USAGE_STATS_SINCE): UsageTotals {
    const u = this.sql
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS tokensInput, COALESCE(SUM(output_tokens), 0) AS tokensOutput,
                COALESCE(SUM(cache_read_tokens), 0) AS tokensCacheRead, COALESCE(SUM(cache_write_tokens), 0) AS tokensCacheWrite,
                COALESCE(SUM(CASE WHEN kind = 'session' THEN 1 ELSE 0 END), 0) AS claudeTurns,
                COALESCE(SUM(duration_ms), 0) AS claudeWorkMs,
                COUNT(DISTINCT CASE WHEN kind = 'session' THEN session_id END) AS sessions
         FROM claude_usage WHERE ts >= ?`,
      )
      .get(since) as Pick<UsageTotals, "tokensInput" | "tokensOutput" | "tokensCacheRead" | "tokensCacheWrite" | "claudeTurns" | "claudeWorkMs" | "sessions">;
    // An agent is in agent_log once it finished; one still running is only its worktree project (same id).
    const a = this.sql
      .prepare(
        `SELECT (SELECT COUNT(*) FROM (SELECT worktree_id FROM agent_log WHERE COALESCE(started_at, ts) >= ?1
                                       UNION SELECT id FROM projects WHERE parent_id IS NOT NULL AND created_at >= ?1)) AS agentsStarted,
                (SELECT COUNT(DISTINCT worktree_id) FROM agent_log WHERE outcome = 'merged' AND ts >= ?1) AS agentsMerged`,
      )
      .get(since) as { agentsStarted: number; agentsMerged: number };
    const projects = this.sql.prepare("SELECT value FROM stats_counters WHERE key = 'projectsCreated'").get() as { value: number } | undefined;
    const calls = this.sql.prepare("SELECT COUNT(*) AS n FROM phone_calls WHERE started_at >= ?").get(since) as { n: number };
    const userTurns = this.sql.prepare("SELECT COUNT(*) AS n FROM claude_usage WHERE kind = 'session' AND purpose IS NULL AND ts >= ?").get(since) as { n: number };
    // Cost and models only exist for calls recorded with modelUsage; older ones count in the token sums above only.
    const cost = this.sql.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM claude_usage WHERE ts >= ?").get(since) as { c: number };
    const sums: Record<string, { tokens: number; costUsd: number }> = {};
    for (const r of this.sql.prepare("SELECT models FROM claude_usage WHERE models IS NOT NULL AND ts >= ?").all(since) as Array<{ models: string }>) {
      for (const [model, m] of Object.entries(JSON.parse(r.models) as Record<string, ModelTokens>)) {
        const t = (sums[model] ??= { tokens: 0, costUsd: 0 });
        t.tokens += m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
        t.costUsd += m.costUsd;
      }
    }
    // Rounded once at the end: per call, cents would get lost on many cheap calls.
    const models: UsageTotals["models"] = Object.fromEntries(Object.entries(sums).map(([k, t]) => [k, { tokens: t.tokens, costUsdCents: Math.round(t.costUsd * 100) }]));
    return { ...u, ...a, projectsCreated: projects?.value ?? 0, phoneCalls: calls.n, userTurns: userTurns.n, costUsdCents: Math.round(cost.c * 100), models };
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
    if (patch.gitEnabled !== undefined) cols.git_enabled = patch.gitEnabled ? 1 : 0;
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

  // ---- dev tools

  /** Stored dev tools config as JSON; null when the project has none yet. */
  getDevTools(projectId: string): unknown {
    const r = this.sql.prepare("SELECT config FROM dev_tools WHERE project_id = ?").get(projectId) as { config: string } | undefined;
    return r ? (JSON.parse(r.config) as unknown) : null;
  }

  setDevTools(projectId: string, config: unknown) {
    this.sql
      .prepare("INSERT INTO dev_tools(project_id, config) VALUES(?, ?) ON CONFLICT(project_id) DO UPDATE SET config = excluded.config")
      .run(projectId, JSON.stringify(config));
  }

  /** Test database ports taken by other projects. */
  devToolsPorts(exceptProjectId: string): number[] {
    const rows = this.sql.prepare("SELECT json_extract(config, '$.database.port') AS port FROM dev_tools WHERE project_id <> ?").all(exceptProjectId) as Array<{ port: number | null }>;
    return rows.map((r) => r.port).filter((p): p is number => typeof p === "number");
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

  listSessionIds(): string[] {
    return (this.stmt("SELECT id FROM sessions").all() as Array<{ id: string }>).map((r) => r.id);
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

  // ---- sessions to open again after a restart for an update

  /** A session marked twice (two-step update) stays working if it was working once. */
  markForResume(sessionId: string, working: boolean, fromVersion: string | null, at: string) {
    this.stmt(
      `INSERT INTO update_resume(session_id, working, from_version, marked_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET working = max(working, excluded.working), marked_at = excluded.marked_at`,
    ).run(sessionId, working ? 1 : 0, fromVersion, at);
  }

  /** Marks of a restart that did not happen yet (the second step of an update) count from `at` on. */
  touchResumeMarks(at: string) {
    this.stmt("UPDATE update_resume SET marked_at = ?").run(at);
  }

  listResumeMarks(): ResumeMark[] {
    const rows = this.stmt("SELECT * FROM update_resume ORDER BY marked_at").all() as unknown as Array<{ session_id: string; working: number; from_version: string | null; marked_at: string }>;
    return rows.map((r) => ({ sessionId: r.session_id, working: r.working === 1, fromVersion: r.from_version, markedAt: r.marked_at }));
  }

  /** Reads and removes all marks, so a failing resume is never tried again on the next start. */
  takeResumeMarks(): ResumeMark[] {
    const marks = this.listResumeMarks();
    this.stmt("DELETE FROM update_resume").run();
    return marks;
  }

  // ---- plan usage readings for the limit forecast

  /** Stores readings and drops those of windows that are over or older than `keepSince`. */
  addUsageSamples(samples: UsageSample[], keepSince: number, now: number) {
    for (const s of samples) this.stmt("INSERT INTO usage_samples(window_key, resets_at, at, utilization) VALUES(?, ?, ?, ?)").run(s.key, s.resetsAt, s.at, s.utilization);
    this.stmt("DELETE FROM usage_samples WHERE at < ? OR resets_at < ?").run(keepSince, now);
  }

  listUsageSamples(since: number): UsageSample[] {
    const rows = this.stmt("SELECT window_key, resets_at, at, utilization FROM usage_samples WHERE at >= ? ORDER BY at").all(since) as unknown as Array<{ window_key: string; resets_at: number; at: number; utilization: number }>;
    return rows.map((r) => ({ key: r.window_key, resetsAt: Number(r.resets_at), at: Number(r.at), utilization: Number(r.utilization) }));
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
    if (body.type === "turn.result") {
      // modelUsage counts subagents and compaction too, but cumulatively per Claude process: this turn is the difference.
      const turn = body.models ? modelDelta(body.models, this.lastModelTotals(sessionId, ev.seq)) : null;
      const t = turn ? sumModels(turn) : null;
      this.stmt(
        `INSERT INTO claude_usage(ts, kind, session_id, project_id, root_id, root_name, duration_ms, api_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, is_error, purpose, models, cost_usd)
         SELECT ?, 'session', s.id, s.project_id, COALESCE(p.parent_id, s.project_id), COALESCE(r.name, p.name), ?, ?, ?, ?, ?, ?, ?,
           CASE (SELECT json_extract(e.body, '$.source') FROM events e WHERE e.session_id = s.id AND e.type = 'user.message' ORDER BY e.seq DESC LIMIT 1)
             WHEN 'auto' THEN 'auto' END, ?, ?
         FROM sessions s JOIN projects p ON p.id = s.project_id LEFT JOIN projects r ON r.id = p.parent_id WHERE s.id = ?`,
      ).run(
        ev.ts,
        body.durationMs ?? 0,
        body.numTurns ?? 0,
        t?.inputTokens ?? body.inputTokens ?? 0,
        t?.outputTokens ?? body.outputTokens ?? 0,
        t?.cacheReadTokens ?? body.cacheReadTokens ?? 0,
        t?.cacheWriteTokens ?? body.cacheWriteTokens ?? 0,
        body.isError ? 1 : 0,
        turn ? JSON.stringify(turn) : null,
        t?.costUsd ?? null,
        sessionId,
      );
    }
    return ev;
  }

  /** modelUsage of the session's last result before `beforeSeq` that carried any tokens (a crashed run reports zeros). */
  private lastModelTotals(sessionId: string, beforeSeq: number): Record<string, ModelTokens> | null {
    const rows = this.stmt("SELECT body FROM events WHERE session_id = ? AND type = 'turn.result' AND seq < ? ORDER BY seq DESC LIMIT 5").all(sessionId, beforeSeq) as Array<{ body: string }>;
    for (const r of rows) {
      const models = (JSON.parse(r.body) as { models?: Record<string, ModelTokens> }).models;
      if (models && sumModels(models).total > 0) return models;
    }
    return null;
  }

  /**
   * A Claude call outside a session (titles, commit messages, summaries, the phone). With `models` (modelUsage of
   * the one-shot query, which is its total) the tokens come from there, subagents and all.
   */
  recordClaudeUsage(u: { kind: "assist" | "phone"; purpose: ForgeUsagePurpose; durationMs: number; apiCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; isError: boolean; models?: Record<string, ModelTokens> }) {
    const t = u.models ? sumModels(u.models) : null;
    this.stmt(
      `INSERT INTO claude_usage(ts, kind, purpose, duration_ms, api_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, is_error, models, cost_usd) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now(),
      u.kind,
      u.purpose,
      u.durationMs,
      u.apiCalls,
      t?.inputTokens ?? u.inputTokens,
      t?.outputTokens ?? u.outputTokens,
      t?.cacheReadTokens ?? u.cacheReadTokens,
      t?.cacheWriteTokens ?? u.cacheWriteTokens,
      u.isError ? 1 : 0,
      u.models ? JSON.stringify(u.models) : null,
      t?.costUsd ?? null,
    );
  }

  /** Claude calls that ended in [from, to), oldest first; rootIds narrows to those projects (calls outside a session drop out). */
  claudeUsageBetween(from: string, to: string, rootIds: ReadonlySet<string> | null): ClaudeUsageRow[] {
    const rows = this.stmt(
      `SELECT ts, kind, purpose, project_id, root_id, root_name, duration_ms, api_calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM claude_usage
       WHERE ts >= ? AND ts < ? ORDER BY ts`,
    ).all(from, to) as Array<{ ts: string; kind: string; purpose: string | null; project_id: string | null; root_id: string | null; root_name: string | null; duration_ms: number; api_calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }>;
    return rows
      .filter((r) => !rootIds || (r.root_id !== null && rootIds.has(r.root_id)))
      .map((r) => ({
        ts: r.ts,
        kind: r.kind as ClaudeUsageRow["kind"],
        purpose: r.purpose as ForgeUsagePurpose | null,
        projectId: r.project_id,
        rootId: r.root_id,
        rootName: r.root_name,
        durationMs: r.duration_ms,
        apiCalls: r.api_calls,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
      }));
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

  /** All events of the given types of a session after `afterSeq`, in order, however long it is. */
  listEventsOfTypes(sessionId: string, types: readonly SessionEventBody["type"][], afterSeq = 0): SessionEvent[] {
    if (!types.length) return [];
    const rows = this.stmt(`SELECT seq, ts, body FROM events WHERE session_id = ? AND seq > ? AND type IN (${types.map(() => "?").join(", ")}) ORDER BY seq ASC`).all(
      sessionId,
      afterSeq,
      ...types,
    ) as Array<{
      seq: number;
      ts: string;
      body: string;
    }>;
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
   * `phrase`: the words in this order, next to each other (the last one still as a prefix). `sessionId` / `projectId` narrow the
   * hits (a project includes the worktrees of its agents); `order: "time"` lists them newest first, for stepping through a chat.
   */
  searchEvents(query: string, limit: number, opts: SearchFilter = {}): SearchHit[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
    if (!words.length) return [];
    const match = opts.phrase ? `"${words.join(" ")}"*` : words.map((w) => `"${w}"*`).join(" ");
    const where = ["events_fts MATCH ?"];
    const args: Array<string | number> = [match];
    if (opts.sessionId) {
      where.push("e.session_id = ?");
      args.push(opts.sessionId);
    }
    if (opts.projectId) {
      where.push("(s.project_id = ? OR p.parent_id = ?)");
      args.push(opts.projectId, opts.projectId);
    }
    const order = opts.order === "time" ? "e.ts DESC, e.seq DESC" : "e.type IN ('tool.use', 'tool.result'), f.rank, e.ts DESC";
    const rows = this.sql
      .prepare(
        `SELECT e.session_id, e.seq, e.ts, e.type, s.project_id, s.title, p.name AS project_name,
                snippet(events_fts, 0, '${SEARCH_MARK_START}', '${SEARCH_MARK_END}', '…', 16) AS snippet
         FROM events_fts f
         JOIN events e ON e.rowid = f.rowid
         JOIN sessions s ON s.id = e.session_id
         JOIN projects p ON p.id = s.project_id
         WHERE ${where.join(" AND ")}
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(...args, limit) as Array<{ session_id: string; seq: number; ts: string; type: string; project_id: string; title: string | null; project_name: string; snippet: string }>;
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
    return rows.map(toPhoneCall);
  }

  /** Calls that started in [from, to), newest first. */
  listPhoneCallsBetween(from: string, to: string, limit = 200): PhoneCallRecord[] {
    const rows = this.stmt("SELECT * FROM phone_calls WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC LIMIT ?").all(from, to, limit) as Array<Record<string, string | null>>;
    return rows.map(toPhoneCall);
  }

  // ---- daily report

  /**
   * Sessions with events in [from, to), the one updated last first; `projectIds` narrows them. Every
   * turn ends with a status change, which moves updated_at, so a session that worked in the range was
   * updated in it or later: that narrows the candidates without an index on events.ts.
   */
  sessionActivity(from: string, to: string, projectIds: ReadonlySet<string> | null, limit: number): SessionActivity[] {
    const rows = this.stmt(
      `SELECT s.*, p.name AS project_name, p.parent_id AS project_parent FROM sessions s JOIN projects p ON p.id = s.project_id
       WHERE s.updated_at >= ? AND s.created_at < ? ORDER BY s.updated_at DESC`,
    ).all(from, to) as unknown as Array<SessionRow & { project_name: string; project_parent: string | null }>;
    const agg = this.stmt(
      `SELECT COUNT(*) AS n, COALESCE(SUM(type = 'turn.result'), 0) AS turns,
              COALESCE(SUM(type = 'turn.result' AND json_extract(body, '$.isError') = 1), 0) AS errors, MIN(ts) AS first, MAX(ts) AS last
       FROM events WHERE session_id = ? AND ts >= ? AND ts < ?`,
    );
    const out: SessionActivity[] = [];
    for (const r of rows) {
      if (projectIds && !projectIds.has(r.project_id)) continue;
      const a = agg.get(r.id, from, to) as { n: number; turns: number; errors: number; first: string | null; last: string | null };
      if (!a.n) continue;
      out.push({
        session: toSession(r),
        projectName: r.project_name,
        projectParentId: r.project_parent,
        turns: a.turns,
        errors: a.errors,
        firstAt: a.first!,
        lastAt: a.last!,
        autoCommits: this.autoCommits(r.id, from, to),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Commits FORGE made after the session's turns (tag auto-commit), oldest first. */
  autoCommits(sessionId: string, from = "", to = "￿"): Array<{ hash: string; subject: string }> {
    return this.stmt(
      `SELECT json_extract(body, '$.hash') AS hash, json_extract(body, '$.message') AS subject FROM events
       WHERE session_id = ? AND type = 'automation' AND ts >= ? AND ts < ?
         AND json_extract(body, '$.action') = 'commit' AND json_extract(body, '$.ok') = 1 AND json_extract(body, '$.hash') IS NOT NULL
       ORDER BY seq`,
    ).all(sessionId, from, to) as Array<{ hash: string; subject: string }>;
  }

  /** Approval requests (questions and plans too) of the session's current turn that have no answer yet, oldest first. */
  openApprovalRequests(sessionId: string): Array<{ ts: string; body: Extract<SessionEventBody, { type: "approval.request" }> }> {
    const rows = this.stmt(
      `SELECT e.ts, e.body FROM events e
       WHERE e.session_id = ? AND e.type = 'approval.request'
         AND e.seq > COALESCE((SELECT MAX(seq) FROM events WHERE session_id = ? AND type = 'user.message'), 0)
         AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id = e.session_id AND r.seq > e.seq AND r.type = 'approval.resolved'
                           AND json_extract(r.body, '$.requestId') = json_extract(e.body, '$.requestId'))
       ORDER BY e.seq`,
    ).all(sessionId, sessionId) as Array<{ ts: string; body: string }>;
    return rows.map((r) => ({ ts: r.ts, body: JSON.parse(r.body) as Extract<SessionEventBody, { type: "approval.request" }> }));
  }

  /**
   * Notes what became of an agent. Waiting agents are tried again every few minutes and a skipped one
   * again after each turn: the same outcome right after itself is no new row.
   */
  logAgent(e: Omit<AgentLogEntry, "ts"> & { ts?: string }) {
    const last = this.stmt("SELECT outcome FROM agent_log WHERE worktree_id = ? ORDER BY id DESC LIMIT 1").get(e.worktreeId) as { outcome: string } | undefined;
    if (last?.outcome === e.outcome && (e.outcome === "waiting" || e.outcome === "skipped")) return;
    this.stmt(
      `INSERT INTO agent_log(worktree_id, root_id, root_name, branch, title, session_id, parent_session_id, started_at, outcome, message, commits, ts)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.worktreeId, e.rootId, e.rootName, e.branch, e.title, e.sessionId, e.parentSessionId, e.startedAt, e.outcome, e.message, JSON.stringify(e.commits), e.ts ?? now());
  }

  /** Agent outcomes noted in [from, to), oldest first. */
  agentLogBetween(from: string, to: string): AgentLogEntry[] {
    const rows = this.stmt("SELECT * FROM agent_log WHERE ts >= ? AND ts < ? ORDER BY id").all(from, to) as unknown as AgentLogRow[];
    return rows.map(toAgentLog);
  }

  /** The newest outcome noted for each of these worktrees. */
  lastAgentLog(worktreeIds: string[]): Map<string, AgentLogEntry> {
    const out = new Map<string, AgentLogEntry>();
    const q = this.stmt("SELECT * FROM agent_log WHERE worktree_id = ? ORDER BY id DESC LIMIT 1");
    for (const id of worktreeIds) {
      const r = q.get(id) as AgentLogRow | undefined;
      if (r) out.set(id, toAgentLog(r));
    }
    return out;
  }

  // ---- prompt templates

  /** null: only the global ones; a project id: the global ones and that project's; "all": every template. Globals first, then by order. */
  listTemplates(scope: string | null | "all"): PromptTemplate[] {
    const order = "ORDER BY project_id IS NOT NULL, project_id, sort_order, created_at";
    const rows = (
      scope === "all"
        ? this.stmt(`SELECT * FROM prompt_templates ${order}`).all()
        : scope === null
          ? this.stmt(`SELECT * FROM prompt_templates WHERE project_id IS NULL ${order}`).all()
          : this.stmt(`SELECT * FROM prompt_templates WHERE project_id IS NULL OR project_id = ? ${order}`).all(scope)
    ) as unknown as TemplateRow[];
    return rows.map(toTemplate);
  }

  getTemplate(id: string): PromptTemplate | null {
    const r = this.stmt("SELECT * FROM prompt_templates WHERE id = ?").get(id) as TemplateRow | undefined;
    return r ? toTemplate(r) : null;
  }

  /** Inserts or replaces the whole row (also from the sync and backups, with their own times). */
  putTemplate(t: PromptTemplate) {
    this.stmt(
      `INSERT INTO prompt_templates(id, project_id, name, description, text, sort_order, created_at, updated_at, learned) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, name = excluded.name, description = excluded.description, text = excluded.text,
         sort_order = excluded.sort_order, updated_at = excluded.updated_at, learned = excluded.learned`,
    ).run(t.id, t.projectId, t.name, t.description, t.text, t.sortOrder, t.createdAt, t.updatedAt, t.learned ? 1 : 0);
  }

  deleteTemplate(id: string): boolean {
    return this.stmt("DELETE FROM prompt_templates WHERE id = ?").run(id).changes > 0;
  }

  /** The next free place at the end of a list (global or one project). */
  nextTemplateOrder(projectId: string | null): number {
    const r = this.stmt("SELECT MAX(sort_order) AS m FROM prompt_templates WHERE project_id IS ?").get(projectId) as { m: number | null };
    return (r.m ?? -1) + 1;
  }

  setTemplateOrder(order: Array<{ id: string; sortOrder: number }>) {
    const q = this.stmt("UPDATE prompt_templates SET sort_order = ? WHERE id = ?");
    this.sql.exec("BEGIN");
    try {
      for (const o of order) q.run(o.sortOrder, o.id);
      this.sql.exec("COMMIT");
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
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
