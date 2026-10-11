import { createSocket } from "node:dgram";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStore } from "../src/phone/secrets.js";
import { describe, expect, it } from "vitest";
import { alawToLinear, beep, decodeG711, Downsampler, encodeG711, linearToAlaw, linearToMulaw, mulawToLinear, pcmToWav, rms } from "../src/phone/audio.js";
import { digestAuthorization, parseChallenge } from "../src/phone/digest.js";
import { buildSdp, chooseCodec, parseSdp, PT_PCMA, PT_PCMU } from "../src/phone/sdp.js";
import { getHeader, getHeaders, parseNameAddr, parseSip, parseVia, responseTo, serializeSip, uriUser } from "../src/phone/sip-message.js";
import { RtpSession } from "../src/phone/rtp.js";
import { Vad } from "../src/phone/vad.js";
import { speakable } from "../src/phone/phone-agent.js";
import { sameNumber } from "../src/phone/phone-service.js";
import { OpenAiVoice } from "../src/phone/voice.js";

const tone = (ms: number, freq: number, rate: number, amp = 8000) =>
  Int16Array.from({ length: Math.round((rate * ms) / 1000) }, (_, i) => Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp));

describe("SIP messages", () => {
  const raw = [
    "INVITE sip:forge@10.0.0.2:5062 SIP/2.0",
    "v: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKabc;rport, SIP/2.0/UDP 10.0.0.9;branch=z9hG4bKdef",
    'f: "Tjorven" <sip:+4930123456@pbx.example>;tag=111',
    "t: <sip:forge@pbx.example>",
    "i: call-1@pbx",
    "CSeq: 7 INVITE",
    "Subject: lange",
    " Zeile",
    "c: application/sdp",
    "l: 4",
    "",
    "v=0\r\nextra",
  ].join("\r\n");

  it("parses compact headers, folded lines, header lists and the body by Content-Length", () => {
    const m = parseSip(raw)!;
    expect(m.method).toBe("INVITE");
    expect(getHeaders(m, "via")).toHaveLength(2);
    expect(getHeader(m, "from")).toContain("tag=111");
    expect(getHeader(m, "subject")).toBe("lange Zeile");
    expect(m.body).toBe("v=0\r");
    expect(parseSip("\r\n\r\n")).toBeNull();
    expect(parseSip("HELLO world")).toBeNull();
  });

  it("builds responses with the request's Via, From, Call-ID, CSeq and our To tag", () => {
    const res = responseTo(parseSip(raw)!, 180, "Ringing", "ourtag");
    const text = serializeSip(res);
    expect(text.startsWith("SIP/2.0 180 Ringing\r\n")).toBe(true);
    expect(text).toContain("To: <sip:forge@pbx.example>;tag=ourtag");
    expect(text).toContain("Call-ID: call-1@pbx");
    expect(text).toContain("Content-Length: 0");
    const back = parseSip(text)!;
    expect(back.status).toBe(180);
    expect(getHeaders(back, "via")).toHaveLength(2);
  });

  it("reads name-addr, Via and the number in a URI", () => {
    const na = parseNameAddr('"Tjorven" <sip:+4930123456@pbx.example;user=phone>;tag=111');
    expect(na).toMatchObject({ display: "Tjorven", uri: "sip:+4930123456@pbx.example;user=phone", params: { tag: "111" } });
    expect(uriUser(na.uri)).toBe("+4930123456");
    expect(parseNameAddr("sip:a@b;tag=x").params.tag).toBe("x");
    expect(parseVia("SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bKabc;rport=4000;received=1.2.3.4")).toMatchObject({
      transport: "UDP",
      host: "10.0.0.1",
      port: 5060,
      params: { branch: "z9hG4bKabc", rport: "4000", received: "1.2.3.4" },
    });
  });
});

describe("digest auth", () => {
  it("matches the RFC 2617 example", () => {
    const ch = parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
    const h = digestAuthorization(ch, { username: "Mufasa", password: "Circle Of Life", method: "GET", uri: "/dir/index.html", nc: 1, cnonce: "0a4f113b" });
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(h).toContain("qop=auth, nc=00000001");
  });

  it("works without qop", () => {
    const ch = parseChallenge('Digest realm="asterisk", nonce="abc"')!;
    expect(ch.qop).toBeNull();
    expect(digestAuthorization(ch, { username: "u", password: "p", method: "REGISTER", uri: "sip:pbx" })).not.toContain("qop");
  });
});

describe("SDP", () => {
  it("offers G.711 and DTMF and picks the remote's preferred codec", () => {
    const offer = parseSdp(buildSdp({ ip: "10.0.0.2", port: 40002, sessionId: "1", version: 1 }))!;
    expect(offer).toMatchObject({ ip: "10.0.0.2", port: 40002, payloads: [8, 0, 101], dtmfPt: 101, secure: false });
    const remote = parseSdp("v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 30000 RTP/AVP 9 0 8 96\r\na=rtpmap:96 telephone-event/8000\r\n")!;
    expect(chooseCodec(remote)).toBe(PT_PCMU);
    expect(remote.dtmfPt).toBe(96);
    expect(parseSdp("v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 1 RTP/SAVP 8\r\n")!.secure).toBe(true);
    expect(chooseCodec(parseSdp("v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 1 RTP/AVP 9 18\r\n")!)).toBeNull();
    expect(buildSdp({ ip: "1.1.1.1", port: 2, sessionId: "1", version: 1, codec: PT_PCMA, dtmfPt: null })).not.toContain("telephone-event");
  });
});

describe("audio", () => {
  it("encodes G.711 like the reference and round-trips speech levels closely", () => {
    expect(linearToAlaw(0)).toBe(0xd5);
    expect(linearToMulaw(0)).toBe(0xff);
    expect(alawToLinear(0xd5)).toBe(8);
    expect(mulawToLinear(0xff)).toBe(0);
    for (const s of [-30000, -5000, -100, 0, 99, 1234, 20000, 32767]) {
      expect(Math.abs(alawToLinear(linearToAlaw(s)) - s)).toBeLessThanOrEqual(Math.max(16, Math.abs(s) / 16));
      expect(Math.abs(mulawToLinear(linearToMulaw(s)) - s)).toBeLessThanOrEqual(Math.max(16, Math.abs(s) / 16));
    }
    const t = tone(20, 440, 8000);
    expect(rms(decodeG711(encodeG711(t, 8), 8))).toBeCloseTo(rms(t), -2);
  });

  it("downsamples 24 kHz speech to the phone band without aliasing", () => {
    const down = new Downsampler(3);
    const pass = down.push(tone(200, 1000, 24000));
    expect(pass.length).toBe(1600);
    expect(rms(pass.subarray(200))).toBeGreaterThan(rms(tone(200, 1000, 24000)) * 0.8);
    const stop = new Downsampler(3).push(tone(200, 7000, 24000));
    expect(rms(stop.subarray(200))).toBeLessThan(rms(tone(200, 7000, 24000)) * 0.1);
  });

  it("writes a valid WAV header", () => {
    const wav = pcmToWav(new Int16Array(160));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.length).toBe(44 + 320);
    expect(beep().length).toBeGreaterThan(0);
  });
});

describe("voice activity", () => {
  const frames = (pcm: Int16Array) => Array.from({ length: pcm.length / 160 }, (_, i) => pcm.subarray(i * 160, (i + 1) * 160));
  const noise = (ms: number, amp: number) => Int16Array.from({ length: (ms / 1000) * 8000 }, () => Math.round((Math.random() * 2 - 1) * amp));

  it("cuts an utterance after a pause and ignores clicks and quiet noise", () => {
    const vad = new Vad();
    const got: Int16Array[] = [];
    let starts = 0;
    vad.on("utterance", (u) => got.push(u));
    vad.on("speechStart", () => starts++);
    for (const f of frames(noise(1000, 60))) vad.push(f);
    for (const f of frames(tone(80, 300, 8000, 9000))) vad.push(f);
    for (const f of frames(noise(1000, 60))) vad.push(f);
    expect(got).toHaveLength(0);
    for (const f of frames(tone(900, 300, 8000, 9000))) vad.push(f);
    for (const f of frames(noise(900, 60))) vad.push(f);
    expect(starts).toBe(2);
    expect(got).toHaveLength(1);
    expect(got[0]!.length).toBeGreaterThan(8000 * 0.9);
  });

  it("needs louder speech while FORGE itself is talking", () => {
    const vad = new Vad();
    let starts = 0;
    vad.on("speechStart", () => starts++);
    vad.outputActive = true;
    for (const f of frames(tone(400, 300, 8000, 900))) vad.push(f);
    expect(starts).toBe(0);
    for (const f of frames(tone(400, 300, 8000, 9000))) vad.push(f);
    expect(starts).toBe(1);
  });
});

describe("speech playback without crackling", () => {
  /** Longest run of near-silent samples; a gap inside a loud tone is what was heard as a crack. */
  const longestGap = (pcm: Int16Array) => {
    let run = 0;
    let max = 0;
    for (const s of pcm) {
      run = Math.abs(s) < 200 ? run + 1 : 0;
      max = Math.max(max, run);
    }
    return max;
  };

  it("joins streamed chunks of any size without inserting silence", async () => {
    const tx = new RtpSession("127.0.0.1");
    const rx = new RtpSession("127.0.0.1");
    await tx.open();
    await rx.open();
    tx.configure({ ip: "127.0.0.1", port: rx.port }, 8, 101);
    rx.configure({ ip: "127.0.0.1", port: tx.port }, 8, 101);
    const got: Int16Array[] = [];
    rx.on("audio", (f) => got.push(f));
    // 1 kHz has no near-zero runs longer than a sample or two at 8 kHz.
    const t = tone(600, 1000, 8000, 12000);
    let i = 0;
    for (const size of [77, 333, 1001, 13, 160, 999, 2000]) {
      tx.play(t.subarray(i, i + size));
      i += size;
    }
    tx.play(t.subarray(i));
    tx.flush();
    tx.start();
    await new Promise((r) => setTimeout(r, 900));
    tx.close();
    rx.close();
    const voiced = got.filter((f) => rms(f) > 1000);
    expect(voiced.length).toBeGreaterThanOrEqual(29);
    const joined = new Int16Array(voiced.length * 160);
    voiced.forEach((f, k) => joined.set(f, k * 160));
    expect(longestGap(joined.subarray(0, joined.length - 160))).toBeLessThan(4);
  });

  it("fades out the end of an utterance and a barge-in instead of breaking off", () => {
    const rtp = new RtpSession("127.0.0.1");
    rtp.play(new Int16Array(100).fill(10000));
    expect(rtp.playing).toBe(true);
    rtp.flush();
    const last = (rtp as unknown as { queue: Int16Array[] }).queue[0]!;
    expect(last[0]).toBe(10000);
    expect(Math.abs(last[99]!)).toBeLessThan(200);
    expect(last[100]).toBe(0);
    rtp.play(new Int16Array(800).fill(10000));
    rtp.clearPlayback();
    const queue = (rtp as unknown as { queue: Int16Array[] }).queue;
    expect(queue).toHaveLength(1);
    expect(queue[0]![0]).toBe(10000);
    expect(Math.abs(queue[0]![159]!)).toBeLessThan(100);
  });

  it("leaves headroom so loud speech from the speech service is not clipped", async () => {
    // Full-scale 24 kHz square-ish speech stand-in, delivered in odd byte counts like a real stream.
    const pcm24 = Int16Array.from({ length: 24000 }, (_, k) => (Math.floor(k / 30) % 2 ? 32767 : -32768));
    const bytes = new Uint8Array(pcm24.buffer);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      const chunks: Uint8Array[] = [];
      for (let k = 0; k < bytes.length; k += 1001) chunks.push(bytes.subarray(k, k + 1001));
      return new Response(new ReadableStream({ start(c) { chunks.forEach((ch) => c.enqueue(ch)); c.close(); } }), { status: 200 });
    }) as typeof fetch;
    try {
      const out: number[] = [];
      for await (const chunk of new OpenAiVoice("sk-test", { voice: "marin", sttModel: "x", ttsModel: "y" }).speak("Hallo", new AbortController().signal)) out.push(...chunk);
      expect(out.length).toBe(8000);
      const peak = Math.max(...out.map(Math.abs));
      expect(peak).toBeLessThan(32767);
      expect(peak).toBeGreaterThan(20000);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("RTP", () => {
  it("sends queued audio and silence every 20 ms, receives audio and reports DTMF once", async () => {
    const a = new RtpSession("127.0.0.1");
    const b = new RtpSession("127.0.0.1");
    await a.open();
    await b.open();
    a.configure({ ip: "127.0.0.1", port: b.port }, 8, 101);
    b.configure({ ip: "127.0.0.1", port: a.port }, 8, 101);
    const levels: number[] = [];
    b.on("audio", (f) => levels.push(rms(f)));
    let drained = false;
    a.on("drained", () => (drained = true));
    a.play(tone(200, 440, 8000));
    a.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(drained).toBe(true);
    expect(levels.filter((l) => l > 1000).length).toBeGreaterThanOrEqual(8);
    expect(levels.filter((l) => l < 50).length).toBeGreaterThan(0);

    const digits: string[] = [];
    b.on("dtmf", (d) => digits.push(d));
    const sock = createSocket("udp4");
    const dtmf = (event: number, end: boolean, ts: number) => {
      const p = Buffer.alloc(16);
      p[0] = 0x80;
      p[1] = 101;
      p.writeUInt32BE(ts, 4);
      p[12] = event;
      p[13] = end ? 0x80 | 10 : 10;
      sock.send(p, b.port, "127.0.0.1");
    };
    dtmf(5, false, 1000);
    dtmf(5, true, 1000);
    dtmf(5, true, 1000);
    dtmf(11, true, 2000);
    await new Promise((r) => setTimeout(r, 100));
    expect(digits).toEqual(["5", "#"]);
    sock.close();
    a.close();
    b.close();
  });
});

describe("secret store", () => {
  it("encrypts and reads secrets back in a new store (DPAPI on Windows)", async () => {
    const dir = path.join(os.tmpdir(), `forge-secrets-${process.pid}`);
    try {
      await new SecretStore(dir).set("x", "Pässwört ß €$\"'`;&|");
      const fresh = new SecretStore(dir);
      expect(fresh.has("x")).toBe(true);
      expect(await fresh.get("x")).toBe("Pässwört ß €$\"'`;&|");
      if (process.platform === "win32") expect(readFileSync(path.join(dir, "x.secret"), "utf8")).not.toContain("Pässwört");
      await fresh.set("x", null);
      expect(new SecretStore(dir).has("x")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("phone helpers", () => {
  it("matches numbers in different notations", () => {
    expect(sameNumber("+49 30 1234567", "0049301234567")).toBe(true);
    expect(sameNumber("030 1234567", "+49301234567")).toBe(true);
    expect(sameNumber("+49301234567", "+49301234568")).toBe(false);
    expect(sameNumber("", "123")).toBe(false);
    expect(sameNumber("21", "21")).toBe(true);
    expect(sameNumber("21", "+4930121")).toBe(false);
    expect(sameNumber("1234567", "+49301234567")).toBe(true);
  });

  it("keeps only speakable text", () => {
    expect(speakable("**Fertig:** `pnpm test` läuft, siehe [Doku](https://x.y) https://a.b/c")).toBe("Fertig: pnpm test läuft, siehe Doku");
    expect(speakable("# Titel\n- Punkt")).toBe("Titel Punkt");
  });
});
