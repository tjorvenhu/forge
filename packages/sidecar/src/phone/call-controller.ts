import { beep, SAMPLE_RATE } from "./audio.js";
import type { PinResult } from "./pin-guard.js";
import type { RtpSession } from "./rtp.js";
import type { SipCall } from "./sip-ua.js";
import { Vad } from "./vad.js";
import { SPEAK_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS, type VoiceProvider } from "./voice.js";

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
  /** null when steering needs no PIN; "locked" when PIN entry is blocked after too many failures */
  checkPin: ((pin: string) => Promise<PinResult>) | null;
  /** spoken right when the call is up (incoming calls), before Claude answers */
  greeting: string | null;
  /** first message to Claude (outgoing calls: the reason); null waits for the caller */
  opening: string | null;
  onTranscript(role: "caller" | "forge", text: string): void;
  onUnlock(): void;
  log(message: string): void;
  /** shorter limits in tests */
  timing?: { speakTimeoutMs?: number; transcribeTimeoutMs?: number; confirmTimeoutMs?: number };
}

const MAX_PIN_TRIES = 3;
const IDLE_HANGUP_MS = 90_000;
const MAX_CALL_MS = 30 * 60_000;
const MAX_VOICE_ERRORS = 3;
const PREBUFFER_MS = 300;
const CONFIRM_TIMEOUT_MS = 45_000;
/** keypad digits for a pending confirmation */
const CONFIRM_KEY = "1";
const CANCEL_KEY = "2";

interface PendingConfirmation {
  run: () => Promise<string>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs one phone conversation over an established call: caller audio -> voice activity ->
 * transcription -> Claude -> speech -> RTP. The caller can interrupt FORGE (barge-in). Digits from
 * the keypad unlock steering (PIN + #) and confirm steering actions (1); neither goes through the
 * language model, so nothing Claude reads or hears can unlock or confirm on its own.
 */
export class CallController {
  unlocked = false;
  private readonly vad = new Vad();
  private conversation: Conversation | null = null;
  private speechQueue: string[] = [];
  private speaking = false;
  private abort: AbortController | null = null;
  /** aborted when the call ends: cancels transcriptions still in flight */
  private readonly life = new AbortController();
  private utterances: Int16Array[] = [];
  private transcribing = false;
  private pin = "";
  private pinTries = 0;
  /** no more PIN attempts in this call: limit reached or locked */
  private pinClosed = false;
  private pinChecking = false;
  private confirmation: PendingConfirmation | null = null;
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
    private readonly call: SipCall,
    private readonly rtp: RtpSession,
    private readonly d: CallControllerDeps,
  ) {
    // Before the call is up, audio is ringback or an announcement of the network, not the caller.
    this.rtp.on("audio", (frame) => {
      if (this.begun) this.vad.push(frame);
    });
    this.rtp.on("dtmf", (digit) => this.onDigit(digit));
    this.call.on("dtmf", (digit) => this.onDigit(digit));
    this.rtp.on("drained", () => this.onDrained());
    this.vad.on("speechStart", () => this.onSpeechStart());
    this.vad.on("utterance", (pcm) => this.onUtterance(pcm));
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
        this.closing = true;
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
    this.closing = true;
    this.cancelConfirmation(null);
    this.speak(text);
    this.hangupPending = true;
    this.maybeHangup();
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.farewell("Ich höre nichts mehr und lege jetzt auf. Bis später."), IDLE_HANGUP_MS);
  }

  // ---------- confirmation of steering actions via keypad

  /**
   * FORGE itself reads out what is about to happen; `run` executes only after the caller presses 1.
   * The outcome reaches Claude as a note. A spoken "yes" is not enough on purpose: text from sessions
   * could talk Claude into calling a tool, but it cannot press a key on the caller's phone.
   */
  requestConfirmation(text: string, run: () => Promise<string>) {
    if (this.ended || this.closing) return;
    this.cancelConfirmation("[FORGE: Die vorige Bestätigung wurde durch eine neue ersetzt und nicht ausgeführt.]");
    const timer = setTimeout(
      () => this.cancelConfirmation("[FORGE: Der Anrufer hat nicht über die Tastatur bestätigt. Nichts wurde ausgeführt.]"),
      this.d.timing?.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS,
    );
    this.confirmation = { run, timer };
    this.speak(`${text} Zum Bestätigen die Taste 1 drücken, zum Abbrechen die 2.`);
  }

  get confirmationPending(): boolean {
    return this.confirmation !== null;
  }

  private cancelConfirmation(note: string | null) {
    const c = this.confirmation;
    if (!c) return;
    clearTimeout(c.timer);
    this.confirmation = null;
    if (note) this.conversation?.say(note);
  }

  private onConfirmDigit(digit: string) {
    const c = this.confirmation;
    if (!c) return;
    if (digit === CANCEL_KEY) {
      this.cancelConfirmation("[FORGE: Der Anrufer hat mit der Taste 2 abgebrochen. Nichts wurde ausgeführt.]");
      return;
    }
    if (digit !== CONFIRM_KEY) return;
    clearTimeout(c.timer);
    this.confirmation = null;
    this.rtp.play(beep());
    void c
      .run()
      .catch((e: unknown) => `Fehler: ${e instanceof Error ? e.message : String(e)}`)
      .then((result) => {
        if (!this.ended) this.conversation?.say(`[FORGE: Der Anrufer hat mit der Taste 1 bestätigt. Ergebnis: ${result}]`);
      });
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
    if (!(this.speaking || this.rtp.playing || this.speechQueue.length) || this.closing) return;
    this.speechQueue = [];
    this.abort?.abort();
    this.rtp.clearPlayback();
    this.updateOutput();
  }

  // ---------- speech input

  /** Utterances are transcribed one after the other, so Claude gets them in the order they were said. */
  private onUtterance(pcm: Int16Array) {
    if (this.ended) return;
    this.touch();
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
        if (++this.voiceErrors >= MAX_VOICE_ERRORS) this.farewell("Die Spracherkennung funktioniert gerade nicht. Ich lege auf.");
        else this.speak("Das habe ich nicht verstanden. Sag es bitte noch einmal.");
        return;
      }
      if (this.ended) return;
      // Silence and noise come back as nothing or as a lone filler.
      if (!text || /^[\s.,!?…-]*$/.test(text)) return;
      this.d.onTranscript("caller", text);
      this.conversation?.say(text);
    } finally {
      this.transcribing = false;
      void this.transcribeNext();
    }
  }

  // ---------- keypad: confirmation and PIN

  private onDigit(digit: string) {
    if (this.ended || !this.begun) return;
    this.touch();
    if (this.confirmation) return this.onConfirmDigit(digit);
    if (!this.d.checkPin || this.unlocked || this.pinClosed || this.closing || this.pinChecking) return;
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
    this.pinChecking = true;
    void this.d
      .checkPin(entered)
      .catch((e: unknown) => {
        this.d.log(`PIN-Prüfung: ${e instanceof Error ? e.message : String(e)}`);
        return "wrong" as const;
      })
      .then((result) => {
        this.pinChecking = false;
        this.onPinResult(result);
      });
  }

  private onPinResult(result: PinResult) {
    // A goodbye may have started while the PIN was checked; a late correct PIN must not unlock it.
    if (this.ended || this.closing || this.pinClosed) return;
    if (result === "ok") {
      this.unlocked = true;
      this.d.onUnlock();
      this.rtp.play(beep());
      this.conversation?.say("[FORGE: Der Anrufer hat die PIN richtig eingegeben. Steuernde Werkzeuge sind jetzt frei. Bestätige das in einem kurzen Satz.]");
      return;
    }
    if (result === "locked") {
      this.pinClosed = true;
      this.d.log("PIN-Eingabe gesperrt (zu viele Fehlversuche)");
      this.speak("Die PIN-Eingabe ist nach zu vielen Fehlversuchen vorübergehend gesperrt. Steuern geht in diesem Gespräch nicht.");
      return;
    }
    if (++this.pinTries >= MAX_PIN_TRIES) {
      this.pinClosed = true;
      this.d.log("PIN dreimal falsch, Anruf beendet");
      this.farewell("Die PIN war mehrmals falsch. Ich lege auf.");
      return;
    }
    this.speak("Die PIN ist falsch. Bitte noch einmal eingeben und mit Raute bestätigen.");
  }

  dispose() {
    if (this.ended) return;
    this.ended = true;
    this.life.abort();
    this.abort?.abort();
    this.speechQueue = [];
    this.utterances = [];
    this.cancelConfirmation(null);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.vad.reset();
    this.conversation?.close();
    this.rtp.close();
  }
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
