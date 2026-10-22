/**
 * Relay for FORGE crews, part of this service under /crew. A room is a numbered list of sealed
 * messages: members post into it and follow it as a stream of server-sent events. The relay cannot
 * read anything (FORGE encrypts end to end with the crew's key); it keeps the newest messages of each
 * room for a while, so a member that was offline catches up. No database: a restart forgets the
 * rooms, the members then exchange their state again.
 *
 * Framework-free: the Next routes (src/app/crew) and the node:http adapter (crew-relay-node.ts, used
 * by FORGE's sidecar tests) both sit on this core.
 */

export interface RelayOptions {
  /** messages kept per room */
  maxMessages?: number;
  /** a message older than this is dropped */
  ttlMs?: number;
  maxRooms?: number;
  maxBodyBytes?: number;
  /** streams per room at the same time */
  maxStreams?: number;
  /** posts per client address and minute */
  postsPerMinute?: number;
  /** comment line that keeps idle streams open through proxies */
  heartbeatMs?: number;
  now?: () => number;
}

/** One reader of a room: gets ready-made SSE chunks. */
export interface Reader {
  write(chunk: string): void;
  close(): void;
}

interface Stored {
  seq: number;
  ts: number;
  /** the JSON line as sent to readers */
  line: string;
}

interface Room {
  seq: number;
  messages: Stored[];
  readers: Set<Reader>;
  touched: number;
}

export interface RelayReply {
  status: number;
  body: Record<string, unknown>;
}

const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SENDER = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_ID = /^[A-Za-z0-9_:.-]{1,64}$/;
const B64 = /^[A-Za-z0-9+/=_-]*$/;

export const isRoomId = (id: string) => ROOM_ID.test(id);

/** Headers of the event stream. no-transform: proxies must not compress (and so buffer) it. */
export const STREAM_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store, no-transform",
  "x-accel-buffering": "no",
  "access-control-allow-origin": "*",
};

export class RelayCore {
  readonly maxBodyBytes: number;
  private readonly maxMessages: number;
  private readonly ttlMs: number;
  private readonly maxRooms: number;
  private readonly maxStreams: number;
  private readonly postsPerMinute: number;
  private readonly now: () => number;
  private readonly rooms = new Map<string, Room>();
  private readonly posts = new Map<string, { minute: number; count: number }>();
  private readonly timers: ReturnType<typeof setInterval>[];

  constructor(opts: RelayOptions = {}) {
    this.maxMessages = opts.maxMessages ?? 500;
    this.ttlMs = opts.ttlMs ?? 3 * 24 * 3600_000;
    this.maxRooms = opts.maxRooms ?? 5000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;
    this.maxStreams = opts.maxStreams ?? 24;
    this.postsPerMinute = opts.postsPerMinute ?? 240;
    this.now = opts.now ?? Date.now;
    const prune = setInterval(() => this.prune(), 60_000);
    const heartbeat = setInterval(() => {
      for (const r of this.rooms.values()) for (const s of r.readers) s.write(": ping\n\n");
    }, opts.heartbeatMs ?? 20_000);
    prune.unref?.();
    heartbeat.unref?.();
    this.timers = [prune, heartbeat];
  }

  private room(id: string): Room | null {
    let r = this.rooms.get(id);
    if (!r) {
      if (this.rooms.size >= this.maxRooms) this.prune();
      if (this.rooms.size >= this.maxRooms) return null;
      r = { seq: 0, messages: [], readers: new Set(), touched: this.now() };
      this.rooms.set(id, r);
    }
    return r;
  }

  /** Drops old messages, then rooms nobody follows and nothing is left in. */
  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, r] of this.rooms) {
      while (r.messages.length && r.messages[0]!.ts < cutoff) r.messages.shift();
      if (!r.messages.length && !r.readers.size && r.touched < cutoff) this.rooms.delete(id);
    }
    const minute = Math.floor(this.now() / 60_000);
    for (const [ip, p] of this.posts) if (p.minute !== minute) this.posts.delete(ip);
  }

  private limited(ip: string): boolean {
    const minute = Math.floor(this.now() / 60_000);
    const p = this.posts.get(ip);
    if (!p || p.minute !== minute) {
      this.posts.set(ip, { minute, count: 1 });
      return false;
    }
    p.count++;
    return p.count > this.postsPerMinute;
  }

  /** A message into the room. `raw`: the request body, null when it was larger than maxBodyBytes. */
  post(roomId: string, raw: string | null, ip: string): RelayReply {
    if (!isRoomId(roomId)) return { status: 404, body: { error: "not found" } };
    if (this.limited(ip)) return { status: 429, body: { error: "too many messages" } };
    if (raw === null || Buffer.byteLength(raw) > this.maxBodyBytes) return { status: 413, body: { error: "message too large" } };
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: "not json" } };
    }
    const { from, kid, iv, tag, data } = msg ?? {};
    const ok =
      typeof from === "string" && SENDER.test(from) && typeof kid === "string" && KEY_ID.test(kid) &&
      [iv, tag, data].every((v) => typeof v === "string" && B64.test(v)) && (data as string).length > 0;
    if (!ok) return { status: 400, body: { error: "invalid message" } };
    const r = this.room(roomId);
    if (!r) return { status: 503, body: { error: "relay full" } };
    if (r.messages.length >= this.maxMessages) r.messages.shift();
    const seq = ++r.seq;
    const ts = this.now();
    r.touched = ts;
    const line = JSON.stringify({ seq, ts, from, kid, iv, tag, data });
    r.messages.push({ seq, ts, line });
    for (const s of r.readers) s.write(`id: ${seq}\ndata: ${line}\n\n`);
    return { status: 200, body: { seq } };
  }

  /**
   * Starts a reader: first what the room kept after `after`, then `ready`, then live. Returns the
   * function that ends it, or an error reply when the room cannot take another reader.
   */
  subscribe(roomId: string, after: number, reader: Reader): { stop: () => void } | RelayReply {
    if (!isRoomId(roomId)) return { status: 404, body: { error: "not found" } };
    const r = this.room(roomId);
    if (!r) return { status: 503, body: { error: "relay full" } };
    if (r.readers.size >= this.maxStreams) return { status: 429, body: { error: "too many readers" } };
    const from = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
    // The reader missed messages that are gone (or the relay forgot the room): it asks the members for the whole state.
    const first = r.messages[0];
    if ((from > 0 && first && first.seq > from + 1) || from > r.seq) reader.write("event: gap\ndata: {}\n\n");
    for (const m of r.messages) if (m.seq > from) reader.write(`id: ${m.seq}\ndata: ${m.line}\n\n`);
    reader.write(`event: ready\ndata: ${JSON.stringify({ seq: r.seq })}\n\n`);
    r.readers.add(reader);
    r.touched = this.now();
    return {
      stop: () => {
        r.readers.delete(reader);
        r.touched = this.now();
      },
    };
  }

  /** rooms and open streams, for the health of the service */
  stats() {
    return { rooms: this.rooms.size, streams: [...this.rooms.values()].reduce((n, r) => n + r.readers.size, 0) };
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    for (const r of this.rooms.values()) for (const s of r.readers) s.close();
    this.rooms.clear();
  }
}

const KEY = Symbol.for("forge.crewRelay");

/**
 * The one relay of the process. Next bundles every route on its own, so module state would exist once
 * per route; globalThis holds it for all of them.
 */
export function crewRelay(): RelayCore {
  const g = globalThis as unknown as Record<symbol, RelayCore | undefined>;
  return (g[KEY] ??= new RelayCore());
}
