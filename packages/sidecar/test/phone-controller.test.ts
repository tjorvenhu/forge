import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CallController, type ConversationCallbacks } from "../src/phone/call-controller.js";
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

/** Plays instantly: queued audio counts as played. */
class FakeRtp extends EventEmitter {
  played = 0;
  closed = false;
  queuedMs = 0;
  playing = false;
  start() {}
  play(pcm: Int16Array) {
    this.played += pcm.length;
  }
  flush() {}
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
}

function setup(o: { checkPin?: ((pin: string) => Promise<PinResult>) | null; voice?: Partial<VoiceProvider>; timing?: { speakTimeoutMs?: number; transcribeTimeoutMs?: number; confirmTimeoutMs?: number } } = {}): Setup {
  const call = new FakeCall();
  const rtp = new FakeRtp();
  const said: string[] = [];
  const spoken: string[] = [];
  const logs: string[] = [];
  const pins: string[] = [];
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
    createConversation: (_cb: ConversationCallbacks) => ({ say: (t: string) => said.push(t), close() {} }),
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
    onUnlock: () => {},
    log: (m) => logs.push(m),
    timing: o.timing,
  });
  return { call, rtp, ctl, said, spoken, logs, pins };
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

describe("call controller: confirmation by keypad", () => {
  it("runs a steering action only after key 1 and reports the result to Claude", async () => {
    const s = setup({ checkPin: null });
    s.ctl.begin();
    let runs = 0;
    s.ctl.requestConfirmation("Nachricht an S1: Mach weiter", async () => {
      runs++;
      return "An S1 gesendet.";
    });
    await until(() => s.spoken.some((t) => t.startsWith("Nachricht an S1: Mach weiter") && t.includes("Taste 1")), 1000, "read out");
    press(s, "9");
    await sleep(20);
    expect(runs).toBe(0);
    press(s, "1");
    await until(() => s.said.some((t) => t.includes("Taste 1 bestätigt") && t.includes("An S1 gesendet.")), 1000, "result note");
    expect(runs).toBe(1);
    press(s, "1");
    await sleep(20);
    expect(runs).toBe(1);
    s.ctl.dispose();
  });

  it("cancels with key 2, on timeout and when the call ends", async () => {
    const s = setup({ checkPin: null, timing: { confirmTimeoutMs: 50 } });
    s.ctl.begin();
    let runs = 0;
    const run = async () => {
      runs++;
      return "ok";
    };
    s.ctl.requestConfirmation("A", run);
    press(s, "2");
    expect(s.said.at(-1)).toMatch(/abgebrochen/);
    s.ctl.requestConfirmation("B", run);
    await until(() => s.said.at(-1)?.includes("nicht über die Tastatur bestätigt"), 1000, "timeout");
    s.ctl.requestConfirmation("C", run);
    s.ctl.dispose();
    press(s, "1");
    await sleep(20);
    expect(runs).toBe(0);
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
    pending[0]!("erstens");
    await until(() => pending.length === 2, 1000, "second transcription started");
    expect(s.said).toEqual(["erstens"]);
    s.call.emit("ended", "Gegenstelle hat aufgelegt");
    pending[1]!("zweitens");
    await sleep(20);
    expect(s.said).toEqual(["erstens"]);
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
