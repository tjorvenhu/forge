import { z } from "zod";

export const ProfileId = z.enum(["safe", "balanced", "autonomous"]);
export type ProfileId = z.infer<typeof ProfileId>;

export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const ProjectTag = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Tags: Kleinbuchstaben, Ziffern und Bindestriche");

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

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  favorite: z.boolean(),
  tags: z.array(z.string()),
  technologies: z.array(z.string()),
  profile: ProfileId,
  autonomousConfirmed: z.boolean(),
  defaultModel: z.string().nullable(),
  createdAt: z.string(),
  lastOpenedAt: z.string().nullable(),
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

export const Session = z.object({
  id: z.string(),
  projectId: z.string(),
  claudeSessionId: z.string().nullable(),
  cwd: z.string(),
  title: z.string().nullable(),
  model: z.string().nullable(),
  profile: ProfileId,
  permissionMode: PermissionMode,
  status: SessionStatus,
  apiKeySource: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastError: z.string().nullable(),
  /** true while a live SDK process is attached in this app instance */
  live: z.boolean(),
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
  z.object({ type: z.literal("user.message"), text: z.string() }),
  z.object({
    type: z.literal("assistant.delta"),
    messageId: z.string(),
    index: z.number().int(),
    text: z.string(),
  }),
  z.object({ type: z.literal("assistant.thinking"), messageId: z.string() }),
  z.object({ type: z.literal("assistant.text"), messageId: z.string(), index: z.number().int(), text: z.string() }),
  z.object({
    type: z.literal("tool.use"),
    toolUseId: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    parentToolUseId: z.string().nullable(),
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
  }),
  z.object({
    type: z.literal("approval.resolved"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    scope: z.enum(["once", "session"]),
    source: z.enum(["user", "policy", "abort"]),
    message: z.string().nullable(),
  }),
  z.object({
    type: z.literal("policy.blocked"),
    toolUseId: z.string().nullable(),
    toolName: z.string(),
    rule: z.string(),
    message: z.string(),
  }),
  z.object({ type: z.literal("status"), status: SessionStatus, detail: z.string().nullable() }),
  z.object({
    type: z.literal("turn.result"),
    subtype: z.string(),
    isError: z.boolean(),
    durationMs: z.number().nullable(),
    numTurns: z.number().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cacheReadTokens: z.number().nullable(),
    text: z.string().nullable(),
  }),
  z.object({
    type: z.literal("rate_limit"),
    status: z.string(),
    resetsAt: z.number().nullable(),
    limitType: z.string().nullable(),
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
  date: z.string(),
  subject: z.string(),
});
export type CommitInfo = z.infer<typeof CommitInfo>;

export const BranchInfo = z.object({
  name: z.string(),
  current: z.boolean(),
  upstream: z.string().nullable(),
});
export type BranchInfo = z.infer<typeof BranchInfo>;

export const Settings = z.object({
  claudePath: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultProfile: ProfileId,
  autonomousUnlocked: z.boolean(),
  stripApiKey: z.boolean(),
  enterToSend: z.boolean(),
  sounds: z.boolean(),
  debugLogs: z.boolean(),
  defaultProjectDir: z.string().nullable(),
});
export type Settings = z.infer<typeof Settings>;

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
    apiProvider: z.string().nullable(),
    error: z.string().nullable(),
  }),
  apiKeyEnvPresent: z.boolean(),
  apiKeyStripped: z.boolean(),
  git: ToolCheck,
  gh: ToolCheck.extend({ authenticated: z.boolean().nullable() }),
  capabilities: z.array(Capability),
});
export type Diagnostics = z.infer<typeof Diagnostics>;

export const ModelInfo = z.object({ value: z.string(), displayName: z.string(), description: z.string() });
export type ModelInfo = z.infer<typeof ModelInfo>;

export const UsageWindow = z.object({
  key: z.string(),
  label: z.string(),
  /** percent used, 0-100 */
  utilization: z.number(),
  resetsAt: z.string().nullable(),
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

export const ClaudeSetupState = z.object({
  task: z.enum(["install", "login"]).nullable(),
  phase: z.enum(["idle", "running", "waiting_code", "done", "error", "cancelled"]),
  url: z.string().nullable(),
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
