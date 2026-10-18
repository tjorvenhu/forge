import { createSdkMcpServer, query, tool, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../claude/async-queue.js";
import { meterKey, tokenMeter } from "../claude/token-meter.js";
import { PHONE_TOOLS, phoneSystemPrompt, zodShape, type PhoneToolset } from "./tools.js";
import { tr } from "../i18n/index.js";

export { asData, type PhoneToolset, type SessionSettingsPatch } from "./tools.js";

export interface PhoneAgentOptions {
  claudePath: string;
  env: Record<string, string>;
  cwd: string;
  model: string;
  tools: PhoneToolset;
  /** why the call happens, e.g. which session finished (outgoing calls) */
  context: string;
  onSentence(text: string): void;
  onTurnDone(): void;
  onHangup(): void;
  onError(message: string): void;
}

/**
 * The conversation partner on the phone: Claude (small model via the user's Claude Code login)
 * with FORGE tools only, no file or shell access. Text is streamed out sentence by sentence so
 * speech output can start before the answer is complete.
 */
export class PhoneAgent {
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly q: Query;
  private buffer = "";
  private closed = false;

  constructor(private readonly o: PhoneAgentOptions) {
    const ctx = { hangup: () => o.onHangup() };
    const server = createSdkMcpServer({
      name: "forge",
      version: "1.0.0",
      tools: PHONE_TOOLS.map((spec) =>
        tool(spec.name, spec.description, zodShape(spec.params), async (a: Record<string, unknown>) => ({
          content: [{ type: "text" as const, text: await spec.run(o.tools, a, ctx) }],
        })),
      ),
    });

    this.q = query({
      prompt: this.input,
      options: {
        cwd: o.cwd,
        env: o.env,
        model: o.model,
        pathToClaudeCodeExecutable: o.claudePath,
        systemPrompt: `${phoneSystemPrompt("text")}\n\n${o.context}`,
        tools: [],
        mcpServers: { forge: server },
        allowedTools: PHONE_TOOLS.map((t) => `mcp__forge__${t.name}`),
        canUseTool: async (name, input) => (name.startsWith("mcp__forge__") ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: tr().phone.common.notAvailable }),
        includePartialMessages: true,
        settingSources: [],
        persistSession: false,
      },
    });
    void this.pump();
  }

  /** Something the caller said (or a note from FORGE in brackets). */
  say(text: string) {
    if (this.closed) return;
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);
  }

  /** The caller talked over the reply: stop writing it. The turn still ends with a result. */
  interrupt() {
    if (this.closed) return;
    this.buffer = "";
    // A failed interrupt only means the reply runs to its end; the controller drops it and moves on.
    this.q.interrupt().catch(() => {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    this.q.close();
  }

  private async pump() {
    const meter = meterKey("phone");
    try {
      for await (const m of this.q) {
        tokenMeter.observe(meter, m);
        const msg = m as Record<string, unknown>;
        if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
          const ev = (msg.event ?? {}) as Record<string, unknown>;
          const delta = (ev.delta ?? {}) as Record<string, unknown>;
          if (ev.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") this.addText(delta.text);
          else if (ev.type === "content_block_stop" || ev.type === "message_stop") this.flush();
        } else if (msg.type === "result") {
          this.flush();
          this.o.onTurnDone();
        }
      }
    } catch (e) {
      if (!this.closed) this.o.onError(e instanceof Error ? e.message : String(e));
    } finally {
      tokenMeter.forget(meter);
    }
  }

  private addText(t: string) {
    this.buffer += t;
    for (;;) {
      const m = /^([\s\S]*?[.!?…:])(\s+)/.exec(this.buffer) ?? /^([\s\S]*?)\n+/.exec(this.buffer);
      if (!m) break;
      this.emitSentence(m[1]!);
      this.buffer = this.buffer.slice(m[0].length);
    }
  }

  private flush() {
    if (this.buffer.trim()) this.emitSentence(this.buffer);
    this.buffer = "";
  }

  private emitSentence(raw: string) {
    const s = speakable(raw);
    if (s) this.o.onSentence(s);
  }
}

/** Removes what should not be read aloud (markdown, code ticks, links). */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^[\s>*#-]+/gm, "")
    .replace(/[*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
