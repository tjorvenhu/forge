import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { ForgeError, type PhoneCallInfo, type PhoneCallRecord, type PhoneConfig, type PhoneState, type ServerEvent, type SessionEventBody } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionService } from "../sessions/session-service.js";
import type { DevServerService } from "../devserver/dev-server.js";
import { CallController, type Conversation, type ConversationCallbacks } from "./call-controller.js";
import { PhoneAgent, type PhoneToolset } from "./phone-agent.js";
import { RtpSession } from "./rtp.js";
import { buildSdp, chooseCodec, parseSdp, PT_PCMA } from "./sdp.js";
import type { SecretStore } from "./secrets.js";
import { SipUserAgent, type SipAccount, type SipCall } from "./sip-ua.js";
import { DEFAULT_STT_MODEL, DEFAULT_TTS_MODEL, DEFAULT_VOICE, OpenAiVoice, type VoiceProvider } from "./voice.js";

const SECRET_PASSWORD = "sip-password";
const SECRET_OPENAI = "openai-key";
/** Claude on the phone: fast replies matter more than depth. */
const PHONE_MODEL = "haiku";
/** wait before calling, so a quick follow-up turn or an answer at the desk makes the call unnecessary */
const NOTIFY_DELAY_MS = { done: 5_000, error: 5_000, approval: 15_000 };
const NOTIFY_COOLDOWN_MS = 60_000;
const GREETING = "Hallo, hier ist FORGE. Was kann ich für dich tun?";

type NotifyKind = "done" | "approval" | "error";

interface StoredConfig {
  server: string;
  port: number;
  username: string;
  authUsername: string | null;
  domain: string | null;
  displayName: string;
  voice: string;
  sttModel: string;
  ttsModel: string;
  allowedCallers: string[];
  notifyNumber: string | null;
  notifyOn: { done: boolean; approval: boolean; error: boolean };
  requirePin: boolean;
  enabled: boolean;
  /** "salt:hash" (scrypt, hex) */
  pinHash: string | null;
}

const DEFAULTS: StoredConfig = {
  server: "",
  port: 5060,
  username: "",
  authUsername: null,
  domain: null,
  displayName: "FORGE",
  voice: DEFAULT_VOICE,
  sttModel: DEFAULT_STT_MODEL,
  ttsModel: DEFAULT_TTS_MODEL,
  allowedCallers: [],
  notifyNumber: null,
  notifyOn: { done: true, approval: true, error: true },
  requirePin: true,
  enabled: false,
  pinHash: null,
};

/** Seams for tests; production uses the real SIP stack, OpenAI and Claude. */
export interface PhoneFactories {
  ua(account: SipAccount): SipUserAgent;
  rtp(localIp: string): RtpSession;
  voice(apiKey: string, o: { voice: string; sttModel: string; ttsModel: string }): VoiceProvider;
  conversation(o: { tools: PhoneToolset; context: string; cb: ConversationCallbacks }): Conversation;
}

export interface PhoneDeps {
  db: Db;
  projects: ProjectManager;
  sessions: SessionService;
  devServers: DevServerService;
  secrets: SecretStore;
  emit(e: ServerEvent): void;
  claude(): { path: string | null; env: Record<string, string>; cwd: string };
  log(message: string): void;
  factories?: Partial<PhoneFactories>;
  /** shorter waits in tests */
  timing?: { notifyDelayMs?: number; notifyCooldownMs?: number };
}

interface ActiveCall {
  call: SipCall;
  controller: CallController;
  info: PhoneCallInfo;
  record: PhoneCallRecord;
  /** S1, S2 ... -> session id, as told to Claude in this call */
  refs: Map<string, string>;
}

/**
 * Same phone number in different notations: +49 30 1234567, 0049301234567 and 030 1234567 match.
 * Short numbers (internal extensions) must match exactly, so "21" never allows "+49 30 121".
 */
export function sameNumber(a: string, b: string): boolean {
  const x = a.replace(/\D/g, "").replace(/^0+/, "");
  const y = b.replace(/\D/g, "").replace(/^0+/, "");
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.endsWith(short);
}

function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(pin, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

function relative(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Minuten`;
  const h = Math.round(min / 60);
  return h < 24 ? `vor ${h} Stunden` : `vor ${Math.round(h / 24)} Tagen`;
}

/**
 * The phone line of FORGE: registers at the user's PBX, takes calls from allowed numbers and calls
 * the user when a session is done, needs an approval or failed. In a call Claude (haiku, via the
 * Claude Code login) talks with the caller and uses FORGE tools; steering needs the PIN.
 */
export class PhoneService {
  private cfg: StoredConfig;
  private ua: SipUserAgent | null = null;
  private registration: PhoneState["registration"] = "off";
  private message: string | null = null;
  private active: ActiveCall | null = null;
  private notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastNotifyAt = 0;
  private readonly f: PhoneFactories;

  constructor(private readonly d: PhoneDeps) {
    this.cfg = { ...DEFAULTS, ...(d.db.getPhoneSettings() as Partial<StoredConfig>) };
    const claude = () => d.claude();
    this.f = {
      ua: (a) => new SipUserAgent(a),
      rtp: (ip) => new RtpSession(ip),
      voice: (key, o) => new OpenAiVoice(key, o),
      conversation: ({ tools, context, cb }) => {
        const c = claude();
        if (!c.path) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden.");
        return new PhoneAgent({ claudePath: c.path, env: c.env, cwd: c.cwd, model: PHONE_MODEL, tools, context, ...cb });
      },
      ...d.factories,
    };
  }

  /** Starts the line on app start if it was switched on before. */
  async init() {
    if (this.cfg.enabled) await this.connect().catch((e: unknown) => this.fail(e));
  }

  // ---------- config

  config(): PhoneConfig {
    const { pinHash, ...rest } = this.cfg;
    return {
      ...rest,
      hasPassword: this.d.secrets.has(SECRET_PASSWORD),
      hasOpenAiKey: this.d.secrets.has(SECRET_OPENAI),
      hasPin: !!pinHash,
    };
  }

  async saveConfig(patch: Partial<Omit<PhoneConfig, "enabled" | "hasPassword" | "hasOpenAiKey" | "hasPin">> & { password?: string; openAiKey?: string; pin?: string }) {
    const { password, openAiKey, pin, ...rest } = patch;
    const before = JSON.stringify(this.connectionKey());
    const next: StoredConfig = { ...this.cfg };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = typeof v === "string" ? v.trim() : v;
    next.allowedCallers = next.allowedCallers.map((n) => n.trim()).filter(Boolean);
    if (next.notifyNumber !== null && !next.notifyNumber.trim()) next.notifyNumber = null;
    if (pin !== undefined) next.pinHash = pin ? hashPin(pin) : null;
    if (password !== undefined) await this.d.secrets.set(SECRET_PASSWORD, password || null);
    if (openAiKey !== undefined) await this.d.secrets.set(SECRET_OPENAI, openAiKey.trim() || null);
    this.cfg = next;
    this.d.db.setPhoneSettings(next as unknown as Record<string, unknown>);
    const changed = before !== JSON.stringify(this.connectionKey()) || password !== undefined;
    if (this.cfg.enabled && changed && !this.active) await this.reconnect();
    return this.config();
  }

  private connectionKey() {
    const c = this.cfg;
    return [c.server, c.port, c.username, c.authUsername, c.domain, c.displayName];
  }

  // ---------- state

  state(): PhoneState {
    return { enabled: this.cfg.enabled, registration: this.registration, message: this.message, call: this.active?.info ?? null };
  }

  private emitState() {
    this.d.emit({ event: "phone.updated", payload: this.state() });
  }

  private persistEnabled(enabled: boolean) {
    this.cfg = { ...this.cfg, enabled };
    this.d.db.setPhoneSettings(this.cfg as unknown as Record<string, unknown>);
  }

  async setEnabled(enabled: boolean): Promise<PhoneState> {
    if (!enabled) {
      this.persistEnabled(false);
      await this.disconnect();
      return this.state();
    }
    const missing = this.missingSetup();
    if (missing) throw new ForgeError("VALIDATION", `Telefon nicht eingerichtet: ${missing} Unter Einstellungen → Telefon ergänzen.`);
    this.persistEnabled(true);
    await this.connect().catch((e: unknown) => this.fail(e));
    return this.state();
  }

  private missingSetup(): string | null {
    if (!this.cfg.server || !this.cfg.username) return "Server und Benutzer fehlen.";
    if (!this.d.secrets.has(SECRET_PASSWORD)) return "SIP-Passwort fehlt.";
    if (!this.d.secrets.has(SECRET_OPENAI)) return "OpenAI-API-Key fehlt.";
    if (!this.d.claude().path) return "Claude Code ist nicht installiert.";
    return null;
  }

  private fail(e: unknown) {
    this.registration = "failed";
    const msg = e instanceof Error ? e.message : String(e);
    this.message = /ENOTFOUND|EAI_AGAIN/.test(msg) ? `Server ${this.cfg.server} nicht gefunden.` : msg.slice(0, 300);
    this.emitState();
  }

  private async connect() {
    await this.disconnect();
    const password = await this.d.secrets.get(SECRET_PASSWORD);
    if (!password) throw new Error("SIP-Passwort fehlt.");
    const ua = this.f.ua({
      server: this.cfg.server,
      port: this.cfg.port,
      username: this.cfg.username,
      authUsername: this.cfg.authUsername,
      password,
      domain: this.cfg.domain,
      displayName: this.cfg.displayName || "FORGE",
    });
    this.ua = ua;
    ua.on("registration", (state, message) => {
      if (this.ua !== ua) return;
      this.registration = state;
      this.message = message;
      this.emitState();
    });
    ua.on("incoming", (call) => void this.onIncoming(call));
    ua.on("log", (m) => this.d.log(`Telefon: ${m}`));
    this.registration = "registering";
    this.message = null;
    this.emitState();
    await ua.start();
  }

  private async disconnect() {
    for (const t of this.notifyTimers.values()) clearTimeout(t);
    this.notifyTimers.clear();
    const ua = this.ua;
    this.ua = null;
    if (ua) await ua.stop().catch(() => {});
    this.registration = "off";
    this.message = null;
    this.emitState();
  }

  private async reconnect() {
    await this.connect().catch((e: unknown) => this.fail(e));
  }

  shutdown() {
    void this.disconnect();
  }

  calls(limit: number) {
    return this.d.db.listPhoneCalls(limit);
  }

  async hangup(): Promise<PhoneState> {
    await this.active?.call.hangup("In FORGE aufgelegt");
    return this.state();
  }

  async testCall(): Promise<PhoneState> {
    if (!this.cfg.notifyNumber) throw new ForgeError("VALIDATION", "Erst unter Einstellungen → Telefon die Nummer für Anrufe von FORGE eintragen.");
    await this.dial(
      this.cfg.notifyNumber,
      "Testanruf",
      "[FORGE: Testanruf aus den Einstellungen. Der Nutzer hat gerade abgenommen. Sag in zwei kurzen Sätzen, dass die Telefonverbindung funktioniert und was du am Telefon kannst, dann frag, ob er etwas wissen möchte.]",
      new Map(),
    );
    return this.state();
  }

  // ---------- calls

  private async voice(): Promise<VoiceProvider> {
    const key = await this.d.secrets.get(SECRET_OPENAI);
    if (!key) throw new Error("OpenAI-API-Key fehlt.");
    return this.f.voice(key, { voice: this.cfg.voice, sttModel: this.cfg.sttModel, ttsModel: this.cfg.ttsModel });
  }

  private newRecord(direction: "in" | "out", number: string, reason: string | null): PhoneCallRecord {
    return { id: randomUUID(), direction, number, reason, startedAt: new Date().toISOString(), endedAt: null, result: "answered", detail: null, transcript: [] };
  }

  private finishRecord(rec: PhoneCallRecord, result: PhoneCallRecord["result"], detail: string | null) {
    rec.endedAt = new Date().toISOString();
    rec.result = result;
    rec.detail = detail;
    this.d.db.savePhoneCall(rec);
  }

  private async onIncoming(call: SipCall) {
    const rec = this.newRecord("in", call.remoteNumber, null);
    const reject = (status: number, reason: string, detail: string) => {
      call.reject(status, reason);
      this.finishRecord(rec, "rejected", detail);
    };
    if (this.active) return reject(486, "Busy Here", "FORGE telefoniert bereits.");
    if (!this.cfg.allowedCallers.some((n) => sameNumber(n, call.remoteNumber))) {
      this.d.log(`Telefon: Anruf von ${call.remoteNumber || "unbekannt"} abgewiesen (nicht freigegeben)`);
      return reject(403, "Forbidden", "Nummer ist nicht freigegeben.");
    }
    const offer = parseSdp(call.remoteSdp);
    const codec = offer && !offer.secure ? chooseCodec(offer) : null;
    if (!offer || codec === null) return reject(488, "Not Acceptable Here", "Audio-Format nicht unterstützt (kein G.711 oder verschlüsseltes RTP).");
    try {
      const rtp = this.f.rtp(this.ua!.localIp);
      await rtp.open();
      rtp.configure({ ip: offer.ip, port: offer.port }, codec, offer.dtmfPt);
      const sdp = buildSdp({ ip: this.ua!.localIp, port: rtp.port, sessionId: String(Date.now()), version: 1, codec, dtmfPt: offer.dtmfPt });
      const controller = await this.startCall(call, rtp, rec, null, GREETING, null, new Map());
      call.accept(sdp);
      this.active!.info.state = "active";
      this.emitState();
      controller.begin();
    } catch (e) {
      this.d.log(`Telefon: Anruf nicht angenommen: ${e instanceof Error ? e.message : String(e)}`);
      if (call.state === "ringing") reject(500, "Server Internal Error", e instanceof Error ? e.message : String(e));
      this.active = null;
      this.emitState();
    }
  }

  /** Calls the user (notifications and test call); Claude prepares the first words while it rings. */
  private async dial(number: string, reason: string, opening: string, refs: Map<string, string>) {
    if (this.active) throw new ForgeError("SESSION_BUSY", "FORGE telefoniert bereits.");
    if (!this.ua || this.registration !== "registered") throw new ForgeError("VALIDATION", "Das Telefon ist nicht an der Anlage angemeldet.");
    const rec = this.newRecord("out", number, reason);
    // Fails early (e.g. no OpenAI key) before the phone rings.
    await this.voice();
    const rtp = this.f.rtp(this.ua.localIp);
    await rtp.open();
    const sdp = buildSdp({ ip: this.ua.localIp, port: rtp.port, sessionId: String(Date.now()), version: 1 });
    const call = this.ua.call(number, sdp);
    let controller: CallController;
    try {
      controller = await this.startCall(call, rtp, rec, reason, null, opening, refs);
    } catch (e) {
      rtp.close();
      await call.hangup("Abgebrochen");
      throw e;
    }
    controller.prepare();
    call.on("answered", (body) => {
      const offer = parseSdp(body);
      const codec = offer ? (chooseCodec(offer) ?? PT_PCMA) : PT_PCMA;
      if (offer) rtp.configure({ ip: offer.ip, port: offer.port }, codec, offer.dtmfPt);
      if (this.active?.call === call) {
        this.active.info.state = "active";
        this.emitState();
      }
      controller.begin();
    });
  }

  private async startCall(call: SipCall, rtp: RtpSession, rec: PhoneCallRecord, reason: string | null, greeting: string | null, opening: string | null, refs: Map<string, string>) {
    const voice = await this.voice();
    const pinHash = this.cfg.pinHash;
    const info: PhoneCallInfo = { id: rec.id, direction: call.direction, number: call.remoteNumber, state: "ringing", startedAt: rec.startedAt, unlocked: false, reason };
    let answered = false;
    call.on("answered", () => (answered = true));
    const active: ActiveCall = {
      call,
      info,
      record: rec,
      refs,
      controller: null as unknown as CallController,
    };
    const context = [
      `Heute ist ${new Date().toLocaleString("de-DE", { dateStyle: "full", timeStyle: "short" })}.`,
      call.direction === "in" ? `Eingehender Anruf von ${call.remoteNumber}. Du hast schon mit "${GREETING}" begrüßt.` : `Du rufst ${call.remoteNumber} an. Anlass: ${reason}.`,
      this.cfg.requirePin ? (pinHash ? "Steuern ist bis zur PIN-Eingabe gesperrt." : "Steuern ist gesperrt, weil keine PIN eingerichtet ist.") : "Steuern ist ohne PIN erlaubt.",
    ].join("\n");
    active.controller = new CallController(call, rtp, {
      voice,
      createConversation: (cb) => this.f.conversation({ tools: this.toolsFor(active), context, cb }),
      checkPin: this.cfg.requirePin && pinHash ? (pin) => verifyPin(pin, pinHash) : null,
      greeting,
      opening,
      onTranscript: (role, text) => rec.transcript.push({ role, text, ts: new Date().toISOString() }),
      onUnlock: () => {
        info.unlocked = true;
        this.emitState();
      },
      log: (m) => {
        rec.detail = m;
        this.d.log(`Telefon: ${m}`);
      },
    });
    if (call.direction === "in") answered = true;
    call.on("ended", (why) => {
      if (this.active === active) this.active = null;
      this.finishRecord(rec, answered ? "answered" : call.direction === "out" ? "missed" : "rejected", why);
      this.emitState();
    });
    this.active = active;
    this.emitState();
    return active.controller;
  }

  // ---------- notifications

  /** Watches session events for the moments the user wants a call for. */
  onServerEvent(e: ServerEvent) {
    if (e.event !== "session.event" || !this.cfg.enabled || !this.cfg.notifyNumber) return;
    const b = e.payload.body;
    let kind: NotifyKind | null = null;
    if (b.type === "turn.result") {
      const interrupted = b.isError && /interrupt|abort/i.test(`${b.subtype} ${b.text ?? ""}`);
      if (!interrupted) kind = b.isError ? "error" : "done";
    } else if (b.type === "approval.request") kind = "approval";
    else if (b.type === "error") kind = "error";
    if (!kind || !this.cfg.notifyOn[kind]) return;
    const sessionId = e.payload.sessionId;
    const key = `${sessionId}:${kind}`;
    const prev = this.notifyTimers.get(key);
    if (prev) clearTimeout(prev);
    this.notifyTimers.set(
      key,
      setTimeout(() => {
        this.notifyTimers.delete(key);
        void this.notify(sessionId, kind!, b).catch((err: unknown) => this.d.log(`Telefon: Anruf nicht möglich: ${err instanceof Error ? err.message : String(err)}`));
      }, this.d.timing?.notifyDelayMs ?? NOTIFY_DELAY_MS[kind]),
    );
  }

  private async notify(sessionId: string, kind: NotifyKind, body: SessionEventBody) {
    if (this.active || this.registration !== "registered" || !this.cfg.notifyNumber) return;
    if (Date.now() - this.lastNotifyAt < (this.d.timing?.notifyCooldownMs ?? NOTIFY_COOLDOWN_MS)) return;
    let session;
    try {
      session = this.d.sessions.get(sessionId);
    } catch {
      return;
    }
    // Things moved on in the meantime: a new turn runs, or the approval was answered at the desk.
    if (kind === "done" && session.status !== "idle" && session.status !== "stopped") return;
    if (kind === "approval" && session.status !== "waiting_approval") return;
    const project = this.d.projects.get(session.projectId);
    const refs = new Map([["S1", sessionId]]);
    const title = session.title ?? "ohne Titel";
    const what =
      kind === "done"
        ? `Die Session S1 „${title}“ im Projekt ${project.name} ist fertig. Letztes Ergebnis von Claude Code: ${quote(body.type === "turn.result" ? (body.text ?? lastAnswer(this.d.db, sessionId)) : lastAnswer(this.d.db, sessionId))}`
        : kind === "approval"
          ? `Die Session S1 „${title}“ im Projekt ${project.name} wartet auf eine Entscheidung. ${pendingText(this.d.db, sessionId)}`
          : `In der Session S1 „${title}“ im Projekt ${project.name} ist ein Fehler aufgetreten: ${quote(body.type === "turn.result" ? (body.text ?? body.subtype) : body.type === "error" ? body.message : "")}`;
    const reason = kind === "done" ? `Session fertig: ${title}` : kind === "approval" ? `Entscheidung nötig: ${title}` : `Fehler: ${title}`;
    this.lastNotifyAt = Date.now();
    await this.dial(
      this.cfg.notifyNumber,
      reason,
      `[FORGE: Du rufst den Nutzer an. ${what} Er hat gerade abgenommen. Begrüße ihn mit „Hallo, hier ist FORGE.“, sag in höchstens drei kurzen Sätzen, worum es geht, und frag, was er tun möchte.]`,
      refs,
    );
  }

  // ---------- tools for Claude on the phone

  private toolsFor(a: ActiveCall): PhoneToolset {
    const sessions = this.d.sessions;
    const locked = (): string | null => {
      if (!this.cfg.requirePin || a.info.unlocked) return null;
      return this.cfg.pinHash
        ? "Gesperrt. Der Anrufer muss zuerst seine PIN über die Telefontastatur eingeben und mit Raute bestätigen."
        : "Gesperrt. In FORGE ist keine PIN eingerichtet, deshalb ist Steuern am Telefon aus.";
    };
    const refFor = (id: string) => {
      for (const [r, sid] of a.refs) if (sid === id) return r;
      const r = `S${a.refs.size + 1}`;
      a.refs.set(r, id);
      return r;
    };
    const resolve = (ref: string) => {
      const key = ref.trim().toUpperCase().replace(/\s+/g, "");
      const byRef = a.refs.get(key) ?? a.refs.get(`S${key}`);
      if (byRef) return sessions.get(byRef);
      const q = ref.trim().toLowerCase();
      const hit = sessions.listAll().find((s) => (s.title ?? "").toLowerCase().includes(q) || s.projectName.toLowerCase().includes(q));
      if (!hit) throw new Error(`Keine Session zu „${ref}“ gefunden. Erst status aufrufen.`);
      return hit;
    };
    const findProject = (name: string) => {
      const q = name.trim().toLowerCase();
      const all = this.d.projects.all().filter((p) => p.exists);
      const p = all.find((x) => x.name.toLowerCase() === q) ?? all.find((x) => x.name.toLowerCase().includes(q));
      if (!p) throw new Error(`Kein Projekt „${name}“. Vorhanden: ${all.map((x) => x.name).join(", ")}.`);
      return p;
    };
    const guard = async (fn: () => Promise<string>): Promise<string> => {
      try {
        return await fn();
      } catch (e) {
        return `Fehler: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    const statusText = (s: { status: string; live: boolean }) =>
      s.status === "running" || s.status === "starting"
        ? "arbeitet gerade"
        : s.status === "waiting_approval"
          ? "wartet auf eine Entscheidung"
          : s.status === "idle" && s.live
            ? "fertig, wartet auf Anweisungen"
            : s.status === "error"
              ? "mit Fehler beendet"
              : "beendet";

    return {
      status: () =>
        guard(async () => {
          const live = sessions.listLive();
          const recent = sessions.listAll().filter((s) => !s.live).slice(0, 6);
          const list = [...live, ...recent].slice(0, 10);
          if (!list.length) return "Es gibt noch keine Sessions.";
          return list
            .map((s) => {
              const pending = s.status === "waiting_approval" ? ` Offen: ${pendingText(this.d.db, s.id, true)}` : "";
              return `${refFor(s.id)}: „${s.title ?? "ohne Titel"}“ im Projekt ${s.projectName}, ${statusText(s)}, zuletzt ${relative(s.updatedAt)}.${pending}`;
            })
            .join("\n");
        }),
      details: (ref) =>
        guard(async () => {
          const s = resolve(ref);
          const project = this.d.projects.get(s.projectId);
          return [
            `${refFor(s.id)}: „${s.title ?? "ohne Titel"}“ im Projekt ${project.name}, ${statusText(s)}.`,
            `Letztes Ergebnis: ${lastAnswer(this.d.db, s.id) || "noch keins"}`,
            s.status === "waiting_approval" ? `Offen: ${pendingText(this.d.db, s.id)}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }),
      sendMessage: (ref, text) =>
        guard(async () => {
          const l = locked();
          if (l) return l;
          const s = resolve(ref);
          await sessions.send(s.id, text);
          return `An ${refFor(s.id)} gesendet. Claude arbeitet daran.`;
        }),
      startSession: (projectName, prompt) =>
        guard(async () => {
          const l = locked();
          if (l) return l;
          const p = findProject(projectName);
          const s = await sessions.start({ projectId: p.id, prompt });
          return `Neue Session ${refFor(s.id)} im Projekt ${p.name} gestartet.`;
        }),
      respond: (ref, decision, answers, feedback) =>
        guard(async () => {
          const l = locked();
          if (l) return l;
          const s = resolve(ref);
          const req = openRequest(this.d.db, s.id);
          if (!req) return `${refFor(s.id)} hat keine offene Anfrage.`;
          let mapped: Record<string, string> | undefined;
          if (req.toolName === "AskUserQuestion" && decision === "allow") {
            const questions = questionTexts(req.input);
            const given = Object.entries(answers ?? {});
            if (!given.length) return "Für die Rückfrage brauche ich die Antworten (answers).";
            mapped = {};
            given.forEach(([q, v], i) => {
              const exact = questions.find((x) => x === q) ?? questions.find((x) => x.toLowerCase().includes(q.toLowerCase())) ?? questions[i];
              if (exact) mapped![exact] = v;
            });
          }
          sessions.respondApproval(s.id, req.requestId, decision, "once", feedback, mapped);
          return decision === "allow" ? `Erledigt, ${refFor(s.id)} arbeitet weiter.` : `Abgelehnt, ${refFor(s.id)} bekommt die Rückmeldung.`;
        }),
      stop: (ref) =>
        guard(async () => {
          const l = locked();
          if (l) return l;
          const s = resolve(ref);
          await sessions.stop(s.id);
          return `${refFor(s.id)} gestoppt.`;
        }),
      devServer: (projectName, action) =>
        guard(async () => {
          const l = locked();
          if (l) return l;
          const p = findProject(projectName);
          const st = action === "start" ? await this.d.devServers.start(p.id) : await this.d.devServers.stop(p.id);
          return action === "start" ? `Dev-Server von ${p.name} läuft (${st.command ?? ""}).` : `Dev-Server von ${p.name} gestoppt.`;
        }),
    };
  }
}

function quote(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? `„${t.length > 1500 ? t.slice(0, 1500) + " …" : t}“` : "(kein Text)";
}

/** The last thing Claude said in a session (result text, else last answer). */
function lastAnswer(db: Db, sessionId: string): string {
  const events = db.listEvents(sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const b = events[i]!.body;
    if (b.type === "turn.result" && b.text && !b.isError) return b.text.slice(0, 1500);
    if (b.type === "assistant.text" && b.text.trim()) return b.text.slice(0, 1500);
  }
  return "";
}

type ApprovalRequest = Extract<SessionEventBody, { type: "approval.request" }>;

function openRequest(db: Db, sessionId: string): ApprovalRequest | null {
  const open = new Map<string, ApprovalRequest>();
  for (const e of db.listEvents(sessionId)) {
    if (e.body.type === "approval.request") open.set(e.body.requestId, e.body);
    else if (e.body.type === "approval.resolved") open.delete(e.body.requestId);
  }
  return [...open.values()].at(-1) ?? null;
}

function questionTexts(input: Record<string, unknown>): string[] {
  return Array.isArray(input.questions) ? (input.questions as Array<{ question?: unknown }>).flatMap((q) => (typeof q.question === "string" ? [q.question] : [])) : [];
}

/** What a session waits for, in words that can be read out. */
function pendingText(db: Db, sessionId: string, short = false): string {
  const req = openRequest(db, sessionId);
  if (!req) return "nichts";
  if (req.toolName === "AskUserQuestion") {
    if (short) return "eine Rückfrage von Claude.";
    const qs = Array.isArray(req.input.questions) ? (req.input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }>) : [];
    return `Rückfrage von Claude: ${qs.map((q) => `${q.question ?? ""} Optionen: ${(q.options ?? []).map((o) => o.label).join(", ")}.`).join(" ")}`;
  }
  if (req.toolName === "ExitPlanMode") {
    if (short) return "ein Plan zur Freigabe.";
    const plan = typeof req.input.plan === "string" ? req.input.plan : "";
    return `Ein Plan zur Freigabe: ${quote(plan)}`;
  }
  const cmd = typeof req.input.command === "string" ? req.input.command : typeof req.input.file_path === "string" ? req.input.file_path : "";
  return `Freigabe für ${req.toolName}${cmd ? `: ${cmd.slice(0, 200)}` : ""}.`;
}
