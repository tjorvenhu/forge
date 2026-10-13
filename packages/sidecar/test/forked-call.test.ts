import { EventEmitter } from "node:events";
import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { ForkedCall } from "../src/phone/forked-call.js";
import { RtpSession } from "../src/phone/rtp.js";
import type { CallEvents, SipCall } from "../src/phone/sip-ua.js";
import { activeNumbers } from "../src/phone/phone-service.js";

/** Stands in for an outgoing SipCall: ringing until answered or ended, hangup like the real one. */
class FakeLeg extends EventEmitter<CallEvents> {
  state: "ringing" | "active" | "ended" = "ringing";
  onOffer: ((sdp: string) => string | null) | null = null;
  hangups: string[] = [];
  constructor(readonly remoteNumber: string) {
    super();
  }
  answer(body = "v=0") {
    this.state = "active";
    this.emit("answered", body);
  }
  end(why: string) {
    if (this.state === "ended") return;
    this.state = "ended";
    this.emit("ended", why);
  }
  async hangup(reason = "Aufgelegt") {
    this.hangups.push(reason);
    this.end(reason);
  }
}

const fork = (...numbers: string[]) => {
  const legs = numbers.map((n) => new FakeLeg(n));
  const call = new ForkedCall(legs as unknown as SipCall[]);
  const events: string[] = [];
  call.on("ringing", () => events.push("ringing"));
  call.on("answered", (b) => events.push(`answered:${b}`));
  call.on("ended", (why) => events.push(`ended:${why}`));
  call.on("dtmf", (d) => events.push(`dtmf:${d}`));
  return { call, legs, events };
};

describe("ForkedCall", () => {
  it("gives the call to the first number that answers and cancels the others", () => {
    const { call, legs, events } = fork("0172 1", "0151 2", "0160 3");
    expect(call.remoteNumber).toBe("0172 1, 0151 2, 0160 3");
    legs[0]!.emit("ringing");
    legs[1]!.emit("ringing");
    legs[1]!.answer("sdp-b");
    expect(events).toEqual(["ringing", "answered:sdp-b"]);
    expect(call.remoteNumber).toBe("0151 2");
    expect(call.state).toBe("active");
    expect(legs[0]!.hangups).toEqual(["An einer anderen Nummer angenommen"]);
    expect(legs[2]!.hangups).toEqual(["An einer anderen Nummer angenommen"]);
    // The cancelled legs end without ending the call; key presses only count from the answering one.
    legs[0]!.emit("dtmf", "1");
    legs[1]!.emit("dtmf", "2");
    expect(events).toEqual(["ringing", "answered:sdp-b", "dtmf:2"]);
    legs[1]!.end("Gegenstelle hat aufgelegt");
    expect(events.at(-1)).toBe("ended:Gegenstelle hat aufgelegt");
    expect(call.state).toBe("ended");
  });

  it("hangs up a second number that answered in the same moment", () => {
    const { legs, events } = fork("a", "b");
    legs[0]!.answer();
    // Its 200 OK crossed the CANCEL: it answered anyway and gets a BYE.
    legs[1]!.state = "active";
    legs[1]!.emit("answered", "late");
    expect(events.filter((e) => e.startsWith("answered"))).toHaveLength(1);
    expect(legs[1]!.state).toBe("ended");
  });

  it("ends only when no number rings any more and says per number why", () => {
    const { call, legs, events } = fork("0172 1", "0151 2");
    legs[0]!.end("Besetzt");
    expect(call.state).toBe("ringing");
    expect(events).toEqual([]);
    legs[1]!.end("Keine Antwort");
    expect(events).toEqual(["ended:0172 1: Besetzt; 0151 2: Keine Antwort"]);
  });

  it("names the reason once when every number ended the same way, and cancels all when FORGE hangs up", async () => {
    const { call, legs, events } = fork("a", "b");
    await call.hangup("Abgebrochen");
    expect(legs.map((l) => l.hangups)).toEqual([["Abgebrochen"], ["Abgebrochen"]]);
    expect(events).toEqual(["ended:Abgebrochen"]);
  });

  it("passes re-offers of the answering number on, not of the others", () => {
    const { call, legs } = fork("a", "b");
    call.onOffer = (sdp) => `answer:${sdp}`;
    legs[0]!.answer();
    expect(legs[0]!.onOffer?.("x")).toBe("answer:x");
    expect(legs[1]!.onOffer?.("y")).toBeNull();
  });
});

describe("phone number lists", () => {
  it("counts only switched-on, non-empty numbers", () => {
    expect(
      activeNumbers([
        { id: "1", number: " 0172 1 ", label: "Handy", enabled: true },
        { id: "2", number: "0151 2", label: "", enabled: false },
        { id: "3", number: " ", label: "", enabled: true },
      ]),
    ).toEqual(["0172 1"]);
  });
});

describe("RTP after a call to several numbers", () => {
  it("latches only the answering address for a moment, then any port of an allowed host again", async () => {
    const rtp = new RtpSession("127.0.0.1");
    await rtp.open();
    const answering = createSocket("udp4");
    const cancelled = createSocket("udp4");
    await new Promise<void>((r) => answering.bind(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => cancelled.bind(0, "127.0.0.1", () => r()));
    const heard: number[] = [];
    rtp.on("audio", () => heard.push(Date.now()));
    const packet = () => {
      const p = Buffer.alloc(12 + 160, 0xd5);
      p[0] = 0x80;
      p[1] = 8;
      return p;
    };
    const remote = () => (rtp as unknown as { remote: { port: number } }).remote.port;
    const settle = () => new Promise((r) => setTimeout(r, 60));
    rtp.configure({ ip: "127.0.0.1", port: answering.address().port }, 8, 101, [], 300);
    // Early media of a cancelled number from another port: dropped, nothing latched.
    cancelled.send(packet(), rtp.port, "127.0.0.1");
    await settle();
    expect(heard).toHaveLength(0);
    answering.send(packet(), rtp.port, "127.0.0.1");
    await settle();
    expect(heard).toHaveLength(1);
    expect(remote()).toBe(answering.address().port);

    // Without the window (one number) the first allowed packet latches, whatever its port.
    rtp.configure({ ip: "127.0.0.1", port: answering.address().port }, 8, 101);
    cancelled.send(packet(), rtp.port, "127.0.0.1");
    await settle();
    expect(remote()).toBe(cancelled.address().port);
    for (const s of [answering, cancelled]) s.close();
    rtp.close();
  });
});
