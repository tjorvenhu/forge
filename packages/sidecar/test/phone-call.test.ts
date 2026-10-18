import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeError, type BackgroundTask, type MemoryScope, type PhoneState, type PlanUsage, type ServerEvent, type Settings, type SubagentProgress } from "@forge/protocol";
import * as cfg from "../src/config/claude-config.js";
import { encodeG711, FRAME_SAMPLES, rms, decodeG711 } from "../src/phone/audio.js";
import type { ConversationCallbacks } from "../src/phone/call-controller.js";
import type { PhoneToolset } from "../src/phone/phone-agent.js";
import { PhoneService, type PhoneDeps, type PhoneRpc } from "../src/phone/phone-service.js";
import { ChatWindowState } from "../src/util/chat-windows.js";
import { PHONE_TOOLS, runPhoneTool, type ParamSpec } from "../src/phone/tools.js";
import { buildSdp } from "../src/phone/sdp.js";
import { SecretStore } from "../src/phone/secrets.js";
import { getHeader, getHeaders, parseNameAddr, parseSip, responseTo, serializeSip, type SipMessage } from "../src/phone/sip-message.js";
import { SipUserAgent } from "../src/phone/sip-ua.js";
import { RtpSession } from "../src/phone/rtp.js";
import type { VoiceProvider } from "../src/phone/voice.js";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { localDate } from "../src/reports/daily-report.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import type { SessionService } from "../src/sessions/session-service.js";
import type { DevServerService } from "../src/devserver/dev-server.js";
import { tempDir } from "./helpers.js";
import type { WorktreeService } from "../src/automation/worktrees.js";
import type { TestDbService } from "../src/devtools/test-db.js";
import { KnowledgeStore } from "../src/knowledge/knowledge.js";

interface FakeSession {
  id: string;
  projectId: string;
  title: string;
  status: string;
  live: boolean;
  updatedAt: string;
  projectName: string;
  background: BackgroundTask[];
  subagents: SubagentProgress[];
}

const fakeSession = (o: Omit<FakeSession, "updatedAt" | "background" | "subagents"> & Partial<FakeSession>): FakeSession => ({
  updatedAt: new Date().toISOString(),
  background: [],
  subagents: [],
  ...o,
});

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const tone = (ms: number, amp = 9000) => Int16Array.from({ length: (ms / 1000) * 8000 }, (_, i) => Math.round(Math.sin((2 * Math.PI * 300 * i) / 8000) * amp));
/** A number entry of the phone settings, switched on unless said otherwise. */
const num = (number: string, enabled = true, label = "") => ({ id: number, number, label, enabled });
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
    // The private address registered first is removed again, so the PBX does not keep a dead binding.
    const privateContact = contacts[0]!.replace(/;expires=\d+$/, "");
    expect(contacts).toContain(`${privateContact};expires=0`);
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
  let windowRequests: ServerEvent[] = [];
  let chatWindows: ChatWindowState;
  let projectId = "";
  let worktreesCreated: string[] = [];
  /** fromDir of each created worktree */
  let createdFrom: string[] = [];
  let removedWorktrees: string[] = [];
  let startedIn: string[] = [];
  let lastStart: { projectId: string; prompt: string; effort?: string } | null;
  let failStart: boolean;
  let planUsage: PlanUsage;
  let sessionList: FakeSession[];
  let secrets: SlowSecrets;
  let failConversation: boolean;
  let rtps: RtpSession[];
  let logs: string[];
  let present: boolean;
  let testDbRunning: boolean;
  let testDbStatus: string | null;
  let testDbCalls: string[];
  let taskCalls: string[];
  let approvals: string[];
  let prsCreated: string[];
  let projects: ProjectManager;
  let gitEngine: GitEngine;
  let timing: NonNullable<PhoneDeps["timing"]>;
  /** FORGE's RPC methods the phone calls: method -> fake result; calls are recorded */
  let rpcResults: Record<string, (params: never) => unknown>;
  let rpcCalls: Array<[string, unknown]>;
  let devConfig: { env: string; useEnv: boolean; database: { port: number; name: string; password: string; withDevServer: boolean; envVar: string | null } };

  beforeEach(async () => {
    t = tempDir();
    mkdirSync(path.join(t.dir, "shop"), { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, new GitEngine(), () => "balanced");
    gitEngine = new GitEngine();
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
    present = false;
    worktreesCreated = [];
    createdFrom = [];
    removedWorktrees = [];
    startedIn = [];
    lastStart = null;
    failStart = false;
    planUsage = { available: false, subscriptionType: null, windows: [], fetchedAt: new Date().toISOString(), error: "kein Abo" };
    taskCalls = [];
    approvals = [];
    prsCreated = [];
    testDbStatus = null;
    sessionList = [fakeSession({ id: "s1", projectId, title: "Warenkorb", status: "idle", live: true, projectName: "shop" })];
    const sessions = {
      get: (id: string) => {
        const s = sessionList.find((x) => x.id === id);
        if (!s) throw new Error("not found");
        return s;
      },
      listLive: () => sessionList.filter((s) => s.live),
      listAll: () => sessionList,
      start: async (o: { projectId: string; prompt: string; effort?: string }) => {
        if (failStart) throw new Error("Claude startet nicht");
        const s = fakeSession({ id: `s${sessionList.length + 1}`, projectId: o.projectId, title: o.prompt, status: "starting", live: true, projectName: "x" });
        sessionList.push(s);
        startedIn.push(o.projectId);
        lastStart = o;
        return s;
      },
      stop: async (id: string) => steered.push(`stop:${id}`),
      stopTask: async (id: string, taskId: string) => (taskCalls.push(`stop:${id}:${taskId}`), { ok: true }),
      taskOutput: async () => ({ output: "> vitest run\n\nnpm ERR! Test fehlgeschlagen\n", totalBytes: 40, truncated: false }),
      toBackground: async (id: string, toolUseId?: string) => (taskCalls.push(`bg:${id}:${toolUseId ?? "alle"}`), { moved: true }),
      messageTask: async (id: string, q: { taskId?: string }, text: string) => (taskCalls.push(`msg:${id}:${q.taskId}:${text}`), sessionList[0]),
      respondApproval: (id: string, requestId: string, decision: string, scope: string) => approvals.push(`${id}:${requestId}:${decision}:${scope}`),
      closeProject: async (ids: string[]) => steered.push(`closeProject:${ids.join(",")}`),
      summarize: async () => ({ summary: "Export gebaut, Tests offen.", model: "haiku" }),
      suggestPullRequest: async () => ({ title: "CSV-Export", body: "Neu: CSV-Export", base: "main", head: "agent/csv" }),
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
      planUsage: async () => planUsage,
      rateLimit: () => ({ status: "ok", limitType: null, resetsAt: null, utilization: null, updatedAt: null }),
    } as unknown as SessionService;
    secrets = new SlowSecrets(path.join(t.dir, "secrets"));
    const voice: VoiceProvider = {
      transcribe: async () => transcripts.shift() ?? "",
      async *speak(text) {
        spoken.push(text);
        yield tone(200, 6000);
      },
    };
    testDbRunning = false;
    testDbCalls = [];
    timing = { notifyDelayMs: 50, notifyCooldownMs: 0, pinLimits: { perCaller: 2, baseDelayMs: 0 }, callbackTickMs: 100 };
    devConfig = { env: "", useEnv: true, database: { port: 54330, name: "shop", password: "x", withDevServer: false, envVar: "DATABASE_URL" } };
    rpcResults = {};
    rpcCalls = [];
    windowRequests = [];
    chatWindows = new ChatWindowState((e) => windowRequests.push(e));
    svc = new PhoneService({
      chatWindows,
      rpc: (async (method: string, params: never) => {
        rpcCalls.push([method, params]);
        const fn = rpcResults[method];
        if (!fn) throw new Error(`${method} ist im Test nicht vorgesehen`);
        return fn(params);
      }) as PhoneRpc,
      db,
      projects,
      sessions,
      devServers: {
        state: async (id: string) => ({ projectId: id, status: id === projectId ? "running" : "stopped", exitCode: null, error: null }),
        output: (id: string) => `Server ${id}\nError: Port 3000 belegt\n`,
        forget: async (id: string) => steered.push(`forget:${id}`),
      } as unknown as DevServerService,
      testDb: {
        state: () => ({ status: testDbStatus ?? (testDbRunning ? "running" : "stopped"), initialized: true, error: null, progress: 0.4 }),
        isRunning: () => testDbRunning,
        start: async (id: string) => (testDbCalls.push(`start:${id}`), (testDbRunning = true)),
        stop: async (id: string) => (testDbCalls.push(`stop:${id}`), (testDbRunning = false)),
        reset: async (id: string) => (testDbCalls.push(`reset:${id}`), (testDbRunning = false)),
        log: () => "LOG: Start\nFATAL: Port 54330 ist belegt\n",
      } as unknown as TestDbService,
      devTools: {
        get: () => devConfig,
        update: (_id: string, patch: { env?: string; useEnv?: boolean; database?: Partial<typeof devConfig.database> }) =>
          (devConfig = { ...devConfig, env: patch.env ?? devConfig.env, useEnv: patch.useEnv ?? devConfig.useEnv, database: { ...devConfig.database, ...patch.database } }),
        envFiles: async () => [".env", ".env.local"],
        readEnvFile: async (_id: string, name: string) => (name === ".env.local" ? "# lokal\nSTRIPE_KEY=sk_live_geheim\nexport PORT=3000\n" : "X=1\n"),
      } as unknown as NonNullable<PhoneDeps["devTools"]>,
      agentFinish: { finish: async (id: string, action: "merge" | "discard") => (steered.push(`finish:${action}:${id}`), { message: "1 Commit von agent/x in main übernommen." }) } as unknown as NonNullable<PhoneDeps["agentFinish"]>,
      github: {
        prForBranch: async () => null,
        createPr: async (_dir: string, p: { title: string; base: string; head: string; draft: boolean }) => (prsCreated.push(`${p.head}->${p.base}:${p.title}:${p.draft}`), "https://github.com/x/y/pull/7"),
      },
      knowledge: new KnowledgeStore(projects, () => {}),
      git: gitEngine,
      worktrees: {
        create: async (parent: { id: string; name: string; path: string }, branch: string, opts?: { fromDir?: string }) => {
          worktreesCreated.push(`${parent.name}:${branch}`);
          createdFrom.push(opts?.fromDir ?? "");
          const dir = path.join(t.dir, `shop-agent-${worktreesCreated.length}`);
          mkdirSync(dir, { recursive: true });
          return projects.import(dir, parent.id);
        },
        assertRemovable: async () => {},
        remove: async (wt: { id: string; name: string }, force: boolean, opts?: { deleteBranch?: boolean }) => {
          removedWorktrees.push(`${wt.name}:${force}:${opts?.deleteBranch === true}`);
          projects.remove(wt.id);
          return { deletedBranch: opts?.deleteBranch ? "agent/x" : null, branchError: null };
        },
      } as unknown as WorktreeService,
      secrets,
      emit: (e) => events.push(e),
      claude: () => ({ path: "claude", env: {}, cwd: t.dir }),
      log: (m) => logs.push(m),
      userPresent: () => present,
      timing,
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
      allowedCallers: [num("+49 30 1112233")],
      notifyNumbers: [num("0172 999")],
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
    expect(svc.config()).toMatchObject({ hasPassword: true, hasOpenAiKey: true, hasPin: true, allowedCallers: [{ number: "+49 30 1112233", enabled: true }] });
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
    svc.onServerEvent({ event: "session.done", payload: { sessionId: "s1" } });
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

  it("turns numbers stored before the number lists into switched-on entries", async () => {
    const { notifyNumbers: _n, ...stored } = db.getPhoneSettings() as Record<string, unknown>;
    db.setPhoneSettings({ ...stored, notifyNumber: "0172 999", allowedCallers: ["+49 30 1112233", "0151 2"] });
    await svc.reload();
    const c = svc.config();
    expect(c.notifyNumbers).toEqual([{ id: expect.any(String), number: "0172 999", label: "", enabled: true }]);
    expect(c.allowedCallers.map((n) => [n.number, n.enabled])).toEqual([
      ["+49 30 1112233", true],
      ["0151 2", true],
    ]);
    expect(c).not.toHaveProperty("notifyNumber");
    // Saving keeps the new shape only.
    await svc.saveConfig({ notifyNumbers: [...c.notifyNumbers, num("  ", true), num("0160 3", false, " Büro ")] });
    expect(db.getPhoneSettings()).not.toHaveProperty("notifyNumber");
    expect(svc.config().notifyNumbers.map((n) => [n.number, n.label, n.enabled])).toEqual([
      ["0172 999", "", true],
      ["0160 3", "Büro", false],
    ]);
  });

  it("rings all switched-on numbers at once, cancels the others when one answers and rejects switched-off callers", async () => {
    await svc.saveConfig({ notifyNumbers: [num("0172 999"), num("0151 555", true, "Büro"), num("0160 000", false)], allowedCallers: [num("+49 30 1112233", false)] });
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");

    // A switched-off caller is not allowed in.
    pbx.send(invite(pbx, "0301112233", "c-off", phoneEnd.port), pbx.uaContact.port);
    await pbx.next((m) => m.status === 403 && getHeader(m, "call-id") === "c-off");

    await svc.testCall();
    const legs = [await pbx.next((m) => m.method === "INVITE"), await pbx.next((m) => m.method === "INVITE")];
    expect(legs.map((l) => l.msg.uri).sort()).toEqual(["sip:0151555@127.0.0.1", "sip:0172999@127.0.0.1"]);
    // Both offer the same audio port: whoever answers talks on it.
    expect(new Set(legs.map((l) => /m=audio (\d+)/.exec(l.msg.body)![1])).size).toBe(1);
    for (const l of legs) pbx.send(responseTo(l.msg, 180, "Ringing", "callee"), l.port);
    await sleep(200);
    expect(svc.state().call).toMatchObject({ direction: "out", state: "ringing", number: "0172 999, 0151 555" });

    const office = legs.find((l) => l.msg.uri!.includes("0151555"))!;
    const mobile = legs.find((l) => l !== office)!;
    const answer = responseTo(office.msg, 200, "OK", "office");
    answer.headers.push(["contact", `<sip:0151555@127.0.0.1:${pbx.port}>`], ["content-type", "application/sdp"]);
    answer.body = buildSdp({ ip: "127.0.0.1", port: phoneEnd.port, sessionId: "6", version: 1, codec: 0 });
    pbx.send(answer, office.port);
    await pbx.next((m) => m.method === "ACK" && getHeader(m, "call-id") === getHeader(office.msg, "call-id"));
    // The other number stops ringing right away.
    const cancel = await pbx.next((m) => m.method === "CANCEL");
    expect(getHeader(cancel.msg, "call-id")).toBe(getHeader(mobile.msg, "call-id"));
    pbx.send(responseTo(cancel.msg, 200, "OK", "callee"), cancel.port);
    pbx.send(responseTo(mobile.msg, 487, "Request Terminated", "callee"), mobile.port);

    await until(() => svc.state().call?.state === "active", 5000, "active");
    expect(svc.state().call?.number).toBe("0151 555");
    // Audio goes to the address of the answering number.
    expect((rtps.at(-1) as unknown as { remote: { port: number } }).remote.port).toBe(phoneEnd.port);

    await svc.hangup();
    const bye = await pbx.next((m) => m.method === "BYE");
    expect(getHeader(bye.msg, "call-id")).toBe(getHeader(office.msg, "call-id"));
    pbx.send(responseTo(bye.msg, 200, "OK"), bye.port);
    await until(() => svc.state().call === null, 3000, "ended");
    expect(svc.calls(5)[0]).toMatchObject({ direction: "out", number: "0151 555", result: "answered", reason: "Testanruf" });
    // The switched-off number never rang.
    expect(pbx.inbox.some((r) => r.msg.method === "INVITE" && r.msg.uri!.includes("0160000"))).toBe(false);
  }, 40_000);

  it("does not call while the user works in the FORGE window", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    present = true;
    svc.onServerEvent({
      event: "session.event",
      payload: {
        seq: 1,
        sessionId: "s1",
        ts: new Date().toISOString(),
        body: { type: "turn.result", subtype: "success", isError: false, durationMs: 1, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, text: "Fertig." },
      },
    });
    svc.onServerEvent({ event: "session.done", payload: { sessionId: "s1" } });
    await until(() => logs.some((l) => l.includes("kein Rückruf (done), FORGE ist im Vordergrund")), 3000, "skipped");
    expect(svc.state().call).toBeNull();
    expect(svc.calls(5).filter((c) => c.direction === "out")).toEqual([]);
  }, 20_000);

  it("refuses to switch on while the setup is incomplete", async () => {
    await svc.saveConfig({ openAiKey: "" });
    await expect(svc.setEnabled(true)).rejects.toMatchObject({ message: expect.stringMatching(/OpenAI-API-Key fehlt/), details: { phoneSetupIncomplete: true } });
  });

  it("calls back as agreed in a call, tells what was asked for and keeps the appointment in the settings until then", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-callback");
    const conv = await until(() => convs[0], 5000, "conversation");
    // Agreed without a PIN: it only calls back the number that is calling.
    expect(await conv.tools.callBack(0.01, "ob die Tests der Session Warenkorb grün sind")).toMatch(/^Rückruf vereinbart für \d\d:\d\d Uhr\.$/);
    // The appointment is stored, not only held in memory.
    expect(JSON.stringify(db.getPhoneSettings())).toContain("ob die Tests der Session Warenkorb grün sind");
    await byeFromPbx("c-callback", inv, ok);

    const call = await pbx.next((m) => m.method === "INVITE", 10_000);
    expect(call.msg.uri).toBe("sip:0301112233@127.0.0.1");
    await until(() => convs[1], 5000, "callback conversation");
    expect(convs[1]!.said[0]).toMatch(/wie verabredet zurück/);
    expect(convs[1]!.said[0]).toContain("ob die Tests der Session Warenkorb grün sind");
    expect(svc.state().call).toMatchObject({ direction: "out", reason: "Rückruf wie verabredet: ob die Tests der Session Warenkorb grün sind" });
    expect(JSON.stringify(db.getPhoneSettings())).not.toContain("Warenkorb grün");
    pbx.send(responseTo(call.msg, 486, "Busy Here", "callee"), call.port);
    await until(() => svc.state().call === null, 5000, "callback ended");
  }, 40_000);

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
    expect(await conv.tools.alwaysOnTop("on")).toBe("FORGE bleibt im Vordergrund.");
    expect(db.getSettings().alwaysOnTop).toBe(true);
    expect(events).toContainEqual({ event: "settings.updated", payload: expect.objectContaining({ alwaysOnTop: true }) });
    expect(await conv.tools.alwaysOnTop("off")).toBe("FORGE bleibt nicht im Vordergrund.");
    await conv.tools.status();
    expect(await conv.tools.chatWindow("status")).toBe("Keine Session ist in einem eigenen Fenster offen.");
    expect(await conv.tools.chatWindow("pin", "S1")).toBe("S1 öffnet sich in einem eigenen Fenster, das über allen anderen Programmen bleibt.");
    expect(windowRequests).toEqual([{ event: "chatWindow.request", payload: expect.objectContaining({ action: "pin", sessionId: "s1" }) }]);
    chatWindows.report(["s1"], ["s1"]);
    expect(await conv.tools.chatWindow("status")).toMatch(/^In eigenen Fenstern: S1 .*\(angeheftet\)\.$/);
    expect(await conv.tools.chatWindow("pin", "S1")).toBe("Das Fenster von S1 ist schon angeheftet.");
    expect(await conv.tools.chatWindow("unpin", "S1")).toBe("Das Fenster von S1 bleibt nicht mehr im Vordergrund.");
    expect(await conv.tools.chatWindow("close", "S1")).toBe("S1 ist zurück im Hauptfenster, ihr Fenster schließt sich.");
    expect(windowRequests.map((e) => (e.event === "chatWindow.request" ? e.payload.action : null))).toEqual(["pin", "unpin", "close"]);
    expect(await conv.tools.chatWindow("open")).toMatch(/^Fehler: Welche Session/);
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

  it("runs the test database behind the PIN and keeps notes in the project knowledge", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-dev");
    const conv = await until(() => convs[0], 5000, "conversation");
    expect(await conv.tools.testDatabase("shop", "status")).toBe("Die Test-Datenbank von shop ist gestoppt.");
    expect(await conv.tools.testDatabase("shop", "start")).toMatch(/^Gesperrt/);
    expect(await conv.tools.rememberNote("shop", "Deploy", "Läuft über Coolify")).toMatch(/^Gesperrt/);
    // Knowledge can be as confidential as session results: only after the PIN.
    expect(await conv.tools.knowledge("shop", "deploy")).toMatch(/^Gesperrt/);
    await sleep(200);
    await phoneEnd.digits("4711#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked");
    expect(await conv.tools.knowledge("shop", "deploy")).toBe("shop hat noch kein Projektwissen.");

    expect(await conv.tools.testDatabase("shop", "start")).toBe("Test-Datenbank von shop läuft.");
    expect(await conv.tools.testDatabase("shop", "reset")).toBe("Test-Datenbank von shop geleert und wieder gestartet.");
    expect(testDbCalls).toEqual([`start:${projectId}`, `reset:${projectId}`, `start:${projectId}`]);

    expect(await conv.tools.rememberNote("shop", "Deploy auf Coolify", "Env-Variablen setzt Coolify, nicht die Datei.")).toBe("Notiz „Deploy auf Coolify“ im Projektwissen von shop abgelegt.");
    expect(await conv.tools.rememberNote("shop", "Coolify Deploy", "Traefik macht die Kompression.")).toBe("Notiz bei „Deploy auf Coolify“ ergänzt.");
    const found = await conv.tools.knowledge("shop", "kompression");
    expect(found).toContain("deploy-auf-coolify: Deploy auf Coolify");
    expect(found.startsWith("<<<SESSION-DATEN>>>")).toBe(true);
    const full = await conv.tools.knowledge("shop", "", "deploy-auf-coolify");
    expect(full).toContain("Env-Variablen setzt Coolify");
    expect(full).toContain("Traefik macht die Kompression.");
    expect(await conv.tools.knowledge("shop", "", undefined, true)).toMatch(/^Fehler: Zum Löschen brauche ich die Kennung/);
    expect(await conv.tools.knowledge("shop", "", "deploy-auf-coolify", true)).toBe("Eintrag deploy-auf-coolify aus dem Projektwissen von shop gelöscht.");
    expect(await conv.tools.knowledge("shop", "kompression")).toBe("shop hat noch kein Projektwissen.");

    rpcResults["knowledge.cleanup"] = () => ({ overlaps: [{ a: "traefik", b: "deploy", score: 0.71 }], long: [{ id: "sync", chars: 9200 }] });
    const tidy = await conv.tools.knowledge("shop", "", undefined, undefined, { cleanup: true });
    expect(tidy).toContain("Überschneidung 71 %: traefik (traefik) und deploy (deploy)");
    expect(tidy).toContain("Sehr lang (9 KB): sync (sync)");
    expect(await conv.tools.knowledge("shop", "", undefined, undefined, { merge: ["deploy", "deploy"] })).toMatch(/^Fehler: Zum Zusammenführen brauche ich mindestens zwei/);
    rpcResults["knowledge.mergeDraft"] = () => ({ title: "Deploy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy", model: "sonnet" });
    rpcResults["knowledge.merge"] = () => ({ entry: { id: "deploy", title: "Deploy", summary: "Wie wir ausliefern", tags: ["deploy"], updatedAt: "", content: "# Deploy" }, removed: ["traefik"] });
    expect(await conv.tools.knowledge("shop", "", undefined, undefined, { merge: ["deploy", "traefik"] })).toMatch(/^Zusammengeführt in deploy: .*Deploy.*\. Gelöscht: traefik\. Den Text hat Claude \(sonnet\) geschrieben/);
    expect(rpcCalls.filter(([m]) => m === "knowledge.merge").at(-1)?.[1]).toEqual({ projectId, ids: ["deploy", "traefik"], title: "Deploy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy" });

    rpcResults["knowledge.mergePlan"] = () => ({ groups: [], model: "sonnet" });
    expect(await conv.tools.knowledge("shop", "", undefined, undefined, { autoMerge: true })).toBe("Claude (sonnet) hat im Projektwissen von shop nichts gefunden, das sich zusammenführen lässt.");
    rpcResults["knowledge.mergePlan"] = () => ({
      groups: [
        { ids: ["deploy", "traefik"], reason: "Auslieferung" },
        { ids: ["sync", "backup"], reason: "Sicherung" },
      ],
      model: "sonnet",
    });
    rpcResults["knowledge.mergeDraft"] = (params: { ids: string[] }) => {
      if (params.ids[0] === "sync") throw new Error("Claude nicht erreichbar");
      return { title: "Deploy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy", model: "sonnet" };
    };
    const auto = await conv.tools.knowledge("shop", "", undefined, undefined, { autoMerge: true });
    expect(auto).toMatch(/^Claude \(sonnet\) hat 2 Gruppen gefunden\./);
    expect(auto).toContain("Zusammengeführt in deploy (Deploy). Gelöscht: traefik.");
    expect(auto).toContain("Nicht zusammengeführt: sync, backup. Claude nicht erreichbar");
    expect(rpcCalls.filter(([m]) => m === "knowledge.merge").at(-1)?.[1]).toMatchObject({ projectId, ids: ["deploy", "traefik"] });

    rpcResults["knowledge.checkRefs"] = () => ({ git: true, entries: [{ id: "deploy", missing: [], checked: 3 }] });
    expect(await conv.tools.knowledge("shop", "", undefined, undefined, { stale: true })).toBe("Im Projektwissen von shop verweist kein Eintrag auf Dateien oder Bezeichner, die es nicht mehr gibt.");
    rpcResults["knowledge.checkRefs"] = () => ({
      git: true,
      entries: [
        { id: "deploy", missing: [{ ref: "src/deploy.ts", kind: "path" }, { ref: "runDeploy", kind: "name", hint: "entfernt in abc123: Deploy neu" }], checked: 5 },
        { id: "sync", missing: [], checked: 2 },
      ],
    });
    const stale = await conv.tools.knowledge("shop", "", undefined, undefined, { stale: true });
    expect(stale).toMatch(/^Ein Eintrag verweist auf etwas, das es nicht mehr gibt:/);
    expect(stale).toContain("deploy (deploy): fehlt src/deploy.ts, runDeploy");
    expect(await conv.tools.knowledge("shop", "", undefined, undefined, { markChecked: true })).toMatch(/^Fehler: Dafür brauche ich die Kennung/);
    rpcResults["knowledge.markChecked"] = () => ({ verified: ["src/deploy.ts", "runDeploy"] });
    expect(await conv.tools.knowledge("shop", "", "deploy", undefined, { markChecked: true })).toMatch(/^Eintrag deploy ist als geprüft markiert\. Diese Verweise meldet FORGE nicht mehr: .*src\/deploy\.ts, runDeploy/);
    rpcResults["knowledge.fixDraft"] = () => ({ title: "Deploy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy\n\nNeu", model: "sonnet" });
    rpcResults["knowledge.save"] = (params: { id: string; title: string }) => ({ id: params.id, title: params.title, summary: "", tags: [], updatedAt: "", content: "" });
    expect(await conv.tools.knowledge("shop", "", "deploy", undefined, { fix: true })).toMatch(/^Claude \(sonnet\) hat deploy korrigiert: .*Deploy.*\. Die alte Fassung liegt im Git\./);
    expect(rpcCalls.filter(([m]) => m === "knowledge.save").at(-1)?.[1]).toEqual({ projectId, id: "deploy", title: "Deploy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy\n\nNeu" });

    testDbCalls = [];
    expect(await conv.tools.testDatabase("shop", "restart")).toBe("Test-Datenbank von shop neu gestartet.");
    expect(testDbCalls).toEqual([`stop:${projectId}`, `start:${projectId}`]);
    expect(await conv.tools.testDatabase("shop", "log")).toContain("FATAL: Port 54330 ist belegt");
    testDbStatus = "installing";
    expect(await conv.tools.testDatabase("shop", "status")).toBe("PostgreSQL für die Test-Datenbank wird gerade heruntergeladen, 40 Prozent.");
    testDbStatus = "starting";
    expect(await conv.tools.testDatabase("shop", "status")).toBe("Die Test-Datenbank von shop startet gerade.");
    testDbStatus = "stopping";
    expect(await conv.tools.testDatabase("shop", "status")).toBe("Die Test-Datenbank von shop wird gerade gestoppt.");

    events = [];
    expect(await conv.tools.devSettings("shop", {})).toBe(
      "shop: Test-Umgebung geht an Dev-Server und Tests. Test-Datenbank auf Port 54330, Name shop, startet nicht mit dem Dev-Server, Verbindungs-URL in DATABASE_URL.",
    );
    expect(events).not.toContainEqual({ event: "project.updated", payload: { projectId } });
    expect(await conv.tools.devSettings("shop", { useEnv: false, withDevServer: true, envVar: "" })).toBe(
      "Gespeichert. Test-Umgebung ist aus. Test-Datenbank auf Port 54330, Name shop, startet mit dem Dev-Server, Verbindungs-URL wird nicht übergeben.",
    );
    // The UI reloads the dev tools on this event.
    expect(events).toContainEqual({ event: "project.updated", payload: { projectId } });
    expect(await conv.tools.devServer("shop", "output")).toContain("Error: Port 3000 belegt");
    await byeFromPbx("c-dev", inv, ok);
  }, 30_000);

  it("finds sessions only by a known short name or a unique title", async () => {
    await svc.saveConfig({ requirePin: false });
    sessionList.push(
      fakeSession({ id: "s2", projectId, title: "Warenkorb Export", status: "idle", live: true, projectName: "shop" }),
      fakeSession({ id: "s3", projectId, title: "Login", status: "idle", live: true, projectName: "shop" }),
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

  /** An agent worktree of shop, named like WorktreeService names it. */
  async function agentWorktree() {
    const dir = path.join(t.dir, "shop-wt");
    mkdirSync(dir, { recursive: true });
    const wt = await projects.import(dir, projectId);
    return projects.update(wt.id, { name: "shop · agent/csv-export-ab12" });
  }

  it("prefers a project over its agents and names no projects before the PIN", async () => {
    const wt = await agentWorktree();
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-find");
    const conv = await until(() => convs[0], 5000, "conversation");
    expect(await conv.tools.testDatabase("nirgends", "status")).toBe("Fehler: Kein Projekt „nirgends“.");
    expect(await conv.tools.testDatabase("sho", "status")).toBe("Die Test-Datenbank von shop ist gestoppt.");
    // An agent only when its branch part is named.
    expect(await conv.tools.testDatabase("shop csv export", "status")).toBe(`Die Test-Datenbank von ${wt.name} ist gestoppt.`);
    expect(await conv.tools.testDatabase("export", "status")).toBe(`Die Test-Datenbank von ${wt.name} ist gestoppt.`);
    // A session named before the PIN could give its title away.
    expect(await conv.tools.testDatabase("", "status", { session: "S1" })).toMatch(/^Gesperrt/);
    await sleep(200);
    await phoneEnd.digits("4711#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked");
    expect(await conv.tools.testDatabase("nirgends", "status")).toBe("Fehler: Kein Projekt „nirgends“. Vorhanden: shop.");
    await byeFromPbx("c-find", inv, ok);
  }, 30_000);

  it("tells how far an agent's worktree is prepared and starts the preparation again", async () => {
    const wt = await agentWorktree();
    await svc.saveConfig({ requirePin: false });
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-setup");
    const conv = await until(() => convs[0], 5000, "conversation");
    const state = {
      projectId: wt.id,
      status: "failed",
      steps: [
        { id: "deps", label: "Abhängigkeiten", status: "failed", detail: "pnpm install fehlgeschlagen (Exit-Code 1)", durationMs: 3000 },
        { id: "build", label: "Build-Ausgaben", status: "pending", detail: null, durationMs: null },
      ],
      devPort: 4100,
      startedAt: "2026-10-17T10:00:00.000Z",
      finishedAt: "2026-10-17T10:00:05.000Z",
    };
    rpcResults["worktrees.setup"] = () => state;
    rpcResults["worktrees.prepare"] = () => ({ ...state, status: "running" });
    const said = await conv.tools.devServer("export", "setup");
    expect(said).toMatch(/^Die Vorbereitung von .+ ist mit Fehlern fertig\. Abhängigkeiten: fehlgeschlagen \(.*pnpm install fehlgeschlagen/);
    expect(said).toContain("Sein Dev-Server bekommt Port 4100.");
    expect(said).not.toContain("Build-Ausgaben");
    expect(await conv.tools.devServer("export", "prepare")).toMatch(/^Vorbereitung von .+ neu gestartet/);
    expect(rpcCalls.at(-1)).toEqual(["worktrees.prepare", { projectId: wt.id }]);
    expect(await conv.tools.devServer("sho", "setup")).toMatch(/^shop ist kein Agent/);
    await byeFromPbx("c-setup", inv, ok);
  }, 30_000);

  it("follows background tasks, answers for the whole session and says when nothing ran", async () => {
    await svc.saveConfig({ requirePin: false });
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    sessionList[0] = fakeSession({
      id: "s1",
      projectId,
      title: "Warenkorb",
      status: "running",
      live: true,
      projectName: "shop",
      subagents: [{ taskId: "k1", toolUseId: "tu1", description: "Auth prüfen", agentType: null, summary: "Liest die Login-Routen", lastTool: null, toolUses: 2, startedAt: fiveMinutesAgo }],
      background: [{ taskId: "b1", description: "npm test", taskType: "local_bash", toolUseId: "tb1", startedAt: new Date().toISOString(), summary: null }],
    });
    const now = new Date().toISOString();
    db.insertSession({ id: "s1", projectId, claudeSessionId: null, cwd: t.dir, title: "Warenkorb", model: null, effort: null, profile: "balanced", permissionMode: "default", status: "running", apiKeySource: null, createdAt: now, updatedAt: now, lastError: null });
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-tasks");
    const conv = await until(() => convs[0], 5000, "conversation");
    await conv.tools.status();

    const details = await conv.tools.details("S1");
    expect(details).toContain("Laufende Aufgaben:");
    expect(details).toContain("Subagent <<<SESSION-DATEN>>>Auth prüfen<<<ENDE SESSION-DATEN>>>, seit 5 Minuten, zuletzt: <<<SESSION-DATEN>>>Liest die Login-Routen");
    expect(details).toContain("Im Hintergrund: Befehl <<<SESSION-DATEN>>>npm test<<<ENDE SESSION-DATEN>>>, seit eben");
    expect(await conv.tools.details("S1", { summary: true })).toContain("Zusammenfassung des Verlaufs: <<<SESSION-DATEN>>>Export gebaut, Tests offen.");

    expect(await conv.tools.backgroundTask("S1", "output", "npm")).toContain("npm ERR! Test fehlgeschlagen");
    // A subagent has no command output: its latest progress line instead.
    expect(await conv.tools.backgroundTask("S1", "output", "auth")).toBe("<<<SESSION-DATEN>>>Auth prüfen<<<ENDE SESSION-DATEN>>> zuletzt: <<<SESSION-DATEN>>>Liest die Login-Routen<<<ENDE SESSION-DATEN>>>");
    expect(await conv.tools.backgroundTask("S1", "stop")).toMatch(/^Fehler: Welche Aufgabe/);
    expect(await conv.tools.backgroundTask("S1", "stop", "npm test")).toBe("<<<SESSION-DATEN>>>npm test<<<ENDE SESSION-DATEN>>> gestoppt, der Rest von S1 läuft weiter.");
    expect(await conv.tools.backgroundTask("S1", "to_background", "auth")).toBe("In den Hintergrund verschoben, S1 arbeitet weiter.");
    expect(await conv.tools.backgroundTask("S1", "to_background", "npm")).toMatch(/läuft schon im Hintergrund/);
    expect(await conv.tools.backgroundTask("S1", "message", "auth")).toMatch(/^Fehler: Was soll in der Nachricht stehen/);
    expect(await conv.tools.backgroundTask("S1", "message", "auth", "Prüf auch die Logout-Route")).toBe("Nachricht an <<<SESSION-DATEN>>>Auth prüfen<<<ENDE SESSION-DATEN>>> geschickt, Claude gibt sie an den Subagenten weiter.");
    expect(await conv.tools.backgroundTask("S1", "message", "npm", "Brich ab, wenn es hängt")).toMatch(/^Nachricht zu .*npm test.* an S1 geschickt. Ein Befehl liest keine Eingaben/);
    expect(taskCalls).toEqual(["stop:s1:b1", "bg:s1:tu1", "msg:s1:k1:Prüf auch die Logout-Route", "msg:s1:b1:Brich ab, wenn es hängt"]);

    db.appendEvent("s1", {
      type: "approval.request",
      requestId: "r1",
      toolUseId: "tu9",
      toolName: "Bash",
      input: { command: "pnpm test" },
      title: null,
      description: null,
      reason: null,
      allowSessionScope: true,
      outsideProject: false,
    });
    expect(await conv.tools.respond("S1", "allow", undefined, undefined, "session")).toBe("Erledigt, Bash ist für den Rest von S1 erlaubt.");
    expect(approvals).toEqual(["s1:r1:allow:session"]);

    expect(await conv.tools.stop("S1")).toBe("S1 gestoppt.");
    sessionList[0]!.status = "idle";
    expect(await conv.tools.stop("S1")).toBe("S1 arbeitet gerade nicht, da lief nichts zum Stoppen.");
    expect(steered).toEqual(["stop:s1"]);

    db.appendEvent("s1", { type: "assistant.text", messageId: "m1", index: 0, text: "Der Stripe-Webhook liegt in api/stripe.ts." });
    expect(await conv.tools.search("stripe webhook")).toMatch(/^S1 <<<SESSION-DATEN>>>Warenkorb<<<ENDE SESSION-DATEN>>> im Projekt shop: <<<SESSION-DATEN>>>.*Stripe-Webhook/);
    expect(await conv.tools.search("zitronenfalter")).toBe("Dazu steht in keiner Session etwas.");
    await byeFromPbx("c-tasks", inv, ok);
  }, 30_000);

  it("starts agents from where the named worktree stands and cleans up after a failed start", async () => {
    await svc.saveConfig({ requirePin: false });
    const wt = await agentWorktree();
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-agent");
    const conv = await until(() => convs[0], 5000, "conversation");
    expect(await conv.tools.startSession("shop csv export", "Baue den JSON-Export", { agent: true, effort: "high" })).toMatch(/^Agent S\d im Projekt shop gestartet/);
    expect(worktreesCreated).toEqual([expect.stringMatching(/^shop:agent\/baue-den-json-export-/)]);
    expect(createdFrom).toEqual([wt.path]);
    expect(lastStart).toMatchObject({ effort: "high" });

    failStart = true;
    expect(await conv.tools.startSession("shop", "Noch ein Export", { agent: true })).toBe("Fehler: Claude startet nicht");
    expect(createdFrom[1]).toBe(projects.get(projectId).path);
    // Removed with force and together with its branch.
    expect(removedWorktrees).toEqual([expect.stringMatching(/:true:true$/)]);
    expect(projects.all().filter((p) => p.parentId === projectId)).toHaveLength(2);

    // "Reicht mein Limit noch?": the usage names the forecast, and a new agent comes with a hint.
    failStart = false;
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const limitAt = new Date(Date.now() + 3_600_000).toISOString();
    planUsage = {
      available: true,
      subscriptionType: "max",
      windows: [
        { key: "five_hour", label: "5 Stunden", utilization: 60, resetsAt, forecast: { outcome: "limit", limitAt, perHour: 40 } },
        { key: "seven_day", label: "Woche", utilization: 20, resetsAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(), forecast: { outcome: "enough", limitAt: null, perHour: 0.2 } },
      ],
      fetchedAt: new Date().toISOString(),
      error: null,
    };
    const usage = await conv.tools.usage();
    expect(usage).toMatch(/^5 Stunden: 60 Prozent, zurückgesetzt .+\. Bei diesem Tempo ist das Limit .+ um \d\d:\d\d erreicht, vor dem Reset\.$/m);
    expect(usage).toMatch(/^Woche: 20 Prozent, .+\. Bei diesem Tempo reicht es bis zum Reset\.$/m);
    expect(await conv.tools.startSession("shop", "Baue den XML-Export", { agent: true })).toMatch(/^Agent S\d im Projekt shop gestartet.+ Hinweis: Bei diesem Tempo ist das Nutzungslimit vor dem Reset erreicht: 5 Stunden gegen /);
    await byeFromPbx("c-agent", inv, ok);
  }, 30_000);

  it("pulls and pushes, hands conflicts to a Claude session and works on an agent's worktree by session", async () => {
    await svc.saveConfig({ requirePin: false });
    const wt = await agentWorktree();
    sessionList.push(fakeSession({ id: "s9", projectId: wt.id, title: "CSV", status: "idle", live: true, projectName: wt.name }));
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-git");
    const conv = await until(() => convs[0], 5000, "conversation");

    gitEngine.pull = async () => ({ output: "3 neue Commits übernommen.", integrated: { mode: "fast-forward", remoteCommits: 3, localCommits: 0 } });
    expect(await conv.tools.git("shop", "pull")).toBe("shop: 3 neue Commits übernommen.");
    gitEngine.push = async () => ({ branch: "main", output: "", integrated: { mode: "rebase", remoteCommits: 2, localCommits: 1 } });
    expect(await conv.tools.git("shop", "push", { allowProtected: true })).toBe("Branch main von shop gepusht. Vorher 2 neue Commits vom Server übernommen.");
    gitEngine.push = async () => {
      throw new ForgeError("GIT_CONFLICT", "Konflikt", { integration: { branch: "main", remoteCommits: 2, localCommits: 1, files: ["src/a.ts"] } });
    };
    expect(await conv.tools.git("shop", "push", { allowProtected: true })).toMatch(
      /^Die neuen Commits vom Server ließen sich nicht automatisch mit den eigenen zusammenführen\. Claude führt sie in der neuen Session S\d zusammen und pusht danach\.$/,
    );
    expect(lastStart).toMatchObject({ projectId, prompt: expect.stringContaining("Ich wollte main pushen.") });
    gitEngine.push = async () => {
      throw new ForgeError("GIT_FAILED", "Kein Remote origin.");
    };
    expect(await conv.tools.git("shop", "push")).toBe("Fehler: Kein Remote origin.");

    // By session: the agent's worktree, not the project.
    expect(await conv.tools.devServer("", "output", { session: "CSV" })).toContain(`Server ${wt.id}`);
    gitEngine.log = async () => [{ hash: "h", shortHash: "h", author: "Tjorven", authorEmail: "t@x", avatarUrl: null, date: "2026-10-13T10:00:00Z", subject: "CSV-Export", parents: [], refs: [] }];
    expect(await conv.tools.git("", "log", { session: "CSV" })).toContain(`Letzte Commits in ${wt.name}:\n<<<SESSION-DATEN>>>CSV-Export (Tjorven)<<<ENDE SESSION-DATEN>>> am`);

    // Pull request of the agent's branch, then clean the agent up.
    gitEngine.currentBranch = async () => "agent/csv";
    gitEngine.defaultBranch = async () => "main";
    gitEngine.push = async () => ({ branch: "agent/csv", output: "", integrated: null });
    expect(await conv.tools.pullRequest("", "status", { session: "CSV" })).toBe("Für den Branch agent/csv gibt es keinen Pull Request.");
    expect(await conv.tools.pullRequest("", "create", { session: "CSV", draft: true })).toBe(
      "Pull Request <<<SESSION-DATEN>>>CSV-Export<<<ENDE SESSION-DATEN>>> von agent/csv nach main angelegt, als Entwurf.",
    );
    expect(prsCreated).toEqual(["agent/csv->main:CSV-Export:true"]);
    expect(await conv.tools.finishAgent("shop", "merge")).toBe("Fehler: shop ist kein Agent-Worktree.");
    expect(await conv.tools.finishAgent("", "merge", { session: "CSV" })).toBe("1 Commit von agent/x in main übernommen.");
    expect(steered.splice(0)).toEqual([`finish:merge:${wt.id}`]);
    expect(await conv.tools.removeAgent("shop")).toBe("Fehler: shop ist kein Agent-Worktree. Projekte entfernt das Werkzeug project mit remove.");
    // Losing the branch with its commits: only after the code on the keypad.
    const ask = await conv.tools.removeAgent("", { session: "CSV", deleteBranch: true });
    expect(ask).toContain("sein Branch mit den Commits");
    expect(removedWorktrees).toEqual([]);
    expect(await keypad(conv, ask)).toContain(`Worktree ${wt.name} entfernt, seine Session ist beendet. Branch agent/x gelöscht.`);
    expect(steered).toEqual([`closeProject:${wt.id}`, `forget:${wt.id}`]);
    expect(projects.all().some((p) => p.id === wt.id)).toBe(false);

    // s1 and the session that merges the conflict.
    expect(await conv.tools.projects()).toBe("shop, Branch agent/csv, Dev-Server läuft, 2 aktive Sessions");
    await byeFromPbx("c-git", inv, ok);
  }, 30_000);

  it("changes when FORGE calls, behind the PIN", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-calls");
    const conv = await until(() => convs[0], 5000, "conversation");
    expect(await conv.tools.callSettings({})).toBe("FORGE ruft an: wenn eine Session fertig ist, wenn eine Entscheidung nötig ist oder Claude dringend etwas meldet, bei Fehlern.");
    expect(await conv.tools.callSettings({ done: false })).toMatch(/^Gesperrt/);
    await sleep(200);
    await phoneEnd.digits("4711#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked");
    // After the PIN the numbers are named too.
    expect(await conv.tools.callSettings({ done: false, error: false })).toBe(
      "FORGE ruft an: wenn eine Entscheidung nötig ist oder Claude dringend etwas meldet. Angerufen wird: <<<SESSION-DATEN>>>0172 999<<<ENDE SESSION-DATEN>>>. Anrufen dürfen: <<<SESSION-DATEN>>>+49 30 1112233<<<ENDE SESSION-DATEN>>>.",
    );
    expect(svc.config().notifyOn).toEqual({ done: false, approval: true, error: false });

    // Numbers by phone: add, switch off by their name, remove.
    const add = await conv.tools.callSettings({ numbers: { action: "add", list: "notify", number: "0151 555", label: "Büro" } });
    expect(add).toMatch(/^<<<SESSION-DATEN>>>Büro \(0151 555\)<<<ENDE SESSION-DATEN>>> ist eingetragen und eingeschaltet\. FORGE ruft an: .* Es klingelt bei 2 Nummern gleichzeitig/);
    expect(await conv.tools.callSettings({ numbers: { action: "off", list: "notify", number: "büro" } })).toMatch(/ist jetzt ausgeschaltet\..*Büro 0151 555 \(aus\)/);
    expect(svc.config().notifyNumbers.map((n) => [n.number, n.label, n.enabled])).toEqual([
      ["0172 999", "", true],
      ["0151 555", "Büro", false],
    ]);
    expect(await conv.tools.callSettings({ numbers: { action: "off", list: "allowed", number: "030 1112233" } })).toContain("ist jetzt ausgeschaltet");
    expect(svc.config().allowedCallers[0]!.enabled).toBe(false);
    expect(await conv.tools.callSettings({ numbers: { action: "remove", list: "notify", number: "0151555" } })).toMatch(/ist gelöscht\./);
    expect(svc.config().notifyNumbers).toHaveLength(1);
    expect(await conv.tools.callSettings({ numbers: { action: "on", list: "notify", number: "Garage" } })).toMatch(/^Fehler: Keine Nummer „Garage“ in der Liste\./);

    expect(await conv.tools.callSettings({ approval: false })).toMatch(/^FORGE ruft von sich aus nicht mehr an\./);
    await byeFromPbx("c-calls", inv, ok);
  }, 30_000);

  /** Arguments that pass the schema of a tool: every required parameter with a plain value. */
  const sampleArgs = (params: Record<string, ParamSpec>) =>
    Object.fromEntries(
      Object.entries(params)
        .filter(([, p]) => !p.optional)
        .map(([k, p]) => [k, p.type === "string" ? (p.enum?.[0] ?? "x") : p.type === "boolean" ? false : p.type === "number" ? (p.min ?? 1) : []]),
    );

  /** An answered incoming call without PIN; returns its conversation and how to end it. */
  /** Types the code an irreversible tool asked for; resolves with FORGE's note about the result. */
  async function keypad(conv: { said: string[] }, ask: string) {
    expect(ask).toMatch(/^Bestätigung nötig/);
    const code = ask.match(/Telefontastatur (\d) (\d) (\d) und dann Raute/)!.slice(1).join("");
    const before = conv.said.length;
    await phoneEnd.digits(`${code}#`);
    return until(() => conv.said.slice(before).find((s) => s.includes("Über die Tastatur bestätigt")), 5000, "keypad");
  }

  async function openCall(callId: string) {
    await svc.saveConfig({ requirePin: false });
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall(callId);
    const conv = await until(() => convs[0], 5000, "conversation");
    return { conv, end: () => byeFromPbx(callId, inv, ok) };
  }

  it("locks every tool that reads or steers until the PIN, new tools included", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-locked");
    const conv = await until(() => convs[0], 5000, "conversation");
    // Counts without titles, plan usage, agreeing a callback and hanging up work before the PIN.
    const open = new Set(["status", "usage", "call_settings", "call_back", "hang_up"]);
    for (const spec of PHONE_TOOLS.filter((x) => !open.has(x.name))) {
      expect(`${spec.name}: ${await runPhoneTool(spec.name, sampleArgs(spec.params), conv.tools, { hangup: () => {} })}`).toMatch(new RegExp(`^${spec.name}: Gesperrt`));
    }
    expect(rpcCalls).toEqual([]);
    await byeFromPbx("c-locked", inv, ok);
  }, 30_000);

  it("creates, clones and configures projects, reads their files and extends their CLAUDE.md", async () => {
    const dir = projects.get(projectId).path;
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), '{ "name": "shop" }');
    db.updateSettings({ defaultProjectDir: t.dir });
    const repo = (fullName: string) => ({ fullName, description: null, private: true, updatedAt: "", cloneUrl: `https://github.com/${fullName}.git` });
    rpcResults = {
      "settings.get": () => db.getSettings(),
      "projects.create": (p: { name: string; gitEnabled: boolean; github: unknown }) => ({
        project: { id: "p-new", name: p.name, gitEnabled: p.gitEnabled },
        github: p.github ? { url: "https://github.com/me/blog", error: null } : null,
      }),
      "github.repos": () => [repo("me/shop-api"), repo("me/blog")],
      "github.account": () => ({ login: "me", id: 1, name: null, avatarUrl: null, profileUrl: "https://github.com/me" }),
      "github.orgs": () => [{ login: "vanturis", avatarUrl: null }, { login: "acme-labs", avatarUrl: null }],
      "projects.import": (p: { path: string; gitEnabled: boolean }) => ({ id: "p-imp", name: path.basename(p.path), gitEnabled: p.gitEnabled }),
      "github.publish": (p: { owner?: string }) => ({ url: `https://github.com/${p.owner ?? "me"}/landing` }),
      "projects.clone": () => ({ id: "p-clone", name: "shop-api" }),
      "projects.update": ({ projectId: id, ...patch }: { projectId: string }) => projects.update(id, patch),
      "projects.removalInfo": () => ({ path: dir, folderExists: true, folderBlocker: null, isWorktree: false, worktrees: 0, githubRepo: "me/shop", githubSignedIn: true, githubCanDelete: true }),
      "projects.remove": () => ({ removed: true, folderDeleted: true, githubDeleted: false }),
      "projects.listFiles": (p: { projectId: string; dir: string }) => projects.listFiles(p.projectId, p.dir),
      "projects.readFile": (p: { projectId: string; path: string }) => projects.readFile(p.projectId, p.path),
      "projects.allFiles": (p: { projectId: string }) => projects.allFiles(p.projectId),
      "config.memoryRead": (p: { projectId: string; scope: MemoryScope }) => cfg.readMemory(p.scope, projects.get(p.projectId).path),
      "config.memoryWrite": (p: { projectId: string; scope: MemoryScope; content: string; expectedMtimeMs: number | null }) =>
        cfg.writeMemory(p.scope, projects.get(p.projectId).path, p.content, p.expectedMtimeMs),
    };
    const { conv, end } = await openCall("c-projects");
    const callOf = (method: string) => rpcCalls.filter(([m]) => m === method).at(-1)?.[1];

    expect(await conv.tools.project("", "create", { name: "blog", github: "private" })).toBe("Projekt blog angelegt. Das private GitHub-Repository ist angelegt.");
    expect(callOf("projects.create")).toEqual({ name: "blog", parentDir: t.dir, gitInit: true, gitEnabled: true, github: { private: true, owner: null } });
    // A spoken organisation is matched against the account's organisations; the account itself means the personal one.
    expect(await conv.tools.project("", "create", { name: "crm", github: "public", owner: "Vanturis" })).toBe(
      "Projekt crm angelegt. Das öffentliche GitHub-Repository ist angelegt, in der Organisation vanturis.",
    );
    expect(callOf("projects.create")).toMatchObject({ github: { private: false, owner: "vanturis" } });
    await conv.tools.project("", "create", { name: "privat", github: "private", owner: "me" });
    expect(callOf("projects.create")).toMatchObject({ github: { private: true, owner: null } });
    expect(await conv.tools.project("", "create", { name: "x", github: "private", owner: "gibtsnicht" })).toMatch(/^Fehler: Keine GitHub-Organisation „gibtsnicht“. Vorhanden: /);
    expect(await conv.tools.project("", "import", { path: path.join(t.dir, "landing"), github: "private", owner: "acme" })).toBe(
      "Projekt landing aufgenommen. Das private GitHub-Repository ist angelegt, in der Organisation acme-labs.",
    );
    expect(callOf("github.publish")).toEqual({ projectId: "p-imp", private: true, owner: "acme-labs" });
    expect(await conv.tools.project("", "create", { name: "notizen", git: false, github: "private" })).toBe("Projekt notizen ohne Git angelegt.");
    expect(callOf("projects.create")).toEqual({ name: "notizen", parentDir: t.dir, gitInit: false, gitEnabled: false, github: null });
    expect(events).toContainEqual({ event: "project.updated", payload: { projectId: "p-new" } });
    // A spoken repository name is looked up among the account's repositories.
    expect(await conv.tools.project("", "clone", { url: "shop api" })).toBe("shop-api geklont und als Projekt aufgenommen.");
    expect(callOf("projects.clone")).toEqual({ url: "https://github.com/me/shop-api.git", parentDir: t.dir });
    expect(await conv.tools.project("", "clone", { url: "gibtsnicht" })).toMatch(/^Fehler: Kein GitHub-Repository „gibtsnicht“\. Vorhanden: /);
    expect(await conv.tools.project("", "import", {})).toBe("Fehler: Welcher Ordner? Bitte den Pfad nennen.");

    expect(await conv.tools.project("shop", "settings", { testCommand: "pnpm test", defaultEffort: "high" })).toBe(
      "Gespeichert für shop: Profil balanced, Standardmodell wie global eingestellt, Denkaufwand high, Testbefehl <<<SESSION-DATEN>>>pnpm test<<<ENDE SESSION-DATEN>>>, Dev-Befehl wird erkannt, mit Git.",
    );
    expect(projects.get(projectId)).toMatchObject({ testCommand: "pnpm test", defaultEffort: "high" });
    expect(await conv.tools.project("shop", "favorite", {})).toBe("shop ist jetzt ein Favorit.");
    expect(await conv.tools.project("shop", "info")).toMatch(/^shop, Favorit: Profil balanced, /);
    expect(await conv.tools.project("shop", "settings", { git: false })).toMatch(/, ohne Git\.$/);
    expect(await conv.tools.git("shop", "status")).toMatch(/^Fehler: shop ist ohne Git eingerichtet\./);
    expect(await conv.tools.project("shop", "settings", { git: true })).toMatch(/, mit Git\.$/);

    const listing = await conv.tools.files("shop", "list");
    expect(listing).toContain("Ordner: src.");
    expect(listing).toContain("package.json");
    expect(await conv.tools.files("shop", "find", { path: "Package.JSON" })).toBe("Gefunden: <<<SESSION-DATEN>>>package.json<<<ENDE SESSION-DATEN>>>.");
    expect(await conv.tools.files("shop", "find", { path: "fehlt.ts" })).toBe("In shop gibt es keine Datei <<<SESSION-DATEN>>>fehlt.ts<<<ENDE SESSION-DATEN>>>.");
    expect(await conv.tools.files("shop", "read", { path: "package.json" })).toBe('<<<SESSION-DATEN>>>package.json<<<ENDE SESSION-DATEN>>>: <<<SESSION-DATEN>>>{ "name": "shop" }<<<ENDE SESSION-DATEN>>>');

    expect(await conv.tools.claudeMd("shop", "read")).toBe("Die CLAUDE.md von shop ist leer oder fehlt.");
    expect(await conv.tools.claudeMd("shop", "append", { text: "Nutze pnpm." })).toBe("Die CLAUDE.md von shop ist ergänzt.");
    expect(await conv.tools.claudeMd("shop", "append", { text: "Texte auf Deutsch." })).toBe("Die CLAUDE.md von shop ist ergänzt.");
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe("Nutze pnpm.\n\nTexte auf Deutsch.\n");
    expect(await conv.tools.claudeMd("shop", "read")).toBe("Die CLAUDE.md von shop: <<<SESSION-DATEN>>>Nutze pnpm. Texte auf Deutsch.<<<ENDE SESSION-DATEN>>>");

    expect(await conv.tools.files("shop", "read", { path: ".env" })).toMatch(/^Fehler: .*Zugangsdaten/);
    // Removing it only from FORGE takes the session history: that waits for the code too.
    expect(await conv.tools.project("shop", "remove")).toMatch(/^Bestätigung nötig, noch ist nichts gelöscht\. Sag dem Anrufer: Das Projekt shop wird aus FORGE entfernt/);
    await phoneEnd.digits("*");
    await until(() => conv.said.at(-1)?.includes("mit Stern abgebrochen"), 5000, "cancelled");
    // Deleting folder or repository waits for a code on the keypad; nothing the model says can confirm it.
    const askDelete = async () => {
      const text = await conv.tools.project("shop", "remove", { deleteFolder: true, deleteGitHubRepo: true });
      expect(text).toMatch(/^Bestätigung nötig, noch ist nichts gelöscht\. .*der Ordner des Projekts shop .*das GitHub-Repository <<<SESSION-DATEN>>>me\/shop<<<ENDE SESSION-DATEN>>>/);
      return text.match(/Telefontastatur (\d) (\d) (\d) und dann Raute/)!.slice(1).join("");
    };
    const lastNote = () => conv.said.at(-1) ?? "";
    let code = await askDelete();
    await phoneEnd.digits(`${code === "000" ? "111" : "000"}#`);
    await until(() => lastNote().includes("Der Code war falsch"), 5000, "wrong code");
    code = await askDelete();
    await phoneEnd.digits("*");
    await until(() => lastNote().includes("mit Stern abgebrochen"), 5000, "cancelled");
    // The code of a cancelled request no longer deletes anything.
    await phoneEnd.digits(`${code}#`);
    await sleep(200);
    expect(callOf("projects.remove")).toBeUndefined();
    code = await askDelete();
    await phoneEnd.digits(`${code}#`);
    await until(() => lastNote().includes("Über die Tastatur bestätigt"), 5000, "confirmed");
    expect(lastNote()).toContain("Projekt shop aus FORGE entfernt. Der Ordner ist gelöscht.");
    expect(callOf("projects.remove")).toEqual({ projectId, deleteFolder: true, deleteGitHubRepo: true });
    await end();
  }, 30_000);

  it("switches the GitHub sync and fetches projects of other computers", async () => {
    const status = (patch: Record<string, unknown> = {}) => ({
      enabled: true,
      phase: "idle",
      account: "me",
      repo: "me/forge-data",
      lastSyncAt: "2026-10-13T10:00:00Z",
      error: null,
      remote: { updatedAt: "2026-10-13T10:00:00Z", device: "PC-B" },
      available: [{ key: "github.com/me/shop-api", name: "shop-api", cloneUrl: "https://github.com/me/shop-api.git" }],
      localOnly: [{ key: "project:github.com/me/blog", kind: "project", label: "Projekt blog", projectId: "p-blog" }],
      hasKey: true,
      ...patch,
    });
    let account: unknown = null;
    rpcResults = {
      "github.account": () => account,
      "settings.update": (p: Record<string, unknown>) => ({ ...db.getSettings(), ...p }),
      "sync.status": () => status(),
      "sync.now": () => status({ available: [] }),
      "sync.cloneProject": (p: { key: string }) => ({ id: "p-sync", name: p.key.split("/").pop() }),
      "sync.keep": () => status(),
      "sync.forceLocal": () => status({ localOnly: [] }),
      "sync.versions": () => [
        { sha: "bbbbbbb", date: "2026-10-13T11:00:00Z", device: "PC-A" },
        { sha: "aaaaaaa", date: "2026-10-12T11:00:00Z", device: "PC-B" },
      ],
      "sync.restoreVersion": () => ({ restored: ["settings"], notes: ["Die anderen Computer bekommen diesen Stand mit dem nächsten Abgleich."] }),
    };
    const { conv, end } = await openCall("c-sync");
    const callOf = (method: string) => rpcCalls.filter(([m]) => m === method).at(-1)?.[1];
    expect(await conv.tools.forgeSystem("sync_on")).toMatch(/^Fehler: Dafür muss FORGE bei GitHub angemeldet sein/);
    expect(callOf("settings.update")).toBeUndefined();
    account = { login: "me" };
    expect(await conv.tools.forgeSystem("sync_on")).toBe("Der Abgleich über GitHub ist an. FORGE gleicht jetzt ab.");
    expect(callOf("settings.update")).toEqual({ syncEnabled: true, syncAsked: true });
    expect(await conv.tools.forgeSystem("sync_status")).toMatch(/^Zuletzt abgeglichen .*, zuletzt geschrieben von <<<SESSION-DATEN>>>PC-B<<<ENDE SESSION-DATEN>>>\. Von anderen Computern fehlen hier noch: <<<SESSION-DATEN>>>shop-api/);
    expect(await conv.tools.forgeSystem("sync_now")).not.toContain("fehlen hier noch");
    expect(await conv.tools.forgeSystem("sync_clone", { project: "shop" })).toBe("shop-api ist jetzt auch auf diesem Computer.");
    expect(callOf("sync.cloneProject")).toEqual({ key: "github.com/me/shop-api" });
    expect(await conv.tools.forgeSystem("sync_clone", { project: "blog" })).toMatch(/^Fehler: Kein fehlendes Projekt „blog“/);
    expect(await conv.tools.forgeSystem("sync_status")).toContain("Nur noch auf diesem Computer, weil auf einem anderen entfernt: <<<SESSION-DATEN>>>Projekt blog");
    expect(await conv.tools.forgeSystem("sync_keep", { project: "blog" })).toBe("Projekt blog wird wieder abgeglichen und geht auch auf die anderen Computer.");
    expect(callOf("sync.keep")).toEqual({ key: "project:github.com/me/blog" });

    // Hard to GitHub removes projects from FORGE: only after the code on the keypad.
    const ask = await conv.tools.forgeSystem("sync_force");
    expect(ask).toMatch(/^Bestätigung nötig, noch ist nichts geändert\. .*entfernt werden hier: <<<SESSION-DATEN>>>Projekt blog/);
    expect(callOf("sync.forceLocal")).toBeUndefined();
    await phoneEnd.digits(`${ask.match(/Telefontastatur (\d) (\d) (\d) und dann Raute/)!.slice(1).join("")}#`);
    await until(() => conv.said.at(-1)?.includes("Dieser Computer ist auf dem Stand von GitHub"), 5000, "forced");
    // Only what the caller was told is removed; if that changed until the code, nothing happens.
    expect(callOf("sync.forceLocal")).toEqual({ key: undefined, expectRemove: ["project:github.com/me/blog"] });

    expect(await conv.tools.forgeSystem("sync_versions")).toMatch(/^1: 13\.10\.26, \d\d:\d\d, von <<<SESSION-DATEN>>>PC-A<<<ENDE SESSION-DATEN>>>\n2: 12\.10\.26/);
    expect(await conv.tools.forgeSystem("sync_restore", { backup: "2", parts: ["settings", "phone"] })).toMatch(/^Stand vom 12\.10\.26, \d\d:\d\d zurückgeholt: Einstellungen\. .*Telefon-Einstellungen lassen sich nur in FORGE am Rechner/);
    expect(callOf("sync.restoreVersion")).toEqual({ sha: "aaaaaaa", parts: ["settings"] });
    expect(await conv.tools.forgeSystem("sync_off")).toBe("Der Abgleich über GitHub ist aus. Das Repository auf GitHub bleibt.");
    await end();
  }, 30_000);

  it("names git, gh and the shipped Python in the diagnostics", async () => {
    const tool = (version: string | null, bundled = true) => ({ found: version !== null, bundled, version, path: null, error: null });
    let python = tool("Python 3.14.8");
    rpcResults = {
      "system.diagnostics": () => ({
        claude: tool("2.1.300 (Claude Code)", false),
        auth: { checked: true, loggedIn: true, subscriptionType: "max", error: null },
        apiKeyEnvPresent: false,
        git: tool("git version 2.56.0.windows.2"),
        gh: { ...tool("gh version 2.102.0"), authenticated: true },
        python,
        capabilities: [],
      }),
    };
    const { conv, end } = await openCall("c-diag");
    expect(await conv.tools.forgeSystem("diagnostics")).toBe(
      "Claude Code 2.1.300 (Claude Code) ist da, angemeldet mit Abo max, Git git version 2.56.0.windows.2 ist da, die GitHub-CLI ist da, Python 3.14.8 ist da (mitgeliefert).",
    );
    python = tool(null, false);
    expect(await conv.tools.forgeSystem("diagnostics")).toMatch(/, Python fehlt\.$/);
    await end();
  }, 30_000);

  it("tells where to donate and where to send suggestions", async () => {
    const { conv, end } = await openCall("c-support");
    const text = await conv.tools.forgeSystem("support");
    expect(text).toContain("buy.stripe.com/9B64gBc4e5j80vg1WxbV600");
    expect(text).toContain("github.com/vanturis/forge/issues/new");
    await end();
  }, 30_000);

  it("lists all sessions, branches and rewinds them and deletes them", async () => {
    sessionList.push(fakeSession({ id: "s2", projectId, title: "Login", status: "stopped", live: false, projectName: "shop", updatedAt: "2026-10-01T10:00:00Z" }));
    const userMessage = (seq: number, text: string, uuid: string) => ({ seq, sessionId: "s1", ts: "", body: { type: "user.message", text, uuid } });
    rpcResults = {
      "sessions.listAll": (p: { query?: string }) => sessionList.filter((s) => !p.query || s.title.toLowerCase().includes(p.query)),
      "sessions.events": () => [userMessage(1, "Baue den Warenkorb", "u1"), { seq: 2, sessionId: "s1", ts: "", body: { type: "assistant.text", text: "Fertig." } }, userMessage(5, "Füge Tests hinzu", "u2")],
      "sessions.rewind": () => ({ canRewind: true, error: null, filesChanged: ["src/cart.ts", "src/cart.test.ts"], insertions: 3, deletions: 40 }),
      "sessions.fork": () => ({
        session: fakeSession({ id: "s7", projectId, title: "Warenkorb (Zweig)", status: "stopped", live: false, projectName: "shop" }),
        prompt: "Baue den Warenkorb",
        filesChanged: null,
      }),
      "sessions.delete": (p: { deleteTranscript: boolean }) => ({ deleted: true, transcriptDeleted: p.deleteTranscript }),
      "sessions.deleteAll": () => ({ deleted: ["s1", "s2"], failed: 0, error: null }),
      "sessions.edit": () => fakeSession({ id: "s1", projectId, title: "Warenkorb", status: "running", live: true, projectName: "shop" }),
    };
    const { conv, end } = await openCall("c-sessions");
    const list = await conv.tools.sessions("list");
    expect(list).toMatch(/^S1: <<<SESSION-DATEN>>>Warenkorb<<<ENDE SESSION-DATEN>>> im Projekt shop, fertig, wartet auf Anweisungen, zuletzt /);
    expect(list).toContain("\nS2: <<<SESSION-DATEN>>>Login<<<ENDE SESSION-DATEN>>> im Projekt shop, beendet, zuletzt 01.10.26");
    expect(await conv.tools.sessions("list", { query: "Login" })).toMatch(/^S2: /);

    expect(await conv.tools.sessions("rewind", { session: "S1" })).toBe(
      "Dateien von S1 auf den Stand vor der Nachricht <<<SESSION-DATEN>>>Füge Tests hinzu<<<ENDE SESSION-DATEN>>> zurückgesetzt, 2 Dateien geändert. Der Verlauf bleibt.",
    );
    expect(rpcCalls.at(-1)).toEqual(["sessions.rewind", { sessionId: "s1", messageUuid: "u2", dryRun: false }]);
    expect(await conv.tools.sessions("rewind", { session: "S1", messagesBack: 3 })).toBe("Fehler: S1 hat nur 2 Nachrichten vom Anrufer.");
    expect(await conv.tools.sessions("fork", { session: "S1", messagesBack: 2 })).toBe(
      "Neuer Zweig S3 von S1 angelegt. Er wartet und läuft mit send_message weiter. Die weggelassene Nachricht war: <<<SESSION-DATEN>>>Baue den Warenkorb<<<ENDE SESSION-DATEN>>>",
    );
    expect(rpcCalls.at(-1)).toEqual(["sessions.fork", { sessionId: "s1", beforeSeq: 1, rewindFiles: false }]);

    expect(await conv.tools.sessions("edit", { session: "S1" })).toBe("Fehler: Wie soll die Nachricht neu lauten?");
    expect(await conv.tools.sessions("edit", { session: "S1", text: "Füge Tests für den Rabatt hinzu" })).toBe(
      "Die Nachricht <<<SESSION-DATEN>>>Füge Tests hinzu<<<ENDE SESSION-DATEN>>> in S1 ist ersetzt. Claude macht mit dem neuen Text weiter; die Dateien sind unverändert.",
    );
    expect(rpcCalls.at(-1)).toEqual(["sessions.edit", { sessionId: "s1", seq: 5, text: "Füge Tests für den Rabatt hinzu" }]);

    expect(await keypad(conv, await conv.tools.sessions("delete", { session: "S2", keepTranscript: true }))).toContain("S2 gelöscht.");
    expect(rpcCalls.at(-1)).toEqual(["sessions.delete", { sessionId: "s2", deleteTranscript: false }]);
    expect(await conv.tools.sessions("delete", {})).toMatch(/^Fehler: Welche Session/);
    const all = await conv.tools.sessions("delete_all");
    expect(all).toMatch(/Alle \d+ Sessions werden gelöscht\. Auch die Verläufe bei Claude Code werden gelöscht/);
    // A second irreversible request does not replace the pending code.
    expect(await conv.tools.sessions("delete", { session: "S1" })).toMatch(/^Fehler: Es wartet noch eine Bestätigung/);
    expect(await keypad(conv, all)).toContain("Alle 2 Sessions gelöscht.");
    expect(rpcCalls.at(-1)).toEqual(["sessions.deleteAll", { deleteTranscript: true }]);

    rpcResults["uiCompare.latest"] = () => null;
    expect(await conv.tools.sessions("ui_compare", { session: "S1" })).toMatch(/^Zu S1 gibt es keinen Vorher-Nachher-Vergleich/);
    const shot = { width: 1280, height: 800, path: "C:/forge/ui-compare/x/before.jpg", takenAt: "2026-10-16T10:00:00.000Z" };
    const compare = { id: "x", sessionId: "s1", projectId, url: "http://localhost:5173/cart", files: ["src/Cart.tsx"], createdAt: "2026-10-16T10:00:00.000Z", status: "ready", before: shot, after: shot, error: null };
    rpcResults["uiCompare.latest"] = () => compare;
    rpcResults["uiCompare.retake"] = () => ({ ...compare, status: "capturing" });
    const said = await conv.tools.sessions("ui_compare", { session: "S1" });
    expect(said).toContain("1 UI-Datei geändert");
    expect(said).toContain("Vorher- und Nachher-Bild liegen vor. Die Bilder gibt es nur am Computer.");
    expect(await conv.tools.sessions("ui_compare_retake", { session: "S1" })).toMatch(/^Das Nachher-Bild des letzten Vergleichs von S1 wird neu aufgenommen/);
    expect(rpcCalls.at(-1)).toEqual(["uiCompare.retake", { sessionId: "s1", compareId: "x" }]);
    await end();
  }, 30_000);

  it("reads the daily report as data, for a project or a past day, and Claude's summary of it", async () => {
    const today = new Date();
    const at = today.toISOString();
    rpcResults = {
      "reports.daily": () => ({
        date: localDate(today),
        from: at,
        to: at,
        projectId: null,
        projectName: null,
        sessions: [{ id: "s1", projectId, projectName: "shop", rootId: projectId, title: "Warenkorb", status: "idle", turns: 3, errors: 0, firstAt: at, lastAt: at, agent: false, lastError: null }],
        agents: [],
        commits: [],
        open: [],
        calls: [],
        usage: { turns: 3, apiCalls: 12, workMs: 720_000, agentWorkMs: 0, activeMs: 720_000, peakParallel: 1, inputTokens: 0, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, forge: { calls: 2, workMs: 4000, tokens: 900, cacheReadTokens: 0, parts: [{ purpose: "commit", calls: 2, workMs: 4000, tokens: 900 }] }, hours: [], projects: [], days: [] },
        gitErrors: [],
        truncated: false,
      }),
      "reports.dailySummary": () => ({ summary: "Der Warenkorb ist fertig.", model: "haiku" }),
    };
    const { conv, end } = await openCall("c-report");
    const text = await conv.tools.sessions("day_report");
    expect(text).toMatch(/^<<<SESSION-DATEN>>>Tagesbericht für heute, /);
    expect(text).toContain("S1 „Warenkorb“ (shop): 3 Durchläufe");
    expect(text).toContain("Durch FORGE selbst: 2 Aufrufe, 900 neue Tokens (18 % der neuen Tokens), 4 s. Davon: Commit-Nachrichten 900 Tokens.");
    expect(text).toMatch(/<<<ENDE SESSION-DATEN>>>$/);
    expect(rpcCalls.at(-1)).toEqual(["reports.daily", { date: localDate(today) }]);
    await conv.tools.sessions("day_report", { project: "shop", daysBack: 1 });
    expect(rpcCalls.at(-1)).toEqual(["reports.daily", { projectId, date: localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)) }]);
    expect(await conv.tools.sessions("day_report", { summary: true })).toBe("Zusammenfassung von Claude: <<<SESSION-DATEN>>>Der Warenkorb ist fertig.<<<ENDE SESSION-DATEN>>>");
    await end();
  });

  it("lists prompt templates, sends one with values or starts a session with it, saves, moves and deletes only after the keypad", async () => {
    const tpl = (id: string, name: string, text: string, projectId: string | null = null, sortOrder = 0) => ({ id, projectId, name, description: null, text, sortOrder, createdAt: "", updatedAt: "" });
    const list = [tpl("t1", "Review vor Release", "Review von {projekt} auf {branch}"), tpl("t2", "Tests schreiben", "Tests für {datei} schreiben", projectId), tpl("t3", "Doku", "Doku", projectId, 1)];
    rpcResults = {
      "templates.list": () => list,
      "projects.get": () => ({ git: { branch: "main" } }),
      "sessions.send": () => ({ id: "s1" }),
      "sessions.start": () => ({ id: "s1" }),
      "templates.save": (p: { name: string; projectId: string | null }) => tpl("t9", p.name, "x", p.projectId),
      "templates.delete": () => ({ ok: true }),
      "templates.reorder": () => [],
    };
    const { conv, end } = await openCall("c-templates");
    const listed = await conv.tools.sessions("templates");
    expect(listed).toContain("3 Vorlagen:");
    expect(listed).toContain("Tests schreiben (nur shop), Platzhalter datei");
    expect(rpcCalls.at(-1)).toEqual(["templates.list", { all: true }]);

    expect(await conv.tools.sessions("template_send", { template: "tests", session: "Warenkorb" })).toMatch(/^Fehler: Für die Vorlage .* fehlen Werte für <<<SESSION-DATEN>>>datei<<<ENDE SESSION-DATEN>>>/);
    expect(await conv.tools.sessions("template_send", { template: "tests", session: "Warenkorb", values: [{ name: "{datei}", value: "src/cart.ts" }] })).toContain("an S1 gesendet");
    expect(rpcCalls.at(-1)).toEqual(["sessions.send", { sessionId: "s1", text: "Tests für src/cart.ts schreiben" }]);
    expect(await conv.tools.sessions("template_send", { template: "review", project: "shop" })).toMatch(/^Neue Session S1 im Projekt shop mit der Vorlage/);
    expect(rpcCalls.at(-1)).toEqual(["sessions.start", { projectId, prompt: "Review von shop auf main" }]);
    expect(await conv.tools.sessions("template_send", { template: "review" })).toBe("Fehler: An welche Session oder in welchem Projekt?");

    expect(await conv.tools.sessions("template_save", { name: "Changelog", text: "Schreib den Changelog für {version}", project: "shop" })).toBe("Vorlage <<<SESSION-DATEN>>>Changelog<<<ENDE SESSION-DATEN>>> angelegt (nur shop).");
    expect(rpcCalls.at(-1)).toEqual(["templates.save", { id: null, projectId, name: "Changelog", description: null, text: "Schreib den Changelog für {version}" }]);

    expect(await conv.tools.sessions("template_move", { template: "doku", direction: "up" })).toContain("steht jetzt an Platz 1 von 2");
    expect(rpcCalls.at(-1)).toEqual(["templates.reorder", { ids: ["t3", "t2"] }]);
    expect(await conv.tools.sessions("template_move", { template: "review", direction: "up" })).toContain("steht schon ganz oben");

    const ask = await conv.tools.sessions("template_delete", { template: "review" });
    expect(rpcCalls.some(([m]) => m === "templates.delete")).toBe(false);
    expect(await keypad(conv, ask)).toContain("gelöscht.");
    expect(rpcCalls.at(-1)).toEqual(["templates.delete", { id: "t1" }]);
    await end();
  });

  it("lists, deletes and diffs in Git, restores a commit, publishes, sets the identity, reviews agents and edits the test environment", async () => {
    const wt = await agentWorktree();
    const commit = (hash: string, subject: string) => ({ hash, shortHash: hash.slice(0, 7), author: "T", authorEmail: "t@x", avatarUrl: null, date: "2026-10-13T10:00:00Z", subject, parents: [], refs: [] });
    const file = (p: string) => ({ path: p, origPath: null, index: " ", worktree: "M", kind: "modified", staged: false, unstaged: true });
    rpcResults = {
      "git.branches": () => [
        { name: "main", current: true, upstream: "origin/main" },
        { name: "feature/login", current: false, upstream: null },
      ],
      "git.deleteBranch": () => [],
      "git.status": () => ({ summary: {}, files: [file("src/cart.ts"), file("README.md")] }),
      "git.diff": () => ({
        path: "src/cart.ts",
        binary: false,
        additions: 1,
        deletions: 1,
        truncated: false,
        lines: [
          { kind: "hunk", text: "@@ -1 +1 @@", oldNo: null, newNo: null },
          { kind: "del", text: "const total = 0;", oldNo: 1, newNo: null },
          { kind: "add", text: "const total = sum(items);", oldNo: null, newNo: 1 },
        ],
      }),
      "git.log": () => [commit("aaaaaaa1111", "Tests ergänzt"), commit("bbbbbbb2222", "Login gebaut")],
      "git.restoreTo": (p: { commit: string }) => ({ commit: p.commit, subject: p.commit.startsWith("b") ? "Login gebaut" : "Tests ergänzt", stashed: true, changed: 4 }),
      "github.publish": () => ({ url: "https://github.com/me/shop" }),
      "github.account": () => null,
      "git.setIdentity": (p: { name: string; email: string }) => p,
      "git.commitFiles": (p: { commit: string }) => ({
        hash: p.commit,
        body: "Mit Warenkorb.",
        truncated: false,
        files: [
          { path: "src/login.ts", origPath: null, kind: "added", additions: 12, deletions: 0, binary: false },
          { path: ".env", origPath: null, kind: "modified", additions: 1, deletions: 1, binary: false },
        ],
      }),
      "git.commitDiff": () => ({
        path: "src/login.ts",
        binary: false,
        additions: 1,
        deletions: 0,
        truncated: false,
        lines: [{ kind: "add", text: "export const login = true;", oldNo: null, newNo: 1 }],
      }),
      "agents.review": () => ({
        projectId: wt.id,
        rootId: projectId,
        rootName: "shop",
        branch: "agent/csv-export-ab12",
        targetBranch: "main",
        targetPath: "",
        sessionId: null,
        sessionTitle: null,
        sessionStatus: null,
        summary: "CSV-Export mit Tests gebaut.",
        busy: false,
        commits: [{ hash: "c1", subject: "CSV-Export" }],
        ahead: 1,
        behind: 2,
        filesChanged: 3,
        uncommitted: 0,
        mergeBlocker: null,
      }),
    };
    const { conv, end } = await openCall("c-git2");
    expect(await conv.tools.git("shop", "branches")).toBe("shop: 2 Branches, aktuell main. Weitere: <<<SESSION-DATEN>>>feature/login<<<ENDE SESSION-DATEN>>>.");
    expect(await keypad(conv, await conv.tools.git("shop", "delete_branch", { branch: "feature/login", force: true }))).toContain("Branch feature/login in shop gelöscht.");
    expect(rpcCalls.at(-1)).toEqual(["git.deleteBranch", { projectId, branch: "feature/login", force: true }]);
    expect(await conv.tools.git("shop", "diff")).toBe("Geändert in shop: <<<SESSION-DATEN>>>src/cart.ts, README.md<<<ENDE SESSION-DATEN>>>. Welche Datei?");
    expect(await conv.tools.git("shop", "diff", { path: "cart" })).toBe(
      "<<<SESSION-DATEN>>>src/cart.ts<<<ENDE SESSION-DATEN>>>: 1 Zeile hinzu, 1 entfernt. <<<SESSION-DATEN>>>weg: const total = 0; neu: const total = sum(items);<<<ENDE SESSION-DATEN>>>",
    );
    expect(await conv.tools.git("shop", "restore", { commit: "login" })).toBe(
      "Dateien von shop auf den Stand von <<<SESSION-DATEN>>>Login gebaut<<<ENDE SESSION-DATEN>>> gesetzt, 4 Dateien geändert und noch nicht committet. Die offene Arbeit von vorher liegt im Stash.",
    );
    expect(rpcCalls.at(-1)).toEqual(["git.restoreTo", { projectId, commit: "bbbbbbb2222" }]);
    const shown = await conv.tools.git("shop", "show", { commit: "login" });
    expect(shown).toContain("Der Commit ändert 2 Dateien, 13 Zeilen hinzu, 1 entfernt:");
    expect(shown).toContain("src/login.ts (+12 -0)");
    expect(shown).toContain("Mit Warenkorb.");
    expect(rpcCalls.at(-1)).toEqual(["git.commitFiles", { projectId, commit: "bbbbbbb2222" }]);
    expect(await conv.tools.git("shop", "show", { path: "login" })).toContain("export const login = true;");
    expect(rpcCalls.at(-1)).toEqual(["git.commitDiff", { projectId, commit: "aaaaaaa1111", path: "src/login.ts" }]);
    expect(await conv.tools.git("shop", "show", { path: ".env" })).toContain("enthält Zugangsdaten");
    await conv.tools.git("shop", "restore", { commit: "1" });
    expect(rpcCalls.at(-1)).toEqual(["git.restoreTo", { projectId, commit: "aaaaaaa1111" }]);
    expect(await conv.tools.git("shop", "publish", { private: false })).toBe("shop ist als öffentliches Repository auf GitHub veröffentlicht.");
    expect(rpcCalls.at(-1)).toEqual(["github.publish", { projectId, private: false }]);
    expect(await conv.tools.git("", "account")).toBe("FORGE ist nicht bei GitHub angemeldet. Anmelden geht nur in FORGE am Rechner über den Browser.");
    expect(await conv.tools.git("", "identity", { name: "Tjorven" })).toBe("Fehler: Für die Git-Identität brauche ich Name und E-Mail.");
    expect(await conv.tools.git("", "identity", { name: "Tjorven", email: "t@example.org" })).toBe("Commits laufen jetzt unter Tjorven, t@example.org.");

    expect(await conv.tools.finishAgent("shop csv export", "review")).toBe(
      [
        `Agent ${wt.name}: 1 Commit auf agent/csv-export-ab12, 3 Dateien geändert, main ist seitdem 2 Commits weiter.`,
        "Letzte Commits: <<<SESSION-DATEN>>>CSV-Export<<<ENDE SESSION-DATEN>>>",
        "Seine Zusammenfassung: <<<SESSION-DATEN>>>CSV-Export mit Tests gebaut.<<<ENDE SESSION-DATEN>>>",
        "Zusammenführen nach main ist möglich.",
      ].join("\n"),
    );

    // Variables are named, their values never said.
    expect(await conv.tools.devSettings("shop", { envSet: "API_URL=https://api.example.org" })).toContain("Variablen: <<<SESSION-DATEN>>>API_URL<<<ENDE SESSION-DATEN>>>.");
    const fromFile = await conv.tools.devSettings("shop", { envFromFile: "local" });
    expect(fromFile).toContain("Variablen: <<<SESSION-DATEN>>>API_URL, STRIPE_KEY, PORT<<<ENDE SESSION-DATEN>>>.");
    expect(fromFile).not.toContain("sk_live");
    expect(devConfig.env).toBe("API_URL=https://api.example.org\nSTRIPE_KEY=sk_live_geheim\nexport PORT=3000\n");
    expect(await conv.tools.devSettings("shop", { envRemove: "STRIPE_KEY" })).toContain("Variablen: <<<SESSION-DATEN>>>API_URL, PORT<<<ENDE SESSION-DATEN>>>.");
    expect(await conv.tools.devSettings("shop", { envRemove: "NOPE" })).toBe("Fehler: NOPE steht nicht in der Test-Umgebung.");
    expect(await conv.tools.devSettings("shop", { envSet: "kaputt" })).toBe("Fehler: Die Variable bitte als NAME=Wert angeben.");
    expect(await conv.tools.devSettings("shop", { envFromFile: "prod" })).toMatch(/^Fehler: Keine \.env-Datei „prod“\. Vorhanden: /);
    await end();
  }, 30_000);

  it("manages extensions, global settings, updates and backups", async () => {
    const backup = (id: string, createdAt: string, reason: string) => ({
      id,
      createdAt,
      reason,
      appVersion: "1.2.0",
      size: 1,
      parts: [
        { part: "settings", label: "Einstellungen" },
        { part: "phone", label: "Telefon" },
        { part: "projects", label: "3 Projekte" },
      ],
    });
    rpcResults = {
      "mcp.list": () => [{ name: "context7", target: "npx", status: "connected", statusText: "" }],
      "mcp.add": () => ({ ok: true, output: "" }),
      "config.docs": () => [{ kind: "skill", scope: "user", name: "code-review", description: "Prüft Diffs", path: "" }],
      "config.docCreate": () => ({ path: "", mtimeMs: 1 }),
      "config.docRead": () => ({ path: "", content: "---\nname: code-review\n---\nPrüfe jeden Diff.", mtimeMs: 1 }),
      "config.hooksRead": () => ({ path: "", hooks: JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [] }], Stop: [{ hooks: [] }] }), mtimeMs: 1 }),
      "system.commands": () => [
        { name: "deploy", description: "Deployt", argumentHint: "" },
        { name: "clear", description: "Leert den Verlauf", argumentHint: "", builtin: true },
      ],
      "plugins.catalog": () => [
        { id: "lint@official", name: "lint", description: "Lint-Regeln", marketplace: "official", installCount: 3, installed: true, enabled: false },
        { id: "docs@official", name: "docs", description: "Doku", marketplace: "official", installCount: 1, installed: false, enabled: null },
      ],
      "plugins.setEnabled": () => [],
      "plugins.install": () => [],
      "settings.get": () => db.getSettings(),
      "settings.update": (patch: Partial<Settings>) => db.updateSettings(patch),
      "backup.list": () => [backup("b-old", "2026-10-01T08:00:00Z", "start"), backup("b-new", "2026-10-12T08:00:00Z", "manual")],
      "backup.restore": (p: { parts: string[] }) => ({ restored: p.parts, safety: backup("b-safe", "2026-10-13T08:00:00Z", "before-restore"), notes: [] }),
      "app.installUpdate": () => ({
        currentVersion: "1.2.0",
        phase: "ready",
        latest: { version: "1.3.0", tag: "v1.3.0", notes: "", since: "1.2.0", publishedAt: null, size: null, kind: "patch", via: null },
        autoInstall: false,
        installerPath: "C:/tmp/forge-update/v1.3.0/x.zip",
        installable: true,
        checkedAt: null,
        message: null,
      }),
      "app.checkUpdate": () => ({
        currentVersion: "1.2.0",
        phase: "available",
        latest: { version: "1.3.0", tag: "v1.3.0", notes: "", since: "1.2.0", publishedAt: null, size: null, kind: "patch", via: null },
        autoInstall: false,
        installerPath: null,
        installable: true,
        checkedAt: null,
        message: null,
      }),
      "claude.update": () => {
        throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code ist nicht installiert.");
      },
      "claude.install": () => ({ task: "install", phase: "running", url: null, log: [], message: null }),
    };
    const { conv, end } = await openCall("c-ext");
    expect(await conv.tools.extensions("mcp", "list")).toBe("MCP-Server: <<<SESSION-DATEN>>>context7 verbunden<<<ENDE SESSION-DATEN>>>");
    expect(await conv.tools.extensions("mcp", "add", { name: "linear", target: "https://mcp.linear.app/sse" })).toBe("MCP-Server linear global hinzugefügt.");
    expect(rpcCalls.at(-1)).toEqual(["mcp.add", { name: "linear", scope: "user", transport: "http", target: "https://mcp.linear.app/sse", args: [], env: {} }]);
    expect(await conv.tools.extensions("mcp", "add", { name: "db", scope: "project" })).toBe("Fehler: Für welches Projekt?");
    expect(await conv.tools.extensions("skill", "add", { project: "shop", name: "Release Notes", description: "Schreibt Release-Notes" })).toBe("Skill release-notes im Projekt shop angelegt.");
    expect(rpcCalls.at(-1)).toEqual(["config.docCreate", { kind: "skill", scope: "project", name: "release-notes", description: "Schreibt Release-Notes", projectId }]);
    expect(await conv.tools.extensions("skill", "read", { name: "code review" })).toBe("Skill code-review: <<<SESSION-DATEN>>>--- name: code-review --- Prüfe jeden Diff.<<<ENDE SESSION-DATEN>>>");
    expect(await conv.tools.extensions("skill", "remove", { name: "nix" })).toBe("Fehler: Kein Skill „nix“. Vorhanden: <<<SESSION-DATEN>>>code-review<<<ENDE SESSION-DATEN>>>.");
    expect(await conv.tools.extensions("hook", "list")).toBe("Hooks global: <<<SESSION-DATEN>>>PreToolUse (1), Stop (1)<<<ENDE SESSION-DATEN>>>");
    expect(await conv.tools.extensions("hook", "add")).toBe("Fehler: Hier geht bei Hooks nur list und read; ändern lassen sie sich in FORGE.");
    expect(await conv.tools.extensions("command", "list")).toBe("Eigene Slash-Befehle: <<<SESSION-DATEN>>>deploy: Deployt<<<ENDE SESSION-DATEN>>>");
    expect(await conv.tools.extensions("plugin", "list")).toBe("Plugins: <<<SESSION-DATEN>>>lint (aus)<<<ENDE SESSION-DATEN>>>");
    expect(await conv.tools.extensions("plugin", "enable", { name: "lint" })).toBe("Plugin lint ist an.");
    expect(rpcCalls.at(-1)).toEqual(["plugins.setEnabled", { id: "lint@official", enabled: true }]);
    expect(await conv.tools.extensions("plugin", "add", { name: "docs" })).toBe("Plugin docs installiert.");
    expect(await conv.tools.extensions("plugin", "remove", { name: "docs" })).toBe("Fehler: Plugin docs ist nicht installiert.");

    expect(await conv.tools.forgeSettings({ sounds: false, defaultEffort: "high" })).toBe("Gespeichert: Töne aus, Denkaufwand high.");
    expect(db.getSettings()).toMatchObject({ sounds: false, defaultEffort: "high" });
    expect(await conv.tools.forgeSettings({ policyRule: "git-reset-hard", policyRuleOn: false })).toMatch(/^Gespeichert: Sperrliste: aus sind .*git reset hard\.$/);
    expect(db.getSettings().disabledPolicyRules).toContain("git-reset-hard");
    expect(await conv.tools.forgeSettings({ policyRule: "git-reset-hard" })).toBe("Die Regel git reset hard ist aus.");
    expect(await conv.tools.forgeSettings({ policyRule: "git-reset-hard", policyRuleOn: true })).not.toContain("git reset hard");
    expect(await conv.tools.forgeSettings({})).toContain("Töne aus, Desktop-Benachrichtigungen");
    expect(await conv.tools.forgeSettings({})).toContain("untätige Claude-Prozesse schließen nach 60 Minuten");
    expect(await conv.tools.forgeSettings({ idleCloseMinutes: 30 })).toBe("Gespeichert: untätige Claude-Prozesse schließen nach 30 Minuten.");
    expect(await conv.tools.forgeSettings({ idleCloseMinutes: 0 })).toBe("Gespeichert: untätige Claude-Prozesse bleiben offen.");
    expect(db.getSettings().idleCloseMinutes).toBe(0);

    expect(await conv.tools.forgeSystem("update_check")).toBe("FORGE 1.3.0 ist verfügbar, installiert ist 1.2.0.");
    expect(await conv.tools.forgeSystem("update_install")).toMatch(/^FORGE 1\.3\.0 wird jetzt installiert und startet neu, dieses Gespräch endet dabei\. Offene Sessions gehen danach weiter/);
    expect(rpcCalls.at(-1)?.[0]).toBe("app.installUpdate");
    // An incomplete installation: reported, and installed fully only after the keypad code (the restart ends the call).
    const installState = (complete: boolean) => ({
      checkable: true,
      complete,
      problems: complete ? [] : [{ part: "gh", kind: "missing", label: "GitHub CLI fehlt" }],
      expectedRuntime: "node-24.21.0_git-2.56.0.2_gh-2.102.0",
      phase: complete ? "idle" : "found",
      installer: complete ? null : { version: "0.1.56", tag: "v0.1.56", name: "FORGE_0.1.56_x64-setup.exe", size: 96 * 1048576, source: "github", then: "0.1.60" },
      received: null,
      installerPath: null,
      canDownload: true,
      checkedAt: null,
      message: null,
    });
    rpcResults["app.checkInstall"] = () => installState(false);
    rpcResults["app.repairInstall"] = () => installState(false);
    expect(await conv.tools.forgeSystem("install_check")).toBe(
      "Die Installation von FORGE ist unvollständig: GitHub CLI fehlt. Mit install_repair installiert sich FORGE vollständig mit dem Installer der Version 0.1.56 (96 MB), danach holt FORGE von selbst das Update auf 0.1.60. Dabei startet FORGE neu und das Gespräch endet.",
    );
    const repairAsk = await conv.tools.forgeSystem("install_repair");
    expect(repairAsk).toMatch(/^Bestätigung nötig, noch ist nichts geändert\. Sag dem Anrufer: FORGE installiert sich vollständig mit dem Installer 0\.1\.56/);
    expect(rpcCalls.some(([m]) => m === "app.repairInstall")).toBe(false);
    expect(await keypad(conv, repairAsk)).toContain("FORGE wird jetzt vollständig installiert und startet neu");
    expect(rpcCalls.at(-1)?.[0]).toBe("app.repairInstall");
    rpcResults["app.checkInstall"] = () => installState(true);
    expect(await conv.tools.forgeSystem("install_repair")).toMatch(/^FORGE ist vollständig installiert/);
    expect(await conv.tools.forgeSystem("claude_update")).toBe("Claude Code wird installiert. Ob es geklappt hat, sagt claude_check.");
    expect(rpcCalls.at(-1)?.[0]).toBe("claude.install");
    // Signing in again needs the browser at the computer: only after the keypad code.
    rpcResults["claude.logout"] = () => ({ task: null, phase: "idle", url: null, log: [], message: null });
    const logoutAsk = await conv.tools.forgeSystem("claude_logout");
    expect(rpcCalls.some(([m]) => m === "claude.logout")).toBe(false);
    expect(await keypad(conv, logoutAsk)).toContain("Claude Code ist abgemeldet.");
    expect(rpcCalls.at(-1)?.[0]).toBe("claude.logout");

    expect(await conv.tools.forgeSystem("backup_list")).toMatch(/^1: 12\.10\.26, \d\d:\d\d, von Hand, FORGE 1\.2\.0\n2: 01\.10\.26, \d\d:\d\d, beim Start, FORGE 1\.2\.0$/);
    // The phone settings stay: restoring them would end this call.
    expect(await conv.tools.forgeSystem("backup_restore", { backup: "1", parts: ["settings", "phone"] })).toMatch(
      /^Backup vom 12\.10\.26, \d\d:\d\d wiederhergestellt: Einstellungen\. Der Stand davor ist als Backup gesichert\. Telefon-Einstellungen lassen sich nur in FORGE/,
    );
    expect(rpcCalls.at(-1)).toEqual(["backup.restore", { id: "b-new", parts: ["settings"] }]);
    // Parts as the model passes them: a comma list; parts the backup lacks are left out.
    await runPhoneTool("forge_system", { action: "backup_restore", backup: "2", parts: "Projects, git" }, conv.tools, { hangup: () => {} });
    expect(rpcCalls.at(-1)).toEqual(["backup.restore", { id: "b-old", parts: ["projects"] }]);
    expect(await conv.tools.forgeSystem("backup_restore", {})).toBe("Fehler: Welches Backup? Die Nummer aus backup_list.");
    await end();
  }, 30_000);

  it("passes an urgent notify into the running call, without details before the PIN", async () => {
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const { inv, ok } = await answeredCall("c-urgent");
    const conv = await until(() => convs[0], 5000, "conversation");
    const urgent = (message: string) =>
      svc.onServerEvent({ event: "session.event", payload: { seq: 1, sessionId: "s1", ts: new Date().toISOString(), body: { type: "notify", message, urgent: true } } });
    urgent("Die Migration braucht deine Freigabe");
    await until(() => conv.said.some((s) => s.includes("Eine Session meldet sich dringend")), 5000, "note before PIN");
    expect(conv.said.join("\n")).not.toContain("Migration");
    await sleep(200);
    await phoneEnd.digits("4711#");
    await until(() => svc.state().call?.unlocked, 5000, "unlocked");
    urgent("Die Migration braucht deine Freigabe");
    await until(() => conv.said.some((s) => s.includes("meldet sich dringend und lässt ausrichten") && s.includes("Die Migration braucht deine Freigabe")), 5000, "note after PIN");
    // No second call while the user is on the line.
    await sleep(200);
    expect(pbx.inbox.some((r) => r.msg.method === "INVITE")).toBe(false);
    await byeFromPbx("c-urgent", inv, ok);
  }, 30_000);

  it("calls again after the pause instead of dropping a notification", async () => {
    timing.notifyCooldownMs = 1500;
    await svc.setEnabled(true);
    await until(() => svc.state().registration === "registered", 5000, "registered");
    const done = (text: string) => {
      svc.onServerEvent({
        event: "session.event",
        payload: {
          seq: 1,
          sessionId: "s1",
          ts: new Date().toISOString(),
          body: { type: "turn.result", subtype: "success", isError: false, durationMs: 1, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, text },
        },
      });
      svc.onServerEvent({ event: "session.done", payload: { sessionId: "s1" } });
    };
    done("Erster Teil fertig.");
    const first = await pbx.next((m) => m.method === "INVITE");
    pbx.send(responseTo(first.msg, 486, "Busy Here", "callee"), first.port);
    await until(() => svc.state().call === null, 5000, "first call ended");
    done("Zweiter Teil fertig.");
    await until(() => logs.some((l) => l.includes("Anruf (done) verschoben")), 3000, "postponed");
    const second = await pbx.next((m) => m.method === "INVITE" && getHeader(m, "call-id") !== getHeader(first.msg, "call-id"), 5000);
    expect(convs.at(-1)!.said[0]).toContain("Zweiter Teil fertig.");
    pbx.send(responseTo(second.msg, 486, "Busy Here", "callee"), second.port);
    await until(() => svc.state().call === null, 5000, "second call ended");
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
