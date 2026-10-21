import { BackupPart, CHAT_WINDOW_ACTIONS, EffortLevel, Language, MemoryScope, PermissionMode, PolicyRuleId, ProfileId, SessionStatus, UpdateChannel, type ChatWindowAction } from "@forge/protocol";
import { z } from "zod";
import { tr, type SidecarMessages } from "../i18n/index.js";

export interface SessionSettingsPatch {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
}

export interface StartSessionOptions {
  model?: string;
  effort?: EffortLevel;
  planOnly?: boolean;
  /** run as a parallel agent in its own git worktree and branch */
  agent?: boolean;
  /** an agent also gets the uncommitted state of the project it starts from */
  withChanges?: boolean;
}

/** Project tools may name a session instead of a project; then the session's project (also an agent's worktree) is meant. */
export interface TargetOptions {
  session?: string;
}

export type DevServerAction = "start" | "stop" | "restart" | "status" | "output" | "setup" | "prepare";
export type TestDbAction = "start" | "stop" | "restart" | "reset" | "status" | "log";
export const GIT_ACTIONS = [
  "status",
  "log",
  "show",
  "commit",
  "push",
  "pull",
  "checkout",
  "fetch",
  "branches",
  "delete_branch",
  "diff",
  "restore",
  "init",
  "publish",
  "account",
  "identity",
] as const;
export type GitAction = (typeof GIT_ACTIONS)[number];
export type TaskAction = "output" | "stop" | "to_background" | "message";

export interface GitOptions extends TargetOptions {
  message?: string;
  allowProtected?: boolean;
  /** checkout and delete_branch: the branch */
  branch?: string;
  /** checkout: create the branch */
  create?: boolean;
  /** delete_branch: also a branch with commits that are in no other branch */
  force?: boolean;
  /** restore and show: hash, position in the log (1 = newest) or words of the subject */
  commit?: string;
  /** diff and show: file path or part of it */
  path?: string;
  /** publish: private repository (default true) */
  private?: boolean;
  /** publish: GitHub organisation instead of the personal account, as spoken */
  owner?: string;
  /** publish: repository name; identity: the author name */
  name?: string;
  /** identity: the author email */
  email?: string;
}

export interface DevSettingsPatch {
  useEnv?: boolean;
  withDevServer?: boolean;
  port?: number;
  name?: string;
  /** "" passes no variable */
  envVar?: string;
  /** test environment: "NAME=value" sets one variable */
  envSet?: string;
  /** test environment: removes the variable with this name */
  envRemove?: string;
  /** test environment: takes over the variables of this .env file in the project root */
  envFromFile?: string;
}

export const PROJECT_ACTIONS = ["info", "create", "import", "clone", "remove", "rename", "favorite", "group", "rename_group", "dissolve_group", "settings"] as const;
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

export interface ProjectOptions extends TargetOptions {
  /** create: name of the new project; rename: the new name; clone: folder name */
  name?: string;
  /** import: the folder; create and clone: the parent folder (default: the projects folder from the settings) */
  path?: string;
  /** clone: Git URL or name of a GitHub repository of the account */
  url?: string;
  /** create and import: false sets the project up without git; settings: switches git on or off */
  git?: boolean;
  /** settings: false switches parallel agents off for the project, true allows them again */
  agents?: boolean;
  /** create and import: also a GitHub repository */
  github?: "private" | "public";
  /** create and import with github: GitHub organisation instead of the personal account, as spoken */
  owner?: string;
  deleteFolder?: boolean;
  deleteGitHubRepo?: boolean;
  favorite?: boolean;
  /** group: the group to put the project in ("" takes it out); rename_group, dissolve_group: the existing group */
  group?: string;
  profile?: ProfileId;
  /** "" or "default" clears it */
  defaultModel?: string;
  defaultEffort?: EffortLevel | "default";
  testCommand?: string;
  devCommand?: string;
}

export const SESSIONS_ACTIONS = [
  "list",
  "delete",
  "delete_all",
  "fork",
  "handoff",
  "rewind",
  "edit",
  "ui_compare",
  "ui_compare_retake",
  "day_report",
  "templates",
  "template_send",
  "template_save",
  "template_delete",
  "template_move",
  "template_learn",
] as const;
export type SessionsAction = (typeof SESSIONS_ACTIONS)[number];

export interface SessionsOptions {
  session?: string;
  /** list: only sessions of this project */
  project?: string;
  query?: string;
  status?: SessionStatus;
  /** delete: keep Claude Code's transcript */
  keepTranscript?: boolean;
  /** fork, rewind and edit: which message of the user, counted from the end (1 = the last one) */
  messagesBack?: number;
  /** fork: files back to the state before that message as well */
  rewindFiles?: boolean;
  /** edit: the new text of the message */
  text?: string;
  /** day_report: which day, counted back from today (0 = today, 1 = yesterday) */
  daysBack?: number;
  /** day_report: Claude's short summary instead of the facts */
  summary?: boolean;
  /** template_*: name of the template, or a part of it */
  template?: string;
  /** template_send: values for the placeholders */
  values?: Array<{ name: string; value: string }>;
  /** template_save: name of a new template (or the new name of `template`) */
  name?: string;
  /** template_save: what the template is for */
  description?: string;
  /** template_move: one place up or down in its list */
  direction?: "up" | "down";
}

export const FILES_ACTIONS = ["list", "read", "find"] as const;
export const CLAUDE_MD_ACTIONS = ["list", "read", "append"] as const;

export const EXTENSION_KINDS = ["mcp", "skill", "agent", "command", "hook", "plugin"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];
export const EXTENSION_ACTIONS = ["list", "read", "add", "remove", "enable", "disable"] as const;
export type ExtensionAction = (typeof EXTENSION_ACTIONS)[number];

export interface ExtensionOptions extends TargetOptions {
  project?: string;
  /** server, skill or agent name, plugin name or id */
  name?: string;
  scope?: "user" | "project" | "local";
  /** skill and agent: what it is for */
  description?: string;
  transport?: "stdio" | "http" | "sse";
  /** mcp: command or URL */
  target?: string;
  /** mcp: arguments of the command, separated by spaces */
  args?: string;
  /** plugin list: search the catalog */
  query?: string;
}

/** Global settings that can be changed on the phone; an empty patch tells the current ones. */
export interface ForgeSettingsPatch {
  /** "" or "default" clears it */
  defaultModel?: string;
  defaultEffort?: EffortLevel | "default";
  defaultProfile?: ProfileId;
  defaultProjectDir?: string;
  sounds?: boolean;
  desktopNotifications?: boolean;
  enterToSend?: boolean;
  autoContinueAfterLimit?: boolean;
  /** minutes until an idle session's process ends; 0 never */
  idleCloseMinutes?: number;
  /** context tokens from which FORGE suggests a new session; 0 never */
  longSessionTokens?: number;
  updateChecks?: boolean;
  /** dev only for accounts that may push to the FORGE repository */
  updateChannel?: UpdateChannel;
  debugLogs?: boolean;
  stripApiKey?: boolean;
  /** the Print key opens FORGE's snipping tool */
  screenshotKey?: boolean;
  /** before/after screenshots of the web app when a turn changes UI files */
  uiCompare?: boolean;
  /** FORGE turns repeated messages into templates on its own */
  learnTemplates?: boolean;
  /** anonymous usage totals every 5 minutes */
  usageStats?: boolean;
  policyRule?: PolicyRuleId;
  policyRuleOn?: boolean;
  /** language of the interface, the messages and the phone */
  language?: Language;
}

/** A rule of the blocklist as it is said on the phone. */
export function policyRuleLabel(rule: PolicyRuleId): string {
  return tr().phone.policyRules[rule];
}

export const SYSTEM_ACTIONS = [
  "diagnostics",
  "update_check",
  "update_download",
  "update_install",
  "changelog",
  "install_check",
  "install_repair",
  "dev_status",
  "dev_promote",
  "claude_check",
  "claude_update",
  "claude_logout",
  "backup_list",
  "backup_create",
  "backup_restore",
  "sync_status",
  "sync_now",
  "sync_on",
  "sync_off",
  "sync_clone",
  "sync_keep",
  "sync_force",
  "sync_versions",
  "sync_restore",
  "support",
] as const;
export type SystemAction = (typeof SYSTEM_ACTIONS)[number];

/** Project tags with behaviour, as in Projekt-Einstellungen > Automatik. */
export const AUTOMATION_TAG_IDS = ["plan-first", "auto-test", "auto-commit", "auto-push", "auto-merge", "review-required", "no-network", "sandbox-only"] as const;
export type AutomationTag = (typeof AUTOMATION_TAG_IDS)[number];

/** An automation tag named as in the project settings. */
export function automationTagLabel(tag: AutomationTag): string {
  return tr().phone.automationTags[tag];
}

export const NUMBER_ACTIONS = ["on", "off", "add", "remove"] as const;
export type NumberAction = (typeof NUMBER_ACTIONS)[number];

/** when FORGE calls on its own (setting notifyOn), and the numbers it calls or lets in */
export interface CallSettingsPatch {
  done?: boolean;
  approval?: boolean;
  error?: boolean;
  /** one entry of a number list: switch on or off, add, remove */
  numbers?: { action: NumberAction; list: "notify" | "allowed"; number: string; label?: string };
}

/** What the conversation partner may do on the phone. Implemented by the phone service, which also checks the PIN. */
export interface PhoneToolset {
  status(): Promise<string>;
  /** `summary`: a summary of the whole history, written by Claude */
  details(session: string, o?: { summary?: boolean }): Promise<string>;
  sendMessage(session: string, text: string): Promise<string>;
  startSession(project: string, prompt: string, o?: StartSessionOptions): Promise<string>;
  respond(session: string, decision: "allow" | "deny", answers?: Record<string, string>, feedback?: string, scope?: "once" | "session"): Promise<string>;
  stop(session: string): Promise<string>;
  close(session: string): Promise<string>;
  sessionSettings(session: string, patch: SessionSettingsPatch): Promise<string>;
  cancelAutoContinue(session: string): Promise<string>;
  /** background tasks and subagents of a session: output of a command, stop one, move foreground work into the background */
  backgroundTask(session: string, action: TaskAction, task?: string, text?: string): Promise<string>;
  remote(action: "on" | "off" | "status"): Promise<string>;
  /** FORGE's main window stays above other programs (setting "Im Vordergrund bleiben") */
  alwaysOnTop(action: "on" | "off" | "status"): Promise<string>;
  /** sessions in their own chat windows: which are open and pinned, open, take back, pin one by one */
  chatWindow(action: ChatWindowAction | "status", session?: string): Promise<string>;
  devServer(project: string, action: DevServerAction, o?: TargetOptions): Promise<string>;
  /** the project's local PostgreSQL for tests (dev tools) */
  testDatabase(project: string, action: TestDbAction, o?: TargetOptions): Promise<string>;
  /** test environment and test database settings (dev tools); an empty patch tells the current ones */
  devSettings(project: string, patch: DevSettingsPatch, o?: TargetOptions): Promise<string>;
  /** switches one automation tag of a project; without `tag` it tells which are on */
  projectAutomation(project: string, patch: { tag?: AutomationTag; on?: boolean }, o?: TargetOptions): Promise<string>;
  /**
   * searches the project's knowledge, reads one entry with `id`, or deletes it with `remove`; `cleanup` lists
   * overlapping and very long entries, `merge` lets Claude merge entries on one topic into the first,
   * `autoMerge` lets Claude find such groups itself and merge them all; `stale` lists entries whose references
   * go nowhere, `markChecked` marks those of `id` as a false alarm, `fix` lets Claude correct entry `id`
   */
  knowledge(
    project: string,
    query: string,
    id?: string,
    remove?: boolean,
    o?: { cleanup?: boolean; merge?: string[]; autoMerge?: boolean; stale?: boolean; markChecked?: boolean; fix?: boolean },
  ): Promise<string>;
  /** keeps a note in the project's knowledge; a note on a known topic is added to that entry */
  rememberNote(project: string, title: string, text: string): Promise<string>;
  git(project: string, action: GitAction, o?: GitOptions): Promise<string>;
  pullRequest(project: string, action: "create" | "status", o?: TargetOptions & { draft?: boolean }): Promise<string>;
  /** removes an agent's worktree (and its session); the branch stays unless `deleteBranch` */
  removeAgent(project: string, o?: TargetOptions & { deleteBranch?: boolean; force?: boolean }): Promise<string>;
  /** merges an agent's branch into the branch it started from, or discards it (worktree and branch go either way); review tells what it did */
  finishAgent(project: string, action: "merge" | "discard" | "review", o?: TargetOptions): Promise<string>;
  projects(): Promise<string>;
  /** creates, imports, clones, removes or configures a project */
  project(project: string, action: ProjectAction, o?: ProjectOptions): Promise<string>;
  /** lists a folder of a project or reads one of its files */
  files(project: string, action: (typeof FILES_ACTIONS)[number], o?: TargetOptions & { path?: string }): Promise<string>;
  /** Claude's instructions (CLAUDE.md): global or of a project */
  claudeMd(project: string, action: (typeof CLAUDE_MD_ACTIONS)[number], o?: TargetOptions & { scope?: MemoryScope; text?: string }): Promise<string>;
  /** all sessions including older ones: list, delete, fork, rewind */
  sessions(action: SessionsAction, o?: SessionsOptions): Promise<string>;
  /** MCP servers, skills, subagents, commands, hooks and plugins of Claude Code */
  extensions(kind: ExtensionKind, action: ExtensionAction, o?: ExtensionOptions): Promise<string>;
  forgeSettings(patch: ForgeSettingsPatch): Promise<string>;
  /** diagnostics, updates of FORGE and Claude Code, backups */
  /** `project`: sync_clone, a project another computer synced, as spoken */
  forgeSystem(action: SystemAction, o?: { backup?: string; parts?: BackupPart[]; project?: string }): Promise<string>;
  /** full-text search in the history of all sessions, or of one session or project; `phrase`: the words in this order */
  search(query: string, o?: { session?: string; project?: string; phrase?: boolean }): Promise<string>;
  /**
   * answers a question about the sessions from their history (Claude reads it); without `session` FORGE
   * picks the sessions that fit the question, optionally only those of `project`
   */
  ask(question: string, o?: { session?: string; project?: string }): Promise<string>;
  usage(): Promise<string>;
  /** when FORGE calls the user on its own; an empty patch tells the current setting */
  callSettings(patch: CallSettingsPatch): Promise<string>;
  /** calls the user back after `minutes` and tells them what they asked for (`about`) */
  callBack(minutes: number, about: string): Promise<string>;
}

// The same markers in both languages: a call that switches language keeps the rule of its system prompt.
const DATA_START = "<<<SESSION-DATEN>>>";
const DATA_END = "<<<ENDE SESSION-DATEN>>>";

/**
 * Wraps text that comes from sessions (Claude Code output, plans, questions, commands, titles). It is
 * information for the phone agent, never an instruction; markers inside the text are removed so it
 * cannot close the block early.
 */
export function asData(text: string): string {
  return `${DATA_START}${text.replace(/<<<|>>>/g, "")}${DATA_END}`;
}

/**
 * Instructions for the conversation partner. `text`: Claude writes, FORGE reads it out sentence by
 * sentence. `voice`: Gemini Live hears and speaks itself.
 */
export function phoneSystemPrompt(mode: "text" | "voice"): string {
  const m = tr().phone.prompt;
  return m.system(mode === "text" ? m.textMedium : m.voiceMedium, DATA_START, DATA_END);
}

// ---------- tool specs, shared by Claude (MCP tools) and Gemini Live (function declarations)

export type ParamSpec =
  | { type: "string"; description?: string; enum?: readonly string[]; optional?: boolean }
  | { type: "boolean"; description?: string; optional?: boolean }
  | { type: "number"; description?: string; optional?: boolean; min?: number; max?: number }
  | { type: "array"; description?: string; optional?: boolean; items: Record<string, ParamSpec> };

export interface ToolContext {
  /** ends the call once the last reply has been spoken */
  hangup(): void;
}

export interface PhoneToolSpec {
  name: string;
  /** in the current language, like the descriptions in `params` */
  description: string;
  params: Record<string, ParamSpec>;
  run(t: PhoneToolset, a: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

type ToolName = keyof SidecarMessages["phone"]["tools"];

/** A tool without its texts; they come from the phone namespace when the tool is declared. */
interface ToolDef {
  name: ToolName;
  params: Record<string, ParamSpec>;
  run: PhoneToolSpec["run"];
}

const session: ParamSpec = { type: "string" };
const project: ParamSpec = { type: "string" };
/** project tools: a project, or a session whose project (also an agent's worktree) is meant */
const targetProject: ParamSpec = { type: "string", optional: true };
const targetSession: ParamSpec = { type: "string", optional: true };
/** parameters many tools share; their description is in `params` of the namespace, not per tool */
const SHARED_PARAMS = new Map<ParamSpec, keyof SidecarMessages["phone"]["params"]>([
  [session, "session"],
  [project, "project"],
  [targetProject, "targetProject"],
  [targetSession, "targetSession"],
]);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const opt = (v: unknown) => (typeof v === "string" ? v : undefined);
const optBool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const optNum = (v: unknown) => (typeof v === "number" ? v : undefined);
/** the value if it is one of `options`, else `fallback` */
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const DEV_SERVER_ACTIONS = ["start", "stop", "restart", "status", "output", "setup", "prepare"] as const;
const TEST_DB_ACTIONS = ["start", "stop", "restart", "reset", "status", "log"] as const;
const TASK_ACTIONS = ["output", "stop", "to_background", "message"] as const;

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "status",
    params: {},
    run: (t) => t.status(),
  },
  {
    name: "details",
    params: {
      session,
      summary: { type: "boolean", optional: true },
    },
    run: (t, a) => t.details(str(a.session), { summary: optBool(a.summary) }),
  },
  {
    name: "send_message",
    params: { session, text: { type: "string" } },
    run: (t, a) => t.sendMessage(str(a.session), str(a.text)),
  },
  {
    name: "start_session",
    params: {
      project,
      prompt: { type: "string" },
      model: { type: "string", optional: true },
      effort: { type: "string", optional: true, enum: EffortLevel.options },
      plan_only: { type: "boolean", optional: true },
      agent: { type: "boolean", optional: true },
      with_changes: { type: "boolean", optional: true },
    },
    run: (t, a) =>
      t.startSession(str(a.project), str(a.prompt), {
        model: opt(a.model),
        effort: opt(a.effort) as EffortLevel | undefined,
        planOnly: optBool(a.plan_only),
        agent: optBool(a.agent),
        withChanges: optBool(a.with_changes),
      }),
  },
  {
    name: "respond",
    params: {
      session,
      decision: { type: "string", enum: ["allow", "deny"] },
      answers: {
        type: "array",
        optional: true,
        items: { question: { type: "string" }, answer: { type: "string" } },
      },
      feedback: { type: "string", optional: true },
      for_session: { type: "boolean", optional: true },
    },
    run: (t, a) => {
      const list = Array.isArray(a.answers) ? (a.answers as Array<{ question?: unknown; answer?: unknown }>) : [];
      const answers = list.length ? Object.fromEntries(list.map((x) => [str(x.question), str(x.answer)])) : undefined;
      return t.respond(str(a.session), a.decision === "allow" ? "allow" : "deny", answers, opt(a.feedback), a.for_session === true ? "session" : "once");
    },
  },
  {
    name: "stop_session",
    params: { session },
    run: (t, a) => t.stop(str(a.session)),
  },
  {
    name: "close_session",
    params: { session },
    run: (t, a) => t.close(str(a.session)),
  },
  {
    name: "session_settings",
    params: {
      session,
      model: { type: "string", optional: true },
      effort: { type: "string", optional: true, enum: EffortLevel.options },
      permission_mode: { type: "string", optional: true, enum: PermissionMode.options },
    },
    run: (t, a) => t.sessionSettings(str(a.session), { model: opt(a.model), effort: opt(a.effort) as EffortLevel | undefined, permissionMode: opt(a.permission_mode) as PermissionMode | undefined }),
  },
  {
    name: "cancel_auto_continue",
    params: { session },
    run: (t, a) => t.cancelAutoContinue(str(a.session)),
  },
  {
    name: "background_task",
    params: {
      session,
      action: { type: "string", enum: TASK_ACTIONS },
      task: { type: "string", optional: true },
      text: { type: "string", optional: true },
    },
    run: (t, a) => t.backgroundTask(str(a.session), pick(a.action, TASK_ACTIONS, "output"), opt(a.task), opt(a.text)),
  },
  {
    name: "remote_control",
    params: { action: { type: "string", enum: ["on", "off", "status"] } },
    run: (t, a) => t.remote(a.action === "on" ? "on" : a.action === "off" ? "off" : "status"),
  },
  {
    name: "always_on_top",
    params: { action: { type: "string", enum: ["on", "off", "status"] } },
    run: (t, a) => t.alwaysOnTop(a.action === "on" ? "on" : a.action === "off" ? "off" : "status"),
  },
  {
    name: "chat_window",
    params: {
      action: { type: "string", enum: ["status", ...CHAT_WINDOW_ACTIONS] },
      session: { ...session, optional: true },
    },
    run: (t, a) => t.chatWindow((CHAT_WINDOW_ACTIONS as readonly string[]).includes(str(a.action)) ? (str(a.action) as ChatWindowAction) : "status", opt(a.session)),
  },
  {
    name: "dev_server",
    params: { project: targetProject, session: targetSession, action: { type: "string", enum: DEV_SERVER_ACTIONS } },
    run: (t, a) => t.devServer(str(a.project), pick(a.action, DEV_SERVER_ACTIONS, "status"), { session: opt(a.session) }),
  },
  {
    name: "test_database",
    params: { project: targetProject, session: targetSession, action: { type: "string", enum: TEST_DB_ACTIONS } },
    run: (t, a) => t.testDatabase(str(a.project), pick(a.action, TEST_DB_ACTIONS, "status"), { session: opt(a.session) }),
  },
  {
    name: "dev_settings",
    params: {
      project: targetProject,
      session: targetSession,
      use_env: { type: "boolean", optional: true },
      env_set: { type: "string", optional: true },
      env_remove: { type: "string", optional: true },
      env_from_file: { type: "string", optional: true },
      with_dev_server: { type: "boolean", optional: true },
      port: { type: "number", optional: true, min: 1024, max: 65535 },
      name: { type: "string", optional: true },
      env_var: { type: "string", optional: true },
    },
    run: (t, a) =>
      t.devSettings(
        str(a.project),
        {
          useEnv: optBool(a.use_env),
          withDevServer: optBool(a.with_dev_server),
          port: optNum(a.port),
          name: opt(a.name),
          envVar: opt(a.env_var),
          envSet: opt(a.env_set),
          envRemove: opt(a.env_remove),
          envFromFile: opt(a.env_from_file),
        },
        { session: opt(a.session) },
      ),
  },
  {
    name: "project_automation",
    params: {
      project: targetProject,
      session: targetSession,
      tag: { type: "string", optional: true, enum: AUTOMATION_TAG_IDS },
      on: { type: "boolean", optional: true },
    },
    run: (t, a) => t.projectAutomation(str(a.project), { tag: AUTOMATION_TAG_IDS.find((x) => x === a.tag), on: optBool(a.on) }, { session: opt(a.session) }),
  },
  {
    name: "knowledge",
    params: {
      project,
      query: { type: "string" },
      id: { type: "string", optional: true },
      delete: { type: "boolean", optional: true },
      cleanup: { type: "boolean", optional: true },
      merge: { type: "string", optional: true },
      auto_merge: { type: "boolean", optional: true },
      stale: { type: "boolean", optional: true },
      mark_checked: { type: "boolean", optional: true },
      fix: { type: "boolean", optional: true },
    },
    run: (t, a) =>
      t.knowledge(str(a.project), str(a.query), opt(a.id), optBool(a.delete), {
        cleanup: optBool(a.cleanup),
        autoMerge: optBool(a.auto_merge),
        stale: optBool(a.stale),
        markChecked: optBool(a.mark_checked),
        fix: optBool(a.fix),
        merge: opt(a.merge)
          ?.split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      }),
  },
  {
    name: "remember",
    params: {
      project,
      title: { type: "string" },
      text: { type: "string" },
    },
    run: (t, a) => t.rememberNote(str(a.project), str(a.title), str(a.text)),
  },
  {
    name: "git",
    params: {
      project: targetProject,
      session: targetSession,
      action: { type: "string", enum: GIT_ACTIONS },
      message: { type: "string", optional: true },
      allow_protected: { type: "boolean", optional: true },
      branch: { type: "string", optional: true },
      create: { type: "boolean", optional: true },
      force: { type: "boolean", optional: true },
      commit: { type: "string", optional: true },
      path: { type: "string", optional: true },
      private: { type: "boolean", optional: true },
      owner: { type: "string", optional: true },
      name: { type: "string", optional: true },
      email: { type: "string", optional: true },
    },
    run: (t, a) =>
      t.git(str(a.project), pick(a.action, GIT_ACTIONS, "status"), {
        session: opt(a.session),
        message: opt(a.message),
        allowProtected: optBool(a.allow_protected),
        branch: opt(a.branch),
        create: optBool(a.create),
        force: optBool(a.force),
        commit: opt(a.commit),
        path: opt(a.path),
        private: optBool(a.private),
        owner: opt(a.owner),
        name: opt(a.name),
        email: opt(a.email),
      }),
  },
  {
    name: "pull_request",
    params: {
      project: targetProject,
      session: targetSession,
      action: { type: "string", enum: ["create", "status"] },
      draft: { type: "boolean", optional: true },
    },
    run: (t, a) => t.pullRequest(str(a.project), a.action === "create" ? "create" : "status", { session: opt(a.session), draft: optBool(a.draft) }),
  },
  {
    name: "remove_agent",
    params: {
      session: { type: "string", optional: true },
      project: { type: "string", optional: true },
      delete_branch: { type: "boolean", optional: true },
      force: { type: "boolean", optional: true },
    },
    run: (t, a) => t.removeAgent(str(a.project), { session: opt(a.session), deleteBranch: optBool(a.delete_branch), force: optBool(a.force) }),
  },
  {
    name: "finish_agent",
    params: {
      session: { type: "string", optional: true },
      project: { type: "string", optional: true },
      action: { type: "string", enum: ["review", "merge", "discard"] },
    },
    run: (t, a) => t.finishAgent(str(a.project), a.action === "discard" ? "discard" : a.action === "review" ? "review" : "merge", { session: opt(a.session) }),
  },
  {
    name: "projects",
    params: {},
    run: (t) => t.projects(),
  },
  {
    name: "project",
    params: {
      action: { type: "string", enum: PROJECT_ACTIONS },
      project: { type: "string", optional: true },
      session: targetSession,
      name: { type: "string", optional: true },
      path: { type: "string", optional: true },
      url: { type: "string", optional: true },
      git: { type: "boolean", optional: true },
      agents: { type: "boolean", optional: true },
      github: { type: "string", optional: true, enum: ["private", "public"] },
      owner: { type: "string", optional: true },
      delete_folder: { type: "boolean", optional: true },
      delete_github_repo: { type: "boolean", optional: true },
      favorite: { type: "boolean", optional: true },
      group: { type: "string", optional: true },
      profile: { type: "string", optional: true, enum: ProfileId.options },
      default_model: { type: "string", optional: true },
      default_effort: { type: "string", optional: true, enum: [...EffortLevel.options, "default"] },
      test_command: { type: "string", optional: true },
      dev_command: { type: "string", optional: true },
    },
    run: (t, a) =>
      t.project(str(a.project), pick(a.action, PROJECT_ACTIONS, "info"), {
        session: opt(a.session),
        name: opt(a.name),
        path: opt(a.path),
        url: opt(a.url),
        git: optBool(a.git),
        agents: optBool(a.agents),
        github: a.github === "private" || a.github === "public" ? a.github : undefined,
        owner: opt(a.owner),
        deleteFolder: optBool(a.delete_folder),
        deleteGitHubRepo: optBool(a.delete_github_repo),
        favorite: optBool(a.favorite),
        group: opt(a.group),
        profile: ProfileId.options.find((x) => x === a.profile),
        defaultModel: opt(a.default_model),
        defaultEffort: [...EffortLevel.options, "default" as const].find((x) => x === a.default_effort),
        testCommand: opt(a.test_command),
        devCommand: opt(a.dev_command),
      }),
  },
  {
    name: "files",
    params: {
      project: targetProject,
      session: targetSession,
      action: { type: "string", enum: FILES_ACTIONS },
      path: { type: "string", optional: true },
    },
    run: (t, a) => t.files(str(a.project), pick(a.action, FILES_ACTIONS, "list"), { session: opt(a.session), path: opt(a.path) }),
  },
  {
    name: "claude_md",
    params: {
      action: { type: "string", enum: CLAUDE_MD_ACTIONS },
      project: { type: "string", optional: true },
      session: targetSession,
      scope: { type: "string", optional: true, enum: MemoryScope.options },
      text: { type: "string", optional: true },
    },
    run: (t, a) =>
      t.claudeMd(str(a.project), pick(a.action, CLAUDE_MD_ACTIONS, "read"), { session: opt(a.session), scope: MemoryScope.options.find((x) => x === a.scope), text: opt(a.text) }),
  },
  {
    name: "sessions",
    params: {
      action: { type: "string", enum: SESSIONS_ACTIONS },
      session: { type: "string", optional: true },
      project: { type: "string", optional: true },
      days_back: { type: "number", optional: true, min: 0, max: 60 },
      summary: { type: "boolean", optional: true },
      query: { type: "string", optional: true },
      status: { type: "string", optional: true, enum: SessionStatus.options },
      keep_transcript: { type: "boolean", optional: true },
      messages_back: { type: "number", optional: true, min: 1, max: 200 },
      rewind_files: { type: "boolean", optional: true },
      text: { type: "string", optional: true },
      template: { type: "string", optional: true },
      values: {
        type: "array",
        optional: true,
        items: { name: { type: "string" }, value: { type: "string" } },
      },
      name: { type: "string", optional: true },
      description: { type: "string", optional: true },
      direction: { type: "string", optional: true, enum: ["up", "down"] },
    },
    run: (t, a) =>
      t.sessions(pick(a.action, SESSIONS_ACTIONS, "list"), {
        session: opt(a.session),
        project: opt(a.project),
        query: opt(a.query),
        status: SessionStatus.options.find((x) => x === a.status),
        keepTranscript: optBool(a.keep_transcript),
        messagesBack: optNum(a.messages_back),
        rewindFiles: optBool(a.rewind_files),
        text: opt(a.text),
        daysBack: optNum(a.days_back),
        summary: optBool(a.summary),
        template: opt(a.template),
        values: Array.isArray(a.values)
          ? a.values.flatMap((v: unknown) => {
              const r = v as { name?: unknown; value?: unknown } | null;
              return typeof r?.name === "string" && typeof r.value === "string" ? [{ name: r.name, value: r.value }] : [];
            })
          : undefined,
        name: opt(a.name),
        description: opt(a.description),
        direction: a.direction === "up" || a.direction === "down" ? a.direction : undefined,
      }),
  },
  {
    name: "extensions",
    params: {
      kind: { type: "string", enum: EXTENSION_KINDS },
      action: { type: "string", enum: EXTENSION_ACTIONS },
      project: { type: "string", optional: true },
      session: targetSession,
      name: { type: "string", optional: true },
      scope: { type: "string", optional: true, enum: ["user", "project", "local"] },
      description: { type: "string", optional: true },
      transport: { type: "string", optional: true, enum: ["stdio", "http", "sse"] },
      target: { type: "string", optional: true },
      args: { type: "string", optional: true },
      query: { type: "string", optional: true },
    },
    run: (t, a) =>
      t.extensions(pick(a.kind, EXTENSION_KINDS, "mcp"), pick(a.action, EXTENSION_ACTIONS, "list"), {
        project: opt(a.project),
        session: opt(a.session),
        name: opt(a.name),
        scope: a.scope === "user" || a.scope === "project" || a.scope === "local" ? a.scope : undefined,
        description: opt(a.description),
        transport: a.transport === "stdio" || a.transport === "http" || a.transport === "sse" ? a.transport : undefined,
        target: opt(a.target),
        args: opt(a.args),
        query: opt(a.query),
      }),
  },
  {
    name: "forge_settings",
    params: {
      default_model: { type: "string", optional: true },
      default_effort: { type: "string", optional: true, enum: [...EffortLevel.options, "default"] },
      default_profile: { type: "string", optional: true, enum: ProfileId.options },
      default_project_dir: { type: "string", optional: true },
      sounds: { type: "boolean", optional: true },
      desktop_notifications: { type: "boolean", optional: true },
      enter_to_send: { type: "boolean", optional: true },
      auto_continue: { type: "boolean", optional: true },
      idle_close_minutes: { type: "number", optional: true, min: 0, max: 1440 },
      long_session_tokens: { type: "number", optional: true, min: 0, max: 2000000 },
      update_checks: { type: "boolean", optional: true },
      update_channel: { type: "string", optional: true, enum: UpdateChannel.options },
      debug_logs: { type: "boolean", optional: true },
      strip_api_key: { type: "boolean", optional: true },
      screenshot_key: { type: "boolean", optional: true },
      ui_compare: { type: "boolean", optional: true },
      learn_templates: { type: "boolean", optional: true },
      usage_stats: { type: "boolean", optional: true },
      language: { type: "string", optional: true, enum: Language.options },
      policy_rule: { type: "string", optional: true, enum: PolicyRuleId.options },
      policy_rule_on: { type: "boolean", optional: true },
    },
    run: (t, a) =>
      t.forgeSettings({
        defaultModel: opt(a.default_model),
        defaultEffort: [...EffortLevel.options, "default" as const].find((x) => x === a.default_effort),
        defaultProfile: ProfileId.options.find((x) => x === a.default_profile),
        defaultProjectDir: opt(a.default_project_dir),
        sounds: optBool(a.sounds),
        desktopNotifications: optBool(a.desktop_notifications),
        enterToSend: optBool(a.enter_to_send),
        autoContinueAfterLimit: optBool(a.auto_continue),
        idleCloseMinutes: optNum(a.idle_close_minutes),
        longSessionTokens: optNum(a.long_session_tokens),
        updateChecks: optBool(a.update_checks),
        updateChannel: UpdateChannel.options.find((x) => x === a.update_channel),
        debugLogs: optBool(a.debug_logs),
        stripApiKey: optBool(a.strip_api_key),
        screenshotKey: optBool(a.screenshot_key),
        uiCompare: optBool(a.ui_compare),
        learnTemplates: optBool(a.learn_templates),
        usageStats: optBool(a.usage_stats),
        language: Language.options.find((x) => x === a.language),
        policyRule: PolicyRuleId.options.find((x) => x === a.policy_rule),
        policyRuleOn: optBool(a.policy_rule_on),
      }),
  },
  {
    name: "forge_system",
    params: {
      action: { type: "string", enum: SYSTEM_ACTIONS },
      backup: { type: "string", optional: true },
      project: { type: "string", optional: true },
      parts: { type: "string", optional: true },
    },
    run: (t, a) => {
      const parts = str(a.parts)
        .split(/[\s,]+/)
        .flatMap((x) => BackupPart.options.filter((p) => p === x.trim().toLowerCase()));
      return t.forgeSystem(pick(a.action, SYSTEM_ACTIONS, "diagnostics"), { backup: opt(a.backup), parts: parts.length ? parts : undefined, project: opt(a.project) });
    },
  },
  {
    name: "ask",
    params: {
      question: { type: "string" },
      session: { type: "string", optional: true },
      project: { type: "string", optional: true },
    },
    run: (t, a) => t.ask(str(a.question), { session: opt(a.session), project: opt(a.project) }),
  },
  {
    name: "search",
    params: {
      query: { type: "string" },
      session: { type: "string", optional: true },
      project: { type: "string", optional: true },
      phrase: { type: "boolean", optional: true },
    },
    run: (t, a) => t.search(str(a.query), { session: opt(a.session), project: opt(a.project), phrase: optBool(a.phrase) }),
  },
  {
    name: "usage",
    params: {},
    run: (t) => t.usage(),
  },
  {
    name: "call_settings",
    params: {
      done: { type: "boolean", optional: true },
      approval: { type: "boolean", optional: true },
      error: { type: "boolean", optional: true },
      number_action: { type: "string", optional: true, enum: NUMBER_ACTIONS },
      list: { type: "string", optional: true, enum: ["notify", "allowed"] },
      number: { type: "string", optional: true },
      label: { type: "string", optional: true },
    },
    run: (t, a) => {
      const action = NUMBER_ACTIONS.find((x) => x === a.number_action);
      return t.callSettings({
        done: optBool(a.done),
        approval: optBool(a.approval),
        error: optBool(a.error),
        numbers: action ? { action, list: a.list === "allowed" ? "allowed" : "notify", number: str(a.number), label: opt(a.label) } : undefined,
      });
    },
  },
  {
    name: "call_back",
    params: {
      minutes: { type: "number", min: 1, max: 1440 },
      about: { type: "string" },
    },
    run: (t, a) => t.callBack(Number(a.minutes), str(a.about)),
  },
  {
    name: "hang_up",
    params: {},
    run: async (_t, _a, ctx) => {
      ctx.hangup();
      return tr().phone.hangUp;
    },
  },
];

/** Parameters with their descriptions in the current language; `texts` keys array items as "param.item". */
function describe(params: Record<string, ParamSpec>, texts: Record<string, string> | undefined, prefix = ""): Record<string, ParamSpec> {
  return Object.fromEntries(
    Object.entries(params).map(([k, p]) => {
      const shared = SHARED_PARAMS.get(p);
      const description = texts?.[prefix + k] ?? (shared ? tr().phone.params[shared] : undefined);
      const spec: ParamSpec = p.type === "array" ? { ...p, items: describe(p.items, texts, `${prefix}${k}.`) } : p;
      return [k, description ? { ...spec, description } : spec];
    }),
  );
}

/** The tools with their texts read when used: the language can change while FORGE runs. */
export const PHONE_TOOLS: readonly PhoneToolSpec[] = TOOL_DEFS.map((def) => {
  const texts = (): { description: string; params?: Record<string, string> } => tr().phone.tools[def.name];
  return {
    name: def.name,
    get description() {
      return texts().description;
    },
    get params() {
      return describe(def.params, texts().params);
    },
    run: def.run,
  };
});

function zodParam(p: ParamSpec): z.ZodType {
  let s: z.ZodType;
  if (p.type === "array") s = z.array(z.object(zodShape(p.items)));
  else if (p.type === "boolean") s = z.boolean();
  else if (p.type === "number") {
    let n = z.number();
    if (p.min !== undefined) n = n.min(p.min);
    if (p.max !== undefined) n = n.max(p.max);
    s = n;
  }
  else s = p.enum ? z.enum(p.enum as [string, ...string[]]) : z.string();
  if (p.description) s = s.describe(p.description);
  return p.optional ? s.optional() : s;
}

/** The parameters as a zod shape (Claude Agent SDK tools, argument checks). */
export function zodShape(params: Record<string, ParamSpec>): Record<string, z.ZodType> {
  return Object.fromEntries(Object.entries(params).map(([k, p]) => [k, zodParam(p)]));
}

export interface GeminiSchema {
  type: "OBJECT" | "STRING" | "BOOLEAN" | "NUMBER" | "ARRAY";
  description?: string;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
}

function geminiObject(params: Record<string, ParamSpec>): GeminiSchema {
  const properties: Record<string, GeminiSchema> = {};
  for (const [k, p] of Object.entries(params)) {
    const base = p.description ? { description: p.description } : {};
    properties[k] =
      p.type === "array"
        ? { type: "ARRAY", ...base, items: geminiObject(p.items) }
        : p.type === "boolean"
          ? { type: "BOOLEAN", ...base }
          : p.type === "number"
            ? { type: "NUMBER", ...base }
          : { type: "STRING", ...base, ...(p.enum ? { enum: [...p.enum] } : {}) };
  }
  const required = Object.entries(params)
    .filter(([, p]) => !p.optional)
    .map(([k]) => k);
  return { type: "OBJECT", properties, ...(required.length ? { required } : {}) };
}

/** Function declarations for the Gemini Live API. Tools without parameters leave `parameters` out. */
export function geminiFunctionDeclarations(tools: readonly PhoneToolSpec[] = PHONE_TOOLS) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(Object.keys(t.params).length ? { parameters: geminiObject(t.params) } : {}),
  }));
}

/**
 * Runs a tool call that came from a model as JSON. Unknown tools and invalid arguments become an
 * error text for the model, never an exception.
 */
export async function runPhoneTool(name: string, args: unknown, t: PhoneToolset, ctx: ToolContext): Promise<string> {
  const spec = PHONE_TOOLS.find((x) => x.name === name);
  const m = tr().phone;
  if (!spec) return m.unknownTool(name);
  const parsed = z.object(zodShape(spec.params)).safeParse(args ?? {});
  if (!parsed.success) return m.invalidArgs(name, parsed.error.issues.map((i) => `${i.path.join(".") || m.inputField} ${i.message}`).join("; "));
  try {
    return await spec.run(t, parsed.data as Record<string, unknown>, ctx);
  } catch (e) {
    return m.error(e instanceof Error ? e.message : String(e));
  }
}
