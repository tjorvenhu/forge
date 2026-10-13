/** Tokens per second over this window; short enough to follow a burst, long enough not to flicker. */
export const RATE_WINDOW_MS = 4_000;
const TICK_MS = 1_000;
/** rough size of a token in characters, for the live estimate while a message streams */
const CHARS_PER_TOKEN = 4;

type Msg = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Output tokens per second of every Claude process of FORGE: sessions, their subagents (also in
 * the background), parallel agents, the phone and one-shot calls (titles, commit messages …).
 * While a message streams, its deltas are estimated by length; its final usage corrects the
 * estimate, so the total is exact and the rate still moves live.
 */
export class TokenMeter {
  private samples: Array<{ at: number; n: number }> = [];
  /** estimate so far per streaming message (query key + subagent) */
  private readonly streaming = new Map<string, number>();
  /** streams that deliver partial messages: their assistant messages are counted already */
  private readonly partial = new Set<string>();
  /** tokens counted per message id, for processes without partial messages */
  private readonly counted = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private listener: ((perSecond: number) => void) | null = null;

  /** Called about every second with the rounded rate while it changes, last with 0. */
  onRate(listener: (perSecond: number) => void) {
    this.listener = listener;
  }

  /** `key` tells parallel processes apart; one key per SDK query. */
  observe(key: string, msg: unknown, now = Date.now()) {
    const m = msg as Msg;
    const stream = `${key}:${typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : ""}`;
    if (m.type === "stream_event") {
      this.partial.add(stream);
      const ev = (m.event ?? {}) as Msg;
      if (ev.type === "message_start") this.streaming.set(stream, 0);
      else if (ev.type === "content_block_delta") {
        const d = (ev.delta ?? {}) as Msg;
        const text = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : d.type === "input_json_delta" ? d.partial_json : null;
        if (typeof text === "string" && text) {
          const est = text.length / CHARS_PER_TOKEN;
          this.streaming.set(stream, (this.streaming.get(stream) ?? 0) + est);
          this.add(est, now);
        }
      } else if (ev.type === "message_delta") {
        const real = num(((ev.usage ?? {}) as Msg).output_tokens);
        // Below the estimate, the difference goes back out of the window.
        this.add(real - (this.streaming.get(stream) ?? 0), now);
        this.streaming.delete(stream);
      }
      return;
    }
    if (m.type === "assistant" && !this.partial.has(stream)) {
      const message = (m.message ?? {}) as Msg;
      const id = typeof message.id === "string" ? `${key}:${message.id}` : null;
      const out = num(((message.usage ?? {}) as Msg).output_tokens);
      if (!id) return this.add(out, now);
      this.add(out - (this.counted.get(id) ?? 0), now);
      this.counted.set(id, Math.max(out, this.counted.get(id) ?? 0));
      return;
    }
    if (m.type === "result") {
      // A one-shot without assistant messages: its result tells the whole output.
      const seen = [...this.counted.keys()].some((k) => k.startsWith(`${key}:`)) || [...this.partial].some((k) => k.startsWith(`${key}:`));
      if (!seen) this.add(num(((m.usage ?? {}) as Msg).output_tokens), now);
      this.forget(key);
    }
  }

  /** The process of `key` ended: its bookkeeping goes, the counted tokens stay in the window. */
  forget(key: string) {
    const prefix = `${key}:`;
    for (const k of [...this.counted.keys()]) if (k.startsWith(prefix)) this.counted.delete(k);
    for (const k of [...this.partial]) if (k.startsWith(prefix)) this.partial.delete(k);
    for (const k of [...this.streaming.keys()]) if (k.startsWith(prefix)) this.streaming.delete(k);
  }

  rate(now = Date.now()): number {
    this.samples = this.samples.filter((s) => now - s.at < RATE_WINDOW_MS);
    const sum = this.samples.reduce((a, s) => a + s.n, 0);
    return Math.max(0, sum / (RATE_WINDOW_MS / 1000));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private add(n: number, now: number) {
    if (!n) return;
    this.samples.push({ at: now, n });
    if (!this.timer && this.listener) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref?.();
      this.tick();
    }
  }

  private tick() {
    const value = Math.round(this.rate());
    if (value !== this.last) {
      this.last = value;
      this.listener?.(value);
    }
    if (!value && !this.samples.length) this.stop();
  }
}

/** One meter for the whole sidecar: every Claude process reports into it. */
export const tokenMeter = new TokenMeter();

let nextKey = 0;
/** A key for one SDK query. */
export function meterKey(prefix: string): string {
  return `${prefix}#${++nextKey}`;
}
