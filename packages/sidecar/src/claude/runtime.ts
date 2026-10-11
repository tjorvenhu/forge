import { randomUUID } from "node:crypto";
import {
  listSessions as sdkListSessions,
  deleteSession as sdkDeleteSession,
  getSessionMessages,
  query,
  type CanUseTool,
  type HookCallback,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Capability, ContextUsage, EffortLevel, ExternalSession, PermissionMode, PlanUsage, RewindResult, SlashCommand } from "@forge/protocol";
import type { ContentBlock } from "./attachments.js";
import { toPlanUsage } from "./usage.js";
import { AsyncQueue } from "./async-queue.js";

export interface StartOptions {
  cwd: string;
  model: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /** Claude session id to resume; null starts a fresh conversation */
  resume: string | null;
  disallowedTools: string[];
  env: Record<string, string>;
  claudePath: string;
  firstMessage: OutgoingMessage | null;
}

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
  /** stops the current turn; the session stays usable */
  interrupt(): Promise<void>;
  /** ends the session and its CLI process */
  close(): void;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** null returns to the model's default effort */
  setEffort(effort: EffortLevel | null): Promise<void>;
  /** context window usage estimated from the last response (cheap, no token-count calls) */
  contextUsage(): Promise<ContextUsage>;
  /** connects this session to claude.ai / the Claude app (Remote Control); returns the session link */
  setRemoteControl(enabled: boolean, name: string): Promise<string | null>;
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
  /** short-lived probe to read models/commands/account without sending a prompt */
  probe(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SDKControlInitializeResponse>;
  /** slash commands and skills available in a project (custom + those the headless CLI supports) */
  commands(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SlashCommand[]>;
  /** one-shot text completion without tools, e.g. commit messages */
  complete(prompt: string, opts: Pick<StartOptions, "cwd" | "env" | "claudePath"> & { model: string }): Promise<string>;
  /** plan rate-limit windows; uses an experimental SDK call, so callers must tolerate failure */
  planUsage(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<PlanUsage>;
}

/** Not in the SDK typings (0.3.x) but used by the official IDE hosts; checked at runtime before use. */
interface RemoteControlQuery {
  enableRemoteControl?: (enabled: boolean, name?: string) => Promise<{ session_url?: unknown } | undefined>;
}

/** Experimental in SDK 0.3.x and announced to be renamed; checked at runtime before use. */
interface UsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"];
}

export const REPLAY_FLAG = "replay-user-messages";
export const REMOTE_UNAVAILABLE = "Remote Control ist mit dieser Claude-Code-Version nicht verfügbar.";
export const USAGE_UNAVAILABLE = "Die Plan-Auslastung ist mit dieser Claude-Code-Version nicht verfügbar.";

/** Upper bound for one-shot CLI calls (probe, commands, completions, usage); a hung CLI must not block the UI. */
const ONE_SHOT_TIMEOUT_MS = 45_000;

function userMessage(m: OutgoingMessage): SDKUserMessage {
  const content = m.blocks.length ? [...m.blocks, { type: "text", text: m.text }] : m.text;
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: m.uuid } as SDKUserMessage;
}

export class AgentSdkRuntime implements ClaudeRuntime {
  readonly id = "agent-sdk";
  private readonly oneShotTimeoutMs: number;

  constructor(opts: { oneShotTimeoutMs?: number } = {}) {
    this.oneShotTimeoutMs = opts.oneShotTimeoutMs ?? ONE_SHOT_TIMEOUT_MS;
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
        reject(new Error(`${what}: Claude Code hat nicht innerhalb von ${Math.round(this.oneShotTimeoutMs / 1000)} Sekunden geantwortet.`));
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
    return [
      { key: "session.start", label: "Session starten", state: "supported", note: "Agent SDK query() mit Streaming-Input" },
      { key: "session.send", label: "Prompt senden", state: "supported", note: "Weitere Nachrichten in derselben Session" },
      { key: "stream.tokens", label: "Token-Streaming", state: "supported", note: "includePartialMessages" },
      { key: "stream.tools", label: "Tool-Events", state: "supported", note: "tool_use / tool_result" },
      { key: "approvals", label: "Freigabeanfragen", state: "supported", note: "canUseTool-Callback" },
      {
        key: "interrupt",
        label: "Stop/Cancel",
        state: "supported",
        note: cliCapabilities.includes("interrupt_receipt_v1") ? "interrupt() mit Bestätigung" : "interrupt()",
      },
      { key: "resume", label: "Resume", state: "supported", note: "options.resume, auch Terminal-Sessions" },
      { key: "sessions.list", label: "Sessions auflisten", state: "supported", note: "listSessions({ dir })" },
      { key: "model.switch", label: "Modell wechseln", state: "supported", note: "setModel()" },
      { key: "permission.modes", label: "Permission-Modi", state: "supported", note: "default, acceptEdits, plan, bypassPermissions" },
      { key: "policy.hook", label: "Harte Sperrliste", state: "supported", note: "PreToolUse-Hook, greift auch im Bypass" },
      {
        key: "slash.commands",
        label: "Slash-Commands",
        state: "partial",
        note: init ? `${commands} Commands/Skills gemeldet; interaktive Built-ins nicht verfügbar` : "Liste erst nach Sessionstart bekannt",
      },
      { key: "attachments", label: "Bilder/Dateien im Prompt", state: "supported", note: "Bilder, PDFs und Textdateien als Content-Blöcke" },
      { key: "rewind", label: "Dateien zurücksetzen", state: "supported", note: "enableFileCheckpointing + rewindFiles()" },
      { key: "questions", label: "Rückfragen und Plan-Freigabe", state: "supported", note: "AskUserQuestion-Antworten und ExitPlanMode über canUseTool" },
      { key: "context", label: "Kontextauslastung", state: "supported", note: "getContextUsage() nach jedem Durchlauf, /compact" },
      { key: "remote", label: "Remote Control (Claude-App)", state: "supported", note: "Bridge der laufenden Session; im SDK nicht dokumentiert" },
      { key: "usage", label: "Token-Usage", state: "supported", note: "aus result.usage" },
      { key: "cost", label: "Kosten", state: "partial", note: "Bei Abo nur API-Äquivalent, wird nicht angezeigt" },
      { key: "terminal", label: "Eingebettetes Terminal", state: "supported", note: "xterm.js + PTY in der Tauri-Hülle" },
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
        decision = { behavior: "deny", message: "Die Freigabeanfrage konnte nicht verarbeitet werden." };
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
        v = { rule: "guard-error", message: "Die Policy-Prüfung ist fehlgeschlagen, der Aufruf wurde vorsichtshalber abgelehnt." };
      }
      if (!v) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `FORGE-Policy (${v.rule}): ${v.message}`,
        },
      };
    };

    const q: Query = query({
      prompt: input,
      options: {
        cwd: opts.cwd,
        env: opts.env,
        model: opts.model ?? undefined,
        ...(opts.effort ? { effort: opts.effort } : {}),
        permissionMode: opts.permissionMode,
        // Always allowed so a profile switch can move a running session to bypass; without the flag the
        // CLI refuses setPermissionMode("bypassPermissions"). The active mode is still set explicitly.
        allowDangerouslySkipPermissions: true,
        resume: opts.resume ?? undefined,
        disallowedTools: opts.disallowedTools,
        includePartialMessages: true,
        enableFileCheckpointing: true,
        settingSources: ["user", "project", "local"],
        pathToClaudeCodeExecutable: opts.claudePath,
        canUseTool,
        hooks: { PreToolUse: [{ hooks: [guard] }] },
        // Echoes user messages, so messages typed in the Claude app (Remote Control) reach the timeline.
        // A CLI flag, not an SDK option: a CLI without it fails at start, reported as "please update".
        extraArgs: { [REPLAY_FLAG]: null },
      },
    });

    let closed = false;
    void (async () => {
      try {
        for await (const msg of q) sink.onMessage(msg);
        sink.onEnd(null);
      } catch (e) {
        sink.onEnd(closed ? null : e instanceof Error ? e : new Error(String(e)));
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
      close: () => {
        if (closed) return;
        closed = true;
        input.end();
        q.close();
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
        if (typeof rc.enableRemoteControl !== "function") throw new Error(REMOTE_UNAVAILABLE);
        const r = await rc.enableRemoteControl.call(q, enabled, name);
        return typeof r?.session_url === "string" ? r.session_url : null;
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

  async commands(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SlashCommand[]> {
    const input = new AsyncQueue<SDKUserMessage>();
    const ac = new AbortController();
    const q = query({
      prompt: input,
      options: { cwd: opts.cwd, env: opts.env, pathToClaudeCodeExecutable: opts.claudePath, settingSources: ["user", "project", "local"], persistSession: false, abortController: ac },
    });
    return this.oneShot("Slash-Commands laden", q, ac, q.supportedCommands().then((list) => list.map(toCommand)), () => input.end());
  }

  async complete(prompt: string, opts: Pick<StartOptions, "cwd" | "env" | "claudePath"> & { model: string }): Promise<string> {
    const ac = new AbortController();
    const q = query({
      prompt,
      options: {
        cwd: opts.cwd,
        env: opts.env,
        model: opts.model,
        pathToClaudeCodeExecutable: opts.claudePath,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController: ac,
      },
    });
    const work = (async () => {
      let text = "";
      for await (const m of q) {
        if (m.type === "result") {
          if (m.subtype !== "success") throw new Error(`Claude konnte keine Antwort erzeugen (${m.subtype})`);
          text = m.result;
        }
      }
      return text;
    })();
    return this.oneShot("Antwort von Claude", q, ac, work);
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
      throw new Error(USAGE_UNAVAILABLE);
    }
    return this.oneShot("Plan-Auslastung", q, ac, usage.call(q, { skipBehaviors: true }).then(toPlanUsage), () => input.end());
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

function toCommand(c: { name: string; description: string; argumentHint?: string }): SlashCommand {
  return { name: c.name, description: c.description ?? "", argumentHint: c.argumentHint ?? "" };
}
