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
import { RtpSession } from "../src/phone/rtp.js";
import type { VoiceProvider } from "../src/phone/voice.js";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import type { SessionService } from "../src/sessions/session-service.js";
import type { DevServerService } from "../src/devserver/dev-server.js";
import { tempDir } from "./helpers.js";
import type { WorktreeService } from "../src/automation/worktrees.js";

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

/** Secret store whose reads can be held back, like the slow first DPAPI call through PowerShell. */
class SlowSecrets extends SecretStore {
  gate: Promise<void> | null = null;
  override async get(name: string) {
    if (this.gate) await this.gate;
    return super.get(name);
  }
}

const socketOf = (r: RtpSession) => (r as unknown as { socket: unknown }).socket;

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
  nonce = "n0nce";
  /** answer the next authorized REGISTER with stale=true */
  expireNonce = false;

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
    const challenge = (stale: boolean) => {
      const res = responseTo(msg, 401, "Unauthorized", "pbx");
      res.headers.push(["www-authenticate", `Digest realm="pbx", nonce="${this.nonce}", qop="auth", algorithm=MD5${stale ? ", stale=true" : ""}`]);
      this.send(res, port, ip);
    };
    if (!auth) return challenge(false);
    const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]]));
    if (this.expireNonce) {
      // The nonce the UA just used has expired: the credentials were right, it must try once more.
      this.expireNonce = false;
      this.nonce = `${this.nonce}x`;
      return challenge(true);
    }
    const expected = md5(`${md5(`${p.username}:pbx:${this.password}`)}:${this.nonce}:${p.nc}:${p.cnonce}:auth:${md5(`REGISTER:${p.uri}`)}`);
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

  it("retries once with the new nonce when the PBX says stale=true", async () => {
    pbx.expireNonce = true;
    const ua = new SipUserAgent({ server: "127.0.0.1", port: pbx.port, username: "forge", authUsername: null, password: pbx.password, domain: null, displayName: "FORGE" });
    await ua.start();
    await until(() => ua.state === "registered", 5000, "registered after stale nonce");
    expect(getHeader(pbx.registrations.at(-1)!, "authorization")).toContain(`nonce="${pbx.nonce}"`);
    await ua.stop();
  });

  it("drops SIP from anyone but the PBX, also requests with a guessed Call-ID", async () => {
    const ua = new SipUserAgent({ server: "127.0.0.1", port: pbx.port, username: "forge", authUsername: null, password: pbx.password, domain: null, displayName: "FORGE" });
    const logs: string[] = [];
    ua.on("log", (m) => logs.push(m));
    let incoming = 0;
    ua.on("incoming", () => incoming++);
    await ua.start();
    await until(() => ua.state === "registered", 5000, "registered");
    const attacker = createSocket("udp4");
    const bound = await new Promise<boolean>((r) => {
      attacker.once("error", () => r(false));
      attacker.bind(0, "127.0.0.2", () => r(true));
    });
    if (bound) {
      const answers: string[] = [];
      attacker.on("message", (b) => answers.push(b.toString()));
      attacker.send(serializeSip(invite(pbx, "+49301112233", "c-spoof", 40000)), pbx.uaContact.port, "127.0.0.1");
      await sleep(300);
      expect(incoming).toBe(0);
      expect(answers).toEqual([]);
      expect(logs.some((l) => l.includes("127.0.0.2") && l.includes("verworfen"))).toBe(true);
    }
    attacker.close();

    // From the PBX's address, but without our tag: no dialog, 481.
    pbx.send(invite(pbx, "+49301112233", "c-real", 40000), pbx.uaContact.port);
    await until(() => incoming === 1, 3000, "real INVITE");
    const bye: SipMessage = {
      method: "BYE",
      uri: `sip:forge@127.0.0.1:${pbx.uaContact.port}`,
      headers: [
        ["via", `SIP/2.0/UDP 127.0.0.1:${pbx.port};branch=z9hG4bKbye-guess`],
        ["from", "<sip:+49301112233@pbx>;tag=p1"],
        ["to", "<sip:forge@pbx>;tag=wrong"],
        ["call-id", "c-real"],
        ["cseq", "2 BYE"],
      ],
      body: "",
    };
    pbx.send(bye, pbx.uaContact.port);
    await pbx.next((m) => m.status === 481 && getHeader(m, "call-id") === "c-real");
    await ua.stop();
  });

  it("repeats a rejection of an incoming call until the ACK arrives", async () => {
    const ua = new SipUserAgent({ server: "127.0.0.1", port: pbx.port, username: "forge", authUsername: null, password: pbx.password, domain: null, displayName: "FORGE" });
    ua.on("incoming", (c) => c.reject(403, "Forbidden"));
    await ua.start();
    await until(() => ua.state === "registered", 5000, "registered");
    const inv = invite(pbx, "+4930999", "c-rej", 40000);
    pbx.send(inv, pbx.uaContact.port);
    const first = await pbx.next((m) => m.status === 403);
    await pbx.next((m) => m.status === 403, 2000);
    const ack: SipMessage = {
      method: "ACK",
      uri: inv.uri,
      headers: [
        ["via", getHeaders(inv, "via")[0]!],
        ["from", getHeader(inv, "from")!],
        ["to", getHeader(first.msg, "to")!],
        ["call-id", "c-rej"],
        ["cseq", "1 ACK"],
      ],
      body: "",
    };
    pbx.send(ack, pbx.uaContact.port);
    await sleep(100);
    const count = pbx.inbox.filter((r) => r.msg.status === 403).length;
    await sleep(1600);
    expect(pbx.inbox.filter((r) => r.msg.status === 403).length).toBe(count);
    await ua.stop();
  }, 15_000);

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
  const steered: string[] = [];
  let remoteOn = false;
  let projectId = "";
  let worktreesCreated: string[] = [];
  let startedIn: string[] = [];
  let sessionList: Array<{ id: string; projectId: string; title: string; status: string; live: boolean; updatedAt: string; projectName: string }>;
  let secrets: SlowSecrets;
  let failConversation: boolean;
  let rtps: RtpSession[];
  let logs: string[];

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
    steered.length = 0;
    remoteOn = false;
    failConversation = false;
    rtps = [];
    logs = [];
    worktreesCreated = [];
    startedIn = [];
    sessionList = [{ id: "s1", projectId, title: "Warenkorb", status: "idle", live: true, updatedAt: new Date().toISOString(), projectName: "shop" }];
    const sessions = {
      get: (id: string) => {
        const s = sessionList.find((x) => x.id === id);
        if (!s) throw new Error("not found");
        return s;
      },
      listLive: () => sessionList.filter((s) => s.live),
      listAll: () => sessionList,
      start: async (o: { projectId: string; prompt: string }) => {
        const s = { id: `s${sessionList.length + 1}`, projectId: o.projectId, title: o.prompt, status: "starting", live: true, updatedAt: new Date().toISOString(), projectName: "x" };
        sessionList.push(s);
        startedIn.push(o.projectId);
        return s;
      },
      send: async (id: string, text: string) => {
        sent.push([id, text]);
        return sessionList[0];
      },
      remoteState: () => ({ enabled: remoteOn, sessions: remoteOn ? [{ sessionId: "s1", state: "connected", message: null }] : [] }),
      remoteStart: async () => {
        remoteOn = true;
        return { enabled: true, sessions: [{ sessionId: "s1", state: "connected", message: null }] };
      },
      setPermissionMode: async (id: string, mode: string) => steered.push(`mode:${id}:${mode}`),
      close: (id: string) => steered.push(`close:${id}`),
    } as unknown as SessionService;
    secrets = new SlowSecrets(path.join(t.dir, "secrets"));
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
      git: new GitEngine(),
      worktrees: {
        create: async (parent: { id: string; name: string; path: string }, branch: string) => {
          worktreesCreated.push(`${parent.name}:${branch}`);
          const dir = path.join(t.dir, "shop-agent");
          mkdirSync(dir, { recursive: true });
          return projects.import(dir, parent.id);
        },
      } as unknown as WorktreeService,
      secrets,
      emit: (e) => events.push(e),
      claude: () => ({ path: "claude", env: {}, cwd: t.dir }),
      log: (m) => logs.push(m),
      timing: { notifyDelayMs: 50, notifyCooldownMs: 0, pinLimits: { perCaller: 2, baseDelayMs: 0 } },
      factories: {
        voice: () => voice,
        rtp: (ip) => {
          const r = new RtpSession(ip);
          rtps.push(r);
          return r;
        },
        conversation: ({ tools, context, cb }) => {
          if (failConversation) throw new Error("Claude startet nicht");
          const c = {
            said: [] as string[],
            tools,
            context,
            cb,
            say(text: string) {
              c.said.push(text);
              if (text.startsWith("[FORGE: Du rufst")) cb.onSentence("Hallo, hier ist FORGE. Die Tests sind grün.");
              else if (!text.startsWith("[")) cb.onSentence("Alles läuft.");
              cb.onTurnDone();
            },
            interrupt() {},
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
      engine: "claude",
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
    expect(await conv.tools.details("S1")).toMatch(/^Gesperrt/);
    expect(sent).toHaveLength(0);
    // Before the PIN, status gives counts only, no titles.
    const lockedStatus = await conv.tools.status();
    expect(lockedStatus).toContain("Aktive Sessions: 1");
    expect(lockedStatus).not.toContain("Warenkorb");
    await phoneEnd.digits("0000#");
    await until(() => spoken.some((s) => s.startsWith("Die PIN ist falsch")), 5000, "wrong PIN");
    await phoneEnd.digits("4711#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked");
    expect(conv.said.some((s) => s.includes("PIN richtig"))).toBe(true);
    expect(await conv.tools.status()).toContain("S1: <<<SESSION-DATEN>>>Warenkorb<<<ENDE SESSION-DATEN>>> im Projekt shop, fertig, wartet auf Anweisungen");

    // After the PIN, steering runs right away.
    expect(await conv.tools.sendMessage("S1", "Mach weiter")).toBe("An S1 gesendet. Claude arbeitet daran.");
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
    await expect(svc.setEnabled(true)).rejects.toMatchObject({ message: expect.stringMatching(/OpenAI-API-Key fehlt/), details: { phoneSetupIncomplete: true } });
  });

  /** INVITE from the PBX, 200 OK, ACK; FakePhone talks to FORGE's RTP port afterwards. */
  async function answeredCall(callId: string, from = "0301112233") {
    const inv = invite(pbx, from, callId, phoneEnd.port);
    pbx.send(inv, pbx.uaContact.port);
    const ok = (await pbx.next((m) => m.status === 200 && getHeader(m, "call-id") === callId)).msg;
    phoneEnd.remote = Number(/m=audio (\d+)/.exec(ok.body)![1]);
    pbx.send(inDialog("ACK", 1, inv, ok, pbx, `ack-${callId}`), pbx.uaContact.port);
    return { inv, ok };
  }

  async function byeFromPbx(callId: string, inv: SipMessage, ok: SipMessage) {
    pbx.send(inDialog("BYE", 2, inv, ok, pbx, `bye-${callId}`), pbx.uaContact.port);
    await until(() => svc.state().call === null, 3000, "call ended");
  }

  it("frees the line when the caller hangs up while FORGE is still preparing the call", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    let release: () => void = () => {};
    secrets.gate = new Promise<void>((r) => (release = r));
    const inv = invite(pbx, "0301112233", "c-cancel", phoneEnd.port);
    pbx.send(inv, pbx.uaContact.port);
    await pbx.next((m) => m.status === 100 && getHeader(m, "call-id") === "c-cancel");
    expect(svc.state().call).toMatchObject({ state: "ringing" });
    const cancel: SipMessage = {
      method: "CANCEL",
      uri: inv.uri,
      headers: [
        ["via", getHeaders(inv, "via")[0]!],
        ["from", getHeader(inv, "from")!],
        ["to", getHeader(inv, "to")!],
        ["call-id", "c-cancel"],
        ["cseq", "1 CANCEL"],
      ],
      body: "",
    };
    pbx.send(cancel, pbx.uaContact.port);
    await pbx.next((m) => m.status === 487 && getHeader(m, "call-id") === "c-cancel");
    expect(svc.state().call).toBeNull();
    secrets.gate = null;
    release();
    await sleep(300);
    expect(pbx.inbox.some((r) => r.msg.status === 200 && getHeader(r.msg, "call-id") === "c-cancel" && cseqIs(r.msg, "INVITE"))).toBe(false);
    expect(rtps.every((r) => !socketOf(r))).toBe(true);
    expect(svc.calls(5).find((c) => c.number === "0301112233")).toMatchObject({ result: "missed", detail: "Anrufer hat aufgelegt" });

    // The line is free again: the next call is answered, not "busy".
    const { inv: inv2, ok } = await answeredCall("c-after");
    expect(svc.state().call).toMatchObject({ state: "active" });
    await byeFromPbx("c-after", inv2, ok);
  }, 30_000);

  it("hangs up and cleans up when the conversation cannot start after answering", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    failConversation = true;
    await answeredCall("c-fail");
    const bye = await pbx.next((m) => m.method === "BYE" && getHeader(m, "call-id") === "c-fail");
    pbx.send(responseTo(bye.msg, 200, "OK"), bye.port);
    await until(() => svc.state().call === null, 3000, "line free");
    expect(rtps.every((r) => !socketOf(r))).toBe(true);
    expect(svc.calls(5)[0]).toMatchObject({ result: "failed", detail: "Claude startet nicht" });
  }, 30_000);

  it("cancels an outgoing call and frees the line when preparing it fails", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    failConversation = true;
    await expect(svc.testCall()).rejects.toThrow(/Claude startet nicht/);
    const inv = await pbx.next((m) => m.method === "INVITE");
    await pbx.next((m) => m.method === "CANCEL" && getHeader(m, "call-id") === getHeader(inv.msg, "call-id"));
    expect(svc.state().call).toBeNull();
    expect(rtps.every((r) => !socketOf(r))).toBe(true);
    failConversation = false;
    await svc.saveConfig({ requirePin: false });
    // Not busy any more.
    const { inv: inv2, ok } = await answeredCall("c-next");
    await byeFromPbx("c-next", inv2, ok);
  }, 30_000);

  it("steers Remote Control, session settings and git right away once unlocked", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-steer");
    const conv = await until(() => convs[0], 5000, "conversation");
    expect(await conv.tools.remote("on")).toMatch(/^Gesperrt/);
    expect(await conv.tools.remote("status")).toBe("Remote Control ist aus.");
    expect(remoteOn).toBe(false);
    await sleep(200);
    await phoneEnd.digits("4711#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked");
    expect(await conv.tools.remote("on")).toBe("Remote Control ist an, 1 Session ist mit der Claude-App verbunden.");
    expect(remoteOn).toBe(true);
    await conv.tools.status();
    expect(await conv.tools.sessionSettings("S1", { permissionMode: "acceptEdits" })).toBe("S1: Modus acceptEdits gesetzt.");
    expect(await conv.tools.sessionSettings("S1", {})).toMatch(/^Fehler/);
    expect(await conv.tools.close("S1")).toBe("S1 geschlossen.");
    expect(steered).toEqual(["mode:s1:acceptEdits", "close:s1"]);
    // The test project is no git repository: the error reaches Claude as text.
    expect(await conv.tools.git("shop", "status")).toMatch(/^Fehler: Kein Git-Repository/);
    expect(await conv.tools.git("nirgends", "push")).toMatch(/^Fehler: Kein Projekt/);
    // A parallel agent gets its own worktree; the session runs there, not in the project itself.
    expect(await conv.tools.startSession("shop", "Baue den CSV-Export", { agent: true })).toMatch(/^Agent S\d im Projekt shop gestartet, in einem eigenen Worktree/);
    expect(worktreesCreated).toEqual([expect.stringMatching(/^shop:agent\/baue-den-csv-export-[a-z0-9]{1,4}$/)]);
    expect(startedIn).toHaveLength(1);
    expect(startedIn[0]).not.toBe(projectId);
    expect(await conv.tools.startSession("shop", "Nur kurz prüfen")).toMatch(/^Neue Session S\d im Projekt shop gestartet/);
    expect(startedIn[1]).toBe(projectId);
    await byeFromPbx("c-steer", inv, ok);
  }, 30_000);

  it("finds sessions only by a known short name or a unique title", async () => {
    await svc.saveConfig({ requirePin: false });
    sessionList.push(
      { id: "s2", projectId, title: "Warenkorb Export", status: "idle", live: true, updatedAt: new Date().toISOString(), projectName: "shop" },
      { id: "s3", projectId, title: "Login", status: "idle", live: true, updatedAt: new Date().toISOString(), projectName: "shop" },
    );
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-refs");
    const conv = await until(() => convs[0], 5000, "conversation");
    expect(await conv.tools.details("")).toMatch(/^Fehler: Welche Session/);
    expect(await conv.tools.details("S3")).toMatch(/^Fehler: S3 ist in diesem Gespräch nicht vergeben/);
    expect(await conv.tools.stop("  ")).toMatch(/^Fehler/);
    // "Warenkorb" is the exact title of one session, "waren" matches two.
    expect(await conv.tools.details("Warenkorb")).toContain("Warenkorb<<<ENDE");
    expect(await conv.tools.details("waren")).toMatch(/^Fehler: Mehrere Sessions passen/);
    expect(await conv.tools.details("login")).toContain("Login");
    await byeFromPbx("c-refs", inv, ok);
  }, 30_000);

  it("keeps PIN failures across calls and locks the number", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const first = await answeredCall("c-pin1");
    await sleep(200);
    await phoneEnd.digits("0000#");
    await until(() => spoken.some((s) => s.startsWith("Die PIN ist falsch")), 5000, "wrong PIN");
    await byeFromPbx("c-pin1", first.inv, first.ok);

    const second = await answeredCall("c-pin2");
    await sleep(200);
    await phoneEnd.digits("1111#");
    await until(() => spoken.some((s) => s.includes("vorübergehend gesperrt")), 5000, "locked");
    await phoneEnd.digits("4711#");
    await sleep(300);
    expect(svc.state().call?.unlocked).toBe(false);
    await byeFromPbx("c-pin2", second.inv, second.ok);
    // A new PIN set at the desk lifts the lock.
    await svc.saveConfig({ pin: "1234" });
    const third = await answeredCall("c-pin3");
    await sleep(200);
    await phoneEnd.digits("1234#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked with new PIN");
    await byeFromPbx("c-pin3", third.inv, third.ok);
  }, 40_000);

  it("answers hold with recvonly and repeats the 200 OK until the ACK", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-hold");
    await until(() => phoneEnd.levels.length > 5, 5000, "audio flows");
    const reinvite = inDialog("INVITE", 2, inv, ok, pbx, "reinv1");
    reinvite.headers.push(["content-type", "application/sdp"]);
    reinvite.body = buildSdp({ ip: "127.0.0.1", port: phoneEnd.port, sessionId: "9", version: 2 }).replace("a=sendrecv", "a=sendonly");
    pbx.send(reinvite, pbx.uaContact.port);
    const answer = (await pbx.next((m) => m.status === 200 && getHeader(m, "cseq") === "2 INVITE")).msg;
    expect(answer.body).toContain("a=recvonly");
    expect(answer.body).toMatch(/o=FORGE \d+ 2 IN IP4/);
    await pbx.next((m) => m.status === 200 && getHeader(m, "cseq") === "2 INVITE", 2000);
    // On hold FORGE sends no audio.
    await sleep(100);
    const before = phoneEnd.levels.length;
    await sleep(300);
    expect(phoneEnd.levels.length).toBe(before);
    pbx.send(inDialog("ACK", 2, inv, ok, pbx, "reack"), pbx.uaContact.port);
    await sleep(100);
    const repeats = pbx.inbox.filter((r) => r.msg.status === 200 && getHeader(r.msg, "cseq") === "2 INVITE").length;
    await sleep(1600);
    expect(pbx.inbox.filter((r) => r.msg.status === 200 && getHeader(r.msg, "cseq") === "2 INVITE").length).toBe(repeats);
    await byeFromPbx("c-hold", inv, ok);
  }, 30_000);
});

function cseqIs(m: SipMessage, method: string) {
  return (getHeader(m, "cseq") ?? "").endsWith(method);
}
