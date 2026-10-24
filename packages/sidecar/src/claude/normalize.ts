import type { ModelTokens, SessionEventBody } from "@forge/protocol";
import { tr } from "../i18n/index.js";

const MAX_TOOL_RESULT = 20_000;
/** per string field of a tool input; a Write of a large file would otherwise land in the DB in full */
export const MAX_INPUT_STRING = 20_000;

/** Shortens long string fields (also nested, e.g. MultiEdit edits) of a tool input for storing. */
export function truncateInput(input: Record<string, unknown>, max = MAX_INPUT_STRING): { input: Record<string, unknown>; truncated: boolean } {
  let truncated = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= max) return v;
      truncated = true;
      return v.slice(0, max) + tr().core.claude.truncationMark;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(input) as Record<string, unknown>;
  return { input: truncated ? out : input, truncated };
}

/**
 * Converts raw Claude Code stream messages (SDK `SDKMessage` / CLI stream-json lines)
 * into FORGE session events. Deliberately typed loosely: the wire format grows with
 * every CLI release and unknown messages must be ignored, not crash the session.
 */
export class Normalizer {
  private currentMessageId: string | null = null;
  /** text block indices seen via stream events, per API message, in order */
  private streamedTextIdx = new Map<string, number[]>();
  private finalTextCount = new Map<string, number>();
  private thinkingSeen = new Set<string>();
  /** taskId -> description of tasks Claude moved to the background */
  private backgroundTasks = new Map<string, string>();
  /** subagent task id -> the Agent call that first started it */
  private agentCalls = new Map<string, string>();

  /**
   * The call a task belongs to. SendMessage resumes a finished subagent as a task with the same id,
   * started by the SendMessage call; its steps still name the first Agent call, so the task stays with it.
   */
  taskCall(m: Record<string, unknown>): { toolUseId: string | null; resumed: boolean } {
    const taskId = str(m.task_id);
    const toolUseId = str(m.tool_use_id);
    if (!taskId) return { toolUseId, resumed: false };
    const first = this.agentCalls.get(taskId);
    if (first) return { toolUseId: first, resumed: m.subtype === "task_started" && toolUseId !== first };
    if (m.subtype === "task_started" && toolUseId && (m.task_type === "local_agent" || typeof m.subagent_type === "string")) this.agentCalls.set(taskId, toolUseId);
    return { toolUseId, resumed: false };
  }

  normalize(raw: unknown): SessionEventBody[] {
    if (!raw || typeof raw !== "object") return [];
    const m = raw as Record<string, unknown>;
    switch (m.type) {
      case "system":
        return this.system(m);
      case "stream_event":
        return this.stream(m);
      case "assistant":
        return this.assistant(m);
      case "user":
        return this.user(m);
      case "result":
        this.endTurn();
        return [this.result(m)];
      case "rate_limit_event": {
        const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
        return [
          {
            type: "rate_limit",
            status: str(info.status) ?? "unknown",
            resetsAt: num(info.resetsAt),
            limitType: str(info.rateLimitType),
            utilization: limitUtilization(info),
            ...(info.isUsingOverage === true || info.overageInUse === true ? { overageInUse: true } : {}),
          },
        ];
      }
      default:
        return [];
    }
  }

  /** Per-message bookkeeping is only needed within a turn; a long session would otherwise grow it forever. */
  private endTurn() {
    this.currentMessageId = null;
    this.streamedTextIdx.clear();
    this.finalTextCount.clear();
    this.thinkingSeen.clear();
  }

  private system(m: Record<string, unknown>): SessionEventBody[] {
    // Only backgrounded tasks: foreground tool calls report task_started/task_notification too.
    if (m.subtype === "task_started") {
      const call = this.taskCall(m);
      // A subagent resumed by SendMessage runs on its own, like one in the background.
      if (m.is_backgrounded !== true && !call.resumed) return [];
      const taskId = str(m.task_id) ?? "";
      const description = str(m.description) ?? this.backgroundTasks.get(taskId) ?? "Hintergrundaufgabe";
      this.backgroundTasks.set(taskId, description);
      return [{ type: "background.task", taskId, description, state: "started", summary: null, toolUseId: call.toolUseId }];
    }
    if (m.subtype === "task_notification") {
      const taskId = str(m.task_id) ?? "";
      const usage = (m.usage ?? null) as Record<string, unknown> | null;
      const call = this.taskCall(m).toolUseId;
      // What a subagent used, foreground or background.
      const used: SessionEventBody[] =
        usage && call && typeof usage.total_tokens === "number"
          ? [{ type: "task.usage", toolUseId: call, tokens: usage.total_tokens, toolUses: num(usage.tool_uses) ?? 0, durationMs: num(usage.duration_ms) ?? 0 }]
          : [];
      const description = this.backgroundTasks.get(taskId);
      if (description === undefined) return used;
      this.backgroundTasks.delete(taskId);
      const status = str(m.status);
      const state = status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped";
      return [{ type: "background.task", taskId, description, state, summary: str(m.summary), toolUseId: call }, ...used];
    }
    if (m.subtype === "compact_boundary") {
      const meta = (m.compact_metadata ?? {}) as Record<string, unknown>;
      return [{ type: "context.compacted", trigger: meta.trigger === "auto" ? "auto" : "manual", preTokens: num(meta.pre_tokens), postTokens: num(meta.post_tokens) }];
    }
    if (m.subtype !== "init") return [];
    return [
      {
        type: "session.init",
        claudeSessionId: str(m.session_id) ?? "",
        model: str(m.model) ?? "",
        permissionMode: str(m.permissionMode) ?? "",
        cwd: str(m.cwd) ?? "",
        tools: Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === "string") : [],
        claudeCodeVersion: str(m.claude_code_version),
        apiKeySource: str(m.apiKeySource),
      },
    ];
  }

  private stream(m: Record<string, unknown>): SessionEventBody[] {
    if (m.parent_tool_use_id) return [];
    const ev = (m.event ?? {}) as Record<string, unknown>;
    const apiId = str(m.api_message_id);
    switch (ev.type) {
      case "message_start": {
        const msg = (ev.message ?? {}) as Record<string, unknown>;
        this.currentMessageId = str(msg.id) ?? apiId;
        return [];
      }
      case "content_block_start": {
        const id = apiId ?? this.currentMessageId;
        const block = (ev.content_block ?? {}) as Record<string, unknown>;
        if (!id) return [];
        if (block.type === "text") {
          const list = this.streamedTextIdx.get(id) ?? [];
          list.push(num(ev.index) ?? list.length);
          this.streamedTextIdx.set(id, list);
        }
        if (block.type === "thinking" && !this.thinkingSeen.has(id)) {
          this.thinkingSeen.add(id);
          return [{ type: "assistant.thinking", messageId: id }];
        }
        return [];
      }
      case "content_block_delta": {
        const id = apiId ?? this.currentMessageId;
        const delta = (ev.delta ?? {}) as Record<string, unknown>;
        if (!id || delta.type !== "text_delta" || typeof delta.text !== "string") return [];
        return [{ type: "assistant.delta", messageId: id, index: num(ev.index) ?? 0, text: delta.text }];
      }
      default:
        return [];
    }
  }

  private assistant(m: Record<string, unknown>): SessionEventBody[] {
    const msg = (m.message ?? {}) as Record<string, unknown>;
    const id = str(msg.id) ?? str(m.uuid) ?? "unknown";
    const parent = str(m.parent_tool_use_id);
    const out: SessionEventBody[] = [];
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const b of content) {
      const block = (b ?? {}) as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        const n = this.finalTextCount.get(id) ?? 0;
        this.finalTextCount.set(id, n + 1);
        const index = this.streamedTextIdx.get(id)?.[n] ?? n;
        // Subagent texts belong to the thread of their Agent call, not to the main chat.
        out.push({ type: "assistant.text", messageId: id, index, text: block.text, ...(parent ? { parentToolUseId: parent } : {}) });
      } else if (block.type === "tool_use") {
        const { input, truncated } = truncateInput((block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>);
        out.push({
          type: "tool.use",
          toolUseId: str(block.id) ?? "",
          name: str(block.name) ?? "unknown",
          input,
          parentToolUseId: parent,
          ...(truncated ? { inputTruncated: true } : {}),
        });
      }
    }
    return out;
  }

  private user(m: Record<string, unknown>): SessionEventBody[] {
    const msg = (m.message ?? {}) as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const out: SessionEventBody[] = [];
    for (const b of content) {
      const block = (b ?? {}) as Record<string, unknown>;
      if (block.type !== "tool_result") continue;
      const text = toolResultText(block.content);
      out.push({
        type: "tool.result",
        toolUseId: str(block.tool_use_id) ?? "",
        isError: block.is_error === true,
        content: { text: text.slice(0, MAX_TOOL_RESULT), truncated: text.length > MAX_TOOL_RESULT },
      });
    }
    return out;
  }

  private result(m: Record<string, unknown>): SessionEventBody {
    const usage = (m.usage ?? {}) as Record<string, unknown>;
    const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === "string").join("\n") : null;
    return {
      type: "turn.result",
      subtype: str(m.subtype) ?? "unknown",
      isError: m.is_error === true,
      durationMs: num(m.duration_ms),
      numTurns: num(m.num_turns),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      models: modelTokens(m.modelUsage),
      text: str(m.result) ?? (errors || null),
    };
  }
}

/** modelUsage of an SDK result as ModelTokens per model; undefined when missing or empty. */
export function modelTokens(raw: unknown): Record<string, ModelTokens> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, ModelTokens> = {};
  for (const [model, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!v || typeof v !== "object") continue;
    out[model] = {
      inputTokens: num(v.inputTokens) ?? 0,
      outputTokens: num(v.outputTokens) ?? 0,
      cacheReadTokens: num(v.cacheReadInputTokens) ?? 0,
      cacheWriteTokens: num(v.cacheCreationInputTokens) ?? 0,
      costUsd: num(v.costUSD) ?? 0,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = (c ?? {}) as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "image") return "[Bild]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Percent used of the reported limit. Recorded CLI output sends fractions (0.34) in unifiedWindows,
 * so values up to 1 are read as fractions.
 */
function limitUtilization(info: Record<string, unknown>): number | null {
  const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown } | undefined>;
  const type = str(info.rateLimitType);
  const raw = num(info.utilization) ?? (type ? num(windows[type]?.utilization) : null);
  if (raw === null) return null;
  return Math.max(0, Math.min(100, Math.round(raw <= 1 ? raw * 100 : raw)));
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
