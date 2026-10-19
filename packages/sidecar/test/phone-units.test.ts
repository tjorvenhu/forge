import { createSocket } from "node:dgram";
import { readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyFile, masterKeyCipher, SecretStore, type KeyBackend } from "../src/phone/secrets.js";
import { describe, expect, it } from "vitest";
import { alawToLinear, beep, decodeG711, Downsampler, encodeG711, linearToAlaw, linearToMulaw, mulawToLinear, pcmToWav, rms } from "../src/phone/audio.js";
import { createHash } from "node:crypto";
import { digestAuthorization, parseChallenge, pickChallenge } from "../src/phone/digest.js";
import { answerDirection, buildSdp, chooseCodec, parseSdp, PT_PCMA, PT_PCMU, withDirection } from "../src/phone/sdp.js";
import { getHeader, getHeaders, parseNameAddr, parseSip, parseVia, responseTo, serializeSip, uriUser } from "../src/phone/sip-message.js";
import { RtpSession } from "../src/phone/rtp.js";
import { Vad } from "../src/phone/vad.js";
import { speakable } from "../src/phone/phone-agent.js";
import { normalizeNumber, sameNumber } from "../src/phone/phone-service.js";
import { PinGuard, hashPin, verifyPin, type PinGuardState } from "../src/phone/pin-guard.js";
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

  const h = (alg: "md5" | "sha256", s: string) => createHash(alg).update(s).digest("hex");
  const responseOf = (header: string) => /response="([0-9a-f]+)"/.exec(header)![1];

  it("computes the -sess variants instead of falling back to plain MD5", () => {
    const md5sess = parseChallenge('Digest realm="r", nonce="n", qop="auth", algorithm=MD5-sess')!;
    expect(md5sess.algorithm).toBe("MD5-sess");
    const a = digestAuthorization(md5sess, { username: "u", password: "p", method: "REGISTER", uri: "sip:pbx", cnonce: "c" });
    const ha1 = h("md5", `${h("md5", "u:r:p")}:n:c`);
    expect(responseOf(a)).toBe(h("md5", `${ha1}:n:00000001:c:auth:${h("md5", "REGISTER:sip:pbx")}`));
    expect(a).toContain("algorithm=MD5-sess");

    const shaSess = parseChallenge('Digest realm="r", nonce="n", algorithm=SHA-256-sess')!;
    const b = digestAuthorization(shaSess, { username: "u", password: "p", method: "INVITE", uri: "sip:1@pbx", cnonce: "c" });
    expect(responseOf(b)).toBe(h("sha256", `${h("sha256", `${h("sha256", "u:r:p")}:n:c`)}:n:${h("sha256", "INVITE:sip:1@pbx")}`));
    expect(b).toContain('cnonce="c"');
  });

  it("answers auth-int-only challenges with the body hash and rejects what it cannot answer", () => {
    const ch = parseChallenge('Digest realm="r", nonce="n", qop="auth-int"')!;
    expect(ch.qop).toBe("auth-int");
    const a = digestAuthorization(ch, { username: "u", password: "p", method: "INVITE", uri: "sip:x", body: "v=0", cnonce: "c" });
    expect(responseOf(a)).toBe(h("md5", `${h("md5", "u:r:p")}:n:00000001:c:auth-int:${h("md5", `INVITE:sip:x:${h("md5", "v=0")}`)}`));
    expect(parseChallenge('Digest realm="r", nonce="n", algorithm=SHA-512-256')).toBeNull();
    expect(parseChallenge('Digest realm="r", nonce="n", qop="token"')).toBeNull();
  });

  it("prefers SHA-256 among several challenges and reads stale", () => {
    const best = pickChallenge(['Digest realm="r", nonce="a", algorithm=MD5', 'Basic realm="x"', 'Digest realm="r", nonce="b", algorithm=SHA-256, stale=TRUE'])!;
    expect(best).toMatchObject({ algorithm: "SHA-256", nonce: "b", stale: true });
    expect(pickChallenge(['Basic realm="x"'])).toBeNull();
  });

  it("escapes quotes and backslashes and unescapes the challenge", () => {
    const ch = parseChallenge('Digest realm="a \\"b\\" c", nonce="n"')!;
    expect(ch.realm).toBe('a "b" c');
    const a = digestAuthorization(ch, { username: 'x"y\\z', password: "p", method: "REGISTER", uri: "sip:pbx" });
    expect(a).toContain('username="x\\"y\\\\z"');
    expect(a).toContain('realm="a \\"b\\" c"');
    expect(responseOf(a)).toBe(h("md5", `${h("md5", 'x"y\\z:a "b" c:p')}:n:${h("md5", "REGISTER:sip:pbx")}`));
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

  it("reads hold and answers it with recvonly and a new version", () => {
    expect(parseSdp("v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 1 RTP/AVP 8\r\na=sendonly\r\n")!.direction).toBe("sendonly");
    expect(parseSdp("v=0\r\nc=IN IP4 0.0.0.0\r\nm=audio 1 RTP/AVP 8\r\n")!.direction).toBe("sendonly");
    expect(parseSdp("v=0\r\nc=IN IP4 1.2.3.4\r\na=inactive\r\nm=audio 1 RTP/AVP 8\r\n")!.direction).toBe("inactive");
    expect(parseSdp(buildSdp({ ip: "1.1.1.1", port: 2, sessionId: "1", version: 1 }))!.direction).toBe("sendrecv");
    expect(answerDirection("sendonly")).toBe("recvonly");
    expect(answerDirection("recvonly")).toBe("sendonly");
    expect(answerDirection("inactive")).toBe("inactive");
    const held = withDirection(buildSdp({ ip: "1.1.1.1", port: 2, sessionId: "7", version: 3 }), "recvonly");
    expect(held).toContain("a=recvonly\r\n");
    expect(held).not.toContain("sendrecv");
    expect(held).toContain("o=FORGE 7 4 IN IP4");
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

  it("joins frames of different packet sizes into one utterance", () => {
    const vad = new Vad();
    const got: Int16Array[] = [];
    vad.on("utterance", (u) => got.push(u));
    const speech = tone(900, 300, 8000, 9000);
    // 20 ms, 10 ms and 30 ms packets mixed, as after a codec or ptime change.
    const sizes = [160, 80, 240];
    let pushed = 0;
    for (let i = 0, k = 0; i < speech.length; k++) {
      const n = sizes[k % sizes.length]!;
      vad.push(speech.subarray(i, i + n));
      pushed += Math.min(n, speech.length - i);
      i += n;
    }
    expect(() => {
      for (const f of frames(noise(900, 60))) vad.push(f);
    }).not.toThrow();
    expect(got).toHaveLength(1);
    expect(got[0]!.length).toBeGreaterThanOrEqual(pushed);
    expect(rms(got[0]!.subarray(1600, 1600 + 4000))).toBeGreaterThan(5000);
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

  it("does not let a short sound cut FORGE off, but keeps a short answer when FORGE is silent", () => {
    const vad = new Vad();
    let starts = 0;
    let noises = 0;
    const got: Int16Array[] = [];
    vad.on("speechStart", () => starts++);
    vad.on("noise", () => noises++);
    vad.on("utterance", (u) => got.push(u));
    for (const f of frames(noise(1000, 60))) vad.push(f);
    vad.outputActive = true;
    for (const f of frames(tone(140, 300, 8000, 9000))) vad.push(f);
    for (const f of frames(noise(900, 60))) vad.push(f);
    expect(starts).toBe(0);
    vad.outputActive = false;
    // "Ja": about a quarter second.
    for (const f of frames(tone(240, 300, 8000, 9000))) vad.push(f);
    for (const f of frames(noise(900, 60))) vad.push(f);
    expect(got).toHaveLength(1);
    // A click starts speech but ends as noise, so the controller can go on talking.
    for (const f of frames(tone(80, 300, 8000, 9000))) vad.push(f);
    for (const f of frames(noise(900, 60))) vad.push(f);
    expect(starts).toBe(2);
    expect(noises).toBe(1);
    expect(got).toHaveLength(1);
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

describe("speech service limits", () => {
  /** fetch that never answers but honors the abort signal, like a stalled connection */
  const hangingFetch = (async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error)))) as typeof fetch;

  it("gives up on a transcription that does not answer and on a call that ended", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = hangingFetch;
    try {
      const voice = new OpenAiVoice("sk-test", { voice: "marin", sttModel: "x", ttsModel: "y", timeouts: { transcribeMs: 100, speakMs: 100 } });
      const started = Date.now();
      await expect(voice.transcribe(new Int16Array(160))).rejects.toThrow(/antwortet nicht rechtzeitig/);
      expect(Date.now() - started).toBeLessThan(2000);
      const ended = new AbortController();
      const p = voice.transcribe(new Int16Array(160), ended.signal);
      ended.abort();
      await expect(p).rejects.toThrow();
      await expect(
        (async () => {
          for await (const _ of voice.speak("Hallo", new AbortController().signal)) void _;
        })(),
      ).rejects.toThrow(/Sprachausgabe: OpenAI antwortet nicht rechtzeitig/);
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

    a.close();
    b.close();

    // DTMF from the latched peer is reported once per event.
    const c = new RtpSession("127.0.0.1");
    await c.open();
    const sock = createSocket("udp4");
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
    c.configure({ ip: "127.0.0.1", port: sock.address().port }, 8, 101);
    const digits: string[] = [];
    c.on("dtmf", (d) => digits.push(d));
    const dtmf = (event: number, end: boolean, ts: number) => sock.send(dtmfPacket(event, end, ts), c.port, "127.0.0.1");
    dtmf(5, false, 1000);
    dtmf(5, true, 1000);
    dtmf(5, true, 1000);
    dtmf(11, true, 2000);
    await new Promise((r) => setTimeout(r, 100));
    expect(digits).toEqual(["5", "#"]);
    sock.close();
    c.close();
  });

  it("ignores packets before the remote address is known, from other hosts and, once latched, from other ports", async () => {
    const rtp = new RtpSession("127.0.0.1");
    await rtp.open();
    const peer = createSocket("udp4");
    const other = createSocket("udp4");
    const stranger = createSocket("udp4");
    await new Promise<void>((r) => peer.bind(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => other.bind(0, "127.0.0.1", () => r()));
    const strangerBound = await new Promise<boolean>((r) => {
      stranger.once("error", () => r(false));
      stranger.bind(0, "127.0.0.2", () => r(true));
    });
    const digits: string[] = [];
    rtp.on("dtmf", (d) => digits.push(d));
    const settle = () => new Promise((r) => setTimeout(r, 60));
    // Early media of an outgoing call: no SDP answer yet, nothing is accepted.
    peer.send(dtmfPacket(1, true, 10), rtp.port, "127.0.0.1");
    await settle();
    expect(digits).toEqual([]);
    rtp.configure({ ip: "127.0.0.1", port: 9 }, 8, 101, ["10.1.1.1"]);
    if (strangerBound) {
      stranger.send(dtmfPacket(2, true, 20), rtp.port, "127.0.0.1");
      await settle();
      expect(digits).toEqual([]);
    }
    // Same IP as the SDP, other port (NAT): latched. Afterwards only that port counts.
    peer.send(dtmfPacket(3, true, 30), rtp.port, "127.0.0.1");
    await settle();
    other.send(dtmfPacket(4, true, 40), rtp.port, "127.0.0.1");
    await settle();
    expect(digits).toEqual(["3"]);
    expect((rtp as unknown as { remote: { port: number } }).remote.port).toBe(peer.address().port);
    for (const s of [peer, other, stranger]) s.close();
    rtp.close();
  });
});

function dtmfPacket(event: number, end: boolean, ts: number): Buffer {
  const p = Buffer.alloc(16);
  p[0] = 0x80;
  p[1] = 101;
  p.writeUInt32BE(ts, 4);
  p[12] = event;
  p[13] = end ? 0x80 | 10 : 10;
  return p;
}

describe("secret store", () => {
  /** A key store held in memory, like the keychain; `broken` fails like a locked one. */
  const memoryKey = (state: { key: Buffer | null; broken?: boolean }): KeyBackend => ({
    load: async () => {
      if (state.broken) throw new Error("locked");
      return state.key;
    },
    save: async (key) => {
      if (state.broken) return false;
      state.key = key;
      return true;
    },
  });

  it("encrypts with a key from the keychain on macOS and Linux and reads secrets back in a new store", async () => {
    const dir = path.join(os.tmpdir(), `forge-secrets-aes-${process.pid}`);
    try {
      const keychain = { key: null as Buffer | null };
      await new SecretStore(dir, masterKeyCipher([memoryKey(keychain)])).set("x", "Pässwört ß €$\"'`;&|");
      expect(keychain.key?.length).toBe(32);
      const blob = readFileSync(path.join(dir, "x.secret"), "utf8");
      expect(blob).toMatch(/^aes1:/);
      expect(blob).not.toContain("Pässwört");
      expect(await new SecretStore(dir, masterKeyCipher([memoryKey(keychain)])).get("x")).toBe("Pässwört ß €$\"'`;&|");
      // Another key (another user or computer) cannot read it.
      await expect(new SecretStore(dir, masterKeyCipher([memoryKey({ key: Buffer.alloc(32, 7) })])).get("x")).rejects.toThrow();
      // A locked keychain must not lead to a new key while secrets exist.
      const fallback = keyFile(path.join(dir, "fb"));
      await expect(new SecretStore(dir, masterKeyCipher([memoryKey({ key: null, broken: true }), fallback], () => true)).get("x")).rejects.toThrow();
      expect(await fallback.load()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a key file when there is no keychain", async () => {
    const dir = path.join(os.tmpdir(), `forge-secrets-file-${process.pid}`);
    try {
      const backends = () => [keyFile(dir, true), memoryKey({ key: null, broken: true }), keyFile(dir)];
      await new SecretStore(dir, masterKeyCipher(backends())).set("x", "geheim");
      expect(readFileSync(path.join(dir, "master.key"), "utf8")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      if (process.platform !== "win32") expect(statSync(path.join(dir, "master.key")).mode & 0o777).toBe(0o600);
      expect(await new SecretStore(dir, masterKeyCipher(backends())).get("x")).toBe("geheim");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("encrypts with DPAPI and reads secrets back in a new store", async () => {
    const dir = path.join(os.tmpdir(), `forge-secrets-${process.pid}`);
    try {
      await new SecretStore(dir).set("x", "Pässwört ß €$\"'`;&|");
      const fresh = new SecretStore(dir);
      expect(fresh.has("x")).toBe(true);
      expect(await fresh.get("x")).toBe("Pässwört ß €$\"'`;&|");
      expect(readFileSync(path.join(dir, "x.secret"), "utf8")).not.toContain("Pässwört");
      await fresh.set("x", null);
      expect(new SecretStore(dir).has("x")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PIN lockout", () => {
  const limits = { perCaller: 3, global: 5, windowMs: 60_000, lockMs: 60_000, baseDelayMs: 0, maxDelayMs: 0 };

  it("hashes with scrypt and verifies asynchronously", async () => {
    const stored = await hashPin("4711");
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(await verifyPin("4711", stored)).toBe(true);
    expect(await verifyPin("4712", stored)).toBe(false);
    expect(await verifyPin("4711", "kaputt")).toBe(false);
  });

  it("locks a number after repeated failures across calls, then everyone, and keeps it after a restart", async () => {
    let now = 1_000_000;
    let saved: PinGuardState | undefined;
    const guard = new PinGuard(undefined, (s) => (saved = s), limits, () => now);
    const wrong = async () => false;
    const right = async () => true;
    expect(await guard.check("+491", wrong)).toBe("wrong");
    expect(await guard.check("+491", wrong)).toBe("wrong");
    expect(await guard.check("+491", wrong)).toBe("locked");
    // Locked means the PIN is not even checked, so the right one does not help.
    let checked = false;
    expect(
      await guard.check("+491", async () => {
        checked = true;
        return true;
      }),
    ).toBe("locked");
    expect(checked).toBe(false);
    expect(await guard.check("+492", right)).toBe("ok");

    // The state survives a restart.
    const restarted = new PinGuard(saved, (s) => (saved = s), limits, () => now);
    expect(restarted.lockedFor("+491")).toBeGreaterThan(0);
    expect(await restarted.check("+492", wrong)).toBe("wrong");
    expect(await restarted.check("+493", wrong)).toBe("locked");
    expect(restarted.lockedFor("+494")).toBeGreaterThan(0);

    now += 61_000;
    expect(restarted.lockedFor("+491")).toBe(0);
    expect(await restarted.check("+491", right)).toBe("ok");
  });

  it("answers wrong PINs later and later", async () => {
    const guard = new PinGuard(undefined, () => {}, { ...limits, perCaller: 10, global: 10, baseDelayMs: 40, maxDelayMs: 100 });
    const timed = async () => {
      const t = Date.now();
      await guard.check("+491", async () => false);
      return Date.now() - t;
    };
    const first = await timed();
    await timed();
    const third = await timed();
    expect(first).toBeGreaterThanOrEqual(30);
    expect(third).toBeGreaterThanOrEqual(90);
  });
});

describe("phone helpers", () => {
  it("matches numbers in different notations, but only the same number", () => {
    expect(normalizeNumber("+49 (0) 30 123-45 67")).toBe("+49301234567");
    expect(normalizeNumber("0049 30 1234567")).toBe("+49301234567");
    expect(normalizeNumber("030/1234567")).toBe("+49301234567");
    expect(normalizeNumber("030 1234567", "43")).toBe("+43301234567");
    expect(normalizeNumber("21")).toBe("21");
    expect(sameNumber("+49 30 1234567", "0049301234567")).toBe(true);
    expect(sameNumber("030 1234567", "+49301234567")).toBe(true);
    expect(sameNumber("+49301234567", "+49301234568")).toBe(false);
    expect(sameNumber("", "123")).toBe(false);
    expect(sameNumber("21", "21")).toBe(true);
    expect(sameNumber("21", "+4930121")).toBe(false);
    // A suffix is not the same number, however long it is.
    expect(sameNumber("1234567", "+49301234567")).toBe(false);
    expect(sameNumber("234567", "+49 30 1234567")).toBe(false);
    expect(sameNumber("+43 30 1234567", "030 1234567")).toBe(false);
  });

  it("keeps only speakable text", () => {
    expect(speakable("**Fertig:** `pnpm test` läuft, siehe [Doku](https://x.y) https://a.b/c")).toBe("Fertig: pnpm test läuft, siehe Doku");
    expect(speakable("# Titel\n- Punkt")).toBe("Titel Punkt");
  });
});
