import type { SessionEventBody } from "@forge/protocol";

const MAX_TOOL_RESULT = 20_000;

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
        return [this.result(m)];
      case "rate_limit_event": {
        const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
        return [
          {
            type: "rate_limit",
            status: str(info.status) ?? "unknown",
            resetsAt: num(info.resetsAt),
            limitType: str(info.rateLimitType),
          },
        ];
      }
      default:
        return [];
    }
  }

  private system(m: Record<string, unknown>): SessionEventBody[] {
    // Only backgrounded tasks: foreground tool calls report task_started/task_notification too.
    if (m.subtype === "task_started" && m.is_backgrounded === true) {
      const taskId = str(m.task_id) ?? "";
      const description = str(m.description) ?? "Hintergrundaufgabe";
      this.backgroundTasks.set(taskId, description);
      return [{ type: "background.task", taskId, description, state: "started", summary: null }];
    }
    if (m.subtype === "task_notification") {
      const taskId = str(m.task_id) ?? "";
      const description = this.backgroundTasks.get(taskId);
      if (description === undefined) return [];
      this.backgroundTasks.delete(taskId);
      const status = str(m.status);
      const state = status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped";
      return [{ type: "background.task", taskId, description, state, summary: str(m.summary) }];
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
      if (block.type === "text" && typeof block.text === "string" && !parent) {
        const n = this.finalTextCount.get(id) ?? 0;
        this.finalTextCount.set(id, n + 1);
        const index = this.streamedTextIdx.get(id)?.[n] ?? n;
        out.push({ type: "assistant.text", messageId: id, index, text: block.text });
      } else if (block.type === "tool_use") {
        out.push({
          type: "tool.use",
          toolUseId: str(block.id) ?? "",
          name: str(block.name) ?? "unknown",
          input: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>,
          parentToolUseId: parent,
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
      text: str(m.result) ?? (errors || null),
    };
  }
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

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
