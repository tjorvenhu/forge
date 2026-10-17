import { z } from "zod";
import { RpcErrorSchema } from "./errors.js";
import {
  AgentFinishResult,
  AgentReview,
  Attachment,
  BranchInfo,
  ClaudeSetupState,
  ClaudeUpdateInfo,
  CommitDetails,
  CommitInfo,
  ContextUsage,
  DailyReport,
  ReportDate,
  DevServerState,
  DevToolsConfig,
  WorktreeSetupState,
  KnowledgeCleanup,
  KnowledgeEntry,
  KnowledgeMergeDraft,
  KnowledgeMergePlan,
  KnowledgeStaleReport,
  KnowledgeSummary,
  PromptTemplate,
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_TEXT_MAX,
  TestDbConfig,
  TestDbState,
  SearchHit,
  PhoneConfig,
  PhoneEngine,
  PhoneNumberEntry,
  AppUpdateState,
  AppInstallState,
  AppChangelog,
  BackupInfo,
  BackupPart,
  PhoneState,
  PhoneCallRecord,
  ConfigDoc,
  ConfigDocKind,
  ConfigScope,
  Diagnostics,
  ExternalSession,
  FileDiff,
  GitHubAccount,
  GitHubLoginState,
  GitHubOrg,
  GitHubOwner,
  GitHubRepo,
  GitIntegrated,
  GitStatus,
  McpServer,
  MarketplacePlugin,
  MemoryFile,
  MemoryScope,
  PermissionMode,
  ProfileId,
  PlanUsage,
  Project,
  ProjectTag,
  ProjectWithStatus,
  PullRequest,
  RateLimitState,
  RemoteState,
  EffortLevel,
  ProjectRemovalInfo,
  RewindResult,
  RuntimeInfo,
  Session,
  SessionEvent,
  Settings,
  SlashCommand,
  SyncProbe,
  SyncStatus,
  SyncVersion,
  TextDoc,
  UiCompare,
  MAX_PROMPT_CHARS,
  UPLOAD_CHUNK_CHARS,
} from "./models.js";

const id = z.string().min(1).max(100);
const knowledgeFields = {
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(300),
  tags: z.array(z.string().trim().min(1).max(40)).max(12),
  content: z.string().max(50_000),
};
const knowledgeIds = z.array(id).min(2).max(6);
const projectRef = z.object({ projectId: id });
const sessionRef = z.object({ sessionId: id });
/** also a folder name in the data folder */
const compareId = z.string().regex(/^[a-z0-9-]{1,64}$/);
const relPaths = z.array(z.string().min(1).max(4096)).min(1).max(2000);
const empty = z.object({}).strict();
const voiceConnection = z.object({ language: z.string().min(2).max(12).default("de"), keyterms: z.array(z.string().max(100)).max(200).default([]) });
const pluginId = z.string().regex(/^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._-]{1,128}$/);
/** date: local day (JJJJ-MM-TT), today without it; projectId: one project with its agents, all without it */
const dailyReportParams = z.object({ date: ReportDate.optional(), projectId: id.optional() });

/**
 * Every RPC method: params are validated in the sidecar, results are typed for the UI.
 * Adding a method here forces a handler in the sidecar (see rpc/handlers.ts).
 */
export const methods = {
  "system.diagnostics": { params: z.object({ refresh: z.boolean().optional() }), result: Diagnostics },
  "system.runtimeInfo": { params: empty, result: RuntimeInfo.nullable() },
  "system.usage": { params: z.object({ refresh: z.boolean().optional() }), result: PlanUsage },
  /** latest plan rate limit reported by any session; changes arrive as ratelimit.updated */
  "system.rateLimit": { params: empty, result: RateLimitState },

  "claude.setupState": { params: empty, result: ClaudeSetupState },
  "claude.install": { params: empty, result: ClaudeSetupState },
  "claude.login": { params: empty, result: ClaudeSetupState },
  "claude.checkUpdate": { params: empty, result: ClaudeUpdateInfo },
  "claude.update": { params: empty, result: ClaudeSetupState },
  "claude.submitLoginCode": { params: z.object({ code: z.string().min(1).max(2000) }), result: ClaudeSetupState },
  "claude.cancelSetup": { params: empty, result: ClaudeSetupState },
  /** signs Claude Code out on this computer; sessions need a new sign-in afterwards */
  "claude.logout": { params: empty, result: ClaudeSetupState },

  "remote.state": { params: empty, result: RemoteState },
  "remote.start": { params: empty, result: RemoteState },
  "remote.stop": { params: empty, result: RemoteState },

  "github.account": { params: empty, result: GitHubAccount.nullable() },
  "github.loginState": { params: empty, result: GitHubLoginState },
  "github.startLogin": { params: z.object({ scopes: z.array(z.enum(["delete_repo"])).optional() }), result: GitHubLoginState },
  "github.cancelLogin": { params: empty, result: GitHubLoginState },
  "github.logout": { params: empty, result: z.object({ ok: z.boolean() }) },
  "github.repos": { params: empty, result: z.array(GitHubRepo) },
  "github.orgs": { params: empty, result: z.array(GitHubOrg) },
  "github.publish": {
    /** owner: an organisation of the account; without it the personal account */
    params: projectRef.extend({ private: z.boolean(), name: z.string().min(1).max(100).optional(), owner: GitHubOwner.optional() }),
    result: z.object({ url: z.string() }),
  },
  "git.identity": { params: empty, result: z.object({ name: z.string().nullable(), email: z.string().nullable() }) },
  "git.setIdentity": {
    params: z.object({ name: z.string().min(1).max(200), email: z.string().email().max(200) }),
    result: z.object({ name: z.string().nullable(), email: z.string().nullable() }),
  },

  "config.memoryList": { params: z.object({ projectId: id.optional() }), result: z.array(MemoryFile) },
  "config.memoryRead": { params: z.object({ projectId: id.optional(), scope: MemoryScope }), result: TextDoc },
  "config.memoryWrite": {
    params: z.object({ projectId: id.optional(), scope: MemoryScope, content: z.string().max(1_000_000), expectedMtimeMs: z.number().nullable() }),
    result: z.object({ path: z.string(), mtimeMs: z.number() }),
  },
  "config.docs": { params: z.object({ kind: ConfigDocKind, projectId: id.optional() }), result: z.array(ConfigDoc) },
  "config.docRead": { params: z.object({ kind: ConfigDocKind, scope: ConfigScope, name: z.string().max(64), projectId: id.optional() }), result: TextDoc },
  "config.docWrite": {
    params: z.object({
      kind: ConfigDocKind,
      scope: ConfigScope,
      name: z.string().max(64),
      projectId: id.optional(),
      content: z.string().max(1_000_000),
      expectedMtimeMs: z.number().nullable(),
    }),
    result: z.object({ path: z.string(), mtimeMs: z.number() }),
  },
  "config.docCreate": {
    params: z.object({ kind: ConfigDocKind, scope: ConfigScope, name: z.string().max(64), description: z.string().max(500), projectId: id.optional() }),
    result: z.object({ path: z.string(), mtimeMs: z.number() }),
  },
  "config.docDelete": { params: z.object({ kind: ConfigDocKind, scope: ConfigScope, name: z.string().max(64), projectId: id.optional() }), result: z.object({ ok: z.boolean() }) },
  "config.hooksRead": {
    params: z.object({ scope: z.enum(["user", "project", "local"]), projectId: id.optional() }),
    result: z.object({ path: z.string(), hooks: z.string(), mtimeMs: z.number().nullable() }),
  },
  "config.hooksWrite": {
    params: z.object({ scope: z.enum(["user", "project", "local"]), projectId: id.optional(), hooks: z.string().max(200_000), expectedMtimeMs: z.number().nullable() }),
    result: z.object({ path: z.string(), mtimeMs: z.number() }),
  },
  "mcp.list": { params: z.object({ projectId: id.optional() }), result: z.array(McpServer) },
  "mcp.add": {
    params: z.object({
      projectId: id.optional(),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      scope: z.enum(["user", "project", "local"]),
      transport: z.enum(["stdio", "http", "sse"]),
      target: z.string().min(1).max(2000),
      args: z.array(z.string().max(2000)).max(50).default([]),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).default({}),
    }),
    result: z.object({ ok: z.boolean(), output: z.string() }),
  },
  "mcp.remove": {
    params: z.object({ projectId: id.optional(), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), scope: z.enum(["user", "project", "local"]) }),
    result: z.object({ ok: z.boolean(), output: z.string() }),
  },

  /** all plugins of the added marketplaces plus the installed ones (user scope) */
  "plugins.catalog": { params: z.object({ refresh: z.boolean().optional() }), result: z.array(MarketplacePlugin) },
  "plugins.install": { params: z.object({ id: pluginId }), result: z.array(MarketplacePlugin) },
  "plugins.uninstall": { params: z.object({ id: pluginId }), result: z.array(MarketplacePlugin) },
  "plugins.setEnabled": { params: z.object({ id: pluginId, enabled: z.boolean() }), result: z.array(MarketplacePlugin) },

  "worktrees.create": { params: projectRef.extend({ branch: z.string().min(1).max(200) }), result: Project },
  "worktrees.remove": {
    /** deleteBranch: also delete the worktree's branch afterwards, merged or not */
    params: projectRef.extend({ force: z.boolean().default(false), deleteBranch: z.boolean().default(false) }),
    result: z.object({ ok: z.boolean(), deletedBranch: z.string().nullable(), branchError: z.string().nullable() }),
  },
  /** preparation of an agent's worktree (dependencies, local config, build cache, database, dev server); null for other projects */
  "worktrees.setup": { params: projectRef, result: WorktreeSetupState.nullable() },
  /** runs the preparation again, e.g. after a failed install */
  "worktrees.prepare": { params: projectRef, result: WorktreeSetupState },
  /** what a parallel agent did, for the decision to merge or discard its branch */
  "agents.review": { params: projectRef, result: AgentReview },
  /** merge: rebase the agent's branch onto its target and fast-forward it, then remove worktree and branch; discard: remove both unmerged */
  "agents.finish": { params: projectRef.extend({ action: z.enum(["merge", "discard"]) }), result: AgentFinishResult },
  "sessions.summarize": { params: sessionRef, result: z.object({ summary: z.string(), model: z.string() }) },

  /** what happened on a day (default today), over all projects or for one with its agents */
  "reports.daily": { params: dailyReportParams, result: DailyReport },
  /** short summary of the same report by Claude (small model, one-shot) */
  "reports.dailySummary": { params: dailyReportParams, result: z.object({ summary: z.string(), model: z.string() }) },

  "settings.get": { params: empty, result: Settings },
  "settings.update": { params: Settings.partial(), result: Settings },

  "projects.list": { params: empty, result: z.array(ProjectWithStatus) },
  "projects.get": { params: projectRef, result: ProjectWithStatus },
  /** gitEnabled is ignored for a folder that already has a .git: such a folder is always imported with git. */
  "projects.import": { params: z.object({ path: z.string().min(1).max(4096), gitEnabled: z.boolean().default(true) }), result: Project },
  /** What the import dialog shows before importing; a missing or unreadable folder is no error, just no git. */
  "projects.inspectFolder": { params: z.object({ path: z.string().min(1).max(4096) }), result: z.object({ hasGit: z.boolean() }) },
  "projects.create": {
    params: z.object({
      name: z.string().min(1).max(100),
      parentDir: z.string().min(1).max(4096),
      gitInit: z.boolean(),
      /** false: project without git; gitInit and github are ignored */
      gitEnabled: z.boolean().default(true),
      /** create a GitHub repository for the new project (requires GitHub login) */
      github: z.object({ private: z.boolean(), owner: GitHubOwner.nullable().default(null) }).nullable().default(null),
    }),
    result: z.object({ project: Project, github: z.object({ url: z.string().nullable(), error: z.string().nullable() }).nullable() }),
  },
  "projects.clone": {
    params: z.object({
      url: z.string().min(1).max(2048),
      parentDir: z.string().min(1).max(4096),
      dirName: z.string().max(100).optional(),
    }),
    result: Project,
  },
  "projects.update": {
    params: projectRef.extend({
      name: z.string().min(1).max(100).optional(),
      favorite: z.boolean().optional(),
      tags: z.array(ProjectTag).max(30).optional(),
      profile: ProfileId.optional(),
      defaultModel: z.string().max(100).nullable().optional(),
      defaultEffort: EffortLevel.nullable().optional(),
      testCommand: z.string().max(500).nullable().optional(),
      devCommand: z.string().max(500).nullable().optional(),
      gitEnabled: z.boolean().optional(),
    }),
    result: Project,
  },
  "projects.removalInfo": { params: projectRef, result: ProjectRemovalInfo },
  "projects.remove": {
    params: projectRef.extend({ deleteFolder: z.boolean().default(false), deleteGitHubRepo: z.boolean().default(false) }),
    result: z.object({ removed: z.boolean(), folderDeleted: z.boolean(), githubDeleted: z.boolean() }),
  },
  "projects.touch": { params: projectRef, result: Project },
  "projects.readClaudeMd": {
    params: projectRef,
    result: z.object({ exists: z.boolean(), content: z.string(), path: z.string() }),
  },
  "projects.listFiles": {
    params: projectRef.extend({ dir: z.string().max(4096).default("") }),
    result: z.array(z.object({ name: z.string(), path: z.string(), isDir: z.boolean(), size: z.number() })),
  },
  "projects.allFiles": {
    params: projectRef,
    result: z.object({ files: z.array(z.object({ name: z.string(), path: z.string() })), truncated: z.boolean() }),
  },
  "projects.readFile": {
    params: projectRef.extend({ path: z.string().min(1).max(4096) }),
    result: z.object({ path: z.string(), content: z.string(), truncated: z.boolean(), binary: z.boolean() }),
  },
  /** raw bytes of a project file from `offset` on (base64, a few MB per call), for image, PDF and media previews */
  "projects.readFileChunk": {
    params: projectRef.extend({ path: z.string().min(1).max(4096), offset: z.number().int().min(0).default(0) }),
    result: z.object({ size: z.number(), base64: z.string() }),
  },

  "sessions.list": {
    params: projectRef,
    result: z.object({ sessions: z.array(Session), external: z.array(ExternalSession) }),
  },
  "sessions.listAll": {
    params: z.object({ query: z.string().max(200).optional(), status: z.string().max(40).optional() }),
    result: z.array(Session.extend({ projectName: z.string() })),
  },
  "sessions.listLive": { params: z.object({}), result: z.array(Session.extend({ projectName: z.string() })) },
  "sessions.delete": {
    params: sessionRef.extend({ deleteTranscript: z.boolean().default(true) }),
    result: z.object({ deleted: z.boolean(), transcriptDeleted: z.boolean() }),
  },
  /** deletes every session; failures (e.g. a process that would not end) leave that session in place */
  "sessions.deleteAll": {
    params: z.object({ deleteTranscript: z.boolean().default(true) }),
    result: z.object({ deleted: z.array(z.string()), failed: z.number().int(), error: z.string().nullable() }),
  },
  "sessions.get": { params: sessionRef, result: Session },
  /** stops one background task or subagent; the turn and other tasks go on */
  "sessions.stopTask": { params: sessionRef.extend({ taskId: z.string().min(1) }), result: z.object({ ok: z.boolean() }) },
  /** the end (last 8 KiB) of what a background command printed so far */
  "sessions.taskOutput": {
    params: sessionRef.extend({ taskId: z.string().min(1) }),
    result: z.object({ output: z.string(), totalBytes: z.number(), truncated: z.boolean() }),
  },
  /**
   * A message to a background task, by task id or the call that started it. A subagent gets it
   * through Claude (SendMessage), a command cannot read input: Claude gets it with the task named.
   */
  "sessions.messageTask": {
    params: sessionRef.extend({ taskId: z.string().min(1).optional(), toolUseId: z.string().min(1).optional(), text: z.string().min(1).max(MAX_PROMPT_CHARS) }),
    result: Session,
  },
  /** moves running foreground work (a subagent or command, or all with no toolUseId) into the background, like Ctrl+B */
  "sessions.toBackground": { params: sessionRef.extend({ toolUseId: z.string().optional() }), result: z.object({ moved: z.boolean() }) },
  /**
   * A branch of the conversation: a new session with the history before the prompt with seq
   * `beforeSeq` (the whole history without it). `session` is null when the branch starts before the
   * first prompt; `prompt` is the text to edit and send again.
   */
  "sessions.fork": {
    params: sessionRef.extend({ beforeSeq: z.number().int().optional(), rewindFiles: z.boolean().default(false) }),
    result: z.object({ session: Session.nullable(), prompt: z.string().nullable(), filesChanged: z.array(z.string()).nullable() }),
  },
  "sessions.events": {
    /** the newest events (at most 2,000) after afterSeq; older ones page by passing the first seq as beforeSeq */
    params: sessionRef.extend({ afterSeq: z.number().int().optional(), beforeSeq: z.number().int().optional() }),
    result: z.array(SessionEvent),
  },
  /**
   * A file pasted into the composer, uploaded in chunks so no protocol line gets large. The last chunk
   * returns the path of the stored file; from then on it is attached like a file from disk.
   */
  "attachments.upload": {
    params: z.object({
      uploadId: z.uuid(),
      name: z.string().min(1).max(260),
      index: z.number().int().min(0),
      chunk: z.string().max(UPLOAD_CHUNK_CHARS),
      last: z.boolean(),
    }),
    result: z.object({ path: z.string().nullable() }),
  },
  /** the images of a sent user message or of a tool result (seq of the tool.result), read back from the Claude Code transcript */
  "sessions.images": {
    params: sessionRef.extend({ seq: z.number().int() }),
    result: z.array(z.object({ mediaType: z.string(), base64: z.string() })),
  },
  "sessions.start": {
    params: projectRef.extend({
      prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
      model: z.string().max(100).nullable().optional(),
      effort: EffortLevel.nullable().optional(),
      planOnly: z.boolean().optional(),
      resumeClaudeSessionId: z.string().max(100).optional(),
      attachments: z.array(Attachment).max(10).default([]),
    }),
    result: Session,
  },
  "sessions.send": { params: sessionRef.extend({ text: z.string().min(1).max(MAX_PROMPT_CHARS), attachments: z.array(Attachment).max(10).default([]) }), result: Session },
  "sessions.rewind": { params: sessionRef.extend({ messageUuid: z.string().max(100), dryRun: z.boolean().default(false) }), result: RewindResult },
  /**
   * Replaces the prompt with seq `seq` by `text`: a running turn stops, Claude's conversation goes back
   * to before that prompt and continues with the new text. Files stay as they are.
   */
  "sessions.edit": { params: sessionRef.extend({ seq: z.number().int(), text: z.string().min(1).max(MAX_PROMPT_CHARS) }), result: Session },
  "system.commands": { params: z.object({ projectId: id.optional() }), result: z.array(SlashCommand) },
  "sessions.resume": {
    params: sessionRef.extend({ prompt: z.string().min(1).max(MAX_PROMPT_CHARS), attachments: z.array(Attachment).max(10).default([]) }),
    result: Session,
  },
  "sessions.stop": { params: sessionRef, result: Session },
  /** drops the planned automatic continuation after a usage limit */
  "sessions.cancelAutoContinue": { params: sessionRef, result: Session },
  /** a before/after comparison of the web app (event ui.compare); NOT_FOUND once its images were cleaned up */
  "uiCompare.get": { params: sessionRef.extend({ compareId }), result: UiCompare },
  /** one image of a comparison, read from FORGE's data folder */
  "uiCompare.image": {
    params: sessionRef.extend({ compareId, side: z.enum(["before", "after"]) }),
    result: z.object({ mediaType: z.string(), base64: z.string() }),
  },
  /** takes the after image again (the dev server was still reloading); returns right away with status capturing */
  "uiCompare.retake": { params: sessionRef.extend({ compareId }), result: UiCompare },
  /** the newest comparison of a session, of a project or of all; null when there is none */
  "uiCompare.latest": { params: z.object({ sessionId: id.optional(), projectId: id.optional() }), result: UiCompare.nullable() },
  "sessions.close": { params: sessionRef, result: Session },
  "sessions.setModel": { params: sessionRef.extend({ model: z.string().max(100) }), result: Session },
  "sessions.setEffort": { params: sessionRef.extend({ effort: EffortLevel.nullable() }), result: Session },
  "sessions.setPermissionMode": { params: sessionRef.extend({ mode: PermissionMode }), result: Session },
  "sessions.respondApproval": {
    params: sessionRef.extend({
      requestId: id,
      decision: z.enum(["allow", "deny"]),
      scope: z.enum(["once", "session"]).default("once"),
      message: z.string().max(2000).optional(),
      /** answers to an AskUserQuestion request: question text -> answer (multi-select comma-separated) */
      answers: z.record(z.string().max(2000), z.string().max(5000)).optional(),
    }),
    result: z.object({ ok: z.boolean() }),
  },
  "sessions.contextUsage": { params: sessionRef, result: ContextUsage.nullable() },
  "search.sessions": {
    params: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(200).default(50) }),
    result: z.array(SearchHit),
  },

  "devserver.state": { params: projectRef, result: DevServerState },
  "devserver.start": { params: projectRef, result: DevServerState },
  "devserver.stop": { params: projectRef, result: DevServerState },
  "devserver.output": { params: projectRef, result: z.object({ text: z.string() }) },

  "devtools.get": { params: projectRef, result: DevToolsConfig },
  "devtools.update": {
    params: projectRef.extend({
      env: DevToolsConfig.shape.env.optional(),
      useEnv: z.boolean().optional(),
      database: TestDbConfig.omit({ password: true }).partial().optional(),
    }),
    result: DevToolsConfig,
  },
  /** .env files in the project root, to take over into the test environment */
  "devtools.envFiles": { params: projectRef, result: z.array(z.string()) },
  "devtools.readEnvFile": { params: projectRef.extend({ name: z.string().min(1).max(200) }), result: z.object({ text: z.string() }) },

  "testdb.state": { params: projectRef, result: TestDbState },
  /** downloads PostgreSQL on first use, creates the database if needed and starts it */
  "testdb.start": { params: projectRef, result: TestDbState },
  "testdb.stop": { params: projectRef, result: TestDbState },
  /** deletes all data: the next start begins with an empty database */
  "testdb.reset": { params: projectRef, result: TestDbState },
  "testdb.log": { params: projectRef, result: z.object({ text: z.string() }) },

  "knowledge.list": { params: projectRef, result: z.array(KnowledgeSummary) },
  "knowledge.read": { params: projectRef.extend({ id }), result: KnowledgeEntry },
  "knowledge.save": {
    params: projectRef.extend({
      /** null creates a new entry */
      id: id.nullable(),
      ...knowledgeFields,
    }),
    result: KnowledgeEntry,
  },
  "knowledge.delete": { params: projectRef.extend({ id }), result: z.object({ ok: z.boolean() }) },
  /** entries that likely cover the same topic, and very long ones */
  "knowledge.cleanup": { params: projectRef, result: KnowledgeCleanup },
  /** one-shot Claude call that writes the merged text; saves nothing */
  "knowledge.mergeDraft": { params: projectRef.extend({ ids: knowledgeIds }), result: KnowledgeMergeDraft },
  /** one-shot Claude call that picks the entries to merge; changes nothing */
  "knowledge.mergePlan": { params: projectRef, result: KnowledgeMergePlan },
  /** writes the text into the first entry and deletes the others */
  "knowledge.merge": {
    params: projectRef.extend({ ids: knowledgeIds, ...knowledgeFields }),
    result: z.object({ entry: KnowledgeEntry, removed: z.array(z.string()) }),
  },
  /** files, folders and code names the entries mention that no longer exist; cached per entry and project state */
  "knowledge.checkRefs": { params: projectRef.extend({ id: id.optional(), refresh: z.boolean().default(false) }), result: KnowledgeStaleReport },
  /** the missing refs of an entry were a false alarm: they are left out from now on */
  "knowledge.markChecked": { params: projectRef.extend({ id }), result: z.object({ verified: z.array(z.string()) }) },
  /** one-shot Claude call that corrects the missing refs of an entry; saves nothing (knowledge.save does) */
  "knowledge.fixDraft": { params: projectRef.extend({ id }), result: KnowledgeMergeDraft },

  /** global templates plus those of the project; all: every template of every project (settings page) */
  "templates.list": { params: z.object({ projectId: id.optional(), all: z.boolean().default(false) }), result: z.array(PromptTemplate) },
  "templates.save": {
    params: z.object({
      /** null creates a new template, at the end of its list */
      id: id.nullable(),
      /** null: global */
      projectId: id.nullable(),
      name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
      description: z.string().trim().max(TEMPLATE_DESCRIPTION_MAX).nullable().default(null),
      text: z.string().min(1).max(TEMPLATE_TEXT_MAX),
    }),
    result: PromptTemplate,
  },
  "templates.delete": { params: z.object({ id }), result: z.object({ ok: z.boolean() }) },
  /** new order of the given templates within their list (global or one project); others keep their place */
  "templates.reorder": { params: z.object({ ids: z.array(id).min(1).max(1000) }), result: z.array(PromptTemplate) },

  "app.updateState": { params: empty, result: AppUpdateState },
  /**
   * whether a FORGE window is active, and whether the user just used it (keys, mouse); FORGE does not call while they are there.
   * window: label of the reporting window (main or a chat window), so several windows do not overwrite each other's focus.
   */
  "app.presence": { params: z.object({ focused: z.boolean(), active: z.boolean(), window: z.string().min(1).max(120).default("main") }), result: z.object({}) },
  /** looks for a newer release now */
  "app.checkUpdate": { params: empty, result: AppUpdateState },
  /** downloads and checks the installer of the newest release; installing is a command of the desktop shell */
  "app.downloadUpdate": { params: empty, result: AppUpdateState },
  /**
   * The desktop shell ends FORGE for an update next: the open sessions are noted and continue after the
   * restart, those that were working with a message to Claude. cancel: the installation did not start.
   */
  "app.prepareInstall": {
    params: z.object({ cancel: z.boolean().default(false) }),
    result: z.object({ sessions: z.number().int(), working: z.number().int() }),
  },
  /** asks the main window to install the offered update (event update.install); for the phone */
  "app.installUpdate": { params: empty, result: AppUpdateState },
  /** state of Claude's summary of the offered release; starts it and returns at once (poll while "writing") */
  "app.changelog": { params: empty, result: AppChangelog.nullable() },
  /** whether the bundled runtime is complete, and the state of the repair (full installer) */
  "app.installState": { params: empty, result: AppInstallState },
  /** checks the runtime again and looks for the matching full installer */
  "app.checkInstall": { params: empty, result: AppInstallState },
  /** downloads and checks the full installer that was found (or copies the local one into the update folder) */
  "app.downloadFullInstaller": { params: empty, result: AppInstallState },
  /** a setup.exe the user picked: checked and copied into the update folder, then ready to run */
  "app.useLocalInstaller": { params: z.object({ path: z.string().min(1).max(4096) }), result: AppInstallState },
  /** asks the main window to install FORGE fully (event install.repair); for the phone */
  "app.repairInstall": { params: empty, result: AppInstallState },

  "backup.list": { params: empty, result: z.array(BackupInfo) },
  "backup.create": { params: empty, result: BackupInfo },
  /** writes a backup to a file the user picked: the stored one with `id`, otherwise a fresh one */
  "backup.export": { params: z.object({ id: z.string().max(200).optional(), path: z.string().min(1).max(4096) }), result: z.object({ path: z.string() }) },
  /** reads a backup file the user picked, for the preview before restoring */
  "backup.inspect": { params: z.object({ path: z.string().min(1).max(4096) }), result: BackupInfo },
  /**
   * Restores the chosen parts from a stored backup (`id`) or a file (`path`). Saves the current
   * state first, so the restore itself can be undone.
   */
  "backup.restore": {
    params: z.object({ id: z.string().max(200).optional(), path: z.string().max(4096).optional(), parts: z.array(BackupPart).min(1) }),
    result: z.object({ restored: z.array(BackupPart), safety: BackupInfo, notes: z.array(z.string()) }),
  },

  /** switched on and off with the setting syncEnabled */
  "sync.status": { params: empty, result: SyncStatus },
  /** syncs right away (pull, merge, push); fails when sync is off or nobody is signed in with GitHub */
  "sync.now": { params: empty, result: SyncStatus },
  /** looks into the sync repository without changing anything, e.g. before switching sync on */
  "sync.probe": { params: empty, result: SyncProbe },
  /** clones a project from the sync repository into the folder for new projects and takes over its settings */
  "sync.cloneProject": { params: z.object({ key: z.string().min(1).max(500) }), result: Project },
  /**
   * The sync password of this computer. With data on GitHub it must open it; otherwise it becomes the
   * password of the repository. Only a key derived from it is stored, DPAPI-encrypted.
   */
  "sync.setPassphrase": { params: z.object({ passphrase: z.string().min(1).max(500) }), result: SyncStatus },
  /** overwrites the sync repository with this computer's data under a new password (forgotten password, fresh start) */
  "sync.resetRemote": { params: z.object({ passphrase: z.string().min(1).max(500) }), result: SyncStatus },
  /**
   * Sets this computer hard to the state on GitHub: every synced value is taken over, what was removed
   * on another computer is removed here too (projects only from FORGE, their folders stay). With `key`
   * only that item. Saves a backup first.
   */
  "sync.forceLocal": {
    /** expectRemove: what the user was told would be removed here; when that changed meanwhile, nothing happens */
    params: z.object({ key: z.string().min(1).max(600).optional(), expectRemove: z.array(z.string().max(600)).max(2000).optional() }),
    result: SyncStatus,
  },
  /** syncs an item again that another computer removed: it goes back into the repository */
  "sync.keep": { params: z.object({ key: z.string().min(1).max(600) }), result: SyncStatus },
  /** states of the sync repository, newest first */
  "sync.versions": { params: empty, result: z.array(SyncVersion) },
  /** takes the chosen parts back from an older state on GitHub; saves a backup first, the other computers get it with the next sync */
  "sync.restoreVersion": {
    params: z.object({ sha: z.string().regex(/^[0-9a-f]{7,64}$/), parts: z.array(BackupPart).min(1) }),
    result: z.object({ restored: z.array(BackupPart), notes: z.array(z.string()) }),
  },

  "phone.config": { params: empty, result: PhoneConfig },
  "phone.saveConfig": {
    params: z.object({
      server: z.string().max(253).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().max(100).optional(),
      authUsername: z.string().max(100).nullable().optional(),
      domain: z.string().max(253).nullable().optional(),
      displayName: z.string().max(60).optional(),
      voice: z.string().max(40).optional(),
      sttModel: z.string().max(60).optional(),
      ttsModel: z.string().max(60).optional(),
      allowedCallers: z.array(PhoneNumberEntry).max(20).optional(),
      notifyNumbers: z.array(PhoneNumberEntry).max(10).optional(),
      notifyOn: z.object({ done: z.boolean(), approval: z.boolean(), error: z.boolean() }).optional(),
      requirePin: z.boolean().optional(),
      engine: PhoneEngine.optional(),
      liveModel: z.string().max(80).optional(),
      geminiVoice: z.string().max(40).optional(),
      speechProvider: z.enum(["openai", "gemini"]).optional(),
      geminiSttModel: z.string().max(80).optional(),
      geminiTtsModel: z.string().max(80).optional(),
      desk: z
        .object({
          enabled: z.boolean(),
          phoneIp: z.string().max(64),
          httpPort: z.number().int().min(1024).max(65535),
          webUser: z.string().max(100),
          sessionKeys: z.array(z.number().int().min(1).max(30)).max(10),
          clearKeys: z.array(z.number().int().min(1).max(30)).max(30),
          leds: z.boolean(),
          hotline: z.boolean(),
          display: z.enum(["lines", "statusline", "off"]),
        })
        .partial()
        .optional(),
      /** new Gemini API key; empty string removes it */
      geminiKey: z.string().max(400).optional(),
      /** new web password of the desk phone; empty string removes it */
      deskPassword: z.string().max(200).optional(),
      /** new SIP password; empty string removes it */
      password: z.string().max(200).optional(),
      /** new OpenAI API key; empty string removes it */
      openAiKey: z.string().max(400).optional(),
      /** new PIN (4 to 8 digits); empty string removes it */
      pin: z.string().regex(/^(\d{4,8})?$/, "PIN: 4 bis 8 Ziffern").optional(),
    }),
    result: PhoneConfig,
  },
  "phone.state": { params: empty, result: PhoneState },
  "phone.setEnabled": { params: z.object({ enabled: z.boolean() }), result: PhoneState },
  "phone.testCall": { params: empty, result: PhoneState },
  "phone.hangup": { params: empty, result: PhoneState },
  /** shows a test message on the desk phone and refreshes keys and LEDs */
  "phone.deskTest": { params: empty, result: PhoneState },
  "phone.calls": { params: z.object({ limit: z.number().int().min(1).max(100).default(20) }), result: z.array(PhoneCallRecord) },

  /**
   * Dictation in the composer over Claude's speech service (the one of /voice in the terminal).
   * start opens the stream, audio sends 16-bit mono samples at 16 kHz (base64), stop returns the text.
   * While recording, "voice.transcript" events carry the text so far. prewarm opens the connection
   * ahead of a recording with the same language and keyterms, so start does not wait for it.
   */
  "voice.prewarm": { params: voiceConnection, result: z.object({}) },
  "voice.start": { params: voiceConnection, result: z.object({ id: z.string() }) },
  "voice.audio": { params: z.object({ id: z.string(), pcm: z.string().min(1).max(400_000) }), result: z.object({}) },
  "voice.stop": { params: z.object({ id: z.string() }), result: z.object({ text: z.string() }) },
  "voice.cancel": { params: z.object({ id: z.string() }), result: z.object({}) },

  "git.status": { params: projectRef, result: GitStatus },
  "git.diff": {
    params: projectRef.extend({ path: z.string().min(1).max(4096), staged: z.boolean() }),
    result: FileDiff,
  },
  "git.stage": { params: projectRef.extend({ paths: relPaths }), result: GitStatus },
  "git.unstage": { params: projectRef.extend({ paths: relPaths }), result: GitStatus },
  "git.commit": {
    params: projectRef.extend({
      message: z.string().min(1).max(20_000),
      /** files the user reviewed; they are staged exactly, everything else is unstaged */
      paths: relPaths,
      allowSensitive: z.boolean().default(false),
    }),
    result: z.object({ hash: z.string(), summary: z.string() }),
  },
  "git.log": { params: projectRef.extend({ limit: z.number().int().min(1).max(500).default(50) }), result: z.array(CommitInfo) },
  /**
   * GitHub pictures of the authors in the latest `limit` commits, by author email, looked up on the
   * GitHub remote via gh. null: no GitHub account found. Emails without an entry were not looked up.
   */
  "git.authorAvatars": {
    params: projectRef.extend({ limit: z.number().int().min(1).max(500).default(50) }),
    result: z.record(z.string(), z.string().nullable()),
  },
  /** Message body and changed files of a commit, against its first parent. */
  "git.commitFiles": {
    params: projectRef.extend({ commit: z.string().regex(/^[0-9a-f]{7,40}$/i) }),
    result: CommitDetails,
  },
  /** Diff of one file of a commit against its first parent; `origPath` for the old side of a rename. */
  "git.commitDiff": {
    params: projectRef.extend({ commit: z.string().regex(/^[0-9a-f]{7,40}$/i), path: z.string().min(1).max(4096), origPath: z.string().min(1).max(4096).optional() }),
    result: FileDiff,
  },
  /** Files of the project back to the state of a commit, as uncommitted changes; open work is stashed first. */
  "git.restoreTo": {
    params: projectRef.extend({ commit: z.string().regex(/^[0-9a-f]{7,40}$/i) }),
    result: z.object({ commit: z.string(), subject: z.string(), stashed: z.boolean(), changed: z.number().int() }),
  },
  "git.branches": { params: projectRef, result: z.array(BranchInfo) },
  /** Local branch; without force, a branch with commits in no other branch fails with CONFLICT (details.unmerged). */
  "git.deleteBranch": {
    params: projectRef.extend({ branch: z.string().min(1).max(250), force: z.boolean().default(false) }),
    result: z.array(BranchInfo),
  },
  "git.checkout": {
    params: projectRef.extend({ branch: z.string().min(1).max(250), create: z.boolean().default(false) }),
    result: GitStatus,
  },
  /**
   * Takes over new commits from origin first (fast-forward or rebase), then pushes. When that runs
   * into conflicts, a Claude session is started to resolve them and push; it comes back as `session`.
   */
  "git.push": {
    params: projectRef.extend({ allowProtected: z.boolean().default(false) }),
    result: z.object({ branch: z.string().nullable(), integrated: GitIntegrated.nullable(), session: Session.nullable() }),
  },
  /** like git.push without the push; conflicts also start a Claude session */
  "git.pull": { params: projectRef, result: z.object({ output: z.string(), integrated: GitIntegrated.nullable(), session: Session.nullable() }) },
  "git.fetch": { params: projectRef, result: GitStatus },
  "github.pr": { params: projectRef, result: PullRequest.nullable() },
  "github.suggestPr": { params: projectRef, result: z.object({ title: z.string(), body: z.string(), base: z.string(), head: z.string() }) },
  "github.createPr": {
    params: projectRef.extend({ title: z.string().min(1).max(256), body: z.string().max(60_000), base: z.string().min(1).max(250), draft: z.boolean().default(false) }),
    result: z.object({ url: z.string() }),
  },
  "git.init": { params: projectRef, result: GitStatus },
  "git.suggestCommitMessage": {
    params: projectRef.extend({ paths: z.array(z.string().min(1).max(4096)).max(2000).optional() }),
    result: z.object({ message: z.string(), model: z.string(), skipped: z.array(z.string()) }),
  },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = z.input<Methods[M]["params"]>;
export type ParsedParamsOf<M extends MethodName> = z.output<Methods[M]["params"]>;
export type ResultOf<M extends MethodName> = z.output<Methods[M]["result"]>;

export const RpcRequest = z.object({
  id: z.string().min(1).max(64),
  method: z.string(),
  params: z.unknown(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcResponse = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: RpcErrorSchema }),
]);
export type RpcResponse = z.infer<typeof RpcResponse>;

/** Push events from sidecar to UI. */
export type ServerEvent =
  | { event: "session.event"; payload: SessionEvent }
  | { event: "session.updated"; payload: Session }
  /** a whole job of the session is done: its turn, its background tasks and the agents it started */
  | { event: "session.done"; payload: { sessionId: string } }
  | { event: "project.updated"; payload: { projectId: string } }
  | { event: "github.login"; payload: GitHubLoginState }
  | { event: "claude.setup"; payload: ClaudeSetupState }
  /** Claude Code rejected the sign-in in a session (expired or revoked): the UI offers to sign in again */
  | { event: "claude.authRequired"; payload: { sessionId: string } }
  | { event: "remote.updated"; payload: RemoteState }
  /** settings changed (in any window or over the phone) */
  | { event: "settings.updated"; payload: Settings }
  | { event: "ratelimit.updated"; payload: RateLimitState }
  /** output tokens per second of all Claude processes together (sessions, subagents, agents, phone); sent while it changes */
  | { event: "tokens.rate"; payload: { perSecond: number } }
  | { event: "devserver.updated"; payload: DevServerState }
  | { event: "devserver.output"; payload: { projectId: string; text: string } }
  | { event: "testdb.updated"; payload: TestDbState }
  | { event: "worktree.setup"; payload: WorktreeSetupState }
  /** an entry of the project's knowledge was saved or deleted (also by Claude) */
  | { event: "knowledge.updated"; payload: { projectId: string } }
  /** prompt templates changed (in any window, over the phone or by the sync); projectId null: global ones */
  | { event: "templates.updated"; payload: { projectId: string | null } }
  /**
   * auto-merge of a finished agent. skipped: FORGE could not merge on its own, the user decides
   * (the dialog for `worktreeId`); conflict: the agent resolves them, the next turn end tries again
   */
  /** `sessionIds`: sessions of the worktree, read before the merge removed them (their chat windows close) */
  | { event: "agent.autoMerge"; payload: { rootId: string; worktreeId: string; branch: string | null; outcome: "merged" | "conflict" | "skipped" | "waiting"; message: string; sessionIds: string[] } }
  /** a before/after comparison changed (after image taken, failed, taken again) */
  | { event: "uiCompare.updated"; payload: UiCompare }
  | { event: "phone.updated"; payload: PhoneState }
  | { event: "sync.updated"; payload: SyncStatus }
  | { event: "update.updated"; payload: AppUpdateState }
  /** the main window installs the offered update (asked for on the phone) */
  | { event: "update.install"; payload: Record<string, never> }
  | { event: "install.updated"; payload: AppInstallState }
  /** the main window installs FORGE fully with the full installer (asked for on the phone) */
  | { event: "install.repair"; payload: Record<string, never> }
  | { event: "sidecar.ready"; payload: { version: string } }
  /** dictation: the text of a running recording so far (finished utterances plus the current one) */
  | { event: "voice.transcript"; payload: { id: string; text: string } }
  /** Claude Code's model list changed; `added`: models FORGE has not seen before (empty on the first run) */
  | { event: "runtime.models"; payload: { added: Array<{ value: string; displayName: string }> } }
  | { event: "log"; payload: { level: "info" | "warn" | "error"; message: string } };

export type ServerEventName = ServerEvent["event"];
export type ServerEventPayload<E extends ServerEventName> = Extract<ServerEvent, { event: E }>["payload"];
