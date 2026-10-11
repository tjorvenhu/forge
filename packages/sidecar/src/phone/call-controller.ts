import { beep, SAMPLE_RATE } from "./audio.js";
import type { RtpSession } from "./rtp.js";
import type { SipCall } from "./sip-ua.js";
import { Vad } from "./vad.js";
import type { VoiceProvider } from "./voice.js";

/** The part of the conversation partner the controller needs (PhoneAgent in production). */
export interface Conversation {
  say(text: string): void;
  close(): void;
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
  /** null when steering needs no PIN */
  checkPin: ((pin: string) => boolean) | null;
  /** spoken right when the call is up (incoming calls), before Claude answers */
  greeting: string | null;
  /** first message to Claude (outgoing calls: the reason); null waits for the caller */
  opening: string | null;
  onTranscript(role: "caller" | "forge", text: string): void;
  onUnlock(): void;
  log(message: string): void;
}

const MAX_PIN_TRIES = 3;
const IDLE_HANGUP_MS = 90_000;
const MAX_CALL_MS = 30 * 60_000;
const MAX_VOICE_ERRORS = 3;
const PREBUFFER_MS = 300;

/**
 * Runs one phone conversation over an established call: caller audio -> voice activity ->
 * transcription -> Claude -> speech -> RTP. The caller can interrupt FORGE (barge-in). Digits from
 * the keypad unlock steering (PIN + #); the PIN never reaches the language model.
 */
export class CallController {
  unlocked = false;
  private readonly vad = new Vad();
  private conversation: Conversation | null = null;
  private speechQueue: string[] = [];
  private speaking = false;
  private abort: AbortController | null = null;
  private pin = "";
  private pinTries = 0;
  private voiceErrors = 0;
  private hangupPending = false;
  private ended = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  /** outgoing calls prepare Claude's first words while it rings; held back until answered */
  private held: string[] | null = null;

  constructor(
    private readonly call: SipCall,
    private readonly rtp: RtpSession,
    private readonly d: CallControllerDeps,
  ) {
    this.rtp.on("audio", (frame) => this.vad.push(frame));
    this.rtp.on("dtmf", (digit) => this.onDigit(digit));
    this.call.on("dtmf", (digit) => this.onDigit(digit));
    this.rtp.on("drained", () => this.onDrained());
    this.vad.on("speechStart", () => this.onSpeechStart());
    this.vad.on("utterance", (pcm) => void this.onUtterance(pcm));
    this.call.on("ended", () => this.dispose());
  }

  /** Starts Claude before the call is answered, so the first words are ready (outgoing calls). */
  prepare() {
    this.held = [];
    this.startConversation();
  }

  /** The call is up and media flows. */
  begin() {
    this.rtp.start();
    if (this.d.greeting) this.speak(this.d.greeting);
    if (!this.conversation) this.startConversation();
    if (this.held) {
      const held = this.held;
      this.held = null;
      for (const s of held) this.speak(s);
    }
    this.touch();
    this.maxTimer = setTimeout(() => this.farewell("Das Gespräch dauert schon sehr lange. Ich lege jetzt auf."), MAX_CALL_MS);
  }

  private startConversation() {
    this.conversation = this.d.createConversation({
      onSentence: (s) => {
        this.d.onTranscript("forge", s);
        if (this.held) this.held.push(s);
        else this.speak(s);
      },
      onTurnDone: () => this.touch(),
      onHangup: () => {
        this.hangupPending = true;
        this.maybeHangup();
      },
      onError: (m) => {
        this.d.log(`Claude: ${m}`);
        this.farewell("Ich habe gerade ein technisches Problem und lege auf. Bitte versuch es gleich noch einmal.");
      },
    });
    if (this.d.opening) this.conversation.say(this.d.opening);
  }

  /** Says goodbye and hangs up once it is spoken. */
  farewell(text: string) {
    if (this.ended) return;
    this.speak(text);
    this.hangupPending = true;
    this.maybeHangup();
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.farewell("Ich höre nichts mehr und lege jetzt auf. Bis später."), IDLE_HANGUP_MS);
  }

  // ---------- speech output

  private speak(text: string) {
    if (this.ended || !text.trim()) return;
    this.speechQueue.push(text);
    void this.speakNext();
  }

  private async speakNext() {
    if (this.speaking || this.ended) return;
    const text = this.speechQueue.shift();
    if (text === undefined) {
      this.updateOutput();
      this.maybeHangup();
      return;
    }
    this.speaking = true;
    this.updateOutput();
    const abort = (this.abort = new AbortController());
    try {
      // The speech stream can start slower than real time. Collect a little before playing, so the
      // first syllables do not run dry and break up. Audio still queued from the last sentence counts.
      let started = this.rtp.queuedMs >= PREBUFFER_MS;
      let held: Int16Array[] = [];
      let heldSamples = 0;
      for await (const chunk of this.d.voice.speak(text, abort.signal)) {
        if (abort.signal.aborted || this.ended) break;
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
      this.voiceErrors = 0;
    } catch (e) {
      if (!abort.signal.aborted) {
        this.d.log(`Sprachausgabe: ${e instanceof Error ? e.message : String(e)}`);
        if (++this.voiceErrors >= MAX_VOICE_ERRORS) void this.call.hangup("Sprachausgabe fehlgeschlagen");
      }
    } finally {
      this.speaking = false;
      this.abort = null;
      void this.speakNext();
    }
  }

  private updateOutput() {
    this.vad.outputActive = this.speaking || this.rtp.playing || this.speechQueue.length > 0;
  }

  private onDrained() {
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

  /** The caller talks while FORGE speaks: stop talking and listen. */
  private onSpeechStart() {
    if (!(this.speaking || this.rtp.playing || this.speechQueue.length) || this.hangupPending) return;
    this.speechQueue = [];
    this.abort?.abort();
    this.rtp.clearPlayback();
    this.updateOutput();
  }

  // ---------- speech input

  private async onUtterance(pcm: Int16Array) {
    if (this.ended) return;
    this.touch();
    let text: string;
    try {
      text = await this.d.voice.transcribe(pcm);
      this.voiceErrors = 0;
    } catch (e) {
      this.d.log(`Spracherkennung: ${e instanceof Error ? e.message : String(e)}`);
      if (++this.voiceErrors >= MAX_VOICE_ERRORS) this.farewell("Die Spracherkennung funktioniert gerade nicht. Ich lege auf.");
      else this.speak("Das habe ich nicht verstanden. Sag es bitte noch einmal.");
      return;
    }
    // Silence and noise come back as nothing or as a lone filler.
    if (!text || /^[\s.,!?…-]*$/.test(text)) return;
    this.d.onTranscript("caller", text);
    this.conversation?.say(text);
  }

  // ---------- PIN via keypad

  private onDigit(digit: string) {
    if (this.ended) return;
    this.touch();
    if (!this.d.checkPin || this.unlocked) return;
    if (digit === "*") {
      this.pin = "";
      return;
    }
    if (digit !== "#") {
      if (this.pin.length < 16) this.pin += digit;
      return;
    }
    const entered = this.pin;
    this.pin = "";
    if (this.d.checkPin(entered)) {
      this.unlocked = true;
      this.d.onUnlock();
      this.rtp.play(beep());
      this.conversation?.say("[FORGE: Der Anrufer hat die PIN richtig eingegeben. Steuernde Werkzeuge sind jetzt frei. Bestätige das in einem kurzen Satz und mach mit seinem letzten Anliegen weiter.]");
      return;
    }
    if (++this.pinTries >= MAX_PIN_TRIES) {
      this.d.log("PIN dreimal falsch, Anruf beendet");
      this.farewell("Die PIN war mehrmals falsch. Ich lege auf.");
      return;
    }
    this.speak("Die PIN ist falsch. Bitte noch einmal eingeben und mit Raute bestätigen.");
  }

  dispose() {
    if (this.ended) return;
    this.ended = true;
    this.abort?.abort();
    this.speechQueue = [];
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.vad.reset();
    this.conversation?.close();
    this.rtp.close();
  }
}
