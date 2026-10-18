import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type ServerEvent } from "@forge/protocol";
import { claudeHome } from "../config/claude-config.js";
import { tr } from "../i18n/index.js";

/**
 * Dictation over Claude Code's own speech service (what `/voice` uses in the terminal), with the
 * user's Claude login. The service has no public API: endpoint, headers and messages are taken from
 * Claude Code 2.1.296 and may change with a Claude Code update. Everything about it lives here.
 */
const ENDPOINT = "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream";
const KEEPALIVE = '{"type":"KeepAlive"}';
const CLOSE_STREAM = '{"type":"CloseStream"}';
const KEEPALIVE_MS = 8_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** after CloseStream: the final endpoint usually comes at once; without any message for this long, it is done */
const FINISH_QUIET_MS = 1_500;
const FINISH_LIMIT_MS = 5_000;
/** the service reads the hint list from a header: ASCII, comma-separated, at most 1 KB */
const KEYTERMS_MAX = 1024;
/** tokens this close to expiry are refreshed by Claude Code first */
const TOKEN_MARGIN_MS = 60_000;
/** a refresh that did not help is not tried again on every start; each try starts a Claude Code process */
const REFRESH_RETRY_MS = 5 * 60_000;
/** A recording without audio for this long has lost its window (crash, reload); it is dropped. */
const IDLE_MS = 30_000;
/** No dictation runs this long; a stream still open then was forgotten. */
const MAX_RECORDING_MS = 15 * 60_000;
export const SAMPLE_RATE = 16_000;

/** What the service answers; other message types are ignored like Claude Code does. */
type Incoming =
  | { type: "TranscriptInterim" | "TranscriptText"; data?: string }
  | { type: "TranscriptEndpoint" }
  | { type: "TranscriptError"; description?: string; error_code?: string }
  | { type: "error"; message?: string };

/** The part of a WebSocket the dictation needs; tests pass a fake. */
export interface VoiceSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
}

export interface DictationDeps {
  emit(e: ServerEvent): void;
  /** Claude Code version for the User-Agent, like Claude Code sends it */
  cliVersion(): Promise<string | null>;
  /** lets Claude Code refresh an expired login (a short CLI start does that) */
  refreshLogin(): Promise<void>;
  /** where Claude Code keeps its login; tests pass their own */
  credentialsFile?: string;
  connect?: (url: string, headers: Record<string, string>) => VoiceSocket;
  now?: () => number;
  /** tests shorten the limits of a recording */
  idleMs?: number;
  maxRecordingMs?: number;
}

interface Stream {
  socket: VoiceSocket;
  /** finished utterances */
  finals: string[];
  /** current utterance, replaced by every interim result */
  pending: string;
  keepalive: ReturnType<typeof setInterval> | null;
  closing: boolean;
  error: string | null;
  /** resolves the running stop() */
  finish: (() => void) | null;
  lastMessageAt: number;
  /** drops the stream when no audio comes; every block restarts it */
  idle: ReturnType<typeof setTimeout>;
  /** drops the stream after the longest recording */
  limit: ReturnType<typeof setTimeout>;
}

const OPEN = 1;
/** A connection opened ahead of a recording waits this long for it; every prewarm extends the wait. */
const SPARE_MS = 60_000;

/** A connection to the service, before a recording takes it. */
interface Conn {
  key: string;
  socket: VoiceSocket;
  /** resolves once the socket is open; rejects with the reason it did not open */
  opened: Promise<void>;
  keepalive: ReturnType<typeof setInterval> | null;
  /** closed by the service or by FORGE before a recording took it */
  dead: boolean;
  /** the service closed it while it waited */
  onLost: (() => void) | null;
}

interface Spare {
  key: string;
  conn: Promise<Conn>;
  expiry: ReturnType<typeof setTimeout>;
}

export class DictationService {
  private streams = new Map<string, Stream>();
  private spare: Spare | null = null;
  /** when a refresh of the login last failed to bring a valid token */
  private refreshFailedAt = -Infinity;

  constructor(private readonly d: DictationDeps) {}

  /**
   * Opens a connection ahead of a recording (composer focused, space pressed), so a recording does
   * not wait for the login check and the TLS handshake and the first words show at once.
   */
  prewarm(opts: { language: string; keyterms: string[] }) {
    const key = connKey(opts);
    if (this.spare?.key === key) {
      clearTimeout(this.spare.expiry);
      this.spare.expiry = setTimeout(() => this.dropSpare(), SPARE_MS);
      return;
    }
    this.dropSpare();
    // Focus or a typed space is no reason to start Claude Code for a login refresh; the recording does that.
    const spare: Spare = { key, conn: this.open(opts, false), expiry: setTimeout(() => this.dropSpare(), SPARE_MS) };
    this.spare = spare;
    const forget = () => {
      if (this.spare === spare) this.dropSpare();
    };
    spare.conn.then((c) => (c.onLost = forget), forget);
    spare.conn.then((c) => c.opened).catch(forget);
  }

  /** Opens the connection (or takes the prewarmed one); audio can follow as soon as this resolves. */
  async start(opts: { language: string; keyterms: string[] }): Promise<{ id: string }> {
    let conn: Conn | null = null;
    const warm = this.spare?.key === connKey(opts) ? this.spare.conn : null;
    if (warm) {
      clearTimeout(this.spare!.expiry);
      this.spare = null;
      try {
        conn = await warm;
        await conn.opened;
        if (conn.dead) conn = null;
      } catch {
        conn = null;
      }
    }
    this.dropSpare();
    if (!conn) {
      conn = await this.open(opts, true);
      await conn.opened;
    }

    conn.onLost = null;
    const { socket } = conn;
    const id = randomUUID();
    const s: Stream = {
      socket,
      finals: [],
      pending: "",
      keepalive: conn.keepalive,
      closing: false,
      error: null,
      finish: null,
      lastMessageAt: this.now(),
      idle: setTimeout(() => this.drop(id), this.d.idleMs ?? IDLE_MS),
      limit: setTimeout(() => this.drop(id), this.d.maxRecordingMs ?? MAX_RECORDING_MS),
    };
    this.streams.set(id, s);

    socket.onmessage = (e) => this.onMessage(id, s, e.data);
    socket.onerror = () => {
      s.error ??= tr().system.dictation.interrupted;
      s.finish?.();
    };
    socket.onclose = (e) => {
      if (!s.closing && e.code !== 1000 && e.code !== 1005) s.error ??= `Sprachdienst getrennt (Code ${e.code}).`;
      s.finish?.();
    };
    return { id };
  }

  /** One block of 16-bit mono samples at 16 kHz, base64. */
  audio(id: string, pcmBase64: string) {
    const s = this.require(id);
    if (s.closing || s.socket.readyState !== OPEN) return;
    s.idle.refresh();
    s.socket.send(Buffer.from(pcmBase64, "base64"));
  }

  /** Ends the recording and returns everything that was said. */
  async stop(id: string): Promise<{ text: string }> {
    const s = this.require(id);
    if (!s.closing && s.socket.readyState === OPEN) {
      s.closing = true;
      s.lastMessageAt = this.now();
      s.socket.send(CLOSE_STREAM);
      await new Promise<void>((resolve) => {
        const limit = setTimeout(done, FINISH_LIMIT_MS);
        const quiet = setInterval(() => this.now() - s.lastMessageAt >= FINISH_QUIET_MS && done(), 100);
        function done() {
          clearTimeout(limit);
          clearInterval(quiet);
          s.finish = null;
          resolve();
        }
        s.finish = done;
      });
    }
    this.promote(s);
    const text = s.finals.join(" ").trim();
    const error = s.error;
    this.drop(id);
    if (error && !text) throw new ForgeError("CLAUDE_RUNTIME", error);
    return { text };
  }

  cancel(id: string) {
    this.drop(id);
  }

  shutdown() {
    this.dropSpare();
    for (const id of [...this.streams.keys()]) this.drop(id);
  }

  private onMessage(id: string, s: Stream, raw: unknown) {
    s.lastMessageAt = this.now();
    let m: Incoming;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8")) as Incoming;
    } catch {
      return;
    }
    switch (m.type) {
      case "TranscriptInterim":
      case "TranscriptText":
        if (m.data) s.pending = m.data;
        break;
      case "TranscriptEndpoint":
        this.promote(s);
        if (s.closing) s.finish?.();
        break;
      case "TranscriptError":
        s.error = tr().system.dictation.recognition(m.description ?? m.error_code);
        this.promote(s);
        break;
      case "error":
        s.error = tr().system.dictation.service(m.message);
        this.promote(s);
        break;
      default:
        return;
    }
    this.d.emit({ event: "voice.transcript", payload: { id, text: [...s.finals, s.pending].join(" ").trim() } });
  }

  private promote(s: Stream) {
    if (s.pending.trim()) s.finals.push(s.pending.trim());
    s.pending = "";
  }

  private require(id: string): Stream {
    const s = this.streams.get(id);
    if (!s) throw new ForgeError("NOT_FOUND", tr().system.dictation.ended);
    return s;
  }

  private drop(id: string) {
    const s = this.streams.get(id);
    if (!s) return;
    this.streams.delete(id);
    if (s.keepalive) clearInterval(s.keepalive);
    clearTimeout(s.idle);
    clearTimeout(s.limit);
    s.closing = true;
    s.finish?.();
    s.socket.onopen = s.socket.onmessage = s.socket.onerror = s.socket.onclose = null;
    try {
      s.socket.close();
    } catch {
      /* already closed */
    }
  }

  private async open(opts: { language: string; keyterms: string[] }, refresh: boolean): Promise<Conn> {
    const token = await this.token(refresh);
    const version = (await this.d.cliVersion()) ?? "unknown";
    const query = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      endpointing_ms: "300",
      utterance_end_ms: "1000",
      language: opts.language,
      use_conversation_engine: "true",
      // Without it the service sends text only at pauses and at the end, not while the user speaks.
      forward_interims: "typed",
    });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      // FORGE talks to Claude Code through the Agent SDK and says so.
      "User-Agent": `claude-cli/${version} (external, sdk-ts, client-app/forge)`,
      "x-app": "cli",
      "anthropic-client-platform": "claude_code_sdk",
    };
    const keyterms = keytermHeader(opts.keyterms);
    if (keyterms) headers["x-config-keyterms"] = keyterms;

    const socket = (this.d.connect ?? defaultConnect)(`${ENDPOINT}?${query.toString()}`, headers);
    const conn: Conn = { key: connKey(opts), socket, opened: Promise.resolve(), keepalive: null, dead: false, onLost: null };
    conn.opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(tr().system.dictation.noAnswer), CONNECT_TIMEOUT_MS);
      const fail = (message: string) => {
        clearTimeout(timer);
        closeConn(conn);
        reject(new ForgeError("CLAUDE_RUNTIME", message));
      };
      socket.onopen = () => {
        clearTimeout(timer);
        socket.send(KEEPALIVE);
        conn.keepalive = setInterval(() => socket.readyState === OPEN && socket.send(KEEPALIVE), KEEPALIVE_MS);
        // Until a recording takes it over, a connection the service closes is just gone.
        const lost = () => {
          closeConn(conn);
          conn.onLost?.();
        };
        socket.onerror = lost;
        socket.onclose = lost;
        resolve();
      };
      socket.onerror = () => fail(tr().system.dictation.noConnection);
      socket.onclose = (e) => fail(e.code === 1008 || e.code === 4001 || e.code === 4003 ? tr().system.dictation.loginRejected : tr().system.dictation.disconnected(e.code));
    });
    // A prewarmed connection may fail without anyone waiting for it.
    conn.opened.catch(() => {});
    return conn;
  }

  private dropSpare() {
    const s = this.spare;
    if (!s) return;
    this.spare = null;
    clearTimeout(s.expiry);
    s.conn.then(closeConn, () => {});
  }

  /**
   * The OAuth token of the Claude login; with `refresh`, an expiring one is refreshed by Claude Code
   * first. Without, an expiring token fails: the recording then refreshes it.
   */
  private async token(refresh: boolean): Promise<string> {
    const read = async () => {
      try {
        const file = this.d.credentialsFile ?? path.join(claudeHome(), ".credentials.json");
        const o = (JSON.parse(await readFile(file, "utf8")) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth;
        return o?.accessToken ? { token: o.accessToken, expiresAt: o.expiresAt ?? Infinity } : null;
      } catch {
        return null;
      }
    };
    let c = await read();
    if (c && c.expiresAt - this.now() < TOKEN_MARGIN_MS) {
      if (!refresh) throw new ForgeError("CLAUDE_NOT_LOGGED_IN", tr().system.dictation.loginExpiring);
      if (this.now() - this.refreshFailedAt >= REFRESH_RETRY_MS) {
        await this.d.refreshLogin().catch(() => {});
        c = await read();
        if (!c || c.expiresAt - this.now() < TOKEN_MARGIN_MS) this.refreshFailedAt = this.now();
      }
    }
    if (!c) throw new ForgeError("CLAUDE_NOT_LOGGED_IN", tr().system.dictation.needsLogin);
    if (c.expiresAt - this.now() < 0) throw new ForgeError("CLAUDE_NOT_LOGGED_IN", tr().system.dictation.loginExpired);
    return c.token;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }
}

function defaultConnect(url: string, headers: Record<string, string>): VoiceSocket {
  // Node's WebSocket (undici) takes headers as a second argument, the browser one does not.
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  return ws as unknown as VoiceSocket;
}

/** Like Claude Code: ASCII only, no commas inside a term, no duplicates, cut at 1 KB. */
export function keytermHeader(terms: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let size = 0;
  for (const t of terms) {
    const clean = t.replace(/,/g, " ").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) continue;
    const add = clean.length + (out.length ? 1 : 0);
    if (size + add > KEYTERMS_MAX) break;
    seen.add(clean);
    out.push(clean);
    size += add;
  }
  return out.join(",");
}

/** Connections differ only in language and hint words; a spare one fits a recording with the same. */
function connKey(opts: { language: string; keyterms: string[] }): string {
  return `${opts.language}\n${keytermHeader(opts.keyterms)}`;
}

function closeConn(c: Conn) {
  c.dead = true;
  if (c.keepalive) clearInterval(c.keepalive);
  c.socket.onopen = c.socket.onmessage = c.socket.onerror = c.socket.onclose = null;
  try {
    c.socket.close();
  } catch {
    /* already closed */
  }
}
