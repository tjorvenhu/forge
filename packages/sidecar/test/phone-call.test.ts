import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PhoneState, ServerEvent } from "@forge/protocol";
import { encodeG711, FRAME_SAMPLES, rms, decodeG711 } from "../src/phone/audio.js";
import type { ConversationCallbacks } from "../src/phone/call-controller.js";
import type { PhoneToolset } from "../src/phone/phone-agent.js";
import { PhoneService } from "../src/phone/phone-service.js";
import { buildSdp } from "../src/phone/sdp.js";
import { SecretStore } from "../src/phone/secrets.js";
import { getHeader, getHeaders, parseNameAddr, parseSip, responseTo, serializeSip, type SipMessage } from "../src/phone/sip-message.js";
import { SipUserAgent } from "../src/phone/sip-ua.js";
import type { VoiceProvider } from "../src/phone/voice.js";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import type { SessionService } from "../src/sessions/session-service.js";
import type { DevServerService } from "../src/devserver/dev-server.js";
import { tempDir } from "./helpers.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const tone = (ms: number, amp = 9000) => Int16Array.from({ length: (ms / 1000) * 8000 }, (_, i) => Math.round(Math.sin((2 * Math.PI * 300 * i) / 8000) * amp));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | null | false, ms = 8000, label = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(20);
  }
}

interface Received {
  msg: SipMessage;
  ip: string;
  port: number;
}

/** A tiny PBX for tests: digest-protected REGISTER, scripted calls, raw access to everything. */
class FakePbx {
  sock: Socket = createSocket("udp4");
  port = 0;
  inbox: Received[] = [];
  private used = new Set<Received>();
  /** what the next REGISTER answer puts into Via received/rport (NAT test) */
  natAddress: { ip: string; port: number } | null = null;
  registrations: SipMessage[] = [];
  readonly password = "geheim";

  async start() {
    await new Promise<void>((r) => this.sock.bind(0, "127.0.0.1", () => r()));
    this.port = this.sock.address().port;
    this.sock.on("message", (buf, rinfo) => {
      const msg = parseSip(buf.toString("utf8"));
      if (!msg) return;
      const rec = { msg, ip: rinfo.address, port: rinfo.port };
      if (msg.method === "REGISTER") return this.onRegister(rec);
      this.inbox.push(rec);
    });
  }

  private onRegister({ msg, ip, port }: Received) {
    this.registrations.push(msg);
    const auth = getHeader(msg, "authorization");
    if (!auth) {
      const res = responseTo(msg, 401, "Unauthorized", "pbx");
      res.headers.push(["www-authenticate", 'Digest realm="pbx", nonce="n0nce", qop="auth", algorithm=MD5']);
      return this.send(res, port, ip);
    }
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    const expected = md5(`${md5(`${p.username}:pbx:${this.password}`)}:n0nce:${p.nc}:${p.cnonce}:auth:${md5(`REGISTER:${p.uri}`)}`);
    if (p.response !== expected) return this.send(responseTo(msg, 403, "Forbidden", "pbx"), port, ip);
    const res = responseTo(msg, 200, "OK", "pbx");
    if (this.natAddress) {
      const via = getHeaders(res, "via")[0]!.replace(";rport", `;rport=${this.natAddress.port};received=${this.natAddress.ip}`);
      res.headers = res.headers.map(([k, v]) => (k === "via" && v === getHeaders(msg, "via")[0] ? ["via", via] : [k, v]));
    }
    res.headers.push(["contact", `${getHeader(msg, "contact")}`]);
    this.send(res, port, ip);
  }

  get uaContact() {
    const last = this.registrations.at(-1)!;
    const uri = parseNameAddr(getHeader(last, "contact")!).uri;
    const m = /@([\d.]+):(\d+)/.exec(uri)!;
    return { ip: m[1]!, port: Number(m[2]) };
  }

  send(msg: SipMessage, port: number, ip = "127.0.0.1") {
    this.sock.send(serializeSip(msg), port, ip);
  }

  next(pred: (m: SipMessage) => boolean, ms = 8000): Promise<Received> {
    return until(() => {
      const hit = this.inbox.find((r) => !this.used.has(r) && pred(r.msg));
      if (hit) this.used.add(hit);
      return hit;
    }, ms, "SIP message");
  }

  close() {
    this.sock.close();
  }
}

function invite(pbx: FakePbx, from: string, callId: string, rtpPort: number): SipMessage {
  const ua = pbx.uaContact;
  return {
    method: "INVITE",
    uri: `sip:forge@127.0.0.1:${ua.port}`,
    headers: [
      ["via", `SIP/2.0/UDP 127.0.0.1:${pbx.port};branch=z9hG4bK${callId}`],
      ["max-forwards", "70"],
      ["from", `<sip:${from}@pbx>;tag=p1`],
      ["to", "<sip:forge@pbx>"],
      ["call-id", callId],
      ["cseq", "1 INVITE"],
      ["contact", `<sip:${from}@127.0.0.1:${pbx.port}>`],
      ["content-type", "application/sdp"],
    ],
    body: buildSdp({ ip: "127.0.0.1", port: rtpPort, sessionId: "9", version: 1 }),
  };
}

function inDialog(method: string, cseq: number, call: SipMessage, ok: SipMessage, pbx: FakePbx, branch: string): SipMessage {
  return {
    method,
    uri: parseNameAddr(getHeader(ok, "contact")!).uri,
    headers: [
      ["via", `SIP/2.0/UDP 127.0.0.1:${pbx.port};branch=z9hG4bK${branch}`],
      ["from", getHeader(call, "from")!],
      ["to", getHeader(ok, "to")!],
      ["call-id", getHeader(call, "call-id")!],
      ["cseq", `${cseq} ${method}`],
    ],
    body: "",
  };
}

/** RTP endpoint on the PBX side: sends speech or DTMF to FORGE and measures what comes back. */
class FakePhone {
  sock = createSocket("udp4");
  port = 0;
  remote = 0;
  levels: number[] = [];
  private seq = 1;
  async start() {
    await new Promise<void>((r) => this.sock.bind(0, "127.0.0.1", () => r()));
    this.port = this.sock.address().port;
    this.sock.on("message", (buf) => {
      const pt = buf[1]! & 0x7f;
      if (buf.length > 12 && (pt === 0 || pt === 8)) this.levels.push(rms(decodeG711(buf.subarray(12), pt)));
    });
  }
  private packet(pt: number, payload: Buffer, ts: number) {
    const h = Buffer.alloc(12);
    h[0] = 0x80;
    h[1] = pt;
    h.writeUInt16BE(this.seq++ & 0xffff, 2);
    h.writeUInt32BE(ts, 4);
    h.writeUInt32BE(4242, 8);
    this.sock.send(Buffer.concat([h, payload]), this.remote, "127.0.0.1");
  }
  async talk(pcm: Int16Array) {
    for (let i = 0; i < pcm.length; i += FRAME_SAMPLES) {
      this.packet(8, encodeG711(pcm.subarray(i, i + FRAME_SAMPLES), 8), i);
      if (i % (FRAME_SAMPLES * 10) === 0) await sleep(2);
    }
  }
  async digits(s: string) {
    let ts = 100_000;
    for (const d of s) {
      const ev = "0123456789*#".indexOf(d);
      for (const end of [false, true, true]) this.packet(101, Buffer.from([ev, end ? 0x8a : 0x0a, 0, 160]), ts);
      ts += 1000;
      await sleep(5);
    }
  }
  close() {
    this.sock.close();
  }
}

describe("SIP user agent against a test PBX", () => {
  let pbx: FakePbx;
  beforeEach(async () => {
    pbx = new FakePbx();
    await pbx.start();
  });
  afterEach(() => pbx.close());

  it("registers with digest auth and learns its public address behind NAT", async () => {
    pbx.natAddress = { ip: "10.9.9.9", port: 40123 };
    const ua = new SipUserAgent({ server: "127.0.0.1", port: pbx.port, username: "forge", authUsername: null, password: pbx.password, domain: "pbx.test", displayName: "FORGE" });
    const states: string[] = [];
    ua.on("registration", (s) => states.push(s));
    await ua.start();
    await until(() => ua.state === "registered", 5000, "registered");
    const contacts = pbx.registrations.map((r) => getHeader(r, "contact"));
    expect(contacts.at(-1)).toContain("@10.9.9.9:40123");
    expect(getHeader(pbx.registrations[0]!, "to")).toBe("<sip:forge@pbx.test>");
    pbx.natAddress = null;
    await ua.stop();
    expect(getHeader(pbx.registrations.at(-1)!, "expires")).toBe("0");
    expect(states.at(-1)).toBe("off");
  });

  it("dials only digits and ends a ringing call at once when FORGE hangs up (CANCEL)", async () => {
    const ua = new SipUserAgent({ server: "127.0.0.1", port: pbx.port, username: "forge", authUsername: null, password: pbx.password, domain: null, displayName: "FORGE" });
    await ua.start();
    await until(() => ua.state === "registered", 5000, "registered");
    const call = ua.call("0170 123/45-6", buildSdp({ ip: "127.0.0.1", port: 40000, sessionId: "1", version: 1 }));
    let ended: string | null = null;
    call.on("ended", (r) => (ended = r));
    const inv = await pbx.next((m) => m.method === "INVITE");
    expect(inv.msg.uri).toBe("sip:0170123456@127.0.0.1");
    pbx.send(responseTo(inv.msg, 180, "Ringing", "callee"), inv.port);
    await sleep(100);
    const started = Date.now();
    await call.hangup("In FORGE aufgelegt");
    expect(Date.now() - started).toBeLessThan(500);
    expect(ended).toBe("In FORGE aufgelegt");
    const cancel = await pbx.next((m) => m.method === "CANCEL");
    expect(getHeader(cancel.msg, "cseq")).toBe("1 CANCEL");
    expect(getHeaders(cancel.msg, "via")[0]).toBe(getHeaders(inv.msg, "via")[0]);
    await ua.stop();
  });

  it("reports wrong credentials", async () => {
    const ua = new SipUserAgent({ server: "127.0.0.1", port: pbx.port, username: "forge", authUsername: null, password: "falsch", domain: null, displayName: "FORGE" });
    let message: string | null = null;
    ua.on("registration", (s, m) => s === "failed" && (message = m));
    await ua.start();
    await until(() => message, 5000, "failure");
    expect(message).toMatch(/Zugangsdaten abgelehnt \(403/);
    await ua.stop();
  });
});

describe("PhoneService end to end with a test PBX", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let pbx: FakePbx;
  let phoneEnd: FakePhone;
  let svc: PhoneService;
  let events: ServerEvent[];
  let spoken: string[];
  let transcripts: string[];
  let convs: Array<{ said: string[]; tools: PhoneToolset; context: string; cb: ConversationCallbacks }>;
  const sent: Array<[string, string]> = [];
  let projectId = "";

  beforeEach(async () => {
    t = tempDir();
    mkdirSync(path.join(t.dir, "shop"), { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    const projects = new ProjectManager(db, new GitEngine(), () => "balanced");
    projectId = (await projects.import(path.join(t.dir, "shop"))).id;
    pbx = new FakePbx();
    await pbx.start();
    phoneEnd = new FakePhone();
    await phoneEnd.start();
    events = [];
    spoken = [];
    transcripts = [];
    convs = [];
    sent.length = 0;
    const session = { id: "s1", projectId, title: "Warenkorb", status: "idle", live: true, updatedAt: new Date().toISOString(), projectName: "shop" };
    const sessions = {
      get: () => session,
      listLive: () => [session],
      listAll: () => [session],
      send: async (id: string, text: string) => {
        sent.push([id, text]);
        return session;
      },
    } as unknown as SessionService;
    const voice: VoiceProvider = {
      transcribe: async () => transcripts.shift() ?? "",
      async *speak(text) {
        spoken.push(text);
        yield tone(200, 6000);
      },
    };
    svc = new PhoneService({
      db,
      projects,
      sessions,
      devServers: {} as DevServerService,
      secrets: new SecretStore(path.join(t.dir, "secrets")),
      emit: (e) => events.push(e),
      claude: () => ({ path: "claude", env: {}, cwd: t.dir }),
      log: () => {},
      timing: { notifyDelayMs: 50, notifyCooldownMs: 0 },
      factories: {
        voice: () => voice,
        conversation: ({ tools, context, cb }) => {
          const c = {
            said: [] as string[],
            tools,
            context,
            cb,
            say(text: string) {
              c.said.push(text);
              if (text.startsWith("[FORGE: Du rufst")) cb.onSentence("Hallo, hier ist FORGE. Die Tests sind grün.");
              else if (!text.startsWith("[")) cb.onSentence("Alles läuft.");
            },
            close() {},
          };
          convs.push(c);
          return c;
        },
      },
    });
    await svc.saveConfig({
      server: "127.0.0.1",
      port: pbx.port,
      username: "forge",
      password: pbx.password,
      openAiKey: "sk-test",
      pin: "4711",
      allowedCallers: ["+49 30 1112233"],
      notifyNumber: "0172 999",
    });
  }, 30_000);

  afterEach(async () => {
    await svc.setEnabled(false);
    pbx.close();
    phoneEnd.close();
    db.close();
    t.cleanup();
  });

  const lastState = () => [...events].reverse().find((e) => e.event === "phone.updated")?.payload as PhoneState | undefined;

  it("rejects numbers that are not allowed, talks with allowed callers and unlocks steering with the PIN", async () => {
    expect(svc.config()).toMatchObject({ hasPassword: true, hasOpenAiKey: true, hasPin: true, allowedCallers: ["+49 30 1112233"] });
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");

    // Not on the list: 403, nothing answered.
    pbx.send(invite(pbx, "+4930999", "c-unknown", phoneEnd.port), pbx.uaContact.port);
    await pbx.next((m) => m.status === 100 && getHeader(m, "call-id") === "c-unknown");
    await pbx.next((m) => m.status === 403 && getHeader(m, "call-id") === "c-unknown");

    // Allowed caller (other notation of the same number).
    const inv = invite(pbx, "0301112233", "c-ok", phoneEnd.port);
    pbx.send(inv, pbx.uaContact.port);
    const ok = (await pbx.next((m) => m.status === 200 && getHeader(m, "call-id") === "c-ok")).msg;
    expect(ok.body).toContain("m=audio");
    phoneEnd.remote = Number(/m=audio (\d+)/.exec(ok.body)![1]);
    pbx.send(inDialog("ACK", 1, inv, ok, pbx, "ack1"), pbx.uaContact.port);
    expect(svc.state().call).toMatchObject({ direction: "in", state: "active", unlocked: false });

    // FORGE greets first and the audio reaches the caller.
    await until(() => spoken.includes("Hallo, hier ist FORGE. Was kann ich für dich tun?"), 5000, "greeting");
    await until(() => phoneEnd.levels.some((l) => l > 1000), 5000, "audio from FORGE");

    // The caller speaks: VAD, transcription, Claude.
    transcripts.push("Wie ist der Status?");
    await sleep(400);
    await phoneEnd.talk(tone(900));
    await phoneEnd.talk(new Int16Array(8000));
    const conv = await until(() => convs[0], 5000, "conversation");
    await until(() => conv.said.includes("Wie ist der Status?"), 8000, "utterance reached Claude");
    await until(() => spoken.includes("Alles läuft."), 5000, "answer spoken");

    // Steering is locked until the PIN comes in via keypad.
    expect(await conv.tools.sendMessage("S1", "Mach weiter")).toMatch(/^Gesperrt/);
    expect(sent).toHaveLength(0);
    expect(await conv.tools.status()).toContain("S1: „Warenkorb“ im Projekt shop, fertig, wartet auf Anweisungen");
    await phoneEnd.digits("0000#");
    await until(() => spoken.some((s) => s.startsWith("Die PIN ist falsch")), 5000, "wrong PIN");
    await phoneEnd.digits("4711#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked");
    expect(conv.said.some((s) => s.includes("PIN richtig eingegeben"))).toBe(true);
    expect(await conv.tools.sendMessage("S1", "Mach weiter")).toMatch(/gesendet/);
    expect(sent).toEqual([["s1", "Mach weiter"]]);

    // The caller hangs up.
    pbx.send(inDialog("BYE", 2, inv, ok, pbx, "bye1"), pbx.uaContact.port);
    await pbx.next((m) => m.status === 200 && getHeader(m, "cseq") === "2 BYE");
    await until(() => svc.state().call === null, 3000, "call ended");
    const [log] = svc.calls(5).filter((c) => c.number === "0301112233");
    expect(log).toMatchObject({ direction: "in", result: "answered", detail: "Gegenstelle hat aufgelegt" });
    expect(log!.transcript.map((x) => x.text)).toEqual(expect.arrayContaining(["Wie ist der Status?", "Alles läuft."]));
    expect(svc.calls(5).find((c) => c.number === "+4930999")).toMatchObject({ result: "rejected", detail: "Nummer ist nicht freigegeben." });
    expect(lastState()?.call).toBeNull();
  }, 40_000);

  it("calls the user when a session is done, with proxy auth, and speaks only after the call is answered", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    svc.onServerEvent({
      event: "session.event",
      payload: {
        seq: 1,
        sessionId: "s1",
        ts: new Date().toISOString(),
        body: { type: "turn.result", subtype: "success", isError: false, durationMs: 1, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, text: "Alle 42 Tests sind grün." },
      },
    });
    const first = await pbx.next((m) => m.method === "INVITE");
    expect(first.msg.uri).toBe("sip:0172999@127.0.0.1");
    const challenge = responseTo(first.msg, 407, "Proxy Authentication Required", "pbx");
    challenge.headers.push(["proxy-authenticate", 'Digest realm="pbx", nonce="n2"']);
    pbx.send(challenge, first.port);
    const ack = await pbx.next((m) => m.method === "ACK");
    expect(getHeader(ack.msg, "cseq")).toBe("1 ACK");
    const second = await pbx.next((m) => m.method === "INVITE");
    expect(getHeader(second.msg, "proxy-authorization")).toContain('username="forge"');
    expect(getHeader(second.msg, "cseq")).toBe("2 INVITE");

    pbx.send(responseTo(second.msg, 180, "Ringing", "callee"), second.port);
    await sleep(300);
    // Claude already prepared the greeting, but nothing is spoken while it rings.
    expect(convs[0]!.said[0]).toContain("Alle 42 Tests sind grün.");
    expect(spoken).toEqual([]);
    expect(svc.state().call).toMatchObject({ direction: "out", state: "ringing", reason: "Session fertig: Warenkorb" });

    const answer = responseTo(second.msg, 200, "OK", "callee");
    answer.headers.push(["contact", `<sip:0172999@127.0.0.1:${pbx.port}>`], ["content-type", "application/sdp"]);
    answer.body = buildSdp({ ip: "127.0.0.1", port: phoneEnd.port, sessionId: "5", version: 1, codec: 0 });
    pbx.send(answer, second.port);
    const ack2 = await pbx.next((m) => m.method === "ACK");
    expect(getHeader(ack2.msg, "to")).toContain("tag=callee");
    await until(() => spoken.includes("Hallo, hier ist FORGE. Die Tests sind grün."), 5000, "greeting after answer");
    await until(() => phoneEnd.levels.some((l) => l > 1000), 5000, "PCMU audio");

    await svc.hangup();
    const bye = await pbx.next((m) => m.method === "BYE");
    expect(getHeader(bye.msg, "to")).toContain("tag=callee");
    pbx.send(responseTo(bye.msg, 200, "OK"), bye.port);
    await until(() => svc.state().call === null, 3000, "ended");
    expect(svc.calls(5)[0]).toMatchObject({ direction: "out", number: "0172 999", result: "answered", reason: "Session fertig: Warenkorb" });
  }, 40_000);

  it("refuses to switch on while the setup is incomplete", async () => {
    await svc.saveConfig({ openAiKey: "" });
    await expect(svc.setEnabled(true)).rejects.toThrow(/OpenAI-API-Key fehlt/);
  });
});
