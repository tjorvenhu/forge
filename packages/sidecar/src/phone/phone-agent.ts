import { createSdkMcpServer, query, tool, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { AsyncQueue } from "../claude/async-queue.js";

/** What Claude may do on the phone. Implemented by the phone service, which also checks the PIN. */
export interface PhoneToolset {
  status(): Promise<string>;
  details(session: string): Promise<string>;
  sendMessage(session: string, text: string): Promise<string>;
  startSession(project: string, prompt: string): Promise<string>;
  respond(session: string, decision: "allow" | "deny", answers?: Record<string, string>, feedback?: string): Promise<string>;
  stop(session: string): Promise<string>;
  devServer(project: string, action: "start" | "stop"): Promise<string>;
}

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

const SYSTEM_PROMPT = `Du bist FORGE, ein Assistent am Telefon für Softwareprojekte, die mit Claude Code bearbeitet werden.
Du sprichst mit dem Besitzer von FORGE. Alles, was du schreibst, wird vorgelesen.

So sprichst du:
- Deutsch, kurz, natürlich, wie am Telefon. Höchstens drei Sätze am Stück, dann darf der Anrufer reagieren.
- Kein Markdown, keine Listen, keine Codeblöcke, keine Emojis, keine URLs, keine langen IDs oder Dateipfade.
- Nenne Sessions mit ihrem Kürzel (S1, S2) und Titel, Projekte mit Namen.
- Bevor du ein Werkzeug benutzt, das länger dauert, sag kurz "Moment."
- Wenn du etwas nicht verstanden hast, frag nach. Erfinde nichts, prüfe den Stand mit den Werkzeugen.

Was du kannst:
- status: Überblick über laufende und kürzlich beendete Sessions, offene Freigaben und Rückfragen.
- details: letztes Ergebnis einer Session, offene Rückfrage oder Plan im Wortlaut.
- send_message, start_session, respond, stop_session, dev_server: steuern. Diese Werkzeuge können gesperrt sein,
  bis der Anrufer die PIN über die Telefontastatur eingibt und mit Raute bestätigt. Sag ihm das dann genau so.
  Frag nie nach der PIN im Gespräch und wiederhole keine Ziffern.
- Vor dem Ausführen von send_message, start_session oder respond mit allow: fasse kurz zusammen, was du tust,
  und hole ein Ja ein, außer der Anrufer hat es schon eindeutig gesagt.
- hang_up: wenn der Anrufer sich verabschiedet oder nichts mehr braucht. Verabschiede dich vorher in einem Satz.`;

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
    const t = o.tools;
    const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
    const server = createSdkMcpServer({
      name: "forge",
      version: "1.0.0",
      tools: [
        tool("status", "Überblick: laufende und kürzlich beendete Sessions mit Kürzel, Status, offene Freigaben und Rückfragen.", {}, async () => text(await t.status())),
        tool(
          "details",
          "Letztes Ergebnis einer Session und offene Rückfrage oder Plan im Wortlaut.",
          { session: z.string().describe("Kürzel wie S1 oder ein Teil des Titels") },
          async (a) => text(await t.details(a.session)),
        ),
        tool(
          "send_message",
          "Schickt einer Session eine Anweisung (Claude arbeitet dann weiter). Steuernd.",
          { session: z.string(), text: z.string().describe("Anweisung an Claude Code, ausformuliert") },
          async (a) => text(await t.sendMessage(a.session, a.text)),
        ),
        tool(
          "start_session",
          "Startet eine neue Claude-Code-Session in einem Projekt. Steuernd.",
          { project: z.string().describe("Projektname oder Teil davon"), prompt: z.string().describe("Auftrag, ausformuliert") },
          async (a) => text(await t.startSession(a.project, a.prompt)),
        ),
        tool(
          "respond",
          "Beantwortet die offene Freigabe, Rückfrage oder den Plan einer Session. allow = erlauben, Plan annehmen oder Rückfrage beantworten (answers: Frage -> Antwort). deny = ablehnen oder Plan mit feedback zurückgeben. Steuernd.",
          {
            session: z.string(),
            decision: z.enum(["allow", "deny"]),
            answers: z.record(z.string(), z.string()).optional().describe("nur für Rückfragen: Fragetext -> gewählte Antwort"),
            feedback: z.string().optional().describe("bei deny: Begründung oder Änderungswunsch"),
          },
          async (a) => text(await t.respond(a.session, a.decision, a.answers, a.feedback)),
        ),
        tool("stop_session", "Stoppt den laufenden Durchlauf einer Session. Steuernd.", { session: z.string() }, async (a) => text(await t.stop(a.session))),
        tool(
          "dev_server",
          "Startet oder stoppt den Dev-Server eines Projekts. Steuernd.",
          { project: z.string(), action: z.enum(["start", "stop"]) },
          async (a) => text(await t.devServer(a.project, a.action)),
        ),
        tool("hang_up", "Beendet das Telefonat, nachdem deine letzte Antwort vorgelesen wurde.", {}, async () => {
          o.onHangup();
          return text("Das Gespräch wird beendet.");
        }),
      ],
    });

    this.q = query({
      prompt: this.input,
      options: {
        cwd: o.cwd,
        env: o.env,
        model: o.model,
        pathToClaudeCodeExecutable: o.claudePath,
        systemPrompt: `${SYSTEM_PROMPT}\n\n${o.context}`,
        tools: [],
        mcpServers: { forge: server },
        allowedTools: ["mcp__forge__status", "mcp__forge__details", "mcp__forge__send_message", "mcp__forge__start_session", "mcp__forge__respond", "mcp__forge__stop_session", "mcp__forge__dev_server", "mcp__forge__hang_up"],
        canUseTool: async (name, input) => (name.startsWith("mcp__forge__") ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Nicht verfügbar" }),
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

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    this.q.close();
  }

  private async pump() {
    try {
      for await (const m of this.q) {
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
