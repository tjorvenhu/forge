import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CallController, isBackchannel, soundsUnfinished, type CallControllerDeps, type ConversationCallbacks } from "../src/phone/call-controller.js";
import type { PinResult } from "../src/phone/pin-guard.js";
import type { RtpSession } from "../src/phone/rtp.js";
import type { SipCall } from "../src/phone/sip-ua.js";
import type { VoiceProvider } from "../src/phone/voice.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | null | false, ms = 3000, label = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(10);
  }
}

class FakeCall extends EventEmitter {
  hungUp: string | null = null;
  state = "active";
  async hangup(reason: string) {
    if (this.hungUp) return;
    this.hungUp = reason;
    this.state = "ended";
    this.emit("ended", reason);
  }
}

/** Plays instantly: queued audio counts as played; reports the end of playback like the real one, a moment later. */
class FakeRtp extends EventEmitter {
  played = 0;
  closed = false;
  queuedMs = 0;
  playing = false;
  start() {}
  play(pcm: Int16Array) {
    this.played += pcm.length;
  }
  flush() {
    setTimeout(() => this.emit("drained"), 0);
  }
  clearPlayback() {}
  close() {
    this.closed = true;
  }
}

interface Setup {
  call: FakeCall;
  rtp: FakeRtp;
  ctl: CallController;
  said: string[];
  spoken: string[];
  logs: string[];
  pins: string[];
  interrupts: number;
  /** callbacks of the conversation, to play Claude */
  cb(): ConversationCallbacks;
}

/** `autoDone` (default): Claude ends each turn at once without saying anything. */
function setup(o: { checkPin?: ((pin: string) => Promise<PinResult>) | null; voice?: Partial<VoiceProvider>; timing?: CallControllerDeps["timing"]; autoDone?: boolean } = {}): Setup {
  const call = new FakeCall();
  const rtp = new FakeRtp();
  const said: string[] = [];
  const spoken: string[] = [];
  const logs: string[] = [];
  const pins: string[] = [];
  let conversation: ConversationCallbacks | null = null;
  const voice: VoiceProvider = {
    transcribe: async () => "",
    async *speak(text) {
      spoken.push(text);
      yield new Int16Array(160);
    },
    ...o.voice,
  };
  const ctl = new CallController(call as unknown as SipCall, rtp as unknown as RtpSession, {
    voice,
    createConversation: (cb: ConversationCallbacks) => {
      conversation = cb;
      return {
        say: (t: string) => {
          said.push(t);
          if (o.autoDone !== false) cb.onTurnDone();
        },
        interrupt: () => void result.interrupts++,
        close() {},
      };
    },
    checkPin:
      o.checkPin === undefined
        ? async (pin) => {
            pins.push(pin);
            return pin === "4711" ? "ok" : "wrong";
          }
        : o.checkPin,
    greeting: null,
    opening: null,
    onTranscript: () => {},
    onUnlock: () => "",
    log: (m) => logs.push(m),
    timing: { turnEndMs: 10, turnEndUnfinishedMs: 100, ...o.timing },
  });
  const result: Setup = {
    call,
    rtp,
    ctl,
    said,
    spoken,
    logs,
    pins,
    interrupts: 0,
    cb: () => {
      if (!conversation) throw new Error("no conversation yet");
      return conversation;
    },
  };
  return result;
}

const press = (s: Setup, digits: string) => {
  for (const d of digits) s.rtp.emit("dtmf", d);
};

describe("call controller: PIN", () => {
  it("ignores digits before the call is up", async () => {
    const s = setup();
    press(s, "4711#");
    await sleep(20);
    expect(s.pins).toEqual([]);
    s.ctl.dispose();
  });

  it("hangs up after three wrong PINs and ignores every digit while saying goodbye", async () => {
    const s = setup();
    s.ctl.begin();
    for (const pin of ["1111#", "2222#", "3333#"]) {
      press(s, pin);
      await until(() => s.pins.length === ["1111#", "2222#", "3333#"].indexOf(pin) + 1, 1000, "pin checked");
      await sleep(10);
    }
    expect(s.spoken.at(-1)).toMatch(/mehrmals falsch/);
    // The right PIN during the goodbye must neither be checked nor unlock.
    press(s, "4711#");
    await sleep(30);
    expect(s.pins).toEqual(["1111", "2222", "3333"]);
    expect(s.ctl.unlocked).toBe(false);
    await until(() => s.call.hungUp, 2000, "hang up");
    expect(s.said.some((t) => t.includes("PIN richtig"))).toBe(false);
  });

  it("does not unlock when the goodbye started while the PIN was being checked", async () => {
    let release: (r: PinResult) => void = () => {};
    const s = setup({ checkPin: () => new Promise<PinResult>((r) => (release = r)) });
    s.ctl.begin();
    press(s, "4711#");
    s.ctl.farewell("Tschüss.");
    release("ok");
    await sleep(20);
    expect(s.ctl.unlocked).toBe(false);
    await until(() => s.call.hungUp, 2000, "hang up");
  });

  it("checks one PIN at a time and stops asking once the number is locked", async () => {
    const results: PinResult[] = ["locked"];
    let checks = 0;
    const s = setup({
      checkPin: async () => {
        checks++;
        await sleep(30);
        return results.shift() ?? "ok";
      },
    });
    s.ctl.begin();
    press(s, "1#2#3#");
    await until(() => s.spoken.some((t) => t.includes("vorübergehend gesperrt")), 1000, "locked message");
    press(s, "4711#");
    await sleep(60);
    expect(checks).toBe(1);
    expect(s.ctl.unlocked).toBe(false);
    expect(s.call.hungUp).toBeNull();
    s.ctl.dispose();
  });
});

describe("call controller: turn taking", () => {
  const vadOf = (s: Setup) => (s.ctl as unknown as { vad: EventEmitter }).vad;

  it("waits through pauses in an unfinished sentence and hands the whole turn to Claude at once", async () => {
    const heard = ["Schick S1 bitte", "dass die Tests laufen sollen."];
    const s = setup({ timing: { turnEndMs: 20, turnEndUnfinishedMs: 400 }, voice: { transcribe: async () => heard.shift() ?? "" } });
    s.ctl.begin();
    const vad = vadOf(s);
    vad.emit("speechStart");
    vad.emit("utterance", new Int16Array(800));
    await sleep(150);
    // "... bitte" without punctuation: the caller is not done yet.
    expect(s.said).toEqual([]);
    vad.emit("speechStart");
    vad.emit("utterance", new Int16Array(800));
    await until(() => s.said.length === 1, 1000, "turn handed over");
    expect(s.said).toEqual(["Schick S1 bitte dass die Tests laufen sollen."]);
    s.ctl.dispose();
  });

  it("stops talking when the caller talks, goes on after noise or a mhm, and drops the reply for real words", async () => {
    const heard: string[] = [];
    const s = setup({ autoDone: false, timing: { turnEndMs: 10 }, voice: { transcribe: async () => heard.shift() ?? "" } });
    s.ctl.begin();
    const vad = vadOf(s);
    heard.push("Wie ist der Stand?");
    vad.emit("speechStart");
    vad.emit("utterance", new Int16Array(800));
    await until(() => s.said.length === 1, 1000, "first turn");
    const cb = s.cb();
    cb.onSentence("S1 ist fertig.");
    await until(() => s.spoken.includes("S1 ist fertig."), 1000, "first sentence");
    await sleep(20);

    // Noise: FORGE holds back while it lasts, then goes on.
    vad.emit("speechStart");
    cb.onSentence("Die Tests sind grün.");
    await sleep(40);
    expect(s.spoken).not.toContain("Die Tests sind grün.");
    vad.emit("noise");
    await until(() => s.spoken.includes("Die Tests sind grün."), 1000, "goes on after noise");
    await sleep(20);

    // A lone "mhm" is listening, not a new turn.
    vad.emit("speechStart");
    cb.onSentence("Soll ich committen?");
    heard.push("Mhm.");
    vad.emit("utterance", new Int16Array(800));
    await until(() => s.spoken.includes("Soll ich committen?"), 1000, "goes on after mhm");
    expect(s.said).toHaveLength(1);
    expect(s.interrupts).toBe(0);
    await sleep(20);

    // Real words: the reply is dropped, Claude stops writing and gets the new words after its turn ends.
    vad.emit("speechStart");
    cb.onSentence("Außerdem läuft der Dev-Server.");
    heard.push("Nein, schalte lieber Remote ein.");
    vad.emit("utterance", new Int16Array(800));
    await until(() => s.interrupts === 1, 1000, "interrupted");
    cb.onSentence("Das kommt zu spät.");
    await sleep(40);
    expect(s.said).toHaveLength(1);
    cb.onTurnDone();
    await until(() => s.said.length === 2, 1000, "new words to Claude");
    expect(s.said[1]).toBe("Nein, schalte lieber Remote ein.");
    expect(s.spoken).not.toContain("Außerdem läuft der Dev-Server.");
    expect(s.spoken).not.toContain("Das kommt zu spät.");
    s.ctl.dispose();
  });

  it("sends notes to Claude only between turns", async () => {
    const s = setup({ autoDone: false, checkPin: async () => "ok", timing: { turnEndMs: 10 }, voice: { transcribe: async () => "Starte eine Session." } });
    s.ctl.begin();
    const vad = vadOf(s);
    vad.emit("utterance", new Int16Array(800));
    await until(() => s.said.length === 1, 1000, "turn");
    press(s, "4711#");
    await until(() => s.ctl.unlocked, 1000, "unlocked");
    await sleep(20);
    expect(s.said).toHaveLength(1);
    s.cb().onTurnDone();
    await until(() => s.said.length === 2, 1000, "note after the turn");
    expect(s.said[1]).toMatch(/PIN richtig/);
    s.ctl.dispose();
  });

  it("tells unfinished sentences and listening sounds apart", () => {
    expect(soundsUnfinished("Schick S1 bitte")).toBe(true);
    expect(soundsUnfinished("Ich wollte fragen, ob…")).toBe(true);
    expect(soundsUnfinished("Mach das und.")).toBe(true);
    expect(soundsUnfinished("Wie ist der Stand?")).toBe(false);
    expect(isBackchannel("Mhm.")).toBe(true);
    expect(isBackchannel("Okay!")).toBe(true);
    expect(isBackchannel("Ja, hallo?")).toBe(true);
    expect(isBackchannel("Okay, dann stopp S1.")).toBe(false);
  });
});

describe("call controller: speech service problems", () => {
  it("does not stay silent forever when speech output stalls, so the goodbye still hangs up", async () => {
    const s = setup({
      timing: { speakTimeoutMs: 80 },
      voice: {
        // Ignores the signal on purpose: the controller must not depend on the provider behaving.
        async *speak() {
          await new Promise(() => {});
          yield new Int16Array(0);
        },
      },
    });
    s.ctl.begin();
    s.ctl.farewell("Tschüss.");
    await until(() => s.call.hungUp, 2000, "hang up after stalled speech");
    expect(s.logs.some((l) => l.includes("nicht rechtzeitig"))).toBe(true);
  });

  it("transcribes utterances one after the other and drops results after the call ended", async () => {
    const pending: Array<(text: string) => void> = [];
    const s = setup({
      voice: {
        transcribe: () => new Promise<string>((r) => pending.push(r)),
      },
    });
    s.ctl.begin();
    const vad = (s.ctl as unknown as { vad: EventEmitter }).vad;
    vad.emit("utterance", new Int16Array(800));
    vad.emit("utterance", new Int16Array(800));
    await sleep(10);
    expect(pending).toHaveLength(1);
    pending[0]!("erstens,");
    await until(() => pending.length === 2, 1000, "second transcription started");
    // The turn is not over while the caller's words are still being transcribed.
    expect(s.said).toEqual([]);
    pending[1]!("zweitens.");
    await until(() => s.said.length === 1, 1000, "turn handed over");
    expect(s.said).toEqual(["erstens, zweitens."]);
    vad.emit("utterance", new Int16Array(800));
    await sleep(10);
    s.call.emit("ended", "Gegenstelle hat aufgelegt");
    pending[2]!("drittens.");
    await sleep(40);
    expect(s.said).toEqual(["erstens, zweitens."]);
    expect(s.rtp.closed).toBe(true);
  });

  it("times out a transcription that never answers", async () => {
    const s = setup({ timing: { transcribeTimeoutMs: 50 }, voice: { transcribe: () => new Promise<string>(() => {}) } });
    s.ctl.begin();
    (s.ctl as unknown as { vad: EventEmitter }).vad.emit("utterance", new Int16Array(800));
    await until(() => s.spoken.some((t) => t.includes("nicht verstanden")), 1000, "retry prompt");
    s.ctl.dispose();
  });
});
