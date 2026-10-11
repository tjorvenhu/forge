import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { digestAuthorization, parseChallenge } from "./digest.js";
import {
  cseqOf,
  getHeader,
  getHeaders,
  newBranch,
  parseNameAddr,
  parseSip,
  parseVia,
  randomToken,
  responseTo,
  serializeSip,
  tagOf,
  uriUser,
  type SipMessage,
} from "./sip-message.js";

export interface SipAccount {
  server: string;
  port: number;
  username: string;
  authUsername: string | null;
  password: string;
  domain: string | null;
  displayName: string;
}

export type RegistrationState = "off" | "registering" | "registered" | "failed";

const T1 = 500;
const T2 = 4000;
const TX_TIMEOUT = 32_000;
const KEEPALIVE_MS = 25_000;
const REGISTER_EXPIRES = 300;
const RETRY_REGISTER_MS = 60_000;
const RING_TIMEOUT_MS = 45_000;
const ALLOW = "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, NOTIFY";
const USER_AGENT = "FORGE";

interface ClientTx {
  msg: SipMessage;
  method: string;
  resolve: (res: SipMessage | null) => void;
  onProvisional?: (res: SipMessage) => void;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
}

export interface CallEvents {
  ringing: [];
  answered: [string];
  ended: [string];
  dtmf: [string];
}

/** One call (dialog). Created by the user agent; FORGE answers, rejects or hangs up through it. */
export class SipCall extends EventEmitter<CallEvents> {
  state: "ringing" | "active" | "ended" = "ringing";
  readonly localTag = randomToken(6);
  remoteTag: string | null = null;
  /** full From/To header values for requests we send inside the dialog */
  localHeader = "";
  remoteHeader = "";
  remoteTarget = "";
  routeSet: string[] = [];
  localCseq = 1;
  localSdp = "";
  remoteSdp = "";
  /** incoming: the INVITE; outgoing: the current INVITE (for CANCEL) */
  invite: SipMessage | null = null;
  lastAck: SipMessage | null = null;
  private okTimer: ReturnType<typeof setTimeout> | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ua: SipUserAgent,
    readonly id: string,
    readonly direction: "in" | "out",
    readonly remoteNumber: string,
  ) {
    super();
  }

  /** Incoming call: answers with our SDP; 200 OK is repeated until the ACK arrives. */
  accept(sdp: string) {
    if (this.direction !== "in" || this.state !== "ringing" || !this.invite) return;
    this.localSdp = sdp;
    const res = this.ua.inviteResponse(this, 200, "OK", sdp);
    this.state = "active";
    let interval = T1;
    const started = Date.now();
    const resend = () => {
      if (this.state !== "active" || this.lastAck) return;
      if (Date.now() - started > TX_TIMEOUT) {
        void this.hangup("Keine Bestätigung (ACK) von der Anlage");
        return;
      }
      this.ua.sendRaw(res);
      interval = Math.min(interval * 2, T2);
      this.okTimer = setTimeout(resend, interval);
    };
    this.okTimer = setTimeout(resend, interval);
  }

  reject(status = 486, reason = "Busy Here") {
    if (this.direction !== "in" || this.state !== "ringing") return;
    this.ua.inviteResponse(this, status, reason);
    this.end("Abgewiesen");
  }

  async hangup(reason = "Aufgelegt") {
    if (this.state === "ended") return;
    if (this.state === "ringing") {
      if (this.direction === "in") {
        this.reject(603, "Decline");
        this.end(reason);
        return;
      }
      // End right away; the PBX's answer to CANCEL does not matter to the user.
      this.end(reason);
      void this.ua.cancel(this);
      return;
    }
    this.end(reason);
    await this.ua.bye(this);
  }

  /** @internal */
  onAck(ack: SipMessage) {
    this.lastAck = ack;
    if (this.okTimer) clearTimeout(this.okTimer);
  }

  /** @internal */
  setRingTimer(fn: () => void) {
    this.ringTimer = setTimeout(fn, RING_TIMEOUT_MS);
  }

  /** @internal */
  end(reason: string) {
    if (this.state === "ended") return;
    this.state = "ended";
    if (this.okTimer) clearTimeout(this.okTimer);
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.emit("ended", reason);
    this.ua.forget(this);
  }
}

export interface UaEvents {
  registration: [RegistrationState, string | null];
  incoming: [SipCall];
  log: [string];
}

/**
 * Minimal SIP user agent over UDP (RFC 3261): registers at the PBX with digest auth, receives and
 * places calls. All requests go to the PBX (it acts as outbound proxy); responses go back where the
 * request came from. Media (RTP) is handled by the caller through SDP.
 */
export class SipUserAgent extends EventEmitter<UaEvents> {
  private sock: Socket | null = null;
  private server = { ip: "", port: 5060 };
  private local = { ip: "", port: 0 };
  /** address the PBX sees us at (from rport/received), used in Contact */
  private contact = { ip: "", port: 0 };
  private clientTx = new Map<string, ClientTx>();
  private serverTx = new Map<string, { res: SipMessage | null; at: number }>();
  private calls = new Map<string, SipCall>();
  private regCallId = `${randomToken(12)}@forge`;
  private regTag = randomToken(6);
  private regCseq = 1;
  private regTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private contactLearned = false;
  private stopped = false;
  state: RegistrationState = "off";

  constructor(private readonly account: SipAccount) {
    super();
  }

  get domain(): string {
    return this.account.domain || this.account.server;
  }

  get aor(): string {
    return `sip:${this.account.username}@${this.domain}`;
  }

  /** Local IP towards the PBX; RTP binds to it and SDP announces it. */
  get localIp(): string {
    return this.contact.ip || this.local.ip;
  }

  async start() {
    this.stopped = false;
    const resolved = await lookup(this.account.server, { family: 4 });
    this.server = { ip: resolved.address, port: this.account.port };
    this.local.ip = await localIpTowards(this.server.ip, this.server.port);
    const sock = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind(0, () => resolve());
    });
    sock.on("error", (e) => this.emit("log", `SIP-Socket: ${e.message}`));
    sock.on("message", (buf, rinfo) => this.onDatagram(buf.toString("utf8"), rinfo.address, rinfo.port));
    this.sock = sock;
    this.local.port = sock.address().port;
    this.contact = { ...this.local };
    this.keepalive = setInterval(() => this.sendTo("\r\n\r\n", this.server.ip, this.server.port), KEEPALIVE_MS);
    await this.register();
  }

  async stop() {
    this.stopped = true;
    if (this.regTimer) clearTimeout(this.regTimer);
    if (this.keepalive) clearInterval(this.keepalive);
    // Hang up and sign off, but do not wait long for a PBX that does not answer.
    const bounded = (p: Promise<unknown>) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    await bounded(Promise.all([...this.calls.values()].map((c) => c.hangup("FORGE-Telefon ausgeschaltet"))));
    if (this.state === "registered") await bounded(this.register(0));
    for (const tx of this.clientTx.values()) this.finishTx(tx, null);
    this.sock?.close();
    this.sock = null;
    this.setState("off", null);
  }

  // ---------- registration

  private setState(state: RegistrationState, message: string | null) {
    this.state = state;
    this.emit("registration", state, message);
  }

  private async register(expires = REGISTER_EXPIRES): Promise<void> {
    if (this.regTimer) clearTimeout(this.regTimer);
    if (expires > 0) this.setState(this.state === "registered" ? "registered" : "registering", null);
    const uri = `sip:${this.domain}`;
    const res = await this.requestWithAuth(
      (auth) =>
        this.buildRequest("REGISTER", uri, {
          from: `"${this.account.displayName}" <${this.aor}>;tag=${this.regTag}`,
          to: `<${this.aor}>`,
          callId: this.regCallId,
          cseq: this.regCseq++,
          contactParams: `;expires=${expires}`,
          extra: [["expires", String(expires)], ...(auth ? [auth] : [])],
        }),
      false,
    );
    if (expires === 0 || this.stopped) return;
    if (!res) return this.registerFailed(`Keine Antwort von ${this.account.server}:${this.account.port}. Server und Port prüfen.`);
    if (res.status === 423) {
      const min = Number(getHeader(res, "min-expires"));
      if (min > 0) return this.register(min);
    }
    if (res.status !== 200) {
      const why = res.status === 401 || res.status === 403 || res.status === 407 ? "Zugangsdaten abgelehnt" : "Anmeldung abgelehnt";
      return this.registerFailed(`${why} (${res.status} ${res.reason ?? ""}).`.replace(" )", ")"));
    }
    // Behind NAT the PBX tells us our public address; register that so calls can reach us.
    const via = parseVia(getHeaders(res, "via")[0] ?? "");
    const seenIp = via?.params.received || null;
    const seenPort = via?.params.rport ? Number(via.params.rport) : null;
    if (!this.contactLearned && seenIp && seenPort && (seenIp !== this.contact.ip || seenPort !== this.contact.port)) {
      this.contactLearned = true;
      this.contact = { ip: seenIp, port: seenPort };
      this.emit("log", `NAT erkannt, Kontaktadresse ${seenIp}:${seenPort}`);
      return this.register(expires);
    }
    const granted = grantedExpires(res, this.contact) ?? expires;
    this.setState("registered", null);
    this.regTimer = setTimeout(() => void this.register(), Math.max(30, granted * 0.8) * 1000);
  }

  private registerFailed(message: string) {
    this.setState("failed", message);
    if (!this.stopped) this.regTimer = setTimeout(() => void this.register(), RETRY_REGISTER_MS);
  }

  // ---------- outgoing calls

  /** Calls a number through the PBX. `sdp` is our offer. */
  call(number: string, sdp: string): SipCall {
    const callId = `${randomToken(12)}@forge`;
    const call = new SipCall(this, callId, "out", number);
    this.calls.set(callId, call);
    // "0170 123/456-7" -> "01701234567": the PBX dials digits, not formatting.
    const dial = number.replace(/[^\d+*#]/g, "");
    const target = `sip:${dial}@${this.domain}`;
    call.localSdp = sdp;
    call.localHeader = `"${this.account.displayName}" <${this.aor}>;tag=${call.localTag}`;
    call.remoteTarget = target;
    let provisional = false;
    void this.requestWithAuth(
      (auth) => {
        const msg = this.buildRequest("INVITE", target, {
          from: call.localHeader,
          to: `<${target}>`,
          callId,
          cseq: call.localCseq,
          body: sdp,
          contentType: "application/sdp",
          extra: auth ? [auth] : [],
        });
        call.invite = msg;
        return msg;
      },
      true,
      (res) => {
        if (!provisional && (res.status === 180 || res.status === 183)) {
          provisional = true;
          call.emit("ringing");
        }
      },
      () => call.localCseq++,
    ).then((res) => {
      if (call.state === "ended") {
        // Answered while we were cancelling: acknowledge and end it properly.
        if (res?.status && res.status < 300) {
          call.remoteHeader = getHeader(res, "to") ?? call.remoteHeader;
          const contact = getHeaders(res, "contact")[0];
          if (contact) call.remoteTarget = parseNameAddr(contact).uri;
          call.routeSet = getHeaders(res, "record-route").reverse();
          this.sendAck(call, res);
          void this.bye(call);
        }
        return;
      }
      if (!res) return call.end("Keine Antwort von der Anlage");
      if (res.status && res.status >= 200 && res.status < 300) {
        call.remoteTag = tagOf(getHeader(res, "to"));
        call.remoteHeader = getHeader(res, "to") ?? `<${target}>`;
        const contact = getHeaders(res, "contact")[0];
        if (contact) call.remoteTarget = parseNameAddr(contact).uri;
        call.routeSet = getHeaders(res, "record-route").reverse();
        call.remoteSdp = res.body;
        this.sendAck(call, res);
        call.state = "active";
        call.emit("answered", res.body);
        return;
      }
      call.end(describeFailure(res.status ?? 0, res.reason ?? ""));
    });
    call.setRingTimer(() => {
      if (call.state === "ringing") void call.hangup("Nicht angenommen");
    });
    return call;
  }

  private sendAck(call: SipCall, res: SipMessage) {
    const ack = this.buildRequest("ACK", call.remoteTarget, {
      from: call.localHeader,
      to: getHeader(res, "to") ?? "",
      callId: call.id,
      cseq: cseqOf(res).seq,
      routes: call.routeSet,
    });
    call.lastAck = ack;
    this.sendRaw(ack);
  }

  /** @internal CANCEL of a ringing outgoing call (same branch and CSeq number as the INVITE). */
  async cancel(call: SipCall) {
    const inv = call.invite;
    if (!inv) return;
    const via = getHeaders(inv, "via")[0] ?? "";
    const cancel: SipMessage = {
      method: "CANCEL",
      uri: inv.uri,
      headers: [
        ["via", via],
        ["max-forwards", "70"],
        ["from", getHeader(inv, "from") ?? ""],
        ["to", getHeader(inv, "to") ?? ""],
        ["call-id", call.id],
        ["cseq", `${cseqOf(inv).seq} CANCEL`],
        ["user-agent", USER_AGENT],
      ],
      body: "",
    };
    await this.request(cancel, false);
  }

  /** @internal BYE for an established call. */
  async bye(call: SipCall) {
    await this.requestWithAuth(
      (auth) =>
        this.buildRequest("BYE", call.remoteTarget, {
          from: call.localHeader,
          to: call.remoteHeader,
          callId: call.id,
          cseq: ++call.localCseq,
          routes: call.routeSet,
          extra: auth ? [auth] : [],
        }),
      false,
    ).catch(() => null);
  }

  /** @internal */
  forget(call: SipCall) {
    setTimeout(() => this.calls.delete(call.id), TX_TIMEOUT);
  }

  // ---------- incoming

  /** @internal Response to the INVITE of an incoming call; 200 carries Contact and SDP. */
  inviteResponse(call: SipCall, status: number, reason: string, sdp?: string): SipMessage {
    const inv = call.invite!;
    const res = responseTo(inv, status, reason, call.localTag);
    if (status < 300) res.headers.push(["contact", this.contactHeader()]);
    res.headers.push(["user-agent", USER_AGENT], ["allow", ALLOW]);
    if (sdp) {
      res.headers.push(["content-type", "application/sdp"]);
      res.body = sdp;
    }
    this.replyTx(inv, res);
    return res;
  }

  private onDatagram(raw: string, ip: string, port: number) {
    if (!raw.trim()) return;
    const msg = parseSip(raw);
    if (!msg) return;
    if (msg.status !== undefined) this.onResponse(msg);
    else this.onRequest(msg, ip, port);
  }

  private onResponse(res: SipMessage) {
    const via = parseVia(getHeaders(res, "via")[0] ?? "");
    const branch = via?.params.branch;
    const { method } = cseqOf(res);
    const tx = branch ? this.clientTx.get(`${branch}:${method}`) : undefined;
    if (!tx) {
      // A repeated 2xx for an INVITE we already acknowledged: acknowledge again.
      const call = this.calls.get(getHeader(res, "call-id") ?? "");
      if (method === "INVITE" && res.status! < 300 && call?.lastAck) this.sendRaw(call.lastAck);
      return;
    }
    if (res.status! < 200) {
      if (tx.timer && tx.method === "INVITE") {
        clearTimeout(tx.timer);
        tx.timer = null;
        if (tx.deadline) clearTimeout(tx.deadline);
        tx.deadline = null;
      }
      tx.onProvisional?.(res);
      return;
    }
    if (tx.method === "INVITE" && res.status! >= 300) {
      // ACK for a failed INVITE belongs to the transaction: same branch, To from the response.
      this.sendRaw({
        method: "ACK",
        uri: tx.msg.uri,
        headers: [
          ["via", getHeaders(tx.msg, "via")[0] ?? ""],
          ["max-forwards", "70"],
          ["from", getHeader(tx.msg, "from") ?? ""],
          ["to", getHeader(res, "to") ?? ""],
          ["call-id", getHeader(tx.msg, "call-id") ?? ""],
          ["cseq", `${cseqOf(tx.msg).seq} ACK`],
        ],
        body: "",
      });
    }
    this.finishTx(tx, res);
  }

  private onRequest(req: SipMessage, ip: string, port: number) {
    const method = req.method!;
    const callId = getHeader(req, "call-id") ?? "";
    const call = this.calls.get(callId);
    if (method === "ACK") {
      call?.onAck(req);
      return;
    }
    const branch = parseVia(getHeaders(req, "via")[0] ?? "")?.params.branch ?? "";
    const key = `${branch}:${method}`;
    const known = this.serverTx.get(key);
    if (known) {
      if (known.res) this.sendTo(serializeSip(known.res), ip, port);
      return;
    }
    this.serverTx.set(key, { res: null, at: Date.now() });
    this.pruneServerTx();
    const reply = (status: number, reason: string, extra: Array<[string, string]> = [], body = "", toTag?: string) => {
      const res = responseTo(req, status, reason, toTag);
      res.headers.push(["user-agent", USER_AGENT], ...extra);
      if (body) {
        res.headers.push(["content-type", "application/sdp"]);
        res.body = body;
      }
      this.serverTx.set(key, { res, at: Date.now() });
      this.sendTo(serializeSip(res), ip, port);
    };

    switch (method) {
      case "OPTIONS":
        reply(200, "OK", [["allow", ALLOW], ["accept", "application/sdp"]], "", randomToken(6));
        return;
      case "INVITE": {
        if (call && tagOf(getHeader(req, "to"))) {
          // Re-INVITE (hold, session refresh): keep our media as it is.
          if (req.body) call.remoteSdp = req.body;
          reply(200, "OK", [["contact", this.contactHeader()], ["allow", ALLOW]], call.localSdp);
          return;
        }
        if (call) return;
        const identity = getHeader(req, "p-asserted-identity") ?? getHeader(req, "from") ?? "";
        const incoming = new SipCall(this, callId, "in", uriUser(parseNameAddr(identity).uri));
        incoming.invite = req;
        incoming.remoteSdp = req.body;
        incoming.localHeader = `${getHeader(req, "to") ?? ""};tag=${incoming.localTag}`;
        incoming.remoteHeader = getHeader(req, "from") ?? "";
        incoming.remoteTag = tagOf(incoming.remoteHeader);
        const contact = getHeaders(req, "contact")[0];
        incoming.remoteTarget = contact ? parseNameAddr(contact).uri : (req.uri ?? "");
        incoming.routeSet = getHeaders(req, "record-route");
        this.calls.set(callId, incoming);
        this.serverTx.set(key, { res: null, at: Date.now() });
        const trying = responseTo(req, 100, "Trying");
        this.sendTo(serializeSip(trying), ip, port);
        this.serverTx.set(key, { res: trying, at: Date.now() });
        this.emit("incoming", incoming);
        return;
      }
      case "CANCEL": {
        if (!call || call.direction !== "in" || call.state !== "ringing") {
          reply(481, "Call/Transaction Does Not Exist");
          return;
        }
        reply(200, "OK");
        this.inviteResponse(call, 487, "Request Terminated");
        call.end("Anrufer hat aufgelegt");
        return;
      }
      case "BYE":
        if (!call) {
          reply(481, "Call/Transaction Does Not Exist");
          return;
        }
        reply(200, "OK");
        call.end("Gegenstelle hat aufgelegt");
        return;
      case "INFO": {
        reply(200, "OK");
        const signal = /Signal\s*=\s*([0-9*#A-D])/i.exec(req.body)?.[1];
        if (call && signal) call.emit("dtmf", signal.toUpperCase());
        return;
      }
      case "UPDATE":
        reply(200, "OK", [["contact", this.contactHeader()]], req.body && call ? call.localSdp : "");
        return;
      case "NOTIFY":
      case "MESSAGE":
        reply(200, "OK");
        return;
      default:
        reply(405, "Method Not Allowed", [["allow", ALLOW]]);
    }
  }

  private pruneServerTx() {
    const limit = Date.now() - TX_TIMEOUT;
    for (const [k, v] of this.serverTx) if (v.at < limit) this.serverTx.delete(k);
  }

  private replyTx(req: SipMessage, res: SipMessage) {
    const branch = parseVia(getHeaders(req, "via")[0] ?? "")?.params.branch ?? "";
    this.serverTx.set(`${branch}:${req.method}`, { res, at: Date.now() });
    this.sendRaw(res, req);
  }

  // ---------- transport and transactions

  private contactHeader(params = ""): string {
    return `<sip:${this.account.username}@${this.contact.ip}:${this.contact.port};transport=udp>${params}`;
  }

  private buildRequest(
    method: string,
    uri: string,
    o: { from: string; to: string; callId: string; cseq: number; body?: string; contentType?: string; routes?: string[]; extra?: Array<[string, string]>; contactParams?: string },
  ): SipMessage {
    const headers: Array<[string, string]> = [
      ["via", `SIP/2.0/UDP ${this.contact.ip}:${this.contact.port};branch=${newBranch()};rport`],
      ["max-forwards", "70"],
      ["from", o.from],
      ["to", o.to],
      ["call-id", o.callId],
      ["cseq", `${o.cseq} ${method}`],
    ];
    for (const r of o.routes ?? []) headers.push(["route", r]);
    if (method !== "ACK" && method !== "CANCEL") headers.push(["contact", this.contactHeader(o.contactParams)], ["allow", ALLOW]);
    headers.push(["user-agent", USER_AGENT], ...(o.extra ?? []));
    if (o.body) headers.push(["content-type", o.contentType ?? "application/sdp"]);
    return { method, uri, headers, body: o.body ?? "" };
  }

  /**
   * Sends a request and answers one 401/407 challenge with digest auth. `build` creates the request
   * (again) with the Authorization header; `onRetry` bumps CSeq where the caller keeps it.
   */
  private async requestWithAuth(
    build: (auth?: [string, string]) => SipMessage,
    invite: boolean,
    onProvisional?: (res: SipMessage) => void,
    onRetry?: () => void,
  ): Promise<SipMessage | null> {
    const first = build();
    const res = await this.request(first, invite, onProvisional);
    if (!res || (res.status !== 401 && res.status !== 407)) return res;
    const header = getHeader(res, res.status === 401 ? "www-authenticate" : "proxy-authenticate");
    const ch = header ? parseChallenge(header) : null;
    if (!ch) return res;
    onRetry?.();
    const value = digestAuthorization(ch, {
      username: this.account.authUsername || this.account.username,
      password: this.account.password,
      method: first.method!,
      uri: first.uri!,
    });
    const second = build([res.status === 401 ? "authorization" : "proxy-authorization", value]);
    return this.request(second, invite, onProvisional);
  }

  private request(msg: SipMessage, invite: boolean, onProvisional?: (res: SipMessage) => void): Promise<SipMessage | null> {
    const branch = parseVia(getHeaders(msg, "via")[0] ?? "")?.params.branch ?? newBranch();
    const method = msg.method!;
    return new Promise((resolve) => {
      const tx: ClientTx = { msg, method, resolve, onProvisional, timer: null, deadline: null };
      this.clientTx.set(`${branch}:${method}`, tx);
      let interval = T1;
      const send = () => {
        this.sendRaw(msg);
        interval = invite ? interval * 2 : Math.min(interval * 2, T2);
        tx.timer = setTimeout(send, interval);
      };
      send();
      tx.deadline = setTimeout(() => this.finishTx(tx, null), TX_TIMEOUT);
    });
  }

  private finishTx(tx: ClientTx, res: SipMessage | null) {
    if (tx.timer) clearTimeout(tx.timer);
    if (tx.deadline) clearTimeout(tx.deadline);
    for (const [k, v] of this.clientTx) if (v === tx) this.clientTx.delete(k);
    tx.resolve(res);
  }

  /** @internal Requests go to the PBX; responses to where the request came from (Via). */
  sendRaw(msg: SipMessage, inResponseTo?: SipMessage) {
    if (msg.status !== undefined) {
      const via = parseVia(getHeaders(inResponseTo ?? msg, "via")[0] ?? "");
      const ip = via?.params.received || via?.host || this.server.ip;
      const port = via?.params.rport ? Number(via.params.rport) : (via?.port ?? 5060);
      this.sendTo(serializeSip(msg), /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : this.server.ip, Number.isFinite(port) && port > 0 ? port : this.server.port);
      return;
    }
    if (msg.method === "INVITE" || msg.method === "REGISTER" || msg.method === "BYE") {
      const auth = getHeader(msg, "authorization") ? " (mit Anmeldung)" : "";
      this.emit("log", `→ ${msg.method} ${msg.uri}${auth}`);
    }
    this.sendTo(serializeSip(msg), this.server.ip, this.server.port);
  }

  private sendTo(text: string, ip: string, port: number) {
    try {
      this.sock?.send(Buffer.from(text, "utf8"), port, ip);
    } catch {
      /* socket closed */
    }
  }
}

function grantedExpires(res: SipMessage, contact: { ip: string; port: number }): number | null {
  for (const c of getHeaders(res, "contact")) {
    const na = parseNameAddr(c);
    if (na.uri.includes(`@${contact.ip}:${contact.port}`) && na.params.expires) return Number(na.params.expires);
  }
  const h = Number(getHeader(res, "expires"));
  return Number.isFinite(h) && h > 0 ? h : null;
}

function describeFailure(status: number, reason: string): string {
  if (status === 486 || status === 600) return "Besetzt";
  if (status === 603) return "Abgelehnt";
  if (status === 404 || status === 484) return "Nummer nicht erreichbar";
  if (status === 408 || status === 480 || status === 487) return "Nicht angenommen";
  if (status === 401 || status === 403 || status === 407) return "Anlage hat den Anruf nicht erlaubt";
  return `Anruf fehlgeschlagen (${status} ${reason})`.trim();
}

/** The local IP the OS would use to reach the PBX (no packet is sent). */
async function localIpTowards(ip: string, port: number): Promise<string> {
  const s = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.connect(port, ip, () => resolve());
    });
    return s.address().address;
  } finally {
    s.close();
  }
}

