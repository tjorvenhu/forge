import { randomUUID } from "node:crypto";
import {
  listSessions as sdkListSessions,
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
import type { Capability, ExternalSession, PermissionMode, PlanUsage } from "@forge/protocol";
import { toPlanUsage } from "./usage.js";
import { AsyncQueue } from "./async-queue.js";

export interface StartOptions {
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  /** Claude session id to resume; null starts a fresh conversation */
  resume: string | null;
  disallowedTools: string[];
  env: Record<string, string>;
  claudePath: string;
  firstPrompt: string | null;
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
  | { behavior: "allow"; scope: "once" | "session" }
  | { behavior: "deny"; message: string };

/** Callbacks from the runtime into FORGE (the "streamEvents" side of the adapter). */
export interface SessionSink {
  onMessage(msg: unknown): void;
  onApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  /** hard policy check; runs as PreToolUse hook, so it applies in every permission mode */
  preToolUse(toolName: string, input: Record<string, unknown>, toolUseId: string | null): Promise<{ rule: string; message: string } | null>;
  onEnd(error: Error | null): void;
}

export interface RuntimeSession {
  sendMessage(text: string): void;
  /** stops the current turn; the session stays usable */
  interrupt(): Promise<void>;
  /** ends the session and its CLI process */
  close(): void;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  initialization(): Promise<SDKControlInitializeResponse>;
}

export interface ClaudeRuntime {
  readonly id: string;
  capabilities(init?: SDKControlInitializeResponse | null, cliCapabilities?: string[]): Capability[];
  startSession(opts: StartOptions, sink: SessionSink): RuntimeSession;
  resumeSession(claudeSessionId: string, opts: Omit<StartOptions, "resume">, sink: SessionSink): RuntimeSession;
  listSessions(dir: string): Promise<ExternalSession[]>;
  sessionHistory(claudeSessionId: string, dir: string): Promise<unknown[]>;
  /** short-lived probe to read models/commands/account without sending a prompt */
  probe(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SDKControlInitializeResponse>;
  /** one-shot text completion without tools, e.g. commit messages */
  complete(prompt: string, opts: Pick<StartOptions, "cwd" | "env" | "claudePath"> & { model: string }): Promise<string>;
  /** plan rate-limit windows; uses an experimental SDK call, so callers must tolerate failure */
  planUsage(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<PlanUsage>;
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
}

export class AgentSdkRuntime implements ClaudeRuntime {
  readonly id = "agent-sdk";

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
      { key: "attachments", label: "Bilder/Dateien im Prompt", state: "unavailable", note: "In FORGE Phase 1 nicht umgesetzt" },
      { key: "usage", label: "Token-Usage", state: "supported", note: "aus result.usage" },
      { key: "cost", label: "Kosten", state: "partial", note: "Bei Abo nur API-Äquivalent, wird nicht angezeigt" },
      { key: "terminal", label: "Eingebettetes Terminal", state: "unavailable", note: "Phase 2 (xterm.js + PTY)" },
    ];
  }

  startSession(opts: StartOptions, sink: SessionSink): RuntimeSession {
    const input = new AsyncQueue<SDKUserMessage>();
    if (opts.firstPrompt) input.push(userMessage(opts.firstPrompt));

    const canUseTool: CanUseTool = async (toolName, toolInput, o) => {
      const decision = await sink.onApproval(
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
      if (decision.behavior === "deny") return { behavior: "deny", message: decision.message } satisfies PermissionResult;
      const result: PermissionResult = { behavior: "allow", updatedInput: toolInput };
      if (decision.scope === "session" && o.suggestions?.length) {
        // Never let a click persist rules into settings files: session scope only.
        result.updatedPermissions = o.suggestions.map((s) => ({ ...s, destination: "session" }) as PermissionUpdate);
      }
      return result;
    };

    const guard: HookCallback = async (hookInput, toolUseId) => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      const ti = (hookInput.tool_input && typeof hookInput.tool_input === "object" ? hookInput.tool_input : {}) as Record<string, unknown>;
      const v = await sink.preToolUse(hookInput.tool_name, ti, toolUseId ?? null);
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
        permissionMode: opts.permissionMode,
        allowDangerouslySkipPermissions: opts.permissionMode === "bypassPermissions",
        resume: opts.resume ?? undefined,
        disallowedTools: opts.disallowedTools,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        pathToClaudeCodeExecutable: opts.claudePath,
        canUseTool,
        hooks: { PreToolUse: [{ hooks: [guard] }] },
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
      sendMessage: (text) => input.push(userMessage(text)),
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
      initialization: () => q.initializationResult(),
    };
  }

  resumeSession(claudeSessionId: string, opts: Omit<StartOptions, "resume">, sink: SessionSink): RuntimeSession {
    return this.startSession({ ...opts, resume: claudeSessionId }, sink);
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

  async complete(prompt: string, opts: Pick<StartOptions, "cwd" | "env" | "claudePath"> & { model: string }): Promise<string> {
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
      },
    });
    let text = "";
    for await (const m of q) {
      if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`Claude konnte keine Antwort erzeugen (${m.subtype})`);
        text = m.result;
      }
    }
    return text;
  }

  async planUsage(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<PlanUsage> {
    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: { cwd: opts.cwd, env: opts.env, pathToClaudeCodeExecutable: opts.claudePath, settingSources: [], persistSession: false },
    });
    try {
      // Experimental in SDK 0.3.x; isolated here so a rename only touches this line.
      return toPlanUsage(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
    } finally {
      input.end();
      q.close();
    }
  }

  async probe(opts: Pick<StartOptions, "cwd" | "env" | "claudePath">): Promise<SDKControlInitializeResponse> {
    const input = new AsyncQueue<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        cwd: opts.cwd,
        env: opts.env,
        pathToClaudeCodeExecutable: opts.claudePath,
        settingSources: ["user"],
        persistSession: false,
      },
    });
    try {
      return await q.initializationResult();
    } finally {
      input.end();
      q.close();
    }
  }
}
