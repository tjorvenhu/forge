import { z } from "zod";
import { RpcErrorSchema } from "./errors.js";
import {
  BranchInfo,
  ClaudeSetupState,
  CommitInfo,
  Diagnostics,
  ExternalSession,
  FileDiff,
  GitHubAccount,
  GitHubLoginState,
  GitHubRepo,
  GitStatus,
  PermissionMode,
  ProfileId,
  PlanUsage,
  Project,
  ProjectTag,
  ProjectTemplate,
  ProjectWithStatus,
  RuntimeInfo,
  Session,
  SessionEvent,
  Settings,
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

  "github.account": { params: empty, result: GitHubAccount.nullable() },
  "github.loginState": { params: empty, result: GitHubLoginState },
  "github.startLogin": { params: empty, result: GitHubLoginState },
  "github.cancelLogin": { params: empty, result: GitHubLoginState },
  "github.logout": { params: empty, result: z.object({ ok: z.boolean() }) },
  "github.repos": { params: empty, result: z.array(GitHubRepo) },

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
      readme: z.boolean(),
      gitignore: z.boolean(),
      claudeMd: z.boolean(),
      template: ProjectTemplate,
    }),
    result: Project,
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
    }),
    result: Session,
  },
  "sessions.send": { params: sessionRef.extend({ text: z.string().min(1).max(200_000) }), result: Session },
  "sessions.resume": {
    params: sessionRef.extend({ prompt: z.string().min(1).max(200_000) }),
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
  | { event: "sidecar.ready"; payload: { version: string } }
  | { event: "log"; payload: { level: "info" | "warn" | "error"; message: string } };

export type ServerEventName = ServerEvent["event"];
export type ServerEventPayload<E extends ServerEventName> = Extract<ServerEvent, { event: E }>["payload"];
