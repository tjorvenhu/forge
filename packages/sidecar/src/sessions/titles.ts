import type { ClaudeRuntime } from "../claude/runtime.js";
import type { ClaudeAssist } from "./claude-assist.js";
import { titleFrom } from "./live-session.js";
import type { RemoteBridge } from "./remote-bridge.js";
import type { SessionCore } from "./session-core.js";

/** Several messages in a row (a correction right after sending) lead to one refresh. */
export const TITLE_DEBOUNCE_MS = 2_000;
/** Each refresh costs a model call; a busy conversation gets a new title at most once a minute. */
export const TITLE_MIN_INTERVAL_MS = 60_000;
/** Same bound as the one-shot CLI calls; a CLI that never answers must not block later refreshes. */
export const TITLE_TIMEOUT_MS = 45_000;

const PROMPTS = 3;
const PROMPT_CHARS = 300;
const MIN_PROMPT_CHARS = 12;
const TITLE_MAX = 80;

export type TitleMessageSource = "forge" | "remote" | "auto";

/** Words of replies that say nothing about the work ("ok", "ja, mach weiter", "danke, passt so"). */
const FILLER = new Set(
  "ok okay oki jo ja jap jep yes yep nein ne no nö weiter weitermachen mach machen mal fortfahren continue go los danke dank dir vielen schön sehr thanks thank you thx passt gut super top perfekt genau stimmt richtig bitte das so sieht aus klingt prima alles klar sure fine".split(" "),
);

/** Only messages that say what the work is about change the title: no automatic, slash or filler messages. */
export function isTitleWorthy(text: string, source?: TitleMessageSource): boolean {
  if (source === "auto") return false;
  const t = text.trim();
  if (t.length < MIN_PROMPT_CHARS || t.startsWith("/")) return false;
  const words = t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return !words.every((w) => FILLER.has(w));
}

export function buildTitlePrompt(prompts: string[]): string {
  const short = prompts.map((p) => {
    const one = p.replace(/\s+/g, " ").trim();
    return one.length > PROMPT_CHARS ? `${one.slice(0, PROMPT_CHARS - 1)}…` : one;
  });
  return [
    "Schreibe einen kurzen deutschen Titel für diese Claude-Code-Session, höchstens 6 Wörter.",
    "Er beschreibt, woran gerade gearbeitet wird. Die neueste Anfrage zählt am meisten.",
    "Antworte nur mit dem Titel, ohne Anführungszeichen und ohne Punkt am Ende.",
    "",
    ...short.map((p, i) => `${i === 0 ? "Neueste Anfrage" : "Davor"}: ${p}`),
  ].join("\n");
}

const QUOTES = `"'\`„“”‚‘’«»*`;
const LEADING = new RegExp(`^[\\s#${QUOTES}]+`);
const TRAILING = new RegExp(`[\\s${QUOTES}]+$`);

/** One line, no quotes, labels or closing punctuation, at most 80 characters. */
export function cleanTitle(raw: string): string {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const t = line
    .replace(/^(titel|title)\s*:\s*/i, "")
    .replace(LEADING, "")
    .replace(TRAILING, "")
    .replace(/[\s.,;:!?…]+$/u, "")
    .replace(TRAILING, "")
    .replace(/\s+/g, " ");
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

interface TitleState {
  timer: ReturnType<typeof setTimeout> | null;
  lastRun: number;
  running: boolean;
  /** a message arrived during a refresh; another one follows */
  again: boolean;
}

/**
 * Keeps the session title in step with the newest prompts: in FORGE (tabs, sessions list), in Claude
 * Code and, with Remote Control on, in the Claude app. A title is cosmetic, so every failure here is
 * swallowed and never reaches the session.
 */
export class TitleRefresh {
  private readonly states = new Map<string, TitleState>();
  private stopped = false;

  constructor(
    private readonly core: SessionCore,
    private readonly runtime: ClaudeRuntime,
    private readonly assist: ClaudeAssist,
    private readonly remote: RemoteBridge,
    private readonly now: () => number = Date.now,
  ) {}

  /** A user message reached the timeline. */
  note(sessionId: string, text: string, source?: TitleMessageSource) {
    if (this.stopped || !isTitleWorthy(text, source)) return;
    let s = this.states.get(sessionId);
    if (!s) this.states.set(sessionId, (s = { timer: null, lastRun: Number.NEGATIVE_INFINITY, running: false, again: false }));
    if (s.running) s.again = true;
    else this.schedule(sessionId, s);
  }

  forget(sessionId: string) {
    const s = this.states.get(sessionId);
    if (s?.timer) clearTimeout(s.timer);
    this.states.delete(sessionId);
  }

  shutdown() {
    this.stopped = true;
    for (const id of [...this.states.keys()]) this.forget(id);
  }

  private schedule(id: string, s: TitleState) {
    if (s.timer) clearTimeout(s.timer);
    const wait = Math.max(TITLE_DEBOUNCE_MS, s.lastRun + TITLE_MIN_INTERVAL_MS - this.now());
    s.timer = setTimeout(() => void this.run(id, s), wait);
  }

  private async run(id: string, s: TitleState) {
    s.timer = null;
    if (this.stopped || this.states.get(id) !== s) return;
    s.running = true;
    s.again = false;
    s.lastRun = this.now();
    try {
      await this.refresh(id);
    } catch {
      /* the old title stays */
    } finally {
      s.running = false;
      if (s.again && !this.stopped && this.states.get(id) === s) this.schedule(id, s);
    }
  }

  private recentPrompts(id: string): string[] {
    return this.core.db
      .listRecentUserMessages(id, 20)
      .filter((m) => isTitleWorthy(m.text, m.source))
      .slice(0, PROMPTS)
      .map((m) => m.text);
  }

  private async refresh(id: string) {
    const prompts = this.recentPrompts(id);
    if (!prompts.length) return;
    const title = await this.generate(id, prompts);
    if (this.stopped) return;
    const { db } = this.core;
    const rec = db.getSession(id);
    if (!rec || !title || title === rec.title) return;
    this.core.publish(db.updateSession(id, { title }));
    // The Claude app lists the session under the name it was connected with, so it keeps the FORGE prefix.
    const remoteName = this.remote.retitle(id);
    const live = this.core.live.get(id);
    if (live) {
      if (!live.closing) await live.rt.rename(remoteName ?? title, rec.claudeSessionId).catch(() => {});
    } else if (rec.claudeSessionId) {
      await this.runtime.renameTranscript(rec.claudeSessionId, title, rec.cwd).catch(() => {});
    }
  }

  /** Claude Code's own title generator, then a one-shot call with a small model, then the prompt itself. */
  private async generate(id: string, prompts: string[]): Promise<string> {
    const description = buildTitlePrompt(prompts);
    const live = this.core.live.get(id);
    if (live && !live.closing) {
      const t = cleanTitle((await withTimeout(live.rt.generateTitle(description))) ?? "");
      if (t) return t;
    }
    const t = cleanTitle((await withTimeout(this.assist.sessionTitle(id, description))) ?? "");
    return t || titleFrom(prompts[0]!);
  }
}

/** null on error or timeout; the late result is dropped. */
async function withTimeout(p: Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), TITLE_TIMEOUT_MS)));
  try {
    return await Promise.race([p.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
