import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  tool as sdkTool,
  listSessions as sdkListSessions,
  deleteSession as sdkDeleteSession,
  renameSession as sdkRenameSession,
  forkSession as sdkForkSession,
  getSessionMessages,
  query,
  type CanUseTool,
  type HookCallback,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Capability, ContextUsage, EffortLevel, ExternalSession, ForgeUsagePurpose, PermissionMode, PlanUsage, RewindResult, SlashCommand } from "@forge/protocol";
import type { z } from "zod";
import type { ContentBlock } from "./attachments.js";
import { toPlanUsage } from "./usage.js";
import { AsyncQueue } from "./async-queue.js";
import { meterKey, tokenMeter } from "./token-meter.js";
import { GROUP_SPAWN, killTree, PIPE_GRACE_MS } from "../util/proc.js";
import { tr } from "../i18n/index.js";
import { de } from "../i18n/de/index.js";

/** What FORGE asks Claude for outside a session; recorded with the call (claude_usage.purpose). */
export type AssistPurpose = ForgeUsagePurpose;

export type CompleteOptions = Pick<StartOptions, "cwd" | "env" | "claudePath"> & { model: string; purpose?: AssistPurpose; effort?: EffortLevel };

export interface StartOptions {
  cwd: string;
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /** Claude session id to resume; null starts a fresh conversation */
  resume: string | null;
  /** with resume: the conversation goes on after this transcript entry; everything later is dropped */
  resumeAt?: string | null;
  disallowedTools: string[];
  env: Record<string, string>;
  claudePath: string;
  firstMessage: OutgoingMessage | null;
  /** FORGE tools for this session (MCP server "forge", tool names mcp__forge__<name>) */
  tools?: SessionTool[];
  /**
   * Appended to Claude Code's system prompt. Not a SessionStart hook: the SDK never calls SessionStart
   * callbacks passed in `hooks` (checked with SDK 0.3.296). The CLI records the prompt on the first
   * request, so a resumed session keeps the text of its start until the next compaction.
   */
  context?: string | null;
  /** model the CLI switches to when the main one is overloaded (must differ from it) */
  fallbackModel?: string | null;
}

/**
 * Fallback on overload: Opus falls back to Sonnet. Other models get none (the fallback would be the
 * bigger and slower model, or the same one); unknown or default models neither, the CLI refuses a
 * fallback equal to the main model.
 */
export function fallbackFor(model: string | null): string | null {
  return model && /opus/i.test(model) ? "sonnet" : null;
}

/** A tool FORGE offers inside a coding session. */
export interface SessionTool {
  name: string;
  description: string;
  shape: Record<string, z.ZodType>;
  /** allowed without asking (read-only or harmless); the others go through the normal approvals */
  autoAllow: boolean;
  run(args: Record<string, unknown>): Promise<string | ToolOutput>;
}

/** A tool result with images (base64) after the text, e.g. a screenshot. */
export interface ToolOutput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export const FORGE_MCP = "forge";

export interface ApprovalRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  description: string | null;
  reason: string | null;
  suppressAlwaysAllow: boolean;
}

export type ApprovalDecision =
  | {
      behavior: "allow";
      scope: "once" | "session";
      /** replaces the tool input, e.g. AskUserQuestion with the user's answers */
      updatedInput?: Record<string, unknown>;
      /** switches the permission mode with the approval (accepting a plan leaves plan mode) */
      mode?: PermissionMode;
    }
  | { behavior: "deny"; message: string };

/** Callbacks from the runtime into FORGE (the "streamEvents" side of the adapter). */
export interface SessionSink {
  onMessage(msg: unknown): void;
  onApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  /** hard policy check; runs as PreToolUse hook, so it applies in every permission mode */
  preToolUse(toolName: string, input: Record<string, unknown>, toolUseId: string | null): Promise<{ rule: string; message: string } | null>;
  /**
   * Context Claude gets with a tool call it may make: before it (pre, e.g. another crew member works
   * on the file) or with its result (post, e.g. news from the crew). null adds nothing.
   */
  toolContext?(phase: "pre" | "post", toolName: string, input: Record<string, unknown>): string | null;
  onEnd(error: Error | null): void;
}

/** A user turn: text plus optional content blocks (images, PDFs, files) and a client id for rewinding. */
export interface OutgoingMessage {
  text: string;
  blocks: ContentBlock[];
  uuid: string;
}

export interface RuntimeSession {
  sendMessage(msg: OutgoingMessage): void;
  /** restores files to their state before the given user message (file checkpointing) */
  rewindFiles(uuid: string, dryRun: boolean): Promise<RewindResult>;
  supportedCommands(): Promise<SlashCommand[]>;
  /** stops the current turn; the session stays usable. Background tasks keep running (perTaskStopAffordance). */
  interrupt(): Promise<void>;
  /** stops one background task or subagent */
  stopTask(taskId: string): Promise<void>;
  /** the end (last 8 KiB) of what a background shell task printed; only shell and Monitor tasks have one */
  taskOutput(taskId: string): Promise<{ output: string; totalBytes: number; truncated: boolean }>;
  /** moves running foreground work into the background (one tool call, or all); false when nothing matched */
  toBackground(toolUseId?: string): Promise<boolean>;
  /** ends the session and its CLI process */
  close(): void;
  /** ends the CLI process and everything it started right away; for a close() that does not finish */
  kill(): void;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** null returns to the model's default effort */
  setEffort(effort: EffortLevel | null): Promise<void>;
  /** context window usage estimated from the last response (cheap, no token-count calls) */
  contextUsage(): Promise<ContextUsage>;
  /** connects this session to claude.ai / the Claude app (Remote Control); returns the session link */
  setRemoteControl(enabled: boolean, name: string): Promise<string | null>;
  /** a short title Claude Code writes for the description; null when this CLI cannot */
  generateTitle(description: string): Promise<string | null>;
  /**
   * sets the title Claude Code (and with Remote Control the Claude app) shows; a no-op when this CLI
   * cannot. With claudeSessionId the CLI refuses it once it moved to another conversation (/clear).
   */
  rename(title: string, claudeSessionId: string | null): Promise<void>;
  initialization(): Promise<SDKControlInitializeResponse>;
}

export interface ClaudeRuntime {
  readonly id: string;
  capabilities(init?: SDKControlInitializeResponse | null, cliCapabilities?: string[]): Capability[];
  /** starts a CLI process; with opts.resume it continues that Claude session */
  startSession(opts: StartOptions, sink: SessionSink): RuntimeSession;
  listSessions(dir: string): Promise<ExternalSession[]>;
  sessionHistory(claudeSessionId: string, dir: string): Promise<unknown[]>;
  /** removes the CLI's transcript, so the session is gone from `claude --resume` too */
  deleteTranscript(claudeSessionId: string, dir: string): Promise<void>;
  /** writes a new title into the CLI's transcript; for sessions without a running process */
  renameTranscript(claudeSessionId: string, title: string, dir: string): Promise<void>;
  /**
   * copies a transcript into a new Claude session, up to and including `upToMessageId` (null: all);
   * returns the new session id. The copy has no file checkpoints.
   */
  forkTranscript(claudeSessionId: string, dir: string, upToMessageId: string | null, title: string): Promise<string>;
  /** short-lived probe to read models/commands/account without sending a prompt */
  probe(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SDKControlInitializeResponse>;
  /** slash commands and skills available in a project (custom + those the headless CLI supports) */
  commands(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SlashCommand[]>;
  /** one-shot text completion without tools, e.g. commit messages */
  complete(prompt: string, opts: CompleteOptions): Promise<string>;
  /** one-shot answer as JSON matching `schema` (structured output); the caller validates the shape */
  completeJson(prompt: string, schema: Record<string, unknown>, opts: CompleteOptions): Promise<unknown>;
  /** plan rate-limit windows; uses an experimental SDK call, so callers must tolerate failure */
  planUsage(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<PlanUsage>;
}

/** Not in the SDK typings (0.3.x) but used by the official IDE hosts; checked at runtime before use. */
interface RemoteControlQuery {
  enableRemoteControl?: (enabled: boolean, name?: string) => Promise<{ session_url?: unknown } | undefined>;
}

/** Not in the SDK typings (0.3.x); checked at runtime before use. */
interface SessionTitleQuery {
  generateSessionTitle?: (description: string, opts?: { persist?: boolean }) => Promise<unknown>;
  renameSession?: (title: string, sessionId?: string) => Promise<void>;
}

/** Not in the SDK typings (0.3.x); the CLI's get_task_output control request. Checked at runtime before use. */
interface TaskOutputQuery {
  getTaskOutput?: (taskId: string) => Promise<{ output?: unknown; total_bytes?: unknown; truncated?: unknown } | undefined>;
}

/** Experimental in SDK 0.3.x and announced to be renamed; checked at runtime before use. */
interface UsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"];
}

export const REPLAY_FLAG = "replay-user-messages";
/** German wording of these errors, for callers that compare messages; the thrown text follows the language. */
export const REMOTE_UNAVAILABLE = de.core.claude.remoteUnavailable;
export const USAGE_UNAVAILABLE = de.core.claude.usageUnavailable;

/** Upper bound for one-shot CLI calls (probe, commands, completions, usage); a hung CLI must not block the UI. */
const ONE_SHOT_TIMEOUT_MS = 45_000;

function userMessage(m: OutgoingMessage): SDKUserMessage {
  const content = m.blocks.length ? [...m.blocks, { type: "text", text: m.text }] : m.text;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: m.uuid } as SDKUserMessage;
}

/** What a session keeps of the CLI's stderr for the error message when the process fails. */
const STDERR_TAIL_CHARS = 4000;

/** The SDK's exit error ("exited with code 1") with the end of stderr, which usually says why. */
export function withStderr(e: unknown, tail: string): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  const t = tail.trim();
  return !t || err.message.includes(t) ? err : new Error(`${err.message}\n${t}`);
}

export class AgentSdkRuntime implements ClaudeRuntime {
  readonly id = "agent-sdk";
  private readonly oneShotTimeoutMs: number;
  private readonly readDirs: string[];

  /** readDirs: folders every session may read without asking (files FORGE hands to Claude by path) */
  constructor(opts: { oneShotTimeoutMs?: number; readDirs?: string[] } = {}) {
    this.oneShotTimeoutMs = opts.oneShotTimeoutMs ?? ONE_SHOT_TIMEOUT_MS;
    this.readDirs = opts.readDirs ?? [];
  }

  /**
   * Runs a short-lived CLI call with a time limit. On timeout the query is aborted and closed so the
   * CLI process does not linger; the late result or error of `work` is dropped.
   */
  private async oneShot<T>(what: string, q: Query, ac: AbortController, work: Promise<T>, cleanup: () => void = () => {}): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(tr().core.claude.oneShotTimeout(what, Math.round(this.oneShotTimeoutMs / 1000))));
      }, this.oneShotTimeoutMs);
    });
    work.catch(() => {});
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      cleanup();
      try {
        q.close();
      } catch {
        /* already closed */
      }
    }
  }

  capabilities(init?: SDKControlInitializeResponse | null, cliCapabilities: string[] = []): Capability[] {
    const commands = init?.commands?.length ?? 0;
    const c = tr().core.claude.capabilities;
    return [
      { key: "session.start", state: "supported", ...c.sessionStart },
      { key: "session.send", state: "supported", ...c.sessionSend },
      { key: "stream.tokens", state: "supported", ...c.streamTokens },
      { key: "stream.tools", state: "supported", ...c.streamTools },
      { key: "approvals", state: "supported", ...c.approvals },
      {
        key: "interrupt",
        label: c.interrupt,
        state: "supported",
        note: cliCapabilities.includes("interrupt_receipt_v1") ? c.interruptReceipt : "interrupt()",
      },
      { key: "resume", state: "supported", ...c.resume },
      { key: "sessions.list", state: "supported", ...c.sessionsList },
      { key: "model.switch", state: "supported", ...c.modelSwitch },
      { key: "permission.modes", state: "supported", ...c.permissionModes },
      { key: "policy.hook", state: "supported", ...c.policyHook },
      {
        key: "slash.commands",
        label: c.slashCommands,
        state: "partial",
        note: init ? c.slashReported(commands) : c.slashUnknown,
      },
      { key: "attachments", state: "supported", ...c.attachments },
      { key: "rewind", state: "supported", ...c.rewind },
      { key: "fork", state: "supported", ...c.fork },
      { key: "questions", state: "supported", ...c.questions },
      { key: "context", state: "supported", ...c.context },
      { key: "remote", state: "supported", ...c.remote },
      { key: "usage", state: "supported", ...c.usage },
      { key: "cost", state: "partial", ...c.cost },
      { key: "terminal", state: "supported", ...c.terminal },
    ];
  }

  startSession(opts: StartOptions, sink: SessionSink): RuntimeSession {
    const input = new AsyncQueue<SDKUserMessage>();
    if (opts.firstMessage) input.push(userMessage(opts.firstMessage));

    const canUseTool: CanUseTool = async (toolName, toolInput, o) => {
      let decision: ApprovalDecision;
      try {
        decision = await sink.onApproval(
          {
            requestId: randomUUID(),
            toolUseId: o.toolUseID,
            toolName,
            input: toolInput,
            title: o.title ?? null,
            description: o.description ?? null,
            reason: o.decisionReason ?? null,
            suppressAlwaysAllow: o.suppressAlwaysAllowRule === true,
          },
          o.signal,
        );
      } catch {
        decision = { behavior: "deny", message: tr().core.claude.approvalFailed };
      }
      if (decision.behavior === "deny") return { behavior: "deny", message: decision.message } satisfies PermissionResult;
      const updates: PermissionUpdate[] = [];
      if (decision.scope === "session" && o.suggestions?.length) {
        // Never let a click persist rules into settings files: session scope only.
        updates.push(...o.suggestions.map((s) => ({ ...s, destination: "session" }) as PermissionUpdate));
      }
      if (decision.mode) updates.push({ type: "setMode", mode: decision.mode, destination: "session" });
      return { behavior: "allow", updatedInput: decision.updatedInput ?? toolInput, ...(updates.length ? { updatedPermissions: updates } : {}) } satisfies PermissionResult;
    };

    const guard: HookCallback = async (hookInput, toolUseId) => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      const ti = (hookInput.tool_input && typeof hookInput.tool_input === "object" ? hookInput.tool_input : {}) as Record<string, unknown>;
      let v: { rule: string; message: string } | null;
      try {
        v = await sink.preToolUse(hookInput.tool_name, ti, toolUseId ?? null);
      } catch {
        // Fail closed: a check that could not run must not let the call through.
        v = { rule: "guard-error", message: tr().core.claude.policyCheckFailed };
      }
      if (!v) {
        const extra = contextFor("pre", hookInput.tool_name, ti);
        return extra ? { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: extra } } : {};
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: tr().core.claude.policyDenied(v.rule, v.message),
        },
      };
    };
    /** Extra context must never break a tool call. */
    const contextFor = (phase: "pre" | "post", toolName: string, input: Record<string, unknown>): string | null => {
      try {
        return sink.toolContext?.(phase, toolName, input) ?? null;
      } catch {
        return null;
      }
    };
    const after: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== "PostToolUse") return {};
      const ti = (hookInput.tool_input && typeof hookInput.tool_input === "object" ? hookInput.tool_input : {}) as Record<string, unknown>;
      const extra = contextFor("post", hookInput.tool_name, ti);
      return extra ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: extra } } : {};
    };

    // Spawned here instead of by the SDK so a close that hangs can end the whole process tree. The SDK
    // reads stderr only from its own spawn, so the tail for error messages is kept here.
    let child: ChildProcess | null = null;
    let stderrTail = "";
    let stderrClosed: Promise<void> = Promise.resolve();
    const spawnClaude = (o: SpawnOptions): SpawnedProcess => {
      const c = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...GROUP_SPAWN });
      c.stderr.setEncoding("utf8");
      c.stderr.on("data", (d: string) => {
        stderrTail = (stderrTail + d).slice(-STDERR_TAIL_CHARS);
      });
      c.stderr.on("error", () => {});
      stderrClosed = new Promise((r) => c.stderr.once("close", () => r()));
      child = c;
      return c;
    };

    const q: Query = query({
      prompt: input,
      options: {
        cwd: opts.cwd,
        env: opts.env,
        spawnClaudeCodeProcess: spawnClaude,
        model: opts.model ?? undefined,
        ...(opts.fallbackModel ? { fallbackModel: opts.fallbackModel } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        permissionMode: opts.permissionMode,
        // Always allowed so a profile switch can move a running session to bypass; without the flag the
        // CLI refuses setPermissionMode("bypassPermissions"). The active mode is still set explicitly.
        allowDangerouslySkipPermissions: true,
        resume: opts.resume ?? undefined,
        ...(opts.resume && opts.resumeAt ? { resumeSessionAt: opts.resumeAt } : {}),
        disallowedTools: opts.disallowedTools,
        // Writes there still go through FORGE's guard for paths outside the project.
        ...(this.readDirs.length ? { additionalDirectories: this.readDirs } : {}),
        includePartialMessages: true,
        enableFileCheckpointing: true,
        // No agentProgressSummaries: in an SDK session they fork the whole subagent conversation every
        // 30 s (the terminal gets a cheap short mode the SDK cannot select). FORGE builds the progress
        // line from the subagent's tool calls instead (sessions/task-activity.ts).
        // FORGE stops tasks one by one (sessions.stopTask); Stop then only ends the turn, not every background task.
        perTaskStopAffordance: true,
        settingSources: ["user", "project", "local"],
        pathToClaudeCodeExecutable: opts.claudePath,
        canUseTool,
        ...(opts.context ? { systemPrompt: { type: "preset", preset: "claude_code", append: opts.context } } : {}),
        hooks: { PreToolUse: [{ hooks: [guard] }], ...(sink.toolContext ? { PostToolUse: [{ hooks: [after] }] } : {}) },
        ...(opts.tools?.length
          ? {
              mcpServers: { [FORGE_MCP]: forgeServer(opts.tools) },
              allowedTools: opts.tools.filter((t) => t.autoAllow).map((t) => `mcp__${FORGE_MCP}__${t.name}`),
            }
          : {}),
        // Echoes user messages, so messages typed in the Claude app (Remote Control) reach the timeline.
        // A CLI flag, not an SDK option: a CLI without it fails at start, reported as "please update".
        extraArgs: { [REPLAY_FLAG]: null },
      },
    });

    let closed = false;
    const meter = meterKey("session");
    void (async () => {
      try {
        for await (const msg of q) {
          tokenMeter.observe(meter, msg);
          sink.onMessage(msg);
        }
        sink.onEnd(null);
      } catch (e) {
        if (closed) {
          sink.onEnd(null);
        } else {
          // stderr may still be arriving after the exit that ended the stream
          await Promise.race([stderrClosed, new Promise((r) => setTimeout(r, PIPE_GRACE_MS))]);
          sink.onEnd(withStderr(e, stderrTail));
        }
      } finally {
        tokenMeter.forget(meter);
      }
    })();

    return {
      sendMessage: (m) => input.push(userMessage(m)),
      rewindFiles: async (uuid, dryRun) => {
        const r = await q.rewindFiles(uuid, { dryRun });
        return {
          canRewind: r.canRewind,
          error: r.error ?? null,
          filesChanged: r.filesChanged ?? [],
          insertions: r.insertions ?? 0,
          deletions: r.deletions ?? 0,
        };
      },
      supportedCommands: async () => (await q.supportedCommands()).map(toCommand),
      interrupt: async () => {
        await q.interrupt();
      },
      stopTask: (taskId) => q.stopTask(taskId),
      taskOutput: async (taskId) => {
        const tq = q as unknown as TaskOutputQuery;
        if (typeof tq.getTaskOutput !== "function") throw new Error(tr().core.claude.noTaskOutput);
        const r = await tq.getTaskOutput.call(q, taskId);
        return {
          output: typeof r?.output === "string" ? r.output : "",
          totalBytes: typeof r?.total_bytes === "number" ? r.total_bytes : 0,
          truncated: r?.truncated === true,
        };
      },
      toBackground: (toolUseId) => q.backgroundTasks(toolUseId),
      close: () => {
        if (closed) return;
        closed = true;
        input.end();
        q.close();
      },
      kill: () => {
        if (child) killTree(child);
      },
      setModel: (model) => q.setModel(model),
      setPermissionMode: (mode) => q.setPermissionMode(mode),
      setEffort: (effort) => q.applyFlagSettings({ effortLevel: effort }),
      contextUsage: async () => {
        const u = await q.getContextUsage({ detail: "summary" });
        return {
          totalTokens: u.totalTokens,
          maxTokens: u.rawMaxTokens || u.maxTokens,
          percentage: u.percentage,
          categories: u.categories.filter((c) => c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
          updatedAt: new Date().toISOString(),
        };
      },
      setRemoteControl: async (enabled, name) => {
        const rc = q as unknown as RemoteControlQuery;
        if (typeof rc.enableRemoteControl !== "function") throw new Error(tr().core.claude.remoteUnavailable);
        const r = await rc.enableRemoteControl.call(q, enabled, name);
        return typeof r?.session_url === "string" ? r.session_url : null;
      },
      generateTitle: async (description) => {
        const tq = q as unknown as SessionTitleQuery;
        if (typeof tq.generateSessionTitle !== "function") return null;
        // persist: false, FORGE applies the title itself with rename() so every place shows the same one.
        const title = await tq.generateSessionTitle.call(q, description, { persist: false });
        return typeof title === "string" && title.trim() ? title : null;
      },
      rename: async (title, claudeSessionId) => {
        const tq = q as unknown as SessionTitleQuery;
        if (typeof tq.renameSession !== "function") return;
        await tq.renameSession.call(q, title, claudeSessionId ?? undefined);
      },
      initialization: () => q.initializationResult(),
    };
  }

  async listSessions(dir: string): Promise<ExternalSession[]> {
    const list = await sdkListSessions({ dir, limit: 50 });
    return list.map((s) => ({
      claudeSessionId: s.sessionId,
      summary: s.customTitle || s.summary || s.firstPrompt || "(ohne Titel)",
      lastModified: new Date(s.lastModified).toISOString(),
      gitBranch: s.gitBranch ?? null,
      cwd: s.cwd ?? null,
    }));
  }

  async sessionHistory(claudeSessionId: string, dir: string): Promise<unknown[]> {
    return getSessionMessages(claudeSessionId, { dir });
  }

  async deleteTranscript(claudeSessionId: string, dir: string): Promise<void> {
    await sdkDeleteSession(claudeSessionId, { dir });
  }

  async renameTranscript(claudeSessionId: string, title: string, dir: string): Promise<void> {
    await sdkRenameSession(claudeSessionId, title, { dir });
  }

  async forkTranscript(claudeSessionId: string, dir: string, upToMessageId: string | null, title: string): Promise<string> {
    const r = await sdkForkSession(claudeSessionId, { dir, title, ...(upToMessageId ? { upToMessageId } : {}) });
    return r.sessionId;
  }

  async commands(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SlashCommand[]> {
    const input = new AsyncQueue<SDKUserMessage>();
    const ac = new AbortController();
    const q = query({
      prompt: input,
      options: { cwd: opts.cwd, env: opts.env, pathToClaudeCodeExecutable: opts.claudePath, settingSources: ["user", "project", "local"], persistSession: false, abortController: ac },
    });
    return this.oneShot(tr().core.claude.oneShotCommands, q, ac, q.supportedCommands().then((list) => list.map(toCommand)), () => input.end());
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const ac = new AbortController();
    const q = query({
      prompt,
      options: {
        cwd: opts.cwd,
        env: opts.env,
        model: opts.model,
        ...(opts.effort ? { effort: opts.effort } : {}),
        pathToClaudeCodeExecutable: opts.claudePath,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController: ac,
      },
    });
    const meter = meterKey(`complete:${opts.purpose ?? "other"}`);
    const work = (async () => {
      let text = "";
      for await (const m of q) {
        tokenMeter.observe(meter, m);
        if (m.type === "result") {
          if (m.subtype !== "success") throw new Error(tr().core.claude.noAnswer(m.subtype));
          text = m.result;
        }
      }
      return text;
    })();
    return this.oneShot(tr().core.claude.oneShotAnswer, q, ac, work);
  }

  async completeJson(prompt: string, schema: Record<string, unknown>, opts: CompleteOptions): Promise<unknown> {
    const ac = new AbortController();
    const q = query({
      prompt,
      options: {
        cwd: opts.cwd,
        env: opts.env,
        model: opts.model,
        pathToClaudeCodeExecutable: opts.claudePath,
        tools: [],
        outputFormat: { type: "json_schema", schema },
        // The structured answer is delivered through a tool call: one turn for it plus room for a retry.
        maxTurns: 3,
        settingSources: [],
        persistSession: false,
        abortController: ac,
      },
    });
    const meter = meterKey(`complete:${opts.purpose ?? "other"}`);
    const work = (async () => {
      let out: unknown;
      for await (const m of q) {
        tokenMeter.observe(meter, m);
        if (m.type === "result") {
          if (m.subtype !== "success") throw new Error(tr().core.claude.noAnswer(m.subtype));
          out = m.structured_output;
        }
      }
      if (out === undefined) throw new Error(tr().core.claude.noStructuredAnswer);
      return out;
    })();
    return this.oneShot(tr().core.claude.oneShotAnswer, q, ac, work);
  }

  async planUsage(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<PlanUsage> {
    const input = new AsyncQueue<SDKUserMessage>();
    const ac = new AbortController();
    const q = query({
      prompt: input,
      options: { cwd: opts.cwd, env: opts.env, pathToClaudeCodeExecutable: opts.claudePath, settingSources: [], persistSession: false, abortController: ac },
    });
    const usage = (q as unknown as UsageQuery).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof usage !== "function") {
      input.end();
      q.close();
      throw new Error(tr().core.claude.usageUnavailable);
    }
    return this.oneShot(tr().core.claude.oneShotUsage, q, ac, usage.call(q, { skipBehaviors: true }).then(toPlanUsage), () => input.end());
  }

  async probe(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SDKControlInitializeResponse> {
    const input = new AsyncQueue<SDKUserMessage>();
    const ac = new AbortController();
    const q = query({
      prompt: input,
      options: {
        cwd: opts.cwd,
        env: opts.env,
        pathToClaudeCodeExecutable: opts.claudePath,
        settingSources: ["user"],
        persistSession: false,
        abortController: ac,
      },
    });
    return this.oneShot("Claude-Code-Abfrage", q, ac, q.initializationResult(), () => input.end());
  }
}

/** The FORGE tools as an in-process MCP server. */
function forgeServer(tools: SessionTool[]) {
  return createSdkMcpServer({
    name: FORGE_MCP,
    version: "1.0.0",
    tools: tools.map((t) =>
      sdkTool(t.name, t.description, t.shape, async (args: Record<string, unknown>) => {
        let out: string | ToolOutput;
        try {
          out = await t.run(args);
        } catch (e) {
          return { content: [{ type: "text" as const, text: tr().core.claude.toolError(e instanceof Error ? e.message : String(e)) }], isError: true };
        }
        const { text, images = [] } = typeof out === "string" ? { text: out } : out;
        return { content: [{ type: "text" as const, text }, ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))] };
      }),
    ),
  });
}

/** SessionStart hook: tells Claude what FORGE offers in this session. */
function toCommand(c: { name: string; description: string; argumentHint?: string; builtin?: boolean }): SlashCommand {
  return { name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "", ...(c.builtin === true ? { builtin: true } : {}) };
}
