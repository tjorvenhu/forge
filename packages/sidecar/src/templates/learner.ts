import { normalizeForMatch, templateScore, TEMPLATE_NAME_MAX, TEMPLATE_TEXT_MAX, type PromptTemplate } from "@forge/protocol";
import { z } from "zod";
import type { Db } from "../persistence/db.js";
import { redactText } from "../policy/redact.js";
import { AUTO_CONTINUE_PROMPT } from "../sessions/auto-continue.js";
import { UPDATE_CONTINUE_PROMPT } from "../sessions/update-resume.js";
import type { TemplateService } from "./templates.js";

/** New messages after which FORGE looks again; a look costs one short Haiku call. */
export const LEARN_AFTER_MESSAGES = 30;
/** At most one look in this time, however much is written. */
export const LEARN_MIN_GAP_MS = 6 * 60 * 60_000;
/** The first look after the start waits, so it does not slow the start down. */
export const LEARN_START_DELAY_MS = 3 * 60_000;
/** Messages Claude looks through: enough to see what keeps coming back. */
export const LEARN_HISTORY = 400;
/** Below this the history says nothing about habits yet. */
export const LEARN_MIN_HISTORY = 20;
/** Times a request must have come up to become a template. */
export const MIN_REPEATS = 3;
/** New templates per look and learned templates in all, so the list does not fill up on its own. */
export const MAX_NEW_PER_RUN = 3;
export const MAX_LEARNED = 30;
/** A message longer than this is pasted material (logs, code), not a habit. */
const MAX_MESSAGE_CHARS = 1500;
/** Each message goes in shortened; its start says what was asked for. */
const MESSAGE_EXCERPT = 300;
/** A learned template this close to an existing one would only repeat it. */
const DUPLICATE_SCORE = 0.85;

const Candidate = z.object({ name: z.string(), text: z.string(), project: z.string().nullable(), count: z.number() });
const Answer = z.object({ templates: z.array(Candidate) });

export const LEARN_SCHEMA = {
  type: "object",
  properties: {
    templates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "2 bis 4 Wörter zum Wiederfinden" },
          text: { type: "string", description: "der Auftrag an Claude, sauber formuliert, Platzhalter wie {datei}" },
          project: { type: ["string", "null"], description: "Projektname, wenn alle Vorkommen aus einem Projekt stammen, sonst null" },
          count: { type: "integer", description: "wie oft der Auftrag ungefähr vorkam" },
        },
        required: ["name", "text", "project", "count"],
        additionalProperties: false,
      },
    },
  },
  required: ["templates"],
  additionalProperties: false,
};

export interface LearnerMessage {
  text: string;
  project: string;
}

/** What Claude reads: the user's messages, the templates there are, and those the user threw away. */
export function buildLearnPrompt(messages: LearnerMessage[], existing: Array<Pick<PromptTemplate, "name" | "text">>, dismissed: string[]): string {
  return [
    "Unten stehen Nachrichten, die ein Nutzer an Claude Code geschickt hat, neueste zuerst, jeweils mit dem Projekt in eckigen Klammern.",
    `Finde Aufträge, die er immer wieder schickt (mindestens ${MIN_REPEATS} Mal, gleich oder sinngemäß, auch mit Tippfehlern), und mach daraus höchstens 5 wiederverwendbare Prompt-Vorlagen.`,
    "Regeln:",
    "- Nur echte Wiederholungen. Keine Einzelfälle und keine bloßen Antworten wie „ja“, „danke“, „weiter“.",
    "- Ein Befehl aus ein, zwei Wörtern (etwa „push“) lohnt nur, wenn die Vorlage deutlich mehr sagt: dann den vollständigen Auftrag ausformulieren, so wie der Nutzer ihn meint.",
    "- text: Anweisung an Claude in der Sprache des Nutzers, ohne Tippfehler, knapp. Was sich von Mal zu Mal ändert, wird ein Platzhalter in geschweiften Klammern ohne Leerzeichen, etwa {datei}, {projekt}, {branch}, {thema}.",
    "- name: 2 bis 4 Wörter.",
    "- project: der Projektname aus den Klammern, wenn alle Vorkommen aus einem Projekt stammen, sonst null.",
    "- Nichts, was eine vorhandene Vorlage schon abdeckt, und nichts, was einer abgelehnten ähnelt.",
    "- Keine Passwörter, Schlüssel, Telefonnummern oder anderen persönlichen Daten.",
    "- Gibt es keine Wiederholungen, liefere eine leere Liste.",
    "",
    "Vorhandene Vorlagen:",
    existing.length ? existing.map((t) => `- ${t.name}: ${t.text.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") : "(keine)",
    "",
    "Abgelehnte Vorlagen:",
    dismissed.length ? dismissed.slice(-50).map((d) => `- ${d.slice(0, 200)}`).join("\n") : "(keine)",
    "",
    "Nachrichten:",
    ...messages.map((m) => `[${m.project}] ${m.text.replace(/\s+/g, " ").slice(0, MESSAGE_EXCERPT)}`),
  ].join("\n");
}

export interface LearnResult {
  added: PromptTemplate[];
  message: string;
}

export interface TemplateLearnerDeps {
  db: Db;
  templates: TemplateService;
  /** all projects (worktrees with parentId): names for the prompt, and back from the name Claude gives */
  projects(): Array<{ id: string; name: string; parentId: string | null }>;
  /** one short Claude call with a JSON answer */
  ask(prompt: string, schema: Record<string, unknown>): Promise<unknown>;
  /** FORGE learned these on its own; a look somebody asked for answers itself */
  learned(names: string[]): void;
  log(message: string): void;
  now?: () => number;
}

/**
 * Builds prompt templates from what the user keeps asking for. After LEARN_AFTER_MESSAGES own messages
 * (at most every LEARN_MIN_GAP_MS) a short Claude call looks through the recent ones; repeated requests
 * become templates marked as learned. Deleted learned templates are remembered and not made again.
 */
export class TemplateLearner {
  /** own messages since the last look; null until read from the database */
  private pending: number | null = null;
  private running: Promise<LearnResult> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** looks on its own only in the app (after start), not in tests and the CLI */
  private auto = false;

  constructor(private readonly d: TemplateLearnerDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** First look after the start: catches up on messages from before. */
  start() {
    this.stop();
    this.auto = true;
    this.timer = setTimeout(() => this.maybeRun(), LEARN_START_DELAY_MS);
    this.timer.unref?.();
  }

  stop() {
    this.auto = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A message reached a session; automatic ones (limit reset, update) are no habit of the user. */
  noteMessage(source?: string) {
    if (source === "auto") return;
    if (this.pending !== null) this.pending++;
    this.maybeRun();
  }

  /** Looks again when enough was written since the last look and that look is long enough ago. */
  maybeRun() {
    if (!this.auto || this.running || !this.d.db.getSettings().learnTemplates) return;
    const state = this.d.db.getTemplateLearning();
    this.pending ??= this.d.db.countUserMessagesSince(state.lastRunAt);
    const first = state.lastRunAt === null;
    if (this.pending < (first ? LEARN_MIN_HISTORY : LEARN_AFTER_MESSAGES)) return;
    if (!first && this.now() - Date.parse(state.lastRunAt!) < LEARN_MIN_GAP_MS) return;
    void this.run(false).catch((e: unknown) => this.d.log(`Vorlagen lernen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Looks now, asked for in the settings, the palette or on the phone; also when learning is switched off. */
  learn(): Promise<LearnResult> {
    return this.run(true);
  }

  private run(asked: boolean): Promise<LearnResult> {
    this.running ??= this.look(asked).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async look(asked: boolean): Promise<LearnResult> {
    const projects = this.d.projects();
    const byId = new Map(projects.map((p) => [p.id, p]));
    const rootName = (id: string) => {
      const p = byId.get(id);
      return (p?.parentId ? byId.get(p.parentId)?.name : p?.name) ?? "?";
    };
    const messages: LearnerMessage[] = this.d.db
      .recentUserMessages(LEARN_HISTORY * 2)
      .filter((m) => !m.body.source && !m.body.task && m.body.text.trim() && m.body.text.length <= MAX_MESSAGE_CHARS)
      .filter((m) => m.body.text !== UPDATE_CONTINUE_PROMPT && m.body.text !== AUTO_CONTINUE_PROMPT)
      .slice(0, LEARN_HISTORY)
      .map((m) => ({ text: redactText(m.body.text.trim()), project: rootName(m.projectId) }));
    if (messages.length < LEARN_MIN_HISTORY) {
      // No look is recorded: it comes once there is enough.
      this.pending = messages.length;
      return { added: [], message: `Noch zu wenige Nachrichten zum Lernen (${messages.length} von ${LEARN_MIN_HISTORY}).` };
    }
    const done = (message: string, added: PromptTemplate[] = []): LearnResult => {
      this.d.db.setTemplateLearning({ ...this.d.db.getTemplateLearning(), lastRunAt: new Date(this.now()).toISOString() });
      this.pending = 0;
      return { added, message };
    };
    const existing = this.d.templates.list(undefined, true);
    const learnedBefore = existing.filter((t) => t.learned).length;
    if (learnedBefore >= MAX_LEARNED) return done(`Es gibt schon ${MAX_LEARNED} gelernte Vorlagen. Lösch nicht gebrauchte, dann lernt FORGE weitere.`);

    const { dismissed } = this.d.db.getTemplateLearning();
    const answer = Answer.safeParse(await this.d.ask(buildLearnPrompt(messages, existing, dismissed), LEARN_SCHEMA));
    if (!answer.success) throw new Error("Claude hat keine lesbare Antwort geliefert.");

    const thrownAway = new Set(dismissed);
    const taken: PromptTemplate[] = [...existing];
    const added: PromptTemplate[] = [];
    for (const c of answer.data.templates) {
      if (added.length >= MAX_NEW_PER_RUN || learnedBefore + added.length >= MAX_LEARNED) break;
      const name = c.name.trim().slice(0, TEMPLATE_NAME_MAX);
      const text = c.text.trim();
      if (c.count < MIN_REPEATS || name.length < 2 || text.length < 8 || text.length > TEMPLATE_TEXT_MAX) continue;
      const key = normalizeForMatch(text);
      const nameKey = normalizeForMatch(name);
      if (thrownAway.has(key)) continue;
      if (taken.some((t) => normalizeForMatch(t.text) === key || normalizeForMatch(t.name) === nameKey || templateScore(text, t) >= DUPLICATE_SCORE)) continue;
      const project = c.project ? projects.find((p) => !p.parentId && p.name.toLowerCase() === c.project!.trim().toLowerCase()) : undefined;
      const t = this.d.templates.save({ id: null, projectId: project?.id ?? null, name, description: `Gelernt aus etwa ${Math.round(c.count)} ähnlichen Nachrichten`, text, learned: true });
      taken.push(t);
      added.push(t);
    }
    if (added.length && !asked) this.d.learned(added.map((t) => t.name));
    return done(
      added.length ? `${added.length === 1 ? "Neue Vorlage" : `${added.length} neue Vorlagen`} gelernt: ${added.map((t) => t.name).join(", ")}.` : "Keine neuen wiederkehrenden Aufträge gefunden.",
      added,
    );
  }
}
