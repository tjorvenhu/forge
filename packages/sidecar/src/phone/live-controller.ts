import { beep } from "./audio.js";
import type { CallHandler } from "./call-controller.js";
import type { FunctionCall, LiveConversation, LiveHandlers } from "./gemini-live.js";
import type { PinResult } from "./pin-guard.js";
import { PIN_TEXT, PinPad } from "./pin-pad.js";
import type { RtpSession } from "./rtp.js";
import type { SipCall } from "./sip-ua.js";
import { runPhoneTool, type PhoneToolset } from "./tools.js";

export interface LiveControllerDeps {
  createLive(handlers: LiveHandlers): LiveConversation;
  tools: PhoneToolset;
  checkPin: ((pin: string) => Promise<PinResult>) | null;
  /** incoming calls: what Gemini says first, right when the call is up */
  greeting: string | null;
  /** first note to Gemini (outgoing calls: the reason); null waits for the caller */
  opening: string | null;
  onTranscript(role: "caller" | "forge", text: string): void;
  onUnlock(): void;
  log(message: string): void;
  timing?: { idleMs?: number; maxCallMs?: number; hangupGraceMs?: number };
}

const IDLE_HANGUP_MS = 90_000;
const MAX_CALL_MS = 30 * 60_000;
/** after hang_up or a goodbye: hang up at the latest after this, even if the model keeps talking */
const HANGUP_GRACE_MS = 8_000;

/**
 * One phone conversation with Gemini Live: the caller's audio goes straight to Gemini, which hears,
 * decides on its own when the caller is done, speaks and calls FORGE tools. Barge-in is Gemini's
 * own: when it reports an interruption, queued speech is dropped at once.
 *
 * The PIN goes over the keypad as with Claude; Gemini only learns that steering is now allowed.
 */
export class LiveCallController implements CallHandler {
  private live: LiveConversation | null = null;
  private readonly pinPad: PinPad;
  private begun = false;
  private ended = false;
  private closing = false;
  private hangupPending = false;
  /** model speech that arrives before the call is answered (outgoing calls) */
  private held: Int16Array[] | null = null;
  private callerText = "";
  private forgeText = "";
  /** tool calls the model withdrew; their results are not sent */
  private cancelled = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly call: SipCall,
    private readonly rtp: RtpSession,
    private readonly d: LiveControllerDeps,
  ) {
    this.pinPad = new PinPad({
      checkPin: d.checkPin,
      accepting: () => !this.ended && !this.closing,
      onUnlocked: () => {
        this.d.onUnlock();
        this.rtp.play(beep());
        this.note(PIN_TEXT.unlockedNote);
      },
      onLocked: () => this.note(`[FORGE: Sag dem Anrufer genau das: „${PIN_TEXT.locked}“]`),
      onWrong: (final) => (final ? this.farewell(PIN_TEXT.final) : this.note(`[FORGE: Sag dem Anrufer genau das: „${PIN_TEXT.wrong}“]`)),
      log: (m) => this.d.log(m),
    });
    this.rtp.on("audio", (frame) => {
      if (this.begun && !this.ended) this.live?.sendAudio(frame);
    });
    this.rtp.on("dtmf", (digit) => this.onDigit(digit));
    this.call.on("dtmf", (digit) => this.onDigit(digit));
    this.rtp.on("drained", () => this.maybeHangup());
    this.call.on("ended", () => this.dispose());
  }

  get unlocked(): boolean {
    return this.pinPad.unlocked;
  }

  /** Connects to Gemini before the call is up, so the first words come without delay. */
  prepare() {
    if (this.live || this.ended) return;
    if (!this.begun) this.held = [];
    this.start();
  }

  begin() {
    if (this.ended || this.begun) return;
    this.begun = true;
    this.rtp.start();
    if (!this.live) this.start();
    const held = this.held;
    this.held = null;
    for (const pcm of held ?? []) this.rtp.play(pcm);
    this.touch();
    this.maxTimer = setTimeout(() => this.farewell("Das Gespräch dauert schon sehr lange. Ich lege jetzt auf."), this.d.timing?.maxCallMs ?? MAX_CALL_MS);
  }

  private start() {
    const live = this.d.createLive(this.handlers());
    this.live = live;
    if (this.d.greeting) live.sendText(`[FORGE: Der Anrufer ist dran. Begrüße ihn mit genau diesen Worten: „${this.d.greeting}“ Dann warte, was er will.]`);
    if (this.d.opening) live.sendText(this.d.opening);
    live.connect().catch((e: unknown) => this.fatal(e instanceof Error ? e.message : String(e)));
  }

  private handlers(): LiveHandlers {
    return {
      onAudio: (pcm) => {
        if (this.ended) return;
        if (this.held) this.held.push(pcm);
        else {
          this.rtp.play(pcm);
          this.touch();
        }
      },
      onInterrupted: () => {
        // Speech of the old turn that is still queued no longer fits.
        if (this.held) this.held = [];
        this.rtp.clearPlayback();
        this.flushForge();
      },
      onTurnComplete: () => {
        this.rtp.flush();
        this.flushCaller();
        this.flushForge();
        this.touch();
        this.maybeHangup();
      },
      onInputText: (t) => {
        this.flushForge();
        this.callerText += t;
        this.touch();
      },
      onOutputText: (t) => {
        this.flushCaller();
        this.forgeText += t;
      },
      onToolCall: (calls) => void this.runTools(calls),
      onToolCancel: (ids) => ids.forEach((id) => this.cancelled.add(id)),
      onError: (m) => this.fatal(m),
      log: (m) => this.d.log(m),
    };
  }

  private async runTools(calls: FunctionCall[]) {
    this.flushCaller();
    this.touch();
    const ctx = {
      hangup: () => {
        this.closing = true;
        this.hangupPending = true;
        this.startGrace();
      },
    };
    const results = await Promise.all(calls.map(async (c) => ({ id: c.id, name: c.name, result: await runPhoneTool(c.name, c.args, this.d.tools, ctx) })));
    if (this.ended) return;
    this.live?.sendToolResponses(results.filter((r) => !this.cancelled.has(r.id)));
  }

  /** A note from FORGE for Gemini, in brackets. */
  note(text: string) {
    if (this.ended) return;
    this.live?.sendText(text);
  }

  /** Says goodbye (through Gemini) and hangs up once it is spoken. */
  farewell(text: string) {
    if (this.ended || this.closing) return;
    this.closing = true;
    this.hangupPending = true;
    this.note(`[FORGE: Das Gespräch endet jetzt. Sag dem Anrufer genau das und sonst nichts: „${text}“]`);
    this.startGrace();
  }

  private startGrace() {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => void this.call.hangup("FORGE hat aufgelegt"), this.d.timing?.hangupGraceMs ?? HANGUP_GRACE_MS);
  }

  private maybeHangup() {
    if (!this.hangupPending || this.ended || this.rtp.playing) return;
    this.hangupPending = false;
    // A little room so the last syllable is not cut off on the line.
    setTimeout(() => void this.call.hangup("FORGE hat aufgelegt"), 400);
  }

  /** Gemini is gone: nothing can be said any more; a short tone, then hang up. */
  private fatal(message: string) {
    if (this.ended) return;
    this.d.log(message);
    this.closing = true;
    this.rtp.clearPlayback();
    this.rtp.play(beep(400, 440));
    this.rtp.flush();
    setTimeout(() => void this.call.hangup("Gemini Live nicht verfügbar"), 700);
  }

  private onDigit(digit: string) {
    if (this.ended || !this.begun) return;
    this.touch();
    this.pinPad.digit(digit);
  }

  private touch() {
    if (!this.begun || this.ended) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.farewell("Ich höre nichts mehr und lege jetzt auf. Bis später."), this.d.timing?.idleMs ?? IDLE_HANGUP_MS);
  }

  private flushCaller() {
    const t = this.callerText.replace(/\s+/g, " ").trim();
    this.callerText = "";
    if (t) this.d.onTranscript("caller", t);
  }

  private flushForge() {
    const t = this.forgeText.replace(/\s+/g, " ").trim();
    this.forgeText = "";
    if (t) this.d.onTranscript("forge", t);
  }

  dispose() {
    if (this.ended) return;
    this.flushCaller();
    this.flushForge();
    this.ended = true;
    for (const t of [this.idleTimer, this.maxTimer, this.graceTimer]) if (t) clearTimeout(t);
    this.live?.close();
    this.rtp.close();
  }
}
