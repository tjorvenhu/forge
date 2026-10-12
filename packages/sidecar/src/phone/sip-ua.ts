import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { digestAuthorization, pickChallenge } from "./digest.js";
import { answerDirection, parseSdp, withDirection } from "./sdp.js";
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
const DROP_LOG_INTERVAL_MS = 60_000;
const ALLOW = "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, NOTIFY";
const USER_AGENT = "FORGE";

interface ClientTx {
  msg: SipMessage;
  method: string;
  resolve: (res: SipMessage | null) => void;
  onProvisional?: (res: SipMessage) => void;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  provisional: boolean;
}

interface Address {
  ip: string;
  port: number;
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
  /** outgoing: the ACK we sent, repeated when the 2xx comes again */
  lastAck: SipMessage | null = null;
  /** incoming: where the INVITE came from; responses to it go back there, not to the Via */
  peer: Address | null = null;
  /**
   * New SDP offer inside the dialog (re-INVITE, UPDATE). Returns our answer or null to reject it with
   * 488. Without a handler the media stay as they are and only the direction is answered.
   */
  onOffer: ((sdp: string) => string | null) | null = null;
  private repeat: { cseq: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
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
    this.repeatUntilAck(() => this.ua.respond(this, res), cseqOf(this.invite).seq, () => void this.hangup("Keine Bestätigung (ACK) von der Anlage"));
  }

  /** Incoming call that is still ringing: final error response, repeated until the ACK (Timer G/H). */
  reject(status = 486, reason = "Busy Here", why = "Abgewiesen") {
    if (this.direction !== "in" || this.state !== "ringing" || !this.invite) return;
    this.end(why);
    const res = this.ua.inviteResponse(this, status, reason);
    this.repeatUntilAck(() => this.ua.respond(this, res), cseqOf(this.invite).seq, null);
  }

  async hangup(reason = "Aufgelegt") {
    if (this.state === "ended") return;
    if (this.state === "ringing") {
      if (this.direction === "in") {
        this.reject(603, "Decline", reason);
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

  /** @internal Repeats a final response with T1 doubling up to T2 until the matching ACK or 32 s. */
  repeatUntilAck(send: () => void, cseq: number, onTimeout: (() => void) | null) {
    this.stopRepeat();
    let interval = T1;
    const started = Date.now();
    const repeat: { cseq: number; timer: ReturnType<typeof setTimeout> | null } = { cseq, timer: null };
    const tick = () => {
      if (this.repeat !== repeat) return;
      if (Date.now() - started > TX_TIMEOUT) {
        this.repeat = null;
        onTimeout?.();
        return;
      }
      send();
      interval = Math.min(interval * 2, T2);
      repeat.timer = setTimeout(tick, interval);
    };
    repeat.timer = setTimeout(tick, interval);
    this.repeat = repeat;
  }

  private stopRepeat() {
    if (this.repeat?.timer) clearTimeout(this.repeat.timer);
    this.repeat = null;
  }

  /** @internal */
  onAck(ack: SipMessage) {
    if (this.repeat && cseqOf(ack).seq === this.repeat.cseq) this.stopRepeat();
  }

  /** @internal */
  setRingTimer(fn: () => void) {
    this.ringTimer = setTimeout(fn, RING_TIMEOUT_MS);
  }

  /** @internal */
  end(reason: string) {
    if (this.state === "ended") return;
    this.state = "ended";
    this.stopRepeat();
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
 * places calls. All requests go to the PBX (it acts as outbound proxy). Only the PBX may talk to
 * FORGE: datagrams from any other address are dropped, because anyone else in the network could
 * otherwise call FORGE directly with a forged caller number. Media (RTP) is handled by the caller
 * through SDP.
 */
export class SipUserAgent extends EventEmitter<UaEvents> {
  private sock: Socket | null = null;
  private server: Address = { ip: "", port: 5060 };
  private local: Address = { ip: "", port: 0 };
  /** address the PBX sees us at (from rport/received), used in Contact */
  private contact: Address = { ip: "", port: 0 };
  private clientTx = new Map<string, ClientTx>();
  private serverTx = new Map<string, { res: SipMessage | null; at: number }>();
  private calls = new Map<string, SipCall>();
  private regCallId = `${randomToken(12)}@forge`;
  private regTag = randomToken(6);
  private regCseq = 1;
  private regTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private dropLogged = new Map<string, number>();
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

  /** Address announced in SDP: the public one behind NAT, else the local one. */
  get localIp(): string {
    return this.contact.ip || this.local.ip;
  }

  /** Local interface towards the PBX; sockets (SIP and RTP) bind to it. */
  get bindIp(): string {
    return this.local.ip;
  }

  /** The PBX's address; RTP accepts it as a media source besides the SDP address. */
  get serverIp(): string {
    return this.server.ip;
  }

  async start() {
    this.stopped = false;
    await this.resolveServer();
    await this.openSocket();
    this.keepalive = setInterval(() => this.sendTo("\r\n\r\n", this.server.ip, this.server.port), KEEPALIVE_MS);
    await this.register();
  }

  private async resolveServer() {
    const resolved = await lookup(this.account.server, { family: 4 });
    this.server = { ip: resolved.address, port: this.account.port };
    this.local.ip = await localIpTowards(this.server.ip, this.server.port);
  }

  private async openSocket() {
    const sock = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.bind({ port: 0, address: this.local.ip }, () => resolve());
    });
    sock.on("error", (e) => this.emit("log", `SIP-Socket: ${e.message}`));
    sock.on("message", (buf, rinfo) => this.onDatagram(buf.toString("utf8"), rinfo.address, rinfo.port));
    this.sock = sock;
    this.local.port = sock.address().port;
    this.contact = { ...this.local };
  }

  /**
   * After a failed refresh: the network may have changed (other Wi-Fi, VPN up or down). Looks up the
   * PBX and the local interface again and binds a new socket if the interface changed.
   */
  private async refreshTransport() {
    if (this.stopped || [...this.calls.values()].some((c) => c.state !== "ended")) return;
    const before = this.local.ip;
    try {
      await this.resolveServer();
    } catch {
      return;
    }
    if (this.stopped || this.local.ip === before) return;
    this.emit("log", `Netzwerk geändert, neue lokale Adresse ${this.local.ip}`);
    this.sock?.close();
    this.sock = null;
    await this.openSocket().catch((e: unknown) => this.emit("log", `SIP-Socket: ${e instanceof Error ? e.message : String(e)}`));
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

  private async register(expires = REGISTER_EXPIRES, relearned = false): Promise<void> {
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
      if (min > 0) return this.register(min, relearned);
    }
    if (res.status !== 200) {
      const why = res.status === 401 || res.status === 403 || res.status === 407 ? "Zugangsdaten abgelehnt" : "Anmeldung abgelehnt";
      return this.registerFailed(`${why} (${res.status} ${res.reason ?? ""}).`.replace(" )", ")"));
    }
    // Behind NAT the PBX tells us our public address; register that so calls can reach us. It is
    // checked on every refresh because the NAT mapping can change.
    const via = parseVia(getHeaders(res, "via")[0] ?? "");
    const seenIp = via?.params.received || null;
    const seenPort = via?.params.rport ? Number(via.params.rport) : null;
    if (!relearned && seenIp && seenPort && (seenIp !== this.contact.ip || seenPort !== this.contact.port)) {
      this.contact = { ip: seenIp, port: seenPort };
      this.emit("log", `NAT erkannt, Kontaktadresse ${seenIp}:${seenPort}`);
      return this.register(expires, true);
    }
    const granted = grantedExpires(res, this.contact) ?? expires;
    this.setState("registered", null);
    this.regTimer = setTimeout(() => void this.register(), Math.max(30, granted * 0.8) * 1000);
  }

  private registerFailed(message: string) {
    this.setState("failed", message);
    if (this.stopped) return;
    this.regTimer = setTimeout(() => void this.register(), RETRY_REGISTER_MS);
    void this.refreshTransport();
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
    // The PBX must end the INVITE with 487 now; if it never does, the transaction ends anyway.
    const inviteTx = this.clientTx.get(`${parseVia(via)?.params.branch ?? ""}:INVITE`);
    if (inviteTx) {
      if (inviteTx.deadline) clearTimeout(inviteTx.deadline);
      inviteTx.deadline = setTimeout(() => this.finishTx(inviteTx, null), TX_TIMEOUT);
    }
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
    const branch = parseVia(getHeaders(inv, "via")[0] ?? "")?.params.branch ?? "";
    this.serverTx.set(`${branch}:INVITE`, { res, at: Date.now() });
    this.respond(call, res);
    return res;
  }

  /** @internal Sends a response of an incoming call to where its INVITE came from. */
  respond(call: SipCall, res: SipMessage) {
    if (call.peer) this.sendTo(serializeSip(res), call.peer.ip, call.peer.port);
    else this.sendRaw(res, call.invite ?? undefined);
  }

  private onDatagram(raw: string, ip: string, port: number) {
    if (!raw.trim()) return;
    if (ip !== this.server.ip) {
      this.logDropped(ip, port);
      return;
    }
    const msg = parseSip(raw);
    if (!msg) return;
    if (msg.status !== undefined) this.onResponse(msg);
    else this.onRequest(msg, ip, port);
  }

  /** Once a minute per address, so a flood cannot fill the log. */
  private logDropped(ip: string, port: number) {
    const now = Date.now();
    if (now - (this.dropLogged.get(ip) ?? 0) < DROP_LOG_INTERVAL_MS) return;
    if (this.dropLogged.size > 100) this.dropLogged.clear();
    this.dropLogged.set(ip, now);
    this.emit("log", `SIP-Paket von ${ip}:${port} verworfen: nicht die Anlage (${this.server.ip})`);
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
      if (tx.method === "INVITE") {
        if (tx.timer) clearTimeout(tx.timer);
        tx.timer = null;
        // Ringing may take a while, but not forever: Timer C of RFC 3261, sized to our ring limit.
        if (!tx.provisional) {
          tx.provisional = true;
          if (tx.deadline) clearTimeout(tx.deadline);
          tx.deadline = setTimeout(() => this.finishTx(tx, null), RING_TIMEOUT_MS + TX_TIMEOUT);
        }
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

  /** Requests inside a dialog carry our tag in To; a guessed Call-ID alone is not enough. */
  private inDialog(call: SipCall, req: SipMessage): boolean {
    return tagOf(getHeader(req, "to")) === call.localTag;
  }

  /** Our answer to an SDP offer inside the dialog, or null (488). */
  private answerOffer(call: SipCall, offer: string): string | null {
    if (!offer) return call.localSdp;
    let answer: string | null;
    if (call.onOffer) answer = call.onOffer(offer);
    else {
      const parsed = parseSdp(offer);
      answer = parsed && !parsed.secure ? withDirection(call.localSdp, answerDirection(parsed.direction)) : null;
    }
    if (answer !== null) {
      call.remoteSdp = offer;
      call.localSdp = answer;
    }
    return answer;
  }

  private onRequest(req: SipMessage, ip: string, port: number) {
    const method = req.method!;
    const callId = getHeader(req, "call-id") ?? "";
    const call = this.calls.get(callId);
    if (method === "ACK") {
      if (call && this.inDialog(call, req)) call.onAck(req);
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
    const build = (status: number, reason: string, extra: Array<[string, string]> = [], body = "", toTag?: string) => {
      const res = responseTo(req, status, reason, toTag);
      res.headers.push(["user-agent", USER_AGENT], ...extra);
      if (body) {
        res.headers.push(["content-type", "application/sdp"]);
        res.body = body;
      }
      return res;
    };
    const send = (res: SipMessage) => {
      this.serverTx.set(key, { res, at: Date.now() });
      this.sendTo(serializeSip(res), ip, port);
    };
    const reply = (status: number, reason: string, extra: Array<[string, string]> = [], body = "", toTag?: string) => send(build(status, reason, extra, body, toTag));
    const noDialog = () => reply(481, "Call/Transaction Does Not Exist");

    switch (method) {
      case "OPTIONS":
        reply(200, "OK", [["allow", ALLOW], ["accept", "application/sdp"]], "", randomToken(6));
        return;
      case "INVITE": {
        if (call && tagOf(getHeader(req, "to"))) {
          // Re-INVITE (hold, new media address, session refresh).
          if (!this.inDialog(call, req) || call.state !== "active") return noDialog();
          const answer = this.answerOffer(call, req.body);
          if (answer === null) return reply(488, "Not Acceptable Here");
          const res = build(200, "OK", [["contact", this.contactHeader()], ["allow", ALLOW]], answer);
          send(res);
          call.repeatUntilAck(() => this.sendTo(serializeSip(res), ip, port), cseqOf(req).seq, null);
          return;
        }
        if (call) return;
        const identity = getHeader(req, "p-asserted-identity") ?? getHeader(req, "from") ?? "";
        const incoming = new SipCall(this, callId, "in", uriUser(parseNameAddr(identity).uri));
        incoming.invite = req;
        incoming.peer = { ip, port };
        incoming.remoteSdp = req.body;
        incoming.localHeader = `${getHeader(req, "to") ?? ""};tag=${incoming.localTag}`;
        incoming.remoteHeader = getHeader(req, "from") ?? "";
        incoming.remoteTag = tagOf(incoming.remoteHeader);
        const contact = getHeaders(req, "contact")[0];
        incoming.remoteTarget = contact ? parseNameAddr(contact).uri : (req.uri ?? "");
        incoming.routeSet = getHeaders(req, "record-route");
        this.calls.set(callId, incoming);
        send(build(100, "Trying"));
        this.emit("incoming", incoming);
        return;
      }
      case "CANCEL": {
        const inviteBranch = call?.invite ? parseVia(getHeaders(call.invite, "via")[0] ?? "")?.params.branch : undefined;
        if (!call || call.direction !== "in" || call.state !== "ringing" || inviteBranch !== branch) return noDialog();
        reply(200, "OK");
        call.reject(487, "Request Terminated", "Anrufer hat aufgelegt");
        return;
      }
      case "BYE":
        if (!call || !this.inDialog(call, req)) return noDialog();
        reply(200, "OK");
        call.end("Gegenstelle hat aufgelegt");
        return;
      case "INFO": {
        if (!call || !this.inDialog(call, req)) return noDialog();
        reply(200, "OK");
        const signal = /Signal\s*=\s*([0-9*#A-D])/i.exec(req.body)?.[1];
        if (signal) call.emit("dtmf", signal.toUpperCase());
        return;
      }
      case "UPDATE": {
        if (!call || !this.inDialog(call, req)) return noDialog();
        if (!req.body) return reply(200, "OK", [["contact", this.contactHeader()]]);
        const answer = this.answerOffer(call, req.body);
        if (answer === null) return reply(488, "Not Acceptable Here");
        reply(200, "OK", [["contact", this.contactHeader()]], answer);
        return;
      }
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
   * Sends a request and answers a 401/407 challenge with digest auth. `build` creates the request
   * (again) with the Authorization header; `onRetry` bumps CSeq where the caller keeps it. A second
   * challenge is only answered when it says stale=true (expired nonce, credentials were right).
   */
  private async requestWithAuth(
    build: (auth?: [string, string]) => SipMessage,
    invite: boolean,
    onProvisional?: (res: SipMessage) => void,
    onRetry?: () => void,
  ): Promise<SipMessage | null> {
    const first = build();
    let res = await this.request(first, invite, onProvisional);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!res || (res.status !== 401 && res.status !== 407)) return res;
      const ch = pickChallenge(getHeaders(res, res.status === 401 ? "www-authenticate" : "proxy-authenticate"));
      if (!ch) {
        this.emit("log", "Anmeldeverfahren der Anlage wird nicht unterstützt (Digest MD5 oder SHA-256 nötig)");
        return res;
      }
      if (attempt > 0 && !ch.stale) return res;
      onRetry?.();
      const value = digestAuthorization(ch, {
        username: this.account.authUsername || this.account.username,
        password: this.account.password,
        method: first.method!,
        uri: first.uri!,
        body: first.body,
      });
      res = await this.request(build([res.status === 401 ? "authorization" : "proxy-authorization", value]), invite, onProvisional);
    }
    return res;
  }

  private request(msg: SipMessage, invite: boolean, onProvisional?: (res: SipMessage) => void): Promise<SipMessage | null> {
    const branch = parseVia(getHeaders(msg, "via")[0] ?? "")?.params.branch ?? newBranch();
    const method = msg.method!;
    return new Promise((resolve) => {
      const tx: ClientTx = { msg, method, resolve, onProvisional, timer: null, deadline: null, provisional: false };
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

function grantedExpires(res: SipMessage, contact: Address): number | null {
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
export async function localIpTowards(ip: string, port: number): Promise<string> {
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
