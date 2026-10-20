import { z } from "zod";
import { Language, pick } from "./i18n.js";

export const ProfileId = z.enum(["safe", "balanced", "autonomous"]);
export type ProfileId = z.infer<typeof ProfileId>;

/** Rules of FORGE's hard blocklist (policy/guard.ts) that can be switched off in the settings. */
export const PolicyRuleId = z.enum([
  "git-force-push",
  "git-push-mirror",
  "git-push-protected",
  "git-push-delete",
  "git-reset-hard",
  "git-branch-delete",
  "git-clean-force",
  "rm-root",
  "format-disk",
  "sensitive-path",
  "write-outside-project",
]);
export type PolicyRuleId = z.infer<typeof PolicyRuleId>;

/**
 * Rules that are off unless the user switches them on: pushing to main/master, and deleting local
 * branches (Claude cleans up the branches of finished agents).
 */
export const DEFAULT_DISABLED_POLICY_RULES: readonly PolicyRuleId[] = ["git-push-protected", "git-branch-delete"];

export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const ProjectTag = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Tags: Kleinbuchstaben, Ziffern und Bindestriche");

/** Name of a project group as the user typed it (client, area); compared without regard to case. */
export const ProjectGroup = z.string().trim().min(1).max(60);

/** Automation tags that only work with git; a project without git drops them. */
export const GIT_TAGS: readonly string[] = ["auto-commit", "auto-push", "auto-merge", "review-required"];

export const GitSummary = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  ahead: z.number().int(),
  behind: z.number().int(),
  upstream: z.string().nullable(),
  changedCount: z.number().int(),
  conflicted: z.boolean(),
  remoteUrl: z.string().nullable(),
});
export type GitSummary = z.infer<typeof GitSummary>;

export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  favorite: z.boolean(),
  /** the user's own grouping, e.g. by client; null: no group. Worktrees show under their project's group */
  group: z.string().nullable(),
  tags: z.array(z.string()),
  technologies: z.array(z.string()),
  profile: ProfileId,
  defaultModel: z.string().nullable(),
  defaultEffort: EffortLevel.nullable(),
  createdAt: z.string(),
  lastOpenedAt: z.string().nullable(),
  /** command run by the auto-test tag, e.g. "pnpm test" */
  testCommand: z.string().nullable(),
  /** command that starts the project's dev server, e.g. "pnpm dev"; null uses the detected one */
  devCommand: z.string().nullable(),
  /** set for git worktrees: the project they belong to */
  parentId: z.string().nullable(),
  /** false: the project works without git; FORGE hides git and agents and tells Claude not to use git */
  gitEnabled: z.boolean(),
  /** false when the folder no longer exists on disk */
  exists: z.boolean(),
});
export type Project = z.infer<typeof Project>;

export const ProjectWithStatus = Project.extend({
  git: GitSummary.nullable(),
  lastSession: z
    .object({ id: z.string(), title: z.string().nullable(), updatedAt: z.string(), status: z.string() })
    .nullable(),
});
export type ProjectWithStatus = z.infer<typeof ProjectWithStatus>;

export const SessionStatus = z.enum([
  "starting",
  "running",
  "idle",
  "waiting_approval",
  "stopping",
  "stopped",
  "error",
  "interrupted",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const BackgroundTask = z.object({
  taskId: z.string(),
  description: z.string(),
  taskType: z.string(),
  /** the tool call that started the task (Agent/Task or Bash); a subagent's events carry it as parentToolUseId */
  toolUseId: z.string().nullable(),
  /** when FORGE first saw the task */
  startedAt: z.string(),
  /** one-line progress (subagents: written by the model about every 30 s) */
  summary: z.string().nullable(),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;

/** The background task (subagent or command) a user message was written to. */
export const TaskMessageRef = z.object({
  /** the CLI's task id; for a subagent also its agentId, the address SendMessage takes */
  taskId: z.string(),
  /** the Agent or Bash call that started it */
  toolUseId: z.string().nullable(),
  kind: z.enum(["agent", "shell"]),
  description: z.string(),
});
export type TaskMessageRef = z.infer<typeof TaskMessageRef>;

/** A subagent working in the foreground of the current turn (Task tool), with its latest progress. */
export const SubagentProgress = z.object({
  taskId: z.string(),
  toolUseId: z.string().nullable(),
  description: z.string(),
  agentType: z.string().nullable(),
  /** one-line progress written by the model, e.g. "Analysiert das Auth-Modul" */
  summary: z.string().nullable(),
  lastTool: z.string().nullable(),
  toolUses: z.number(),
  startedAt: z.string(),
});
export type SubagentProgress = z.infer<typeof SubagentProgress>;

/** Context window usage as reported by Claude Code (`getContextUsage`). */
export const ContextUsage = z.object({
  totalTokens: z.number(),
  maxTokens: z.number(),
  /** 0-100, may exceed 100 when over the limit */
  percentage: z.number(),
  categories: z.array(z.object({ name: z.string(), tokens: z.number(), kind: z.enum(["used", "free", "buffer", "deferred"]) })),
  updatedAt: z.string(),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

export const Session = z.object({
  id: z.string(),
  projectId: z.string(),
  claudeSessionId: z.string().nullable(),
  cwd: z.string(),
  title: z.string().nullable(),
  model: z.string().nullable(),
  /** reasoning effort; null = Claude Code's default for the model */
  effort: EffortLevel.nullable(),
  profile: ProfileId,
  permissionMode: PermissionMode,
  status: SessionStatus,
  apiKeySource: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastError: z.string().nullable(),
  /** true while a live SDK process is attached in this app instance */
  live: z.boolean(),
  /** commands Claude started in the background that are still running (not persisted) */
  background: z.array(BackgroundTask),
  /** subagents running in the current turn */
  subagents: z.array(SubagentProgress),
  /** context window usage after the last turn; for ended sessions the last value measured */
  context: ContextUsage.nullable(),
  /** when FORGE continues the session on its own after a usage limit (ISO); null when nothing is planned */
  autoContinueAt: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

/** Sessions found in ~/.claude that FORGE did not start (e.g. from the terminal). */
export const ExternalSession = z.object({
  claudeSessionId: z.string(),
  summary: z.string(),
  lastModified: z.string(),
  gitBranch: z.string().nullable(),
  cwd: z.string().nullable(),
});
export type ExternalSession = z.infer<typeof ExternalSession>;

export const ToolResultContent = z.object({
  text: z.string(),
  truncated: z.boolean(),
});

/** Normalized, persisted session events. Deltas are transient and never persisted. */
/** Tokens and estimated cost of one model (modelUsage of the Agent SDK). */
export const ModelTokens = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
});
export type ModelTokens = z.infer<typeof ModelTokens>;

export const SessionEventBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.init"),
    claudeSessionId: z.string(),
    model: z.string(),
    permissionMode: z.string(),
    cwd: z.string(),
    tools: z.array(z.string()),
    claudeCodeVersion: z.string().nullable(),
    apiKeySource: z.string().nullable(),
  }),
  z.object({
    type: z.literal("user.message"),
    text: z.string(),
    /** id passed to Claude Code; needed to rewind files to this point */
    uuid: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), mediaType: z.string(), size: z.number() })).optional(),
    /** "remote": typed in the Claude app (Remote Control); "auto": sent by FORGE (usage limit reset, restart for an update) */
    source: z.enum(["forge", "remote", "auto"]).optional(),
    /** written to a background task: Claude got it with a note naming the task (and passes it on to a subagent) */
    task: TaskMessageRef.optional(),
  }),
  z.object({
    type: z.literal("check.result"),
    command: z.string(),
    ok: z.boolean(),
    exitCode: z.number().nullable(),
    durationMs: z.number(),
    output: z.string(),
  }),
  z.object({
    type: z.literal("automation"),
    /** wait: a finished agent waits until the project is ready to take its work */
    action: z.enum(["commit", "push", "merge", "skip", "wait"]),
    ok: z.boolean(),
    message: z.string(),
    hash: z.string().nullable(),
    files: z.array(z.string()),
  }),
  z.object({
    type: z.literal("files.rewound"),
    toMessageUuid: z.string(),
    filesChanged: z.array(z.string()),
  }),
  /** the user edited the prompt with seq `fromSeq`: everything from it up to here is gone from Claude's conversation */
  z.object({
    type: z.literal("message.edited"),
    fromSeq: z.number().int(),
  }),
  z.object({
    type: z.literal("assistant.delta"),
    messageId: z.string(),
    index: z.number().int(),
    text: z.string(),
  }),
  z.object({ type: z.literal("assistant.thinking"), messageId: z.string() }),
  z.object({
    type: z.literal("assistant.text"),
    messageId: z.string(),
    index: z.number().int(),
    text: z.string(),
    /** set for the text of a subagent: the Agent/Task call it works for */
    parentToolUseId: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("tool.use"),
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    parentToolUseId: z.string().nullable(),
    /** long string fields of the input were shortened before storing (e.g. the content of a large Write) */
    inputTruncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("tool.result"),
    toolUseId: z.string(),
    isError: z.boolean(),
    content: ToolResultContent,
  }),
  z.object({
    type: z.literal("approval.request"),
    requestId: z.string(),
    toolUseId: z.string(),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()),
    title: z.string().nullable(),
    description: z.string().nullable(),
    reason: z.string().nullable(),
    allowSessionScope: z.boolean(),
    outsideProject: z.boolean(),
    /** long string fields of the input were shortened before storing; the decision covers the full input */
    inputTruncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("approval.resolved"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    scope: z.enum(["once", "session"]),
    source: z.enum(["user", "policy", "abort"]),
    message: z.string().nullable(),
    /** AskUserQuestion: question text -> answer */
    answers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("context.compacted"),
    trigger: z.enum(["manual", "auto"]),
    preTokens: z.number().nullable(),
    postTokens: z.number().nullable(),
  }),
  z.object({
    type: z.literal("policy.blocked"),
    toolUseId: z.string().nullable(),
    toolName: z.string(),
    rule: z.string(),
    message: z.string(),
  }),
  z.object({ type: z.literal("status"), status: SessionStatus, detail: z.string().nullable() }),
  /**
   * A long session handed over to a new one (sessions.handoff). In the new session `direction` is "from"
   * (it continues the other one), in the old one "to" (it goes on in the other one).
   */
  z.object({
    type: z.literal("session.handoff"),
    direction: z.enum(["from", "to"]),
    otherSessionId: z.string(),
    otherTitle: z.string().nullable(),
    /** context of the old session when it was handed over */
    contextTokens: z.number().nullable(),
  }),
  /** Claude asked FORGE to get the user's attention (tool notify); urgent ones may ring the phone */
  z.object({ type: z.literal("notify"), message: z.string(), urgent: z.boolean() }),
  z.object({
    type: z.literal("background.task"),
    taskId: z.string(),
    description: z.string(),
    state: z.enum(["started", "completed", "failed", "stopped"]),
    /** at the end: what the task reports, for a subagent its final answer */
    summary: z.string().nullable(),
    /** the tool call that started it; missing in events of older FORGE versions */
    toolUseId: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("turn.result"),
    subtype: z.string(),
    isError: z.boolean(),
    durationMs: z.number().nullable(),
    numTurns: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cacheReadTokens: z.number().nullable(),
    /** missing in events from before it was recorded */
    cacheWriteTokens: z.number().nullable().optional(),
    /**
     * modelUsage of the SDK: per model, every call of the query (main loop, subagents, compaction), cumulative
     * over the turns of one Claude process. The tokens above are the main loop of this turn only.
     */
    models: z.record(z.string(), ModelTokens).optional(),
    text: z.string().nullable(),
  }),
  z.object({
    type: z.literal("rate_limit"),
    status: z.string(),
    resetsAt: z.number().nullable(),
    limitType: z.string().nullable(),
    /** percent of the limit used, when Claude Code reports it */
    utilization: z.number().nullable().optional(),
    /** requests are served from extra usage, so a "rejected" plan limit does not stop the session */
    overageInUse: z.boolean().optional(),
  }),
  /** FORGE continues a session on its own after a usage limit (plan, run, cancel). */
  z.object({
    type: z.literal("auto_continue"),
    state: z.enum(["scheduled", "resumed", "cancelled", "exhausted", "failed"]),
    /** planned time (ISO); for "resumed" the time the plan was due */
    scheduledFor: z.string().nullable(),
    /** false: the reset time is unknown and FORGE checks the plan usage periodically */
    resetKnown: z.boolean().optional(),
    /** automatic continuations without user input so far, including this one */
    attempt: z.number().int().optional(),
    message: z.string().nullable(),
  }),
  /**
   * The turn changed UI files while a dev server ran: FORGE took a screenshot of the web app before and
   * after it. Images and state live in the data folder (uiCompare.get), never in the event or with Claude.
   */
  z.object({
    type: z.literal("ui.compare"),
    compareId: z.string(),
    url: z.string(),
    /** the UI files the turn changed, relative to the session's folder */
    files: z.array(z.string()),
  }),
  /** FORGE restarted for an update while this session worked; the next message lets Claude continue. */
  z.object({
    type: z.literal("app.updated"),
    /** version before the restart; null when unknown (development build) */
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string(), retryable: z.boolean() }),
]);
export type SessionEventBody = z.infer<typeof SessionEventBody>;

export const SessionEvent = z.object({
  seq: z.number().int(),
  sessionId: z.string(),
  ts: z.string(),
  body: SessionEventBody,
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const FileStatus = z.object({
  path: z.string(),
  origPath: z.string().nullable(),
  /** porcelain XY: index status */
  index: z.string(),
  /** porcelain XY: worktree status */
  worktree: z.string(),
  kind: z.enum(["modified", "added", "deleted", "renamed", "untracked", "conflicted", "typechange"]),
  staged: z.boolean(),
  unstaged: z.boolean(),
});
export type FileStatus = z.infer<typeof FileStatus>;

export const GitStatus = z.object({
  summary: GitSummary,
  files: z.array(FileStatus),
});
export type GitStatus = z.infer<typeof GitStatus>;

export const DiffLine = z.object({
  kind: z.enum(["context", "add", "del", "hunk", "meta"]),
  text: z.string(),
  oldNo: z.number().int().nullable(),
  newNo: z.number().int().nullable(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const FileDiff = z.object({
  path: z.string(),
  binary: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  lines: z.array(DiffLine),
  truncated: z.boolean(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const CommitInfo = z.object({
  hash: z.string(),
  shortHash: z.string(),
  author: z.string(),
  authorEmail: z.string(),
  /** GitHub picture when the email already names the account (noreply address); others come from git.authorAvatars */
  avatarUrl: z.string().nullable(),
  date: z.string(),
  subject: z.string(),
  /** full hashes of the parent commits; empty for a root commit */
  parents: z.array(z.string()),
  /** decorations as git prints them, e.g. "HEAD -> main", "origin/main", "tag: v1.0" */
  refs: z.array(z.string()),
});
export type CommitInfo = z.infer<typeof CommitInfo>;

export const CommitFile = z.object({
  path: z.string(),
  /** old path of a renamed or copied file */
  origPath: z.string().nullable(),
  kind: z.enum(["added", "modified", "deleted", "renamed", "typechange"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
});
export type CommitFile = z.infer<typeof CommitFile>;

/** What a commit changed against its first parent, limited to the project folder. */
export const CommitDetails = z.object({
  hash: z.string(),
  /** the message without its subject line */
  body: z.string(),
  files: z.array(CommitFile),
  /** more files than listed */
  truncated: z.boolean(),
});
export type CommitDetails = z.infer<typeof CommitDetails>;

export const BranchInfo = z.object({
  name: z.string(),
  current: z.boolean(),
  upstream: z.string().nullable(),
});
export type BranchInfo = z.infer<typeof BranchInfo>;

export const Settings = z.object({
  claudePath: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultEffort: EffortLevel.nullable(),
  defaultProfile: ProfileId,
  stripApiKey: z.boolean(),
  enterToSend: z.boolean(),
  sounds: z.boolean(),
  debugLogs: z.boolean(),
  defaultProjectDir: z.string().nullable(),
  /** continue a session on its own once a usage limit that stopped it has reset */
  autoContinueAfterLimit: z.boolean(),
  /** minutes without activity after which FORGE ends the idle CLI process of a session; 0 never */
  idleCloseMinutes: z.number().int().min(0).max(1440),
  /** context size (tokens) from which the composer suggests going on in a new session; 0 never */
  longSessionTokens: z.number().int().min(0).max(2_000_000),
  /** look for new FORGE releases on GitHub (start and every 30 minutes) */
  updateChecks: z.boolean(),
  /** Windows notifications when Claude is done, needs a decision or fails */
  desktopNotifications: z.boolean(),
  /** the main window stays above other apps; chat windows are pinned one by one */
  alwaysOnTop: z.boolean(),
  /** while FORGE runs, the Print key opens FORGE's snipping tool instead of the one of Windows */
  screenshotKey: z.boolean(),
  /** before/after screenshots of the web app when a turn changes UI files and a dev server runs */
  uiCompare: z.boolean(),
  /** FORGE turns requests the user sends again and again into prompt templates (marked as learned) */
  learnTemplates: z.boolean(),
  /** blocklist rules the user switched off; every other rule applies */
  disabledPolicyRules: z.array(PolicyRuleId),
  /** the setup assistant of the first start is done (or was skipped); installations from before it count as done */
  setupDone: z.boolean(),
  /** FORGE's data (no secrets) is kept in a private GitHub repository of the signed-in account */
  syncEnabled: z.boolean(),
  /** the user was asked once whether to sync over GitHub */
  syncAsked: z.boolean(),
  /** every 5 minutes anonymous totals (tokens, projects, agents ...) go to USAGE_STATS_URL */
  usageStats: z.boolean(),
  /** the user answered the question about the usage statistics; unanswered they stay off */
  usageStatsAsked: z.boolean(),
  /** language of the interface, the sidecar's texts and the phone; switching reloads the windows */
  language: Language,
});
export type Settings = z.infer<typeof Settings>;

export const UiCompareShot = z.object({
  /** pixels of the JPEG */
  width: z.number().int(),
  height: z.number().int(),
  /** absolute path of the image in FORGE's data folder */
  path: z.string(),
  takenAt: z.string(),
});
export type UiCompareShot = z.infer<typeof UiCompareShot>;

/** A before/after comparison of the web app around one turn (event ui.compare). */
export const UiCompare = z.object({
  id: z.string(),
  sessionId: z.string(),
  projectId: z.string(),
  url: z.string(),
  files: z.array(z.string()),
  createdAt: z.string(),
  /** capturing: the after image is being taken (also when taken again) */
  status: z.enum(["capturing", "ready", "failed"]),
  before: UiCompareShot,
  after: UiCompareShot.nullable(),
  /** why the after image failed */
  error: z.string().nullable(),
});
export type UiCompare = z.infer<typeof UiCompare>;

/** Choices for longSessionTokens in the settings; 0 is off. */
export const LONG_SESSION_CHOICES = [0, 100_000, 200_000, 400_000, 600_000, 800_000] as const;

/** Choices for idleCloseMinutes in the settings; 0 is off. */
export const IDLE_CLOSE_CHOICES = [0, 15, 30, 60, 120, 240] as const;

const IDLE_CLOSED_DETAILS = {
  en: "Claude process ended after inactivity. The next message continues the session.",
  de: "Claude-Prozess wegen Untätigkeit beendet. Die nächste Nachricht setzt die Session fort.",
} as const;

/** Status detail when FORGE ended the CLI process of an idle session; the chat shows it as a quiet note. */
export function idleClosedDetail(): string {
  return pick(IDLE_CLOSED_DETAILS);
}

/** Also true for the text in the other language: stored events keep the language they were written in. */
export function isIdleClosedDetail(detail: string | null | undefined): detail is string {
  return Object.values(IDLE_CLOSED_DETAILS).some((d) => d === detail);
}

/**
 * The latest plan rate limit Claude Code reported, for the whole account (not per session).
 * "warning": close to the limit; "reached": requests are rejected until resetsAt.
 */
export const RateLimitState = z.object({
  status: z.enum(["ok", "warning", "reached"]),
  /** five_hour, seven_day, seven_day_opus, seven_day_sonnet, overage …; null when unknown */
  limitType: z.string().nullable(),
  resetsAt: z.string().nullable(),
  /** percent used, when reported */
  utilization: z.number().nullable(),
  updatedAt: z.string().nullable(),
});
export type RateLimitState = z.infer<typeof RateLimitState>;

export const CapabilityState = z.enum(["supported", "partial", "unavailable"]);
export const Capability = z.object({
  key: z.string(),
  label: z.string(),
  state: CapabilityState,
  note: z.string(),
});
export type Capability = z.infer<typeof Capability>;

export const ToolCheck = z.object({
  found: z.boolean(),
  /** shipped with FORGE (true) or taken from the system (false) */
  bundled: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
  error: z.string().nullable(),
});
export type ToolCheck = z.infer<typeof ToolCheck>;

export const Diagnostics = z.object({
  platform: z.string(),
  nodeVersion: z.string(),
  dataDir: z.string(),
  claude: ToolCheck,
  auth: z.object({
    checked: z.boolean(),
    loggedIn: z.boolean(),
    authMethod: z.string().nullable(),
    subscriptionType: z.string().nullable(),
    /** e.g. default_claude_max_5x / default_claude_max_20x, from Claude Code's account data */
    rateLimitTier: z.string().nullable(),
    apiProvider: z.string().nullable(),
    error: z.string().nullable(),
  }),
  apiKeyEnvPresent: z.boolean(),
  apiKeyStripped: z.boolean(),
  git: ToolCheck,
  gh: ToolCheck.extend({ authenticated: z.boolean().nullable() }),
  python: ToolCheck,
  capabilities: z.array(Capability),
});
export type Diagnostics = z.infer<typeof Diagnostics>;

export const ModelInfo = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(EffortLevel).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/**
 * Where a usage window is heading at the recent pace. "limit": it runs full at `limitAt`, before its
 * reset; "enough": it lasts until the reset. Missing when there are too few readings or no rise.
 */
export const UsageForecast = z.object({
  outcome: z.enum(["limit", "enough"]),
  limitAt: z.string().nullable(),
  /** percentage points per hour, weighted toward recent readings */
  perHour: z.number(),
});
export type UsageForecast = z.infer<typeof UsageForecast>;

export const UsageWindow = z.object({
  key: z.string(),
  label: z.string(),
  /** percent used, 0-100 */
  utilization: z.number(),
  resetsAt: z.string().nullable(),
  forecast: UsageForecast.optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/** Plan limits as reported by Claude Code (claude.ai usage endpoint). */
export const PlanUsage = z.object({
  available: z.boolean(),
  subscriptionType: z.string().nullable(),
  windows: z.array(UsageWindow),
  fetchedAt: z.string(),
  error: z.string().nullable(),
});
export type PlanUsage = z.infer<typeof PlanUsage>;

export const RuntimeInfo = z.object({
  models: z.array(ModelInfo),
  commands: z.array(z.object({ name: z.string(), description: z.string() })),
  agents: z.array(z.object({ name: z.string(), description: z.string() })),
  mcpServers: z.array(z.object({ name: z.string(), status: z.string() })),
  account: z.object({ subscriptionType: z.string().nullable(), apiProvider: z.string().nullable() }),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;


export const GitHubAccount = z.object({
  login: z.string(),
  id: z.number().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileUrl: z.string(),
});
export type GitHubAccount = z.infer<typeof GitHubAccount>;

export const GitHubLoginState = z.object({
  phase: z.enum(["idle", "starting", "waiting", "done", "error", "cancelled"]),
  code: z.string().nullable(),
  url: z.string().nullable(),
  message: z.string().nullable(),
});
export type GitHubLoginState = z.infer<typeof GitHubLoginState>;

export const GitHubRepo = z.object({
  fullName: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  updatedAt: z.string(),
  cloneUrl: z.string(),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

/** A GitHub organisation the signed-in account belongs to; new repositories can go there instead of the personal account. */
export const GitHubOrg = z.object({
  login: z.string(),
  avatarUrl: z.string().nullable(),
});
export type GitHubOrg = z.infer<typeof GitHubOrg>;

/** Account or organisation a new repository is created in, as GitHub writes its name. */
export const GitHubOwner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, { error: () => pick({ en: "Invalid GitHub account name", de: "Ungültiger GitHub-Kontoname" }) });

export const ClaudeUpdateInfo = z.object({
  installed: z.string().nullable(),
  latest: z.string().nullable(),
  channel: z.enum(["latest", "stable"]),
  available: z.boolean(),
  checkedAt: z.string(),
  error: z.string().nullable(),
});
export type ClaudeUpdateInfo = z.infer<typeof ClaudeUpdateInfo>;

export const ClaudeSetupState = z.object({
  task: z.enum(["install", "login", "update"]).nullable(),
  phase: z.enum(["idle", "running", "waiting_code", "done", "error", "cancelled"]),
  /** sign-in page FORGE opens */
  url: z.string().nullable(),
  /**
   * Set when `url` returns to Claude Code on its own (local callback, no code needed): the page that
   * shows a code to paste instead, for when that return does not work.
   */
  codeUrl: z.string().nullable().optional(),
  log: z.array(z.string()),
  message: z.string().nullable(),
});
export type ClaudeSetupState = z.infer<typeof ClaudeSetupState>;

export const MemoryScope = z.enum(["global", "project", "project-dir", "local"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryFile = z.object({
  scope: MemoryScope,
  label: z.string(),
  path: z.string(),
  exists: z.boolean(),
  size: z.number(),
  mtimeMs: z.number().nullable(),
});
export type MemoryFile = z.infer<typeof MemoryFile>;

export const ConfigDocKind = z.enum(["skill", "agent"]);
export type ConfigDocKind = z.infer<typeof ConfigDocKind>;
export const ConfigScope = z.enum(["user", "project"]);
export type ConfigScope = z.infer<typeof ConfigScope>;

export const ConfigDoc = z.object({
  kind: ConfigDocKind,
  scope: ConfigScope,
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
});
export type ConfigDoc = z.infer<typeof ConfigDoc>;

export const TextDoc = z.object({ path: z.string(), content: z.string(), mtimeMs: z.number().nullable() });
export type TextDoc = z.infer<typeof TextDoc>;

export const McpServer = z.object({
  name: z.string(),
  target: z.string(),
  status: z.enum(["connected", "failed", "needs_auth", "unknown"]),
  statusText: z.string(),
});
export type McpServer = z.infer<typeof McpServer>;

/** New commits from origin taken over before a push or on pull. */
export const GitIntegrated = z.object({
  mode: z.enum(["fast-forward", "rebase"]),
  remoteCommits: z.number().int(),
  localCommits: z.number().int(),
});
export type GitIntegrated = z.infer<typeof GitIntegrated>;

/** `details.integration` of the GIT_CONFLICT error when origin's commits could not be taken over automatically. */
export interface GitIntegrationConflict {
  branch: string;
  remoteCommits: number;
  localCommits: number;
  files: string[];
  /** the branch is up to date; the conflict is between it and the uncommitted changes (kept in the stash) */
  stash?: boolean;
}

/** What a parallel agent did on its branch, for the decision to merge or discard it. */
export const AgentReview = z.object({
  /** the agent's worktree project */
  projectId: z.string(),
  rootId: z.string(),
  rootName: z.string(),
  branch: z.string().nullable(),
  /** branch the agent's work goes into: the one it started from, checked out in `targetPath` */
  targetBranch: z.string().nullable(),
  targetPath: z.string(),
  /** the latest session in the worktree */
  sessionId: z.string().nullable(),
  sessionTitle: z.string().nullable(),
  sessionStatus: z.string().nullable(),
  /** the agent's last answer, its closing summary */
  summary: z.string(),
  busy: z.boolean(),
  /** commits on the agent's branch that the target branch does not have, newest first (at most 20) */
  commits: z.array(z.object({ hash: z.string(), subject: z.string() })),
  ahead: z.number().int(),
  /** commits on the target branch since the agent started; they are rebased under the agent's work */
  behind: z.number().int(),
  filesChanged: z.number().int(),
  /** uncommitted changes in the worktree; merging commits them first */
  uncommitted: z.number().int(),
  /** why a merge cannot run right now; discarding works anyway */
  mergeBlocker: z.string().nullable(),
});
export type AgentReview = z.infer<typeof AgentReview>;

export const AgentFinishResult = z.object({
  action: z.enum(["merge", "discard"]),
  /**
   * conflict: the rebase hit conflicts, the agent resolves them (sessionId) and the worktree stays.
   * waiting: uncommitted work in the project overlaps with the agent and cannot be carried over now;
   * the worktree stays, nothing changed.
   */
  outcome: z.enum(["merged", "discarded", "conflict", "waiting"]),
  branch: z.string().nullable(),
  targetBranch: z.string().nullable(),
  commits: z.number().int(),
  files: z.array(z.string()),
  sessionId: z.string().nullable(),
  branchError: z.string().nullable(),
  message: z.string(),
});
export type AgentFinishResult = z.infer<typeof AgentFinishResult>;

/** A plugin from a Claude Code marketplace; plugins bring skills (and sometimes agents, hooks, MCP servers). */
export const MarketplacePlugin = z.object({
  /** name@marketplace */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  marketplace: z.string(),
  installCount: z.number().nullable(),
  installed: z.boolean(),
  enabled: z.boolean().nullable(),
});
export type MarketplacePlugin = z.infer<typeof MarketplacePlugin>;

/**
 * Longest message text the protocol takes. The sidecar hands a text that does not fit into one turn to
 * Claude as a file, so this only bounds the size of one protocol line (at most 6 MB of UTF-8).
 */
export const MAX_PROMPT_CHARS = 2_000_000;
/** base64 characters per attachments.upload call; a multiple of 4, so every chunk decodes on its own */
export const UPLOAD_CHUNK_CHARS = 1_048_576;
/** largest file attachments.upload takes */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const Attachment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal("data"),
    name: z.string().min(1).max(260),
    mediaType: z.string().max(100),
    base64: z.string().max(15_000_000),
  }),
]);
export type Attachment = z.infer<typeof Attachment>;

export const AttachmentMeta = z.object({ name: z.string(), mediaType: z.string(), size: z.number() });
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

export const SlashCommand = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  /** Claude Code's own command; absent for commands of the user, the project, a plugin or an MCP server */
  builtin: z.boolean().optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const RewindResult = z.object({
  canRewind: z.boolean(),
  error: z.string().nullable(),
  filesChanged: z.array(z.string()),
  insertions: z.number(),
  deletions: z.number(),
});
export type RewindResult = z.infer<typeof RewindResult>;

export const ProjectRemovalInfo = z.object({
  path: z.string(),
  folderExists: z.boolean(),
  /** reason why the folder must not be deleted (drive, home, contains other projects), else null */
  folderBlocker: z.string().nullable(),
  isWorktree: z.boolean(),
  /** git worktrees registered as child projects */
  worktrees: z.number(),
  /** "owner/repo" when origin points to github.com */
  githubRepo: z.string().nullable(),
  githubSignedIn: z.boolean(),
  githubCanDelete: z.boolean(),
});
export type ProjectRemovalInfo = z.infer<typeof ProjectRemovalInfo>;

export const RemoteSession = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  /** name of the entry in the Claude app; unique among the connected sessions */
  name: z.string(),
  /** claude.ai/code link of this session; opens in the Claude app on phones */
  url: z.string().nullable(),
  state: z.enum(["connecting", "connected", "error"]),
  message: z.string().nullable(),
});
export type RemoteSession = z.infer<typeof RemoteSession>;

/** Remote Control is global: while enabled, every session with a running CLI process is connected. */
export const RemoteState = z.object({
  enabled: z.boolean(),
  sessions: z.array(RemoteSession),
});
export type RemoteState = z.infer<typeof RemoteState>;

export const PullRequest = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  draft: z.boolean(),
  reviewDecision: z.string().nullable(),
  base: z.string(),
  head: z.string(),
  checks: z.object({ total: z.number(), failed: z.number(), pending: z.number() }),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** Markers around matched terms in SearchHit.snippet (control characters never occur in stored text). */
export const SEARCH_MARK_START = "\u0001";
export const SEARCH_MARK_END = "\u0002";

/** One message in a session timeline that matches a full-text search. */
export const SearchHit = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  sessionTitle: z.string().nullable(),
  seq: z.number().int(),
  ts: z.string(),
  /** tool: a tool call (name and input) or its result */
  role: z.enum(["user", "assistant", "tool"]),
  /** excerpt with matches wrapped in SEARCH_MARK_START / SEARCH_MARK_END */
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

/** Narrows a full-text search; without fields it covers every session, best matches first. */
export const SearchFilter = z.object({
  /** only this session */
  sessionId: z.string().min(1).max(100).optional(),
  /** only the sessions of this project, the worktrees of its agents included */
  projectId: z.string().min(1).max(100).optional(),
  /** the words in this order, next to each other */
  phrase: z.boolean().optional(),
  /** time: newest first instead of best first, to step through a chat */
  order: z.enum(["rank", "time"]).optional(),
});
export type SearchFilter = z.infer<typeof SearchFilter>;

export const DevServerState = z.object({
  projectId: z.string(),
  status: z.enum(["stopped", "running", "exited", "failed"]),
  /** command that runs or ran; null when stopped */
  command: z.string().nullable(),
  /** first local address found in the output */
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  error: z.string().nullable(),
  /** command used on start: the project's dev command, else the detected one */
  effectiveCommand: z.string().nullable(),
});
export type DevServerState = z.infer<typeof DevServerState>;

/** One step of preparing an agent's worktree: what the main folder has and git does not bring along. */
export const WorktreeSetupStep = z.object({
  id: z.enum(["files", "deps", "build", "database", "devserver"]),
  label: z.string(),
  status: z.enum(["pending", "running", "done", "skipped", "failed"]),
  /** what was done or why it failed; never values of configuration files */
  detail: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type WorktreeSetupStep = z.infer<typeof WorktreeSetupStep>;

/** Preparation of a parallel agent's worktree, running beside its session. */
export const WorktreeSetupState = z.object({
  projectId: z.string(),
  /** failed: at least one step failed; the agent can work anyway and is told what is missing */
  status: z.enum(["running", "done", "failed"]),
  steps: z.array(WorktreeSetupStep),
  /** port reserved for the worktree's own dev server */
  devPort: z.number().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type WorktreeSetupState = z.infer<typeof WorktreeSetupState>;

export const TestDbConfig = z.object({
  port: z.number().int().min(1024).max(65535),
  /** database created on first start */
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z_][a-z0-9_]*$/, "Datenbankname: Kleinbuchstaben, Ziffern und Unterstriche"),
  /** generated once per project; the server only listens on 127.0.0.1 */
  password: z.string(),
  /** start the database with the dev server */
  withDevServer: z.boolean(),
  /** variable that carries the connection URL to the dev server and the test command; null passes none */
  envVar: z
    .string()
    .max(100)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Variablenname: Buchstaben, Ziffern und Unterstriche")
    .nullable(),
});
export type TestDbConfig = z.infer<typeof TestDbConfig>;

/** Dev tools of a project. Kept in FORGE's database, never written into the project folder. */
export const DevToolsConfig = z.object({
  /** test environment in .env format */
  env: z.string().max(100_000),
  /** pass the test environment to the dev server and the test command */
  useEnv: z.boolean(),
  database: TestDbConfig,
});
export type DevToolsConfig = z.infer<typeof DevToolsConfig>;

/** Local PostgreSQL of a project, run by FORGE from binaries it downloads once. */
export const TestDbState = z.object({
  projectId: z.string(),
  status: z.enum(["stopped", "installing", "starting", "running", "stopping", "failed"]),
  /** download progress 0-1 while installing */
  progress: z.number().nullable(),
  /** PostgreSQL version FORGE uses */
  version: z.string(),
  /** binaries are downloaded */
  installed: z.boolean(),
  /** the project's data folder exists */
  initialized: z.boolean(),
  url: z.string(),
  startedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type TestDbState = z.infer<typeof TestDbState>;

/** One entry of a project's knowledge (`.forge/knowledge/<id>.md`). */
export const KnowledgeSummary = z.object({
  id: z.string(),
  title: z.string(),
  /** one line, shown in the index Claude gets at session start */
  summary: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});
export type KnowledgeSummary = z.infer<typeof KnowledgeSummary>;

export const KnowledgeEntry = KnowledgeSummary.extend({ content: z.string() });
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

/**
 * A prompt template: a recurring request saved once ("Review vor Release"), with placeholders like
 * {datei} that are asked for before sending. projectId null: global, offered in every project.
 */
export const PromptTemplate = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  text: z.string(),
  /** made by FORGE from repeated messages (templates.learn); an edit by the user makes it theirs */
  learned: z.boolean().optional(),
  /** order in the list; the global templates and those of each project are counted apart */
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromptTemplate = z.infer<typeof PromptTemplate>;
export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_DESCRIPTION_MAX = 300;
export const TEMPLATE_TEXT_MAX = 20_000;

/** What to tidy up in a project's knowledge: entries covering the same topic and very long entries. */
export const KnowledgeCleanup = z.object({
  /** `a` is largely contained in `b`; score 0-1, strongest first */
  overlaps: z.array(z.object({ a: z.string(), b: z.string(), score: z.number() })),
  long: z.array(z.object({ id: z.string(), chars: z.number() })),
});
export type KnowledgeCleanup = z.infer<typeof KnowledgeCleanup>;

/** Merged text Claude suggests for several entries; nothing is saved until knowledge.merge. */
export const KnowledgeMergeDraft = z.object({
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  content: z.string(),
  model: z.string(),
});
export type KnowledgeMergeDraft = z.infer<typeof KnowledgeMergeDraft>;

/** Groups of entries on one topic that Claude suggests merging; the first id of a group stays. */
export const KnowledgeMergePlan = z.object({
  groups: z.array(z.object({ ids: z.array(z.string()), reason: z.string() })),
  model: z.string(),
});
export type KnowledgeMergePlan = z.infer<typeof KnowledgeMergePlan>;

/** A file, folder or code name an entry mentions that the project no longer has. */
export const KnowledgeMissingRef = z.object({
  /** as written in the entry */
  ref: z.string(),
  kind: z.enum(["path", "name"]),
  /** where it went, if known: files with the same name, or the commit that removed it */
  hint: z.string().optional(),
});
export type KnowledgeMissingRef = z.infer<typeof KnowledgeMissingRef>;

/** Which references of the knowledge entries go nowhere; entries marked as checked leave those refs out. */
export const KnowledgeStaleReport = z.object({
  entries: z.array(z.object({ id: z.string(), missing: z.array(KnowledgeMissingRef), checked: z.number() })),
  /** false: the project is checked without git (plain file walk, no history) */
  git: z.boolean(),
});
export type KnowledgeStaleReport = z.infer<typeof KnowledgeStaleReport>;


/**
 * FORGE updates from the GitHub releases of the repository. The installer is fetched with the gh
 * login, so a private repository works for everyone with access to it.
 */
export const AppUpdateState = z.object({
  currentVersion: z.string(),
  phase: z.enum(["idle", "checking", "uptodate", "available", "downloading", "ready", "error"]),
  latest: z
    .object({
      version: z.string(),
      tag: z.string(),
      /** release notes of every version after `since` up to `version`, newest first */
      notes: z.string(),
      /**
       * Version the changes are listed from (not included): the installed one, or when that is too old
       * (local builds are 0.1.0), the release before the oldest one listed.
       */
      since: z.string(),
      publishedAt: z.string().nullable(),
      size: z.number().nullable(),
      /** patch: only exe and sidecar (a few MB); full: installer with the bundled runtime */
      kind: z.enum(["patch", "full"]),
      /**
       * Version whose full installer goes first, when `version` itself is only a small update for a
       * newer runtime than the installed one. The small update follows by itself after the restart.
       */
      via: z.string().nullable(),
    })
    .nullable(),
  /** second step of an update the user already started before the restart: install without asking */
  autoInstall: z.boolean(),
  /** downloaded and checked installer, ready to run */
  installerPath: z.string().nullable(),
  /** false in a development build: there is no installation to update */
  installable: z.boolean(),
  checkedAt: z.string().nullable(),
  message: z.string().nullable(),
});
export type AppUpdateState = z.infer<typeof AppUpdateState>;

/** One thing missing or outdated in the bundled runtime (node, git, gh …) of an installed FORGE. */
export const InstallProblem = z.object({
  /** tool name as in the runtime key (node, git, gh, python …), or runtime/versions for the folder and its list */
  part: z.string(),
  kind: z.enum(["missing", "outdated"]),
  /** short German text for the UI, e.g. "Git fehlt" or "GitHub CLI 2.90.0 statt 2.102.0" */
  label: z.string(),
});
export type InstallProblem = z.infer<typeof InstallProblem>;

/**
 * Whether the installation has the full bundled runtime this app version expects, and the repair:
 * the full installer (`*_<runtime>_x64-setup.exe`), found on GitHub or in the Downloads folder.
 */
export const AppInstallState = z.object({
  /** false in a development build: there is no installation to check */
  checkable: z.boolean(),
  /** null until the first check */
  complete: z.boolean().nullable(),
  problems: z.array(InstallProblem),
  /** runtime key this app version was built for; null when the build does not know it */
  expectedRuntime: z.string().nullable(),
  /** searching: looks for the installer; none: there is no matching one; ready: downloaded and checked */
  phase: z.enum(["idle", "searching", "found", "none", "downloading", "ready", "error"]),
  installer: z
    .object({
      version: z.string(),
      tag: z.string().nullable(),
      name: z.string(),
      size: z.number().nullable(),
      /** github: FORGE downloads it; local: a setup.exe the user already has (Downloads folder or picked) */
      source: z.enum(["github", "local"]),
      /** newer small update installed by itself after the restart, when the installer is an older version */
      then: z.string().nullable(),
    })
    .nullable(),
  /** bytes downloaded so far while `downloading` */
  received: z.number().nullable(),
  installerPath: z.string().nullable(),
  /** the GitHub CLI is there: FORGE can fetch the installer itself */
  canDownload: z.boolean(),
  checkedAt: z.string().nullable(),
  message: z.string().nullable(),
});
export type AppInstallState = z.infer<typeof AppInstallState>;

/**
 * What changed in the offered release, written by Claude from the release notes and commit messages.
 * `writing`: Claude is still at it, `commits` are already there to show. `unavailable`: no-claude
 * (CLI missing), no-login (not signed in), error (generation failed or took too long).
 */
export const AppChangelog = z.object({
  tag: z.string(),
  status: z.enum(["writing", "ready", "unavailable"]),
  text: z.string().nullable(),
  /** first lines of the commit messages since the installed version; empty when unknown */
  commits: z.array(z.string()),
  unavailable: z.enum(["no-claude", "no-login", "error"]).nullable(),
  message: z.string().nullable(),
});
export type AppChangelog = z.infer<typeof AppChangelog>;

/** Parts of a backup that can be restored one by one. */
export const BackupPart = z.enum(["settings", "projects", "phone", "claude", "git", "templates"]);
export type BackupPart = z.infer<typeof BackupPart>;

/** One backup of FORGE's configuration: in the data folder (id) or a file the user picked (no id). */
export const BackupInfo = z.object({
  id: z.string().nullable(),
  createdAt: z.string(),
  reason: z.enum(["start", "manual", "before-restore", "import"]),
  appVersion: z.string(),
  size: z.number(),
  /** parts present in the backup, with a short count for the list */
  parts: z.array(z.object({ part: BackupPart, label: z.string() })),
});
export type BackupInfo = z.infer<typeof BackupInfo>;

/** A project in the sync repository that is not on this computer yet. */
export const SyncAvailableProject = z.object({
  key: z.string(),
  name: z.string(),
  /** https clone URL; null for projects without a remote, which cannot be fetched */
  cloneUrl: z.string().nullable(),
});
export type SyncAvailableProject = z.infer<typeof SyncAvailableProject>;

/**
 * Something this computer still has that the sync repository no longer holds (removed on another
 * computer). It stays here and is not synced until the user decides.
 */
export const SyncLocalOnly = z.object({
  /** item key, e.g. "project:github.com/me/shop" */
  key: z.string(),
  kind: z.enum(["project", "claude", "mcp", "secret", "phone", "devtools", "setting", "git", "template"]),
  label: z.string(),
  /** for projects: the project here */
  projectId: z.string().nullable(),
});
export type SyncLocalOnly = z.infer<typeof SyncLocalOnly>;

/** One state of the sync repository (a commit of its file). */
export const SyncVersion = z.object({ sha: z.string(), date: z.string(), device: z.string().nullable() });
export type SyncVersion = z.infer<typeof SyncVersion>;

/**
 * Sync of FORGE's data over a private GitHub repository, encrypted with a key from the sync
 * password. off: switched off; no-github: nobody signed in with GitHub; needs-passphrase: the sync
 * password is missing on this computer or no longer fits (changed on another one); idle: in sync
 * (or waiting for the next run); syncing: running; error: the last run failed (message in `error`).
 */
export const SyncStatus = z.object({
  enabled: z.boolean(),
  phase: z.enum(["off", "no-github", "needs-passphrase", "idle", "syncing", "error"]),
  /** GitHub login the data belongs to */
  account: z.string().nullable(),
  /** "owner/forge-data" */
  repo: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  error: z.string().nullable(),
  /** who wrote the repository last */
  remote: z.object({ updatedAt: z.string(), device: z.string() }).nullable(),
  available: z.array(SyncAvailableProject),
  localOnly: z.array(SyncLocalOnly),
  /** a sync password is stored on this computer */
  hasKey: z.boolean(),
  /** something changed here and goes up with the next sync (a few seconds later) */
  pending: z.boolean(),
});
export type SyncStatus = z.infer<typeof SyncStatus>;

/** What the sync repository of the signed-in account holds, before syncing is switched on. */
export const SyncProbe = z.object({
  account: z.string().nullable(),
  repo: z.string().nullable(),
  /** the repository exists and holds FORGE data; then the sync password of that data is needed */
  found: z.boolean(),
  updatedAt: z.string().nullable(),
  device: z.string().nullable(),
  /** counts only when the password stored here opens the data */
  projects: z.number().nullable(),
  settings: z.number().nullable(),
});
export type SyncProbe = z.infer<typeof SyncProbe>;

/** OpenAI voices for speech output on the phone; the first one is the default. */
export const PHONE_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;

/** Gemini voices (Live and speech output); the first one is the default. */
export const PHONE_GEMINI_VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"] as const;

/**
 * Who leads the conversation on the phone. `gemini-live`: Gemini hears, thinks and speaks in one
 * model. `claude`: Claude (subscription) answers; speech recognition and output come from
 * `speechProvider`.
 */
export const PhoneEngine = z.enum(["gemini-live", "claude"]);
export type PhoneEngine = z.infer<typeof PhoneEngine>;

/** Yealink desk phone (T5x): session keys with LEDs, status on the display, provisioning by FORGE. */
export const DeskPhoneConfig = z.object({
  enabled: z.boolean(),
  /** IP of the desk phone in the LAN */
  phoneIp: z.string(),
  /** port of FORGE's small HTTP server for the phone (keys, provisioning) */
  httpPort: z.number().int(),
  /** web login of the phone (push messages, LEDs, remote keys) */
  webUser: z.string(),
  hasWebPassword: z.boolean(),
  /** line keys that show sessions, in order (S1 on the first) */
  sessionKeys: z.array(z.number().int().min(1).max(30)),
  /** line keys FORGE sets to "not used" (e.g. leftovers from an earlier setup) */
  clearKeys: z.array(z.number().int().min(1).max(30)),
  leds: z.boolean(),
  /** picking up the handset calls FORGE after a second (typing a number right away calls normally) */
  hotline: z.boolean(),
  /** status on the idle screen: several lines, one compact line, or nothing */
  display: z.enum(["lines", "statusline", "off"]),
  /** Auto Provision server URL to enter in the phone; null until the LAN address is known */
  provisioningUrl: z.string().nullable(),
});
export type DeskPhoneConfig = z.infer<typeof DeskPhoneConfig>;

/** A phone number FORGE calls or accepts calls from; switched off it stays in the list but does not count. */
export const PhoneNumberEntry = z.object({
  id: z.string().min(1).max(64),
  number: z.string().max(40),
  /** e.g. "Handy" or "Büro"; may be empty */
  label: z.string().max(40),
  enabled: z.boolean(),
});
export type PhoneNumberEntry = z.infer<typeof PhoneNumberEntry>;

/** Settings of the phone connection (SIP). Secrets are never sent to the UI, only whether they are set. */
export const PhoneConfig = z.object({
  engine: PhoneEngine,
  /** Gemini Live model */
  liveModel: z.string(),
  /** Gemini voice (Live, and speech output with speechProvider gemini) */
  geminiVoice: z.string(),
  /** speech recognition and output when Claude leads the conversation */
  speechProvider: z.enum(["openai", "gemini"]),
  geminiSttModel: z.string(),
  geminiTtsModel: z.string(),
  hasGeminiKey: z.boolean(),
  desk: DeskPhoneConfig,
  /** registrar / PBX host name or IP */
  server: z.string(),
  port: z.number().int(),
  /** SIP user (extension) */
  username: z.string(),
  /** user for authentication if it differs from the SIP user */
  authUsername: z.string().nullable(),
  /** SIP domain; empty uses the server */
  domain: z.string().nullable(),
  displayName: z.string(),
  /** OpenAI voice for speech output */
  voice: z.string(),
  /** OpenAI model for speech recognition */
  sttModel: z.string(),
  /** OpenAI model for speech output */
  ttsModel: z.string(),
  /** numbers that may call FORGE; none switched on means nobody */
  allowedCallers: z.array(PhoneNumberEntry),
  /** numbers FORGE calls for notifications, all switched-on ones at once; the first to answer takes the call */
  notifyNumbers: z.array(PhoneNumberEntry),
  notifyOn: z.object({ done: z.boolean(), approval: z.boolean(), error: z.boolean() }),
  /** steering actions (send, start, approve, stop) need the PIN via keypad */
  requirePin: z.boolean(),
  enabled: z.boolean(),
  hasPassword: z.boolean(),
  hasOpenAiKey: z.boolean(),
  hasPin: z.boolean(),
});
export type PhoneConfig = z.infer<typeof PhoneConfig>;

export const PhoneCallInfo = z.object({
  id: z.string(),
  direction: z.enum(["in", "out"]),
  number: z.string(),
  state: z.enum(["ringing", "active"]),
  startedAt: z.string(),
  /** PIN entered in this call */
  unlocked: z.boolean(),
  /** why FORGE calls (outgoing), e.g. "Session fertig: Warenkorb" */
  reason: z.string().nullable(),
});
export type PhoneCallInfo = z.infer<typeof PhoneCallInfo>;

export const PhoneState = z.object({
  enabled: z.boolean(),
  registration: z.enum(["off", "registering", "registered", "failed"]),
  message: z.string().nullable(),
  call: PhoneCallInfo.nullable(),
  /** desk phone: null when switched off; reachable null until FORGE has tried */
  desk: z.object({ reachable: z.boolean().nullable(), message: z.string().nullable() }).nullable(),
});
export type PhoneState = z.infer<typeof PhoneState>;

export const PhoneCallRecord = z.object({
  id: z.string(),
  direction: z.enum(["in", "out"]),
  number: z.string(),
  reason: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  result: z.enum(["answered", "rejected", "missed", "failed"]),
  detail: z.string().nullable(),
  transcript: z.array(z.object({ role: z.enum(["caller", "forge"]), text: z.string(), ts: z.string() })),
});
export type PhoneCallRecord = z.infer<typeof PhoneCallRecord>;

/** A day of the report, in local time. */
export const ReportDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum: JJJJ-MM-TT");

/** A session that worked on the report's day (it has events in the day). */
export const DailyReportSession = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  /** main project; for an agent's session the project its worktree belongs to */
  rootId: z.string(),
  title: z.string().nullable(),
  /** current status, not the one at the end of the day */
  status: SessionStatus,
  /** turns that ended on the day */
  turns: z.number().int(),
  /** of them ended with an error */
  errors: z.number().int(),
  firstAt: z.string(),
  lastAt: z.string(),
  /** runs in an agent's worktree */
  agent: z.boolean(),
  lastError: z.string().nullable(),
});
export type DailyReportSession = z.infer<typeof DailyReportSession>;

/**
 * A parallel agent of the day. running: its session works; done: finished, not merged yet; waiting:
 * auto-merge waits until the project can take the work; skipped: auto-merge left the decision to the
 * user; conflict: the agent resolves rebase conflicts; merged and discarded: gone.
 */
export const DailyReportAgentState = z.enum(["running", "done", "waiting", "skipped", "conflict", "merged", "discarded"]);
export type DailyReportAgentState = z.infer<typeof DailyReportAgentState>;

export const DailyReportAgent = z.object({
  /** worktree project; no longer exists after merged and discarded */
  worktreeId: z.string(),
  rootId: z.string(),
  rootName: z.string(),
  branch: z.string().nullable(),
  /** title of the agent's session */
  title: z.string().nullable(),
  /** the agent's session while it exists */
  sessionId: z.string().nullable(),
  /** the session that started it with start_agent */
  parentSessionId: z.string().nullable(),
  startedAt: z.string().nullable(),
  /** last change of its state */
  at: z.string(),
  state: DailyReportAgentState,
  message: z.string().nullable(),
  /** the worktree is still there */
  exists: z.boolean(),
});
export type DailyReportAgent = z.infer<typeof DailyReportAgent>;

export const DailyReportCommit = z.object({
  projectId: z.string(),
  projectName: z.string(),
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
  /** committed by FORGE after a turn (tag auto-commit) */
  auto: z.boolean(),
  /** came in with this agent's branch */
  agentBranch: z.string().nullable(),
  /** session whose turn led to it, while that session exists */
  sessionId: z.string().nullable(),
});
export type DailyReportCommit = z.infer<typeof DailyReportCommit>;

/** Open now (not at the end of the day): what waits for the user. */
export const DailyReportOpen = z.object({
  kind: z.enum(["question", "plan", "approval", "error", "autoContinue"]),
  sessionId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  sessionTitle: z.string().nullable(),
  /** the questions, the plan's first line, the tool and its command, the error */
  text: z.string(),
  /** since when; for autoContinue the planned time */
  at: z.string(),
  /** approval and question: the request to answer */
  requestId: z.string().nullable(),
});
export type DailyReportOpen = z.infer<typeof DailyReportOpen>;

export const DailyReportCall = PhoneCallRecord.omit({ transcript: true }).extend({
  /** lines of the transcript */
  lines: z.number().int(),
});
export type DailyReportCall = z.infer<typeof DailyReportCall>;

/**
 * What FORGE itself had Claude do: "auto" are session turns FORGE sent (continuing after the usage limit,
 * restart after an update, compacting, conflicts of an agent), the rest one-shot calls and the phone.
 */
export const ForgeUsagePurpose = z.enum(["auto", "commit", "title", "summary", "report", "knowledge", "pr", "changelog", "phone", "templates", "other"]);
export type ForgeUsagePurpose = z.infer<typeof ForgeUsagePurpose>;

const UsageTokens = {
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
};

/**
 * Tokens and working time of Claude that day. `tokens` in hours, projects and days are the new ones
 * (input, output, cache write), without the context read from the cache again. Working time is the sum of the calls' durations (parallel
 * calls count twice); activeMs is the clock time in which at least one ran.
 */
export const DailyReportUsage = z.object({
  turns: z.number(),
  /** requests to the API in these turns; each reads the context from the cache again */
  apiCalls: z.number(),
  workMs: z.number(),
  /** of workMs: turns of parallel agents */
  agentWorkMs: z.number(),
  activeMs: z.number(),
  /** most calls running at the same time */
  peakParallel: z.number(),
  ...UsageTokens,
  /**
   * What FORGE itself caused, by purpose, most new tokens first. `tokens` are new ones, like everywhere.
   * For one project only the turns FORGE sent there: the one-shot calls are not tied to a project.
   */
  forge: z.object({
    calls: z.number(),
    workMs: z.number(),
    tokens: z.number(),
    cacheReadTokens: z.number(),
    parts: z.array(z.object({ purpose: ForgeUsagePurpose, calls: z.number(), workMs: z.number(), tokens: z.number() })),
  }),
  /** 24 local hours */
  hours: z.array(z.object({ hour: z.number(), workMs: z.number(), tokens: z.number(), turns: z.number() })),
  /** main projects, most working time first */
  projects: z.array(z.object({ rootId: z.string(), name: z.string(), workMs: z.number(), tokens: z.number(), turns: z.number() })),
  /** the 14 days up to and including this one, oldest first */
  days: z.array(z.object({ date: ReportDate, workMs: z.number(), tokens: z.number() })),
});
export type DailyReportUsage = z.infer<typeof DailyReportUsage>;

/** What happened on one day, over all projects or for one. Facts from the database and git, no Claude. */
export const DailyReport = z.object({
  date: ReportDate,
  /** start and end of the day (ISO, end exclusive) */
  from: z.string(),
  to: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  sessions: z.array(DailyReportSession),
  agents: z.array(DailyReportAgent),
  commits: z.array(DailyReportCommit),
  open: z.array(DailyReportOpen),
  /** null for a report of one project: calls belong to no project */
  calls: z.array(DailyReportCall).nullable(),
  usage: DailyReportUsage,
  /** projects whose commits could not be read */
  gitErrors: z.array(z.object({ projectName: z.string(), message: z.string() })),
  /** more sessions or commits than listed */
  truncated: z.boolean(),
});
export type DailyReport = z.infer<typeof DailyReport>;
