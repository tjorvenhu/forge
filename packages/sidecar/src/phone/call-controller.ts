import { beep, SAMPLE_RATE } from "./audio.js";
import type { PinResult } from "./pin-guard.js";
import { PinPad } from "./pin-pad.js";
import { tr } from "../i18n/index.js";
import type { RtpSession } from "./rtp.js";
import type { PhoneCall } from "./sip-ua.js";
import { Vad } from "./vad.js";
import { SPEAK_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS, type VoiceProvider } from "./voice.js";

/** The part of the conversation partner the controller needs (PhoneAgent in production). */
export interface Conversation {
  /** starts a turn; the controller sends the next message only after onTurnDone */
  say(text: string): void;
  /** stops the reply Claude is writing; onTurnDone still follows for the turn */
  interrupt(): void;
  close(): void;
}

/** One conversation over an established call: Claude with speech services, or Gemini Live. */
export interface CallHandler {
  readonly unlocked: boolean;
  /** outgoing calls: get the first words ready while it rings */
  prepare(): void;
  /** the call is up and media flows */
  begin(): void;
  /** a note from FORGE for the conversation partner, in brackets */
  note(text: string): void;
  dispose(): void;
}

export interface ConversationCallbacks {
  onSentence(text: string): void;
  onTurnDone(): void;
  onHangup(): void;
  onError(message: string): void;
}

export interface CallControllerDeps {
  voice: VoiceProvider;
  createConversation(cb: ConversationCallbacks): Conversation;
  /** null when steering needs no PIN; "locked" when PIN entry is blocked after too many failures */
  checkPin: ((pin: string) => Promise<PinResult>) | null;
  /** spoken right when the call is up (incoming calls), before Claude answers */
  greeting: string | null;
  /** first message to Claude (outgoing calls: the reason); null waits for the caller */
  opening: string | null;
  onTranscript(role: "caller" | "forge", text: string): void;
  onUnlock(): void;
  /** a keypad digit FORGE wants itself (confirming a deletion); true keeps it from the PIN pad */
  onDigit?(digit: string): boolean;
  log(message: string): void;
  /** shorter limits in tests */
  timing?: { speakTimeoutMs?: number; transcribeTimeoutMs?: number; turnEndMs?: number; turnEndUnfinishedMs?: number };
}

const IDLE_HANGUP_MS = 90_000;
const MAX_CALL_MS = 30 * 60_000;
const MAX_VOICE_ERRORS = 3;
const PREBUFFER_MS = 300;
/**
 * Silence after an utterance (on top of the VAD's 700 ms) before the caller's turn counts as over.
 * Transcription runs in the meantime, so this costs little; a sentence that sounds unfinished
 * ("... und", "... weil", no closing punctuation) gets much longer, people pause to think there.
 */
const TURN_END_MS = 400;
const TURN_END_UNFINISHED_MS = 2_000;
/** an interrupted turn normally ends at once; if its result never comes, the conversation must not hang */
const INTERRUPT_SETTLE_MS = 5_000;

/**
 * Runs one phone conversation over an established call: caller audio -> voice activity ->
 * transcription -> Claude -> speech -> RTP.
 *
 * Turn taking: FORGE never starts talking while the caller talks. Short pauses do not end the
 * caller's turn; what was said is collected until the caller is really done and then goes to
 * Claude in one message. If the caller talks while FORGE speaks, FORGE stops at once; a cough or
 * a lone "mhm" lets it go on, anything else drops the reply and Claude answers the new words.
 * Claude gets one message per turn, never one while it still writes.
 *
 * Digits from the keypad unlock steering (PIN + #); that does not go through the language model,
 * so nothing Claude reads or hears can unlock on its own.
 */
export class CallController implements CallHandler {
  get unlocked(): boolean {
    return this.pinPad.unlocked;
  }
  private readonly vad = new Vad();
  private conversation: Conversation | null = null;
  /** Claude is writing a reply */
  private turnActive = false;
  /** sentences of the current turn are dropped (the caller moved on) */
  private muted = false;
  /** messages for Claude that wait for the current turn to end */
  private outbox: string[] = [];
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private speechQueue: string[] = [];
  /** sentences started but not yet fully played; spoken again if the caller only coughed */
  private unfinished: string[] = [];
  private current: string | null = null;
  private speaking = false;
  /** the caller has the floor: nothing new is spoken */
  private paused = false;
  private abort: AbortController | null = null;
  /** aborted when the call ends: cancels transcriptions still in flight */
  private readonly life = new AbortController();
  private utterances: Int16Array[] = [];
  private transcribing = false;
  /** what the caller said in this turn, not yet handed to Claude */
  private heard: string[] = [];
  private lastUtteranceAt = 0;
  private turnEndTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pinPad: PinPad;
  private voiceErrors = 0;
  private hangupPending = false;
  /** FORGE is saying goodbye; set once and never cleared */
  private closing = false;
  private begun = false;
  private ended = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  /** outgoing calls prepare Claude's first words while it rings; held back until answered */
  private held: string[] | null = null;

  constructor(
    private readonly call: PhoneCall,
    private readonly rtp: RtpSession,
    private readonly d: CallControllerDeps,
  ) {
    this.pinPad = new PinPad({
      checkPin: d.checkPin,
      accepting: () => !this.ended && !this.closing,
      onUnlocked: () => {
        this.d.onUnlock();
        this.rtp.play(beep());
        this.tell(tr().phone.pin.unlockedNote);
      },
      onLocked: () => this.speak(tr().phone.pin.locked),
      onWrong: (final) => (final ? this.farewell(tr().phone.pin.final) : this.speak(tr().phone.pin.wrong)),
      log: (m) => this.d.log(m),
    });
    // Before the call is up, audio is ringback or an announcement of the network, not the caller.
    this.rtp.on("audio", (frame) => {
      if (this.begun) this.vad.push(frame);
    });
    this.rtp.on("dtmf", (digit) => this.onDigit(digit, "rtp"));
    this.call.on("dtmf", (digit) => this.onDigit(digit, "info"));
    this.rtp.on("drained", () => this.onDrained());
    this.vad.on("speechStart", () => this.onSpeechStart());
    this.vad.on("utterance", (pcm) => this.onUtterance(pcm));
    this.vad.on("noise", () => this.settleTurn());
    this.call.on("ended", () => this.dispose());
  }

  /** Starts Claude before the call is answered, so the first words are ready (outgoing calls). */
  prepare() {
    this.held = [];
    this.startConversation();
  }

  /** The call is up and media flows. */
  begin() {
    if (this.ended || this.begun) return;
    this.begun = true;
    this.rtp.start();
    if (this.d.greeting) this.speak(this.d.greeting);
    if (!this.conversation) this.startConversation();
    if (this.held) {
      const held = this.held;
      this.held = null;
      for (const s of held) this.speak(s);
    }
    this.touch();
    this.maxTimer = setTimeout(() => this.farewell(tr().phone.call.tooLong), MAX_CALL_MS);
  }

  private startConversation() {
    this.conversation = this.d.createConversation({
      onSentence: (s) => {
        if (this.muted || this.ended) return;
        this.d.onTranscript("forge", s);
        if (this.held) this.held.push(s);
        else this.speak(s);
      },
      onTurnDone: () => {
        this.turnActive = false;
        this.muted = false;
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = null;
        this.touch();
        this.flushOutbox();
      },
      onHangup: () => {
        this.startClosing();
        this.hangupPending = true;
        this.maybeHangup();
      },
      onError: (m) => {
        this.d.log(`Claude: ${m}`);
        this.farewell("Ich habe gerade ein technisches Problem und lege auf. Bitte versuch es gleich noch einmal.");
      },
    });
    if (this.d.opening) this.tell(this.d.opening);
  }

  /** Hands text to Claude: right away, or when the reply it is writing is done. */
  private tell(text: string) {
    if (this.ended) return;
    this.outbox.push(text);
    this.flushOutbox();
  }

  private flushOutbox() {
    if (this.turnActive || !this.outbox.length || !this.conversation || this.ended) return;
    const text = this.outbox.join("\n");
    this.outbox = [];
    this.turnActive = true;
    this.muted = false;
    this.conversation.say(text);
  }

  /** The caller said something new: what FORGE was about to say no longer fits. */
  private dropReply() {
    this.speechQueue = [];
    this.unfinished = [];
    if (!this.turnActive || this.muted) return;
    this.muted = true;
    this.conversation?.interrupt();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (!this.muted) return;
      this.d.log("Claude: unterbrochene Antwort endet nicht, Gespräch geht weiter");
      this.turnActive = false;
      this.flushOutbox();
    }, INTERRUPT_SETTLE_MS);
  }

  /** Says goodbye and hangs up once it is spoken. */
  farewell(text: string) {
    if (this.ended) return;
    this.startClosing();
    this.speak(text);
    this.hangupPending = true;
    this.maybeHangup();
  }

  /** From here on FORGE finishes what it says, also when the caller talks. */
  private startClosing() {
    this.closing = true;
    if (this.paused) {
      this.paused = false;
      void this.speakNext();
    }
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.farewell(tr().phone.call.idle), IDLE_HANGUP_MS);
  }

  // ---------- speech output

  private speak(text: string) {
    if (this.ended || !text.trim()) return;
    this.speechQueue.push(text);
    void this.speakNext();
  }

  private async speakNext() {
    if (this.speaking || this.ended) return;
    if (this.paused) {
      this.updateOutput();
      return;
    }
    const text = this.speechQueue.shift();
    if (text === undefined) {
      this.updateOutput();
      this.maybeHangup();
      return;
    }
    this.speaking = true;
    this.current = text;
    this.unfinished.push(text);
    this.updateOutput();
    const abort = (this.abort = new AbortController());
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.d.timing?.speakTimeoutMs ?? SPEAK_TIMEOUT_MS)]);
    try {
      // The speech stream can start slower than real time. Collect a little before playing, so the
      // first syllables do not run dry and break up. Audio still queued from the last sentence counts.
      let started = this.rtp.queuedMs >= PREBUFFER_MS;
      let held: Int16Array[] = [];
      let heldSamples = 0;
      for await (const chunk of untilAborted(this.d.voice.speak(text, signal), signal)) {
        if (signal.aborted || this.ended) break;
        if (started) {
          this.rtp.play(chunk);
          continue;
        }
        held.push(chunk);
        heldSamples += chunk.length;
        if (heldSamples >= (PREBUFFER_MS / 1000) * SAMPLE_RATE) {
          for (const c of held) this.rtp.play(c);
          held = [];
          started = true;
        }
      }
      if (!abort.signal.aborted && !this.ended) {
        for (const c of held) this.rtp.play(c);
        this.rtp.flush();
      }
      if (signal.aborted && !abort.signal.aborted && !this.ended) throw new Error("Sprachausgabe: OpenAI antwortet nicht rechtzeitig.");
      this.voiceErrors = 0;
    } catch (e) {
      if (!abort.signal.aborted && !this.ended) {
        this.d.log(`Sprachausgabe: ${e instanceof Error ? e.message : String(e)}`);
        if (++this.voiceErrors >= MAX_VOICE_ERRORS) void this.call.hangup("Sprachausgabe fehlgeschlagen");
      }
    } finally {
      this.speaking = false;
      this.current = null;
      this.abort = null;
      void this.speakNext();
    }
  }

  private updateOutput() {
    this.vad.outputActive = this.speaking || this.rtp.playing || (!this.paused && this.speechQueue.length > 0);
  }

  private onDrained() {
    this.unfinished = this.current ? [this.current] : [];
    this.updateOutput();
    this.maybeHangup();
  }

  private maybeHangup() {
    if (!this.hangupPending || this.ended) return;
    if (this.speaking || this.speechQueue.length || this.rtp.playing) return;
    // A little room so the last syllable is not cut off on the line.
    setTimeout(() => void this.call.hangup("FORGE hat aufgelegt"), 400);
    this.hangupPending = false;
  }

  /** The caller starts talking: FORGE stops at once and keeps what it had not finished saying. */
  private onSpeechStart() {
    if (this.turnEndTimer) clearTimeout(this.turnEndTimer);
    this.turnEndTimer = null;
    if (this.closing || this.paused) return;
    this.paused = true;
    if (this.unfinished.length) this.speechQueue.unshift(...this.unfinished);
    this.unfinished = [];
    this.abort?.abort();
    this.rtp.clearPlayback();
    this.updateOutput();
  }

  private resumeOutput() {
    if (!this.paused) return;
    this.paused = false;
    void this.speakNext();
  }

  // ---------- speech input

  /** Utterances are transcribed one after the other, so Claude gets them in the order they were said. */
  private onUtterance(pcm: Int16Array) {
    if (this.ended) return;
    this.touch();
    this.lastUtteranceAt = Date.now();
    this.utterances.push(pcm);
    void this.transcribeNext();
  }

  private async transcribeNext() {
    if (this.transcribing || this.ended) return;
    const pcm = this.utterances.shift();
    if (!pcm) return;
    this.transcribing = true;
    try {
      let text: string;
      try {
        const signal = AbortSignal.any([this.life.signal, AbortSignal.timeout(this.d.timing?.transcribeTimeoutMs ?? TRANSCRIBE_TIMEOUT_MS)]);
        text = await raceAbort(this.d.voice.transcribe(pcm, signal), signal, "Spracherkennung: OpenAI antwortet nicht rechtzeitig.");
        this.voiceErrors = 0;
      } catch (e) {
        if (this.ended) return;
        this.d.log(`Spracherkennung: ${e instanceof Error ? e.message : String(e)}`);
        this.dropReply();
        if (++this.voiceErrors >= MAX_VOICE_ERRORS) this.farewell("Die Spracherkennung funktioniert gerade nicht. Ich lege auf.");
        else this.speak("Das habe ich nicht verstanden. Sag es bitte noch einmal.");
        return;
      }
      if (this.ended) return;
      // Silence and noise come back as nothing or as a lone filler.
      if (!text || /^[\s.,!?…-]*$/.test(text)) return;
      // "Mhm" while FORGE talks is listening, not a new turn.
      if (this.paused && this.speechQueue.length && !this.heard.length && isBackchannel(text)) return;
      this.d.onTranscript("caller", text);
      this.heard.push(text);
      this.dropReply();
    } finally {
      this.transcribing = false;
      if (this.utterances.length) void this.transcribeNext();
      else this.settleTurn();
    }
  }

  /**
   * Called whenever the caller may have finished: after a transcription, after noise. With nothing
   * heard FORGE goes on talking; otherwise the turn ends after a pause that fits how the last
   * sentence ended.
   */
  private settleTurn() {
    if (this.ended || this.vad.active || this.transcribing || this.utterances.length) return;
    if (!this.heard.length) {
      this.resumeOutput();
      return;
    }
    const t = this.d.timing;
    const pause = soundsUnfinished(this.heard.at(-1)!) ? (t?.turnEndUnfinishedMs ?? TURN_END_UNFINISHED_MS) : (t?.turnEndMs ?? TURN_END_MS);
    if (this.turnEndTimer) clearTimeout(this.turnEndTimer);
    this.turnEndTimer = setTimeout(() => this.endTurn(), Math.max(0, pause - (Date.now() - this.lastUtteranceAt)));
  }

  private endTurn() {
    this.turnEndTimer = null;
    if (this.ended || this.vad.active || this.transcribing || this.utterances.length || !this.heard.length) return;
    const text = this.heard.join(" ");
    this.heard = [];
    this.tell(text);
    this.resumeOutput();
  }

  // ---------- keypad: PIN

  /** Some phones send each key both as RTP event and as SIP INFO; the first source that sends one counts. */
  private dtmfSource: "rtp" | "info" | null = null;

  private onDigit(digit: string, source: "rtp" | "info") {
    if (this.ended || !this.begun) return;
    if (this.dtmfSource && this.dtmfSource !== source) return;
    this.dtmfSource = source;
    this.touch();
    if (this.d.onDigit?.(digit)) return;
    this.pinPad.digit(digit);
  }

  /** A note from FORGE for the conversation partner (e.g. a key pressed on the desk phone). */
  note(text: string) {
    if (this.begun) this.tell(text);
  }

  dispose() {
    if (this.ended) return;
    this.ended = true;
    this.life.abort();
    this.abort?.abort();
    this.speechQueue = [];
    this.utterances = [];
    this.heard = [];
    this.outbox = [];
    for (const t of [this.idleTimer, this.maxTimer, this.turnEndTimer, this.settleTimer]) if (t) clearTimeout(t);
    this.vad.reset();
    this.conversation?.close();
    this.rtp.close();
  }
}

const TRAILING_CONNECTIVE = /\b(und|oder|aber|also|dass|weil|wenn|ob|damit|sowie|bzw|dann|äh|ähm|öhm|hm|halt|quasi|sondern|denn|bis|mit|für|von|zu|in|im|an|am|der|die|das|den|dem|ein|eine|einen)\W*$/i;

/** The transcription ends like a sentence that goes on: no closing punctuation, "...", a trailing "und". */
export function soundsUnfinished(text: string): boolean {
  const t = text.trim();
  if (/(\.\.\.|…)$/.test(t)) return true;
  if (!/[.!?]["'»«“”]?$/.test(t)) return true;
  return TRAILING_CONNECTIVE.test(t);
}

/**
 * A short listening sound or acknowledgement, said while the other one talks. "Hallo" belongs here
 * because people say it when they pick up, right as FORGE starts speaking.
 */
export function isBackchannel(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^a-zäöüß ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(m+h*m+|hm+|aha|ah|oh|ja|jaja|jap|okay|ok|genau|richtig|stimmt|klar|alles klar|gut|super|(ja )?hallo( hallo)?|ja bitte)$/.test(t);
}

/** Rejects as soon as the signal aborts, even if the promise itself never settles. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal, timeoutMessage: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(timeoutMessage));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(timeoutMessage));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Ends the iteration when the signal aborts, also when the source stalls and ignores the signal. */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal.aborted) return;
      let r: IteratorResult<T>;
      try {
        r = await raceAbort(it.next(), signal, "aborted");
      } catch (e) {
        if (signal.aborted) return;
        throw e;
      }
      if (r.done) return;
      yield r.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}
