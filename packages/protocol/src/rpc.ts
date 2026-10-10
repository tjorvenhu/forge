import { z } from "zod";
import { RpcErrorSchema } from "./errors.js";
import {
  Attachment,
  BranchInfo,
  ClaudeSetupState,
  CommitInfo,
  ConfigDoc,
  ConfigDocKind,
  ConfigScope,
  Diagnostics,
  ExternalSession,
  FileDiff,
  GitHubAccount,
  GitHubLoginState,
  GitHubRepo,
  GitStatus,
  McpServer,
  MemoryFile,
  MemoryScope,
  PermissionMode,
  ProfileId,
  PlanUsage,
  Project,
  ProjectTag,
  ProjectWithStatus,
  PullRequest,
  RemoteState,
  RewindResult,
  RuntimeInfo,
  Session,
  SessionEvent,
  Schedule,
  Settings,
  SlashCommand,
  TextDoc,
  WorkflowOptions,
  WorkflowRun,
} from "./models.js";

const id = z.string().min(1).max(100);
const projectRef = z.object({ projectId: id });
const sessionRef = z.object({ sessionId: id });
const relPaths = z.array(z.string().min(1).max(4096)).min(1).max(2000);
const empty = z.object({}).strict();

/**
 * Every RPC method: params are validated in the sidecar, results are typed for the UI.
 * Adding a method here forces a handler in the sidecar (see rpc/handlers.ts).
 */
export const methods = {
  "system.diagnostics": { params: z.object({ refresh: z.boolean().optional() }), result: Diagnostics },
  "system.runtimeInfo": { params: empty, result: RuntimeInfo.nullable() },
  "system.usage": { params: z.object({ refresh: z.boolean().optional() }), result: PlanUsage },

  "claude.setupState": { params: empty, result: ClaudeSetupState },
  "claude.install": { params: empty, result: ClaudeSetupState },
  "claude.login": { params: empty, result: ClaudeSetupState },
  "claude.submitLoginCode": { params: z.object({ code: z.string().min(1).max(2000) }), result: ClaudeSetupState },
  "claude.cancelSetup": { params: empty, result: ClaudeSetupState },

  "remote.state": { params: projectRef, result: RemoteState },
  "remote.start": { params: projectRef, result: RemoteState },
  "remote.stop": { params: projectRef, result: RemoteState },

  "github.account": { params: empty, result: GitHubAccount.nullable() },
  "github.loginState": { params: empty, result: GitHubLoginState },
  "github.startLogin": { params: empty, result: GitHubLoginState },
  "github.cancelLogin": { params: empty, result: GitHubLoginState },
  "github.logout": { params: empty, result: z.object({ ok: z.boolean() }) },
  "github.repos": { params: empty, result: z.array(GitHubRepo) },
  "github.publish": {
    params: projectRef.extend({ private: z.boolean(), name: z.string().min(1).max(100).optional() }),
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

  "workflows.list": { params: z.object({ projectId: id.optional() }), result: z.array(WorkflowRun) },
  "workflows.start": {
    params: z.object({ projectId: id, title: z.string().min(1).max(200), requirement: z.string().min(1).max(20_000), branch: z.string().max(200).optional(), options: WorkflowOptions }),
    result: WorkflowRun,
  },
  "workflows.approvePlan": { params: z.object({ id, approve: z.boolean(), feedback: z.string().max(5000).optional() }), result: WorkflowRun },
  "workflows.continue": { params: z.object({ id }), result: WorkflowRun },
  "workflows.fixTests": { params: z.object({ id }), result: WorkflowRun },
  "workflows.cancel": { params: z.object({ id }), result: WorkflowRun },
  "schedules.list": { params: z.object({ projectId: id.optional() }), result: z.array(Schedule) },
  "schedules.save": { params: Schedule.omit({ id: true, lastRunAt: true, lastSessionId: true, createdAt: true }).extend({ id: id.optional() }), result: Schedule },
  "schedules.remove": { params: z.object({ id }), result: z.object({ ok: z.boolean() }) },
  "schedules.runNow": { params: z.object({ id }), result: Schedule },
  "worktrees.create": { params: projectRef.extend({ branch: z.string().min(1).max(200) }), result: Project },
  "worktrees.remove": { params: projectRef.extend({ force: z.boolean().default(false) }), result: z.object({ ok: z.boolean() }) },
  "sessions.summarize": { params: sessionRef, result: z.object({ summary: z.string(), model: z.string() }) },

  "settings.get": { params: empty, result: Settings },
  "settings.update": { params: Settings.partial(), result: Settings },

  "projects.list": { params: empty, result: z.array(ProjectWithStatus) },
  "projects.get": { params: projectRef, result: ProjectWithStatus },
  "projects.import": { params: z.object({ path: z.string().min(1).max(4096) }), result: Project },
  "projects.create": {
    params: z.object({
      name: z.string().min(1).max(100),
      parentDir: z.string().min(1).max(4096),
      gitInit: z.boolean(),
      /** create a GitHub repository for the new project (requires GitHub login) */
      github: z.object({ private: z.boolean() }).nullable().default(null),
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
      testCommand: z.string().max(500).nullable().optional(),
    }),
    result: Project,
  },
  "projects.confirmAutonomous": {
    params: projectRef.extend({ confirmName: z.string() }),
    result: Project,
  },
  "projects.remove": { params: projectRef, result: z.object({ removed: z.boolean() }) },
  "projects.touch": { params: projectRef, result: Project },
  "projects.readClaudeMd": {
    params: projectRef,
    result: z.object({ exists: z.boolean(), content: z.string(), path: z.string() }),
  },
  "projects.listFiles": {
    params: projectRef.extend({ dir: z.string().max(4096).default("") }),
    result: z.array(z.object({ name: z.string(), path: z.string(), isDir: z.boolean(), size: z.number() })),
  },
  "projects.readFile": {
    params: projectRef.extend({ path: z.string().min(1).max(4096) }),
    result: z.object({ path: z.string(), content: z.string(), truncated: z.boolean(), binary: z.boolean() }),
  },

  "sessions.list": {
    params: projectRef,
    result: z.object({ sessions: z.array(Session), external: z.array(ExternalSession) }),
  },
  "sessions.listAll": {
    params: z.object({ query: z.string().max(200).optional(), status: z.string().max(40).optional() }),
    result: z.array(Session.extend({ projectName: z.string() })),
  },
  "sessions.get": { params: sessionRef, result: Session },
  "sessions.events": {
    params: sessionRef.extend({ afterSeq: z.number().int().optional() }),
    result: z.array(SessionEvent),
  },
  "sessions.start": {
    params: projectRef.extend({
      prompt: z.string().min(1).max(200_000),
      model: z.string().max(100).nullable().optional(),
      planOnly: z.boolean().optional(),
      resumeClaudeSessionId: z.string().max(100).optional(),
      attachments: z.array(Attachment).max(10).default([]),
    }),
    result: Session,
  },
  "sessions.send": { params: sessionRef.extend({ text: z.string().min(1).max(200_000), attachments: z.array(Attachment).max(10).default([]) }), result: Session },
  "sessions.rewind": { params: sessionRef.extend({ messageUuid: z.string().max(100), dryRun: z.boolean().default(false) }), result: RewindResult },
  "system.commands": { params: z.object({ projectId: id.optional() }), result: z.array(SlashCommand) },
  "sessions.resume": {
    params: sessionRef.extend({ prompt: z.string().min(1).max(200_000), attachments: z.array(Attachment).max(10).default([]) }),
    result: Session,
  },
  "sessions.stop": { params: sessionRef, result: Session },
  "sessions.close": { params: sessionRef, result: Session },
  "sessions.setModel": { params: sessionRef.extend({ model: z.string().max(100) }), result: Session },
  "sessions.setPermissionMode": { params: sessionRef.extend({ mode: PermissionMode }), result: Session },
  "sessions.respondApproval": {
    params: sessionRef.extend({
      requestId: id,
      decision: z.enum(["allow", "deny"]),
      scope: z.enum(["once", "session"]).default("once"),
      message: z.string().max(2000).optional(),
    }),
    result: z.object({ ok: z.boolean() }),
  },

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
  "git.branches": { params: projectRef, result: z.array(BranchInfo) },
  "git.checkout": {
    params: projectRef.extend({ branch: z.string().min(1).max(250), create: z.boolean().default(false) }),
    result: GitStatus,
  },
  "git.push": { params: projectRef.extend({ allowProtected: z.boolean().default(false) }), result: z.object({ branch: z.string() }) },
  "git.pull": { params: projectRef, result: z.object({ output: z.string() }) },
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
  | { event: "project.updated"; payload: { projectId: string } }
  | { event: "github.login"; payload: GitHubLoginState }
  | { event: "claude.setup"; payload: ClaudeSetupState }
  | { event: "remote.updated"; payload: { projectId: string; state: RemoteState } }
  | { event: "workflow.updated"; payload: WorkflowRun }
  | { event: "schedules.updated"; payload: Record<string, never> }
  | { event: "sidecar.ready"; payload: { version: string } }
  | { event: "log"; payload: { level: "info" | "warn" | "error"; message: string } };

export type ServerEventName = ServerEvent["event"];
export type ServerEventPayload<E extends ServerEventName> = Extract<ServerEvent, { event: E }>["payload"];
