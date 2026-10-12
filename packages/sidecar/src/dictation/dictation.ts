import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type ServerEvent } from "@forge/protocol";
import { claudeHome } from "../config/claude-config.js";

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
}

const OPEN = 1;

export class DictationService {
  private streams = new Map<string, Stream>();

  constructor(private readonly d: DictationDeps) {}

  /** Opens the connection; audio can follow as soon as this resolves. */
  async start(opts: { language: string; keyterms: string[] }): Promise<{ id: string }> {
    const token = await this.token();
    const version = (await this.d.cliVersion()) ?? "unknown";
    const query = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      endpointing_ms: "300",
      utterance_end_ms: "1000",
      language: opts.language,
      use_conversation_engine: "true",
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
    const id = randomUUID();
    const s: Stream = { socket, finals: [], pending: "", keepalive: null, closing: false, error: null, finish: null, lastMessageAt: this.now() };
    this.streams.set(id, s);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail("Der Sprachdienst von Claude antwortet nicht."), CONNECT_TIMEOUT_MS);
      const fail = (message: string) => {
        clearTimeout(timer);
        this.drop(id);
        reject(new ForgeError("CLAUDE_RUNTIME", message));
      };
      socket.onopen = () => {
        clearTimeout(timer);
        socket.send(KEEPALIVE);
        s.keepalive = setInterval(() => socket.readyState === OPEN && socket.send(KEEPALIVE), KEEPALIVE_MS);
        resolve();
      };
      socket.onerror = () => fail("Keine Verbindung zum Sprachdienst von Claude. Netzwerk prüfen, sonst hat sich der Dienst mit einem Claude-Code-Update geändert.");
      socket.onclose = (e) => fail(e.code === 1008 || e.code === 4001 || e.code === 4003 ? "Der Sprachdienst lehnt die Claude-Anmeldung ab." : `Sprachdienst getrennt (Code ${e.code}).`);
    });

    socket.onmessage = (e) => this.onMessage(id, s, e.data);
    socket.onerror = () => {
      s.error ??= "Verbindung zum Sprachdienst unterbrochen.";
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
        s.error = `Spracherkennung: ${m.description ?? m.error_code ?? "unbekannter Fehler"}`;
        this.promote(s);
        break;
      case "error":
        s.error = `Sprachdienst: ${m.message ?? "unbekannter Fehler"}`;
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
    if (!s) throw new ForgeError("NOT_FOUND", "Diese Aufnahme ist schon beendet.");
    return s;
  }

  private drop(id: string) {
    const s = this.streams.get(id);
    if (!s) return;
    this.streams.delete(id);
    if (s.keepalive) clearInterval(s.keepalive);
    s.closing = true;
    s.finish?.();
    s.socket.onopen = s.socket.onmessage = s.socket.onerror = s.socket.onclose = null;
    try {
      s.socket.close();
    } catch {
      /* already closed */
    }
  }

  /** The OAuth token of the Claude login; an expired one is refreshed by Claude Code first. */
  private async token(): Promise<string> {
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
      await this.d.refreshLogin().catch(() => {});
      c = await read();
    }
    if (!c) throw new ForgeError("CLAUDE_NOT_LOGGED_IN", "Die Spracheingabe braucht die Anmeldung bei Claude (Pro oder Max).");
    if (c.expiresAt - this.now() < 0) throw new ForgeError("CLAUDE_NOT_LOGGED_IN", "Die Claude-Anmeldung ist abgelaufen. Unter Einstellungen, Claude Code neu anmelden.");
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
