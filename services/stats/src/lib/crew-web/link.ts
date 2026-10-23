import type { Sealed } from "./crypto";
import type { Envelope } from "./wire";

/**
 * Connection to a room on the relay, as in FORGE's sidecar (packages/sidecar/src/crew/link.ts): server-sent
 * events read through fetch (EventSource cannot resume after a seq of our choosing), plain POSTs to write,
 * an outbox while the relay cannot be reached.
 */

export type LinkState = "connecting" | "online" | "offline";

export interface LinkOptions {
  url: string;
  room: string;
  after: () => number;
  onEnvelope(e: Envelope): void;
  onGap(): void;
  onReady(): void;
  onState(state: LinkState, error: string | null): void;
  fetch?: typeof fetch;
}

const SILENCE_MS = 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const POST_TIMEOUT_MS = 20_000;
const OUTBOX_MAX = 300;

export class RelayLink {
  private abort: AbortController | null = null;
  private stopped = true;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private silence: ReturnType<typeof setTimeout> | null = null;
  private readonly outbox: Array<{ from: string; kid: string; box: Sealed }> = [];
  private flushing = false;
  private flushRetry: ReturnType<typeof setTimeout> | null = null;
  private readonly fetch: typeof fetch;

  constructor(private readonly o: LinkOptions) {
    this.fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private base(): string {
    return `${this.o.url.replace(/\/+$/, "")}/v1/rooms/${encodeURIComponent(this.o.room)}`;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.silence) clearTimeout(this.silence);
    if (this.flushRetry) clearTimeout(this.flushRetry);
    this.retry = this.silence = this.flushRetry = null;
    this.abort?.abort();
    this.abort = null;
  }

  /** A phone woke up or came back online: connect now instead of waiting for the backoff. */
  nudge() {
    if (this.stopped || !this.retry) return;
    clearTimeout(this.retry);
    this.retry = null;
    this.attempt = 0;
    void this.connect();
  }

  post(from: string, kid: string, box: Sealed) {
    this.outbox.push({ from, kid, box });
    if (this.outbox.length > OUTBOX_MAX) this.outbox.splice(0, this.outbox.length - OUTBOX_MAX);
    void this.flush();
  }

  pending(): number {
    return this.outbox.length;
  }

  private async flush() {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      while (this.outbox.length && !this.stopped) {
        const next = this.outbox[0]!;
        const res = await this.fetch(this.base(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: next.from, kid: next.kid, ...next.box }),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        if (!res.ok && res.status !== 400 && res.status !== 413) throw new Error(`HTTP ${res.status}`);
        await res.body?.cancel().catch(() => {});
        this.outbox.shift();
      }
    } catch {
      if (!this.stopped && !this.flushRetry) {
        this.flushRetry = setTimeout(() => {
          this.flushRetry = null;
          void this.flush();
        }, 3_000);
      }
    } finally {
      this.flushing = false;
    }
  }

  private schedule(error: string | null) {
    if (this.stopped) return;
    this.o.onState("offline", error);
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, wait);
  }

  private feel() {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => this.abort?.abort(), SILENCE_MS);
  }

  private async connect() {
    if (this.stopped) return;
    this.o.onState("connecting", null);
    const abort = (this.abort = new AbortController());
    let error: string | null = null;
    try {
      const res = await this.fetch(`${this.base()}/stream?after=${this.o.after()}`, { headers: { accept: "text/event-stream" }, signal: abort.signal, cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.feel();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.feel();
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          this.event(block);
        }
      }
    } catch (e) {
      if (!abort.signal.aborted || !this.stopped) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.silence) clearTimeout(this.silence);
      this.silence = null;
    }
    if (this.abort === abort) this.abort = null;
    this.schedule(error);
  }

  private event(block: string) {
    let name = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }
    if (name === "gap") return this.o.onGap();
    if (name === "ready") {
      this.attempt = 0;
      this.o.onState("online", null);
      this.o.onReady();
      void this.flush();
      return;
    }
    if (name !== "message" || !data.length) return;
    try {
      const e = JSON.parse(data.join("\n")) as Envelope;
      if (typeof e.seq === "number" && typeof e.from === "string" && typeof e.kid === "string") this.o.onEnvelope(e);
    } catch {
      // A broken line is skipped; the next state exchange fills what it carried.
    }
  }
}
