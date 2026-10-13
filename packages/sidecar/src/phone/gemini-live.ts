import { Downsampler, SAMPLE_RATE } from "./audio.js";

export const GEMINI_LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const DEFAULT_LIVE_MODEL = "gemini-3.8-live";

/** The Live API takes 16 kHz input; the phone line is 8 kHz. */
const INPUT_RATE = 16_000;
/** Caller audio is sent in pieces of this length (fewer, larger messages than one per RTP frame). */
const SEND_CHUNK_MS = 60;
/** Gemini's activity detection: speech this long before it counts, silence this long ends the turn. */
const SPEECH_PREFIX_MS = 300;
const SPEECH_END_SILENCE_MS = 700;
const SETUP_TIMEOUT_MS = 15_000;
const MAX_RECONNECTS = 3;

/** The part of a WebSocket the client needs; tests pass a fake. */
export interface SocketLike {
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveHandlers {
  /** model speech, already at 8 kHz */
  onAudio(pcm: Int16Array): void;
  /** the caller talked over the model: drop what is queued for playback */
  onInterrupted(): void;
  onTurnComplete(): void;
  /** transcription of the caller, in fragments */
  onInputText(text: string): void;
  /** transcription of the model's speech, in fragments */
  onOutputText(text: string): void;
  onToolCall(calls: FunctionCall[]): void;
  onToolCancel(ids: string[]): void;
  /** the connection is gone for good */
  onError(message: string): void;
  log(message: string): void;
}

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  voice: string;
  systemInstruction: string;
  functionDeclarations: unknown[];
  handlers: LiveHandlers;
  socket?: (url: string) => SocketLike;
  timing?: { setupTimeoutMs?: number };
}

/** The interface the call controller uses; GeminiLive in production. */
export interface LiveConversation {
  connect(): Promise<void>;
  sendAudio(pcm: Int16Array): void;
  sendText(text: string): void;
  sendToolResponses(responses: Array<{ id: string; name: string; result: string }>): void;
  close(): void;
}

/** Linear 8 kHz -> 16 kHz; `last` carries the previous chunk's final sample so chunks join smoothly. */
export class Upsampler {
  private last = 0;
  push(input: Int16Array): Int16Array {
    const out = new Int16Array(input.length * 2);
    for (let i = 0; i < input.length; i++) {
      const s = input[i]!;
      out[i * 2] = Math.round((this.last + s) / 2);
      out[i * 2 + 1] = s;
      this.last = s;
    }
    return out;
  }
}

function pcmToBase64(pcm: Int16Array): string {
  const b = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i]!, i * 2);
  return b.toString("base64");
}

function base64ToPcm(data: string): Int16Array {
  const b = Buffer.from(data, "base64");
  const out = new Int16Array(Math.floor(b.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
  return out;
}

function rateOf(mimeType: string | undefined): number {
  const m = /rate=(\d+)/.exec(mimeType ?? "");
  return m ? Number(m[1]) : 24_000;
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  return String(data);
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; text?: string }> };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  error?: { message?: string };
}

/**
 * A Gemini Live session over WebSocket: caller audio in, model speech out, function calls for FORGE
 * tools. Connections to the Live API are limited in time; the server announces the end (`goAway`)
 * and hands out resumption handles, so a long call moves to a new connection and keeps its context.
 */
export class GeminiLive implements LiveConversation {
  private ws: SocketLike | null = null;
  private ready = false;
  private closed = false;
  private handle: string | null = null;
  private reconnects = 0;
  private readonly up = new Upsampler();
  private outBuf: Int16Array[] = [];
  private outSamples = 0;
  private down: { rate: number; ds: Downsampler | null } = { rate: 0, ds: null };
  /** text sent while reconnecting goes out once the new connection is ready */
  private pendingText: string[] = [];

  constructor(private readonly o: GeminiLiveOptions) {}

  connect(): Promise<void> {
    return this.open(false);
  }

  private open(resume: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(this.o.apiKey)}`;
      const ws = this.o.socket ? this.o.socket(url) : (new WebSocket(url) as unknown as SocketLike);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.ready = false;
      let settled = false;
      const timer = setTimeout(() => fail("Gemini Live antwortet nicht (Verbindungsaufbau)."), this.o.timing?.setupTimeoutMs ?? SETUP_TIMEOUT_MS);
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        reject(new Error(message));
      };
      ws.onopen = () => ws.send(JSON.stringify({ setup: this.setupMessage(resume) }));
      ws.onerror = () => {
        if (!settled) fail("Verbindung zu Gemini Live fehlgeschlagen.");
      };
      ws.onclose = (ev) => {
        if (!settled) return fail(closeText(ev.code, ev.reason));
        if (this.ws === ws) this.onClosed(ev.code, ev.reason);
      };
      ws.onmessage = (ev) => {
        void messageText(ev.data).then((text) => {
          if (this.ws !== ws) return;
          let msg: ServerMessage;
          try {
            msg = JSON.parse(text) as ServerMessage;
          } catch {
            return;
          }
          if (msg.setupComplete !== undefined && !settled) {
            settled = true;
            clearTimeout(timer);
            this.ready = true;
            this.reconnects = 0;
            const texts = this.pendingText;
            this.pendingText = [];
            for (const t of texts) this.sendText(t);
            resolve();
            return;
          }
          this.onMessage(msg);
        });
      };
    });
  }

  private setupMessage(resume: boolean) {
    return {
      model: `models/${this.o.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voice } } },
      },
      systemInstruction: { parts: [{ text: this.o.systemInstruction }] },
      tools: this.o.functionDeclarations.length ? [{ functionDeclarations: this.o.functionDeclarations }] : [],
      // A phone line carries noise and echo: speech must last a while before it counts and interrupts.
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
          prefixPaddingMs: SPEECH_PREFIX_MS,
          silenceDurationMs: SPEECH_END_SILENCE_MS,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resume && this.handle ? { handle: this.handle } : {},
    };
  }

  private onMessage(msg: ServerMessage) {
    const h = this.o.handlers;
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) this.handle = msg.sessionResumptionUpdate.newHandle;
    if (msg.goAway) {
      h.log(`Gemini Live: Verbindung endet bald (${msg.goAway.timeLeft ?? "?"}), wechsle`);
      void this.reconnect();
      return;
    }
    if (msg.error) {
      h.onError(`Gemini Live: ${msg.error.message ?? "Fehler"}`);
      return;
    }
    const c = msg.serverContent;
    if (c) {
      if (c.interrupted) h.onInterrupted();
      if (c.inputTranscription?.text) h.onInputText(c.inputTranscription.text);
      if (c.outputTranscription?.text) h.onOutputText(c.outputTranscription.text);
      for (const p of c.modelTurn?.parts ?? []) {
        if (p.inlineData?.data) {
          const pcm = this.toLine(base64ToPcm(p.inlineData.data), rateOf(p.inlineData.mimeType));
          if (pcm.length) h.onAudio(pcm);
        }
      }
      if (c.turnComplete) h.onTurnComplete();
    }
    if (msg.toolCall?.functionCalls?.length) {
      h.onToolCall(msg.toolCall.functionCalls.map((f) => ({ id: f.id ?? "", name: f.name ?? "", args: f.args ?? {} })));
    }
    if (msg.toolCallCancellation?.ids?.length) h.onToolCancel(msg.toolCallCancellation.ids);
  }

  /** Model audio to 8 kHz. */
  private toLine(pcm: Int16Array, rate: number): Int16Array {
    if (rate === SAMPLE_RATE) return pcm;
    if (this.down.rate !== rate) {
      const factor = rate / SAMPLE_RATE;
      this.down = { rate, ds: Number.isInteger(factor) && factor > 1 ? new Downsampler(factor) : null };
    }
    if (this.down.ds) return this.down.ds.push(pcm);
    // Not an integer ratio: pick the nearest sample (rare; the API sends 24 kHz).
    const n = Math.floor((pcm.length * SAMPLE_RATE) / rate);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = pcm[Math.min(pcm.length - 1, Math.round((i * rate) / SAMPLE_RATE))]!;
    return out;
  }

  private async reconnect() {
    if (this.closed) return;
    if (++this.reconnects > MAX_RECONNECTS) {
      this.o.handlers.onError("Gemini Live: Verbindung lässt sich nicht halten.");
      return;
    }
    const old = this.ws;
    this.ws = null;
    this.ready = false;
    try {
      old?.close(1000, "resume");
    } catch {
      /* already closed */
    }
    try {
      await this.open(true);
      this.o.handlers.log("Gemini Live: Verbindung gewechselt");
    } catch (e) {
      if (!this.closed) this.o.handlers.onError(e instanceof Error ? e.message : String(e));
    }
  }

  private onClosed(code: number, reason: string) {
    if (this.closed) return;
    this.ready = false;
    // Without a handle the context would be lost; a fresh start mid-call would confuse more than help.
    if (this.handle && code !== 1008) {
      this.o.handlers.log(`Gemini Live: Verbindung getrennt (${code}), setze fort`);
      void this.reconnect();
      return;
    }
    this.o.handlers.onError(closeText(code, reason));
  }

  sendAudio(pcm: Int16Array) {
    if (!this.ready || this.closed) return;
    this.outBuf.push(this.up.push(pcm));
    this.outSamples += pcm.length * 2;
    if (this.outSamples < (INPUT_RATE * SEND_CHUNK_MS) / 1000) return;
    const all = new Int16Array(this.outSamples);
    let off = 0;
    for (const b of this.outBuf) {
      all.set(b, off);
      off += b.length;
    }
    this.outBuf = [];
    this.outSamples = 0;
    this.send({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${INPUT_RATE}`, data: pcmToBase64(all) } } });
  }

  sendText(text: string) {
    if (this.closed) return;
    if (!this.ready) {
      this.pendingText.push(text);
      return;
    }
    this.send({ realtimeInput: { text } });
  }

  sendToolResponses(responses: Array<{ id: string; name: string; result: string }>) {
    if (!responses.length) return;
    this.send({ toolResponse: { functionResponses: responses.map((r) => ({ id: r.id, name: r.name, response: { result: r.result } })) } });
  }

  private send(msg: unknown) {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.o.handlers.log(`Gemini Live: Senden fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "call ended");
    } catch {
      /* already closed */
    }
  }
}

function closeText(code: number, reason: string): string {
  const r = reason?.trim();
  if (/api key/i.test(r)) return "Gemini Live: API-Key ungültig.";
  if (/quota|exhausted|billing/i.test(r)) return "Gemini Live: Limit erreicht oder kein Guthaben.";
  if (/not found|not supported/i.test(r)) return `Gemini Live: Modell nicht verfügbar (${r}).`;
  return `Gemini Live: Verbindung beendet (${code}${r ? `: ${r}` : ""}).`;
}
