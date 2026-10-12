import { randomBytes, randomUUID } from "node:crypto";
import {
  ForgeError,
  type DeskPhoneConfig,
  type PhoneCallInfo,
  type PhoneCallRecord,
  type PhoneConfig,
  type PhoneEngine,
  type PhoneSetupIncomplete,
  type PhoneState,
  type ServerEvent,
  type SessionEventBody,
} from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionService } from "../sessions/session-service.js";
import type { DevServerService } from "../devserver/dev-server.js";
import { slugify, type WorktreeService } from "../automation/worktrees.js";
import { isArtifactPath, isSensitiveFile, type GitEngine } from "../git/git.js";
import { CallController, type CallControllerDeps, type CallHandler, type Conversation, type ConversationCallbacks } from "./call-controller.js";
import { DeskPhone } from "./desk-phone.js";
import { DEFAULT_LIVE_MODEL, GeminiLive, type LiveConversation, type LiveHandlers } from "./gemini-live.js";
import { DEFAULT_GEMINI_STT_MODEL, DEFAULT_GEMINI_TTS_MODEL, DEFAULT_GEMINI_VOICE, GeminiVoice } from "./gemini-voice.js";
import { LiveCallController, type LiveControllerDeps } from "./live-controller.js";
import { asData, PhoneAgent, type PhoneToolset } from "./phone-agent.js";
import { excerptData, lastAnswer, openRequest, pendingText, questionTexts } from "./session-info.js";
import { DEFAULT_PIN_LIMITS, hashPin, PinGuard, verifyPin, type PinGuardState, type PinLimits } from "./pin-guard.js";
import { RtpSession } from "./rtp.js";
import { answerDirection, buildSdp, chooseCodec, parseSdp, PT_PCMA } from "./sdp.js";
import type { SecretStore } from "./secrets.js";
import { localIpTowards, SipUserAgent, type SipAccount, type SipCall } from "./sip-ua.js";
import { geminiFunctionDeclarations, phoneSystemPrompt } from "./tools.js";
import { DEFAULT_STT_MODEL, DEFAULT_TTS_MODEL, DEFAULT_VOICE, OpenAiVoice, type VoiceProvider } from "./voice.js";

const SECRET_PASSWORD = "sip-password";
const SECRET_OPENAI = "openai-key";
const SECRET_GEMINI = "gemini-key";
const SECRET_DESK = "desk-password";
export const DEFAULT_DESK_PORT = 8766;
/** Claude on the phone: fast replies matter more than depth. */
const PHONE_MODEL = "haiku";
/** wait before calling, so a quick follow-up turn or an answer at the desk makes the call unnecessary */
const NOTIFY_DELAY_MS = { done: 5_000, error: 5_000, approval: 15_000, notify: 2_000 };
const NOTIFY_COOLDOWN_MS = 60_000;
const GREETING = "Hallo, hier ist FORGE. Was kann ich für dich tun?";
/** numbers in national notation (030 ...) belong to this country */
export const DEFAULT_COUNTRY_CODE = "49";
const SHUTDOWN_TIMEOUT_MS = 4000;

/** notify: Claude asked for the user with the tool notify (urgent) */
type NotifyKind = "done" | "approval" | "error" | "notify";

type StoredDesk = Omit<DeskPhoneConfig, "hasWebPassword" | "provisioningUrl">;

interface StoredConfig {
  engine: PhoneEngine;
  liveModel: string;
  geminiVoice: string;
  speechProvider: "openai" | "gemini";
  geminiSttModel: string;
  geminiTtsModel: string;
  desk: StoredDesk;
  /** secret part of the URLs the desk phone calls; stays the same so its provisioning keeps working */
  deskToken: string | null;
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
  /** wrong PINs and lockouts, kept across calls and restarts */
  pinGuard?: PinGuardState;
}

const DEFAULT_DESK: StoredDesk = {
  enabled: false,
  phoneIp: "",
  httpPort: DEFAULT_DESK_PORT,
  webUser: "admin",
  sessionKeys: [1, 2, 3, 4],
  clearKeys: [],
  leds: true,
  hotline: true,
  display: "lines",
};

const DEFAULTS: StoredConfig = {
  engine: "gemini-live",
  liveModel: DEFAULT_LIVE_MODEL,
  geminiVoice: DEFAULT_GEMINI_VOICE,
  speechProvider: "openai",
  geminiSttModel: DEFAULT_GEMINI_STT_MODEL,
  geminiTtsModel: DEFAULT_GEMINI_TTS_MODEL,
  desk: DEFAULT_DESK,
  deskToken: null,
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
  geminiVoice(apiKey: string, o: { voice: string; sttModel: string; ttsModel: string }): VoiceProvider;
  conversation(o: { tools: PhoneToolset; context: string; cb: ConversationCallbacks }): Conversation;
  live(o: { apiKey: string; model: string; voice: string; systemInstruction: string; handlers: LiveHandlers }): LiveConversation;
  desk(d: ConstructorParameters<typeof DeskPhone>[0]): DeskPhone;
}

export interface PhoneDeps {
  db: Db;
  projects: ProjectManager;
  sessions: SessionService;
  devServers: DevServerService;
  git: GitEngine;
  worktrees: WorktreeService;
  secrets: SecretStore;
  emit(e: ServerEvent): void;
  claude(): { path: string | null; env: Record<string, string>; cwd: string };
  log(message: string): void;
  factories?: Partial<PhoneFactories>;
  /** shorter waits in tests */
  timing?: {
    notifyDelayMs?: number;
    notifyCooldownMs?: number;
    pinLimits?: Partial<PinLimits>;
    controller?: CallControllerDeps["timing"];
    live?: LiveControllerDeps["timing"];
  };
}

/** Before a call: how it will be talked through. */
type Speech = { engine: "claude"; voice: VoiceProvider } | { engine: "gemini-live"; apiKey: string };

interface ActiveCall {
  call: SipCall;
  /** null while the call is being set up */
  controller: CallHandler | null;
  /** the session this call is about (callback, key on the desk phone); shown on the desk phone */
  focus: string | null;
  rtp: RtpSession | null;
  info: PhoneCallInfo;
  record: PhoneCallRecord;
  /** S1, S2 ... -> session id, as told to Claude in this call */
  refs: Map<string, string>;
  answered: boolean;
  /** set when FORGE ended the call because of an error */
  failure: string | null;
  /** o= line of our SDP; a new answer in the same call needs the same session and a higher version */
  sdp: { session: string; version: number };
}

/**
 * A phone number in one canonical form, so different notations compare equal: "+49 30 1234567",
 * "0049 30 1234567" and "030 1234567" all become "+49301234567". Short numbers without a leading
 * zero (internal extensions) stay as they are and only match exactly.
 */
export function normalizeNumber(raw: string, countryCode = DEFAULT_COUNTRY_CODE): string {
  const s = raw.trim().replace(/\(0\)/g, "");
  const digits = s.replace(/[^\d*#]/g, "");
  if (!digits) return "";
  if (s.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0")) return `+${countryCode}${digits.slice(1)}`;
  return digits;
}

/** Same number after normalizing; "234567" never matches "+49 30 1234567". */
export function sameNumber(a: string, b: string, countryCode = DEFAULT_COUNTRY_CODE): boolean {
  const x = normalizeNumber(a, countryCode);
  return x !== "" && x === normalizeNumber(b, countryCode);
}

/** A reset time as it is said on the phone: "um 14:30" today, else with the weekday. */
function spokenTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `heute um ${time}`;
  return `${d.toLocaleDateString("de-DE", { weekday: "long" })} um ${time}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The phone line of FORGE: registers at the user's PBX, takes calls from allowed numbers and calls
 * the user when a session is done, needs an approval or failed. In a call Claude (haiku, via the
 * Claude Code login) talks with the caller and uses FORGE tools; steering needs the PIN and then
 * runs right away.
 */
export class PhoneService {
  private cfg: StoredConfig;
  private ua: SipUserAgent | null = null;
  private registration: PhoneState["registration"] = "off";
  private message: string | null = null;
  private active: ActiveCall | null = null;
  /** an outgoing call is being prepared; the line counts as busy */
  private dialing = false;
  /** connection settings changed during a call; applied when it ends */
  private pendingReconnect = false;
  private notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastNotifyAt = 0;
  private readonly f: PhoneFactories;
  private readonly pinGuard: PinGuard;
  private readonly desk: DeskPhone;

  constructor(private readonly d: PhoneDeps) {
    const stored = d.db.getPhoneSettings() as Partial<StoredConfig>;
    this.cfg = { ...DEFAULTS, ...stored, desk: { ...DEFAULT_DESK, ...stored.desk } };
    const claude = () => d.claude();
    this.f = {
      ua: (a) => new SipUserAgent(a),
      rtp: (ip) => new RtpSession(ip),
      voice: (key, o) => new OpenAiVoice(key, o),
      geminiVoice: (key, o) => new GeminiVoice(key, o),
      conversation: ({ tools, context, cb }) => {
        const c = claude();
        if (!c.path) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden.");
        return new PhoneAgent({ claudePath: c.path, env: c.env, cwd: c.cwd, model: PHONE_MODEL, tools, context, ...cb });
      },
      live: (o) => new GeminiLive({ ...o, functionDeclarations: geminiFunctionDeclarations() }),
      desk: (dd) => new DeskPhone(dd),
      ...d.factories,
    };
    this.desk = this.f.desk({
      listSessions: () => d.sessions.listLive().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      pending: (id) => openRequest(d.db, id),
      lastAnswer: (id) => lastAnswer(d.db, id),
      respond: (id, requestId, decision) => d.sessions.respondApproval(id, requestId, decision, "once"),
      call: () => ({ active: this.active !== null, sessionId: this.active?.focus ?? null }),
      onKeyInCall: (id) => this.keyInCall(id),
      onReachability: () => this.emitState(),
      log: (m) => d.log(m),
    });
    this.pinGuard = new PinGuard(
      this.cfg.pinGuard,
      (s) => {
        this.cfg = { ...this.cfg, pinGuard: s };
        this.persist();
      },
      { ...DEFAULT_PIN_LIMITS, ...d.timing?.pinLimits },
    );
  }

  /** Starts the line on app start if it was switched on before. */
  async init() {
    if (!this.cfg.enabled) return;
    await this.startDesk();
    await this.connect().catch((e: unknown) => this.fail(e));
  }

  /** After a backup restore: hangs up, reads the stored settings again and starts like on app start. */
  async reload() {
    await this.disconnect();
    await this.desk.stop();
    const stored = this.d.db.getPhoneSettings() as Partial<StoredConfig>;
    this.cfg = { ...DEFAULTS, ...stored, desk: { ...DEFAULT_DESK, ...stored.desk } };
    this.emitState();
    await this.init();
  }

  private persist() {
    this.d.db.setPhoneSettings(this.cfg as unknown as Record<string, unknown>);
  }

  private get busy(): boolean {
    return this.active !== null || this.dialing;
  }

  // ---------- config

  config(): PhoneConfig {
    const { pinHash, pinGuard: _pinGuard, deskToken: _deskToken, desk, ...rest } = this.cfg;
    return {
      ...rest,
      desk: { ...desk, hasWebPassword: this.d.secrets.has(SECRET_DESK), provisioningUrl: this.desk.provisioningUrl },
      hasPassword: this.d.secrets.has(SECRET_PASSWORD),
      hasOpenAiKey: this.d.secrets.has(SECRET_OPENAI),
      hasGeminiKey: this.d.secrets.has(SECRET_GEMINI),
      hasPin: !!pinHash,
    };
  }

  async saveConfig(
    patch: Partial<Omit<PhoneConfig, "enabled" | "hasPassword" | "hasOpenAiKey" | "hasGeminiKey" | "hasPin" | "desk">> & {
      desk?: Partial<StoredDesk>;
      password?: string;
      openAiKey?: string;
      geminiKey?: string;
      deskPassword?: string;
      pin?: string;
    },
  ) {
    const { password, openAiKey, geminiKey, deskPassword, pin, desk, ...rest } = patch;
    const before = JSON.stringify(this.connectionKey());
    const deskBefore = JSON.stringify(this.cfg.desk);
    const next: StoredConfig = { ...this.cfg };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = typeof v === "string" ? v.trim() : v;
    next.allowedCallers = next.allowedCallers.map((n) => n.trim()).filter(Boolean);
    if (next.notifyNumber !== null && !next.notifyNumber.trim()) next.notifyNumber = null;
    if (desk) {
      next.desk = { ...next.desk };
      for (const [k, v] of Object.entries(desk)) if (v !== undefined) (next.desk as unknown as Record<string, unknown>)[k] = typeof v === "string" ? v.trim() : v;
      next.desk.sessionKeys = [...new Set(next.desk.sessionKeys)];
      // A key is either a session key or cleared, never both.
      next.desk.clearKeys = [...new Set(next.desk.clearKeys)].filter((k) => !next.desk.sessionKeys.includes(k));
    }
    if (pin !== undefined) next.pinHash = pin ? await hashPin(pin) : null;
    if (password !== undefined) await this.d.secrets.set(SECRET_PASSWORD, password || null);
    if (openAiKey !== undefined) await this.d.secrets.set(SECRET_OPENAI, openAiKey.trim() || null);
    if (geminiKey !== undefined) await this.d.secrets.set(SECRET_GEMINI, geminiKey.trim() || null);
    if (deskPassword !== undefined) await this.d.secrets.set(SECRET_DESK, deskPassword || null);
    this.cfg = { ...next, pinGuard: this.cfg.pinGuard };
    this.persist();
    // Setting a new PIN at the desk is the owner's decision, so it lifts a lockout.
    if (pin !== undefined) this.pinGuard.reset();
    const changed = before !== JSON.stringify(this.connectionKey()) || password !== undefined;
    if (this.cfg.enabled && changed) {
      // Rebuilding the connection would drop the running call; do it when the call ends.
      if (this.busy) this.pendingReconnect = true;
      else await this.reconnect();
    }
    // The extension is the hotline target, so a new user name changes the provisioning as well.
    if (this.cfg.enabled && (deskBefore !== JSON.stringify(this.cfg.desk) || deskPassword !== undefined || changed)) await this.startDesk();
    return this.config();
  }

  private connectionKey() {
    const c = this.cfg;
    return [c.server, c.port, c.username, c.authUsername, c.domain, c.displayName];
  }

  // ---------- state

  state(): PhoneState {
    const desk = this.cfg.enabled && this.cfg.desk.enabled ? { reachable: this.desk.reachable, message: this.desk.message } : null;
    return { enabled: this.cfg.enabled, registration: this.registration, message: this.message, call: this.active?.info ?? null, desk };
  }

  private emitState() {
    this.d.emit({ event: "phone.updated", payload: this.state() });
    this.desk.refresh();
  }

  private persistEnabled(enabled: boolean) {
    this.cfg = { ...this.cfg, enabled };
    this.persist();
  }

  async setEnabled(enabled: boolean): Promise<PhoneState> {
    if (!enabled) {
      this.persistEnabled(false);
      await this.disconnect();
      await this.desk.stop();
      return this.state();
    }
    const missing = this.missingSetup();
    if (missing) {
      const details: PhoneSetupIncomplete = { phoneSetupIncomplete: true };
      throw new ForgeError("VALIDATION", `Telefon nicht eingerichtet: ${missing} Bitte in den Einstellungen unter Telefon ergänzen.`, details);
    }
    this.persistEnabled(true);
    await this.startDesk();
    await this.connect().catch((e: unknown) => this.fail(e));
    return this.state();
  }

  private missingSetup(): string | null {
    if (!this.cfg.server || !this.cfg.username) return "Server und Benutzer fehlen.";
    if (!this.d.secrets.has(SECRET_PASSWORD)) return "SIP-Passwort fehlt.";
    if (this.cfg.engine === "gemini-live") {
      if (!this.d.secrets.has(SECRET_GEMINI)) return "Gemini-API-Key fehlt (für Gemini Live).";
      return null;
    }
    if (this.cfg.speechProvider === "openai" && !this.d.secrets.has(SECRET_OPENAI)) return "OpenAI-API-Key fehlt.";
    if (this.cfg.speechProvider === "gemini" && !this.d.secrets.has(SECRET_GEMINI)) return "Gemini-API-Key fehlt.";
    if (!this.d.claude().path) return "Claude Code ist nicht installiert.";
    return null;
  }

  private fail(e: unknown) {
    this.registration = "failed";
    const msg = errorText(e);
    this.message = /ENOTFOUND|EAI_AGAIN/.test(msg) ? `Server ${this.cfg.server} nicht gefunden.` : msg.slice(0, 300);
    this.emitState();
  }

  /** Starts (or restarts) the desk phone with the current settings; stops it when it is switched off. */
  private async startDesk() {
    const c = this.cfg.desk;
    if (!this.cfg.enabled || !c.enabled || !c.phoneIp) {
      await this.desk.stop();
      this.emitState();
      return;
    }
    if (!this.cfg.deskToken) {
      this.cfg = { ...this.cfg, deskToken: randomBytes(12).toString("hex") };
      this.persist();
    }
    try {
      await this.desk.start({
        phoneIp: c.phoneIp,
        localIp: await localIpTowards(c.phoneIp, 80),
        httpPort: c.httpPort,
        webUser: c.webUser,
        webPassword: await this.d.secrets.get(SECRET_DESK),
        sessionKeys: c.sessionKeys,
        clearKeys: c.clearKeys,
        leds: c.leds,
        hotline: c.hotline,
        display: c.display,
        forgeNumber: this.cfg.username,
        token: this.cfg.deskToken!,
      });
    } catch (e) {
      const msg = errorText(e);
      this.d.log(`Tischtelefon: nicht gestartet: ${msg}`);
      this.desk.reachable = false;
      this.desk.message = /EADDRINUSE/.test(msg) ? `Port ${c.httpPort} ist belegt (läuft klaus_telefon noch?).` : msg;
    }
    this.emitState();
  }

  /** Shows a test message on the desk phone and sends keys, LEDs and display again. */
  async deskTest(): Promise<PhoneState> {
    if (!this.desk.running) throw new ForgeError("VALIDATION", this.desk.message ?? "Das Tischtelefon ist nicht eingeschaltet.");
    this.desk.notice("FORGE", "Verbindung steht.");
    this.desk.forceRefresh();
    return this.state();
  }

  /** A session key on the desk phone during a call: the conversation is about that session now. */
  private keyInCall(sessionId: string) {
    const a = this.active;
    if (!a?.controller) return;
    let title = "ohne Titel";
    try {
      title = this.d.sessions.get(sessionId).title ?? title;
    } catch {
      return;
    }
    a.focus = sessionId;
    a.controller.note(
      `[FORGE: Der Anrufer hat am Tischtelefon die Taste für Session ${this.refFor(a, sessionId)} ${asData(title)} gedrückt. Ab jetzt geht es um diese Session, wenn er nichts anderes sagt. Sag kurz, wie es um sie steht.]`,
    );
    this.desk.refresh();
  }

  /** The short name (S1, S2 ...) of a session in this call. */
  private refFor(a: ActiveCall, id: string): string {
    for (const [r, sid] of a.refs) if (sid === id) return r;
    const r = `S${a.refs.size + 1}`;
    a.refs.set(r, id);
    return r;
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
    ua.on("incoming", (call) => void this.onIncoming(ua, call));
    ua.on("log", (m) => this.d.log(`Telefon: ${m}`));
    this.registration = "registering";
    this.message = null;
    this.emitState();
    await ua.start();
  }

  private async disconnect() {
    this.pendingReconnect = false;
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

  /**
   * Hangs up a running call, signs off at the PBX and closes the sockets. Resolves when that is done
   * or after `timeoutMs`, whichever comes first; never rejects.
   */
  async shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled([this.disconnect(), this.desk.stop()]), limit]);
    clearTimeout(timer);
  }

  calls(limit: number) {
    return this.d.db.listPhoneCalls(limit);
  }

  async hangup(): Promise<PhoneState> {
    await this.active?.call.hangup("In FORGE aufgelegt");
    return this.state();
  }

  async testCall(): Promise<PhoneState> {
    if (!this.cfg.notifyNumber) throw new ForgeError("VALIDATION", "Bitte zuerst in den Einstellungen unter Telefon die Nummer eintragen, die FORGE anrufen soll.");
    await this.dial(
      this.cfg.notifyNumber,
      "Testanruf",
      "[FORGE: Testanruf aus den Einstellungen. Der Nutzer hat gerade abgenommen. Sag nur „Hallo, hier ist FORGE. Die Verbindung steht.“ und warte, ob er etwas will.]",
      new Map(),
      null,
    );
    return this.state();
  }

  // ---------- calls

  /** What the call needs before it starts; fails early (missing key) before anything rings. */
  private async speech(): Promise<Speech> {
    if (this.cfg.engine === "gemini-live") {
      const apiKey = await this.d.secrets.get(SECRET_GEMINI);
      if (!apiKey) throw new Error("Gemini-API-Key fehlt.");
      return { engine: "gemini-live", apiKey };
    }
    if (this.cfg.speechProvider === "gemini") {
      const key = await this.d.secrets.get(SECRET_GEMINI);
      if (!key) throw new Error("Gemini-API-Key fehlt.");
      return { engine: "claude", voice: this.f.geminiVoice(key, { voice: this.cfg.geminiVoice, sttModel: this.cfg.geminiSttModel, ttsModel: this.cfg.geminiTtsModel }) };
    }
    const key = await this.d.secrets.get(SECRET_OPENAI);
    if (!key) throw new Error("OpenAI-API-Key fehlt.");
    return { engine: "claude", voice: this.f.voice(key, { voice: this.cfg.voice, sttModel: this.cfg.sttModel, ttsModel: this.cfg.ttsModel }) };
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

  /**
   * Takes the line for a call before anything is awaited, so a second call gets "busy" and an early
   * end (CANCEL while FORGE is still preparing) frees the line and closes what was opened so far.
   */
  private attach(call: SipCall, rec: PhoneCallRecord, reason: string | null, refs: Map<string, string>, sdpSession: string, focus: string | null): ActiveCall {
    const info: PhoneCallInfo = { id: rec.id, direction: call.direction, number: call.remoteNumber, state: "ringing", startedAt: rec.startedAt, unlocked: false, reason };
    const a: ActiveCall = { call, controller: null, focus, rtp: null, info, record: rec, refs, answered: false, failure: null, sdp: { session: sdpSession, version: 1 } };
    call.on("answered", () => (a.answered = true));
    call.on("ended", (why) => {
      if (this.active === a) this.active = null;
      a.controller?.dispose();
      a.rtp?.close();
      this.finishRecord(rec, a.failure ? "failed" : a.answered ? "answered" : "missed", a.failure ?? why);
      // Talked about on the phone: no longer new on the desk phone.
      if (a.answered && a.focus) this.desk.markHeard(a.focus);
      this.emitState();
      if (this.pendingReconnect && this.cfg.enabled && this.ua && !this.busy) {
        this.pendingReconnect = false;
        void this.reconnect();
      }
    });
    call.onOffer = (sdp) => this.answerReoffer(a, sdp);
    this.active = a;
    this.emitState();
    return a;
  }

  /** Re-INVITE or UPDATE with new SDP: follow the new address and answer hold with recvonly. */
  private answerReoffer(a: ActiveCall, body: string): string | null {
    const offer = parseSdp(body);
    const codec = offer && !offer.secure ? chooseCodec(offer) : null;
    if (!offer || codec === null || !a.rtp || !this.ua) return null;
    const direction = answerDirection(offer.direction);
    a.rtp.configure({ ip: offer.ip, port: offer.port }, codec, offer.dtmfPt, [this.ua.serverIp]);
    a.rtp.setDirection(direction);
    return buildSdp({ ip: this.ua.localIp, port: a.rtp.port, sessionId: a.sdp.session, version: ++a.sdp.version, codec, dtmfPt: offer.dtmfPt, direction });
  }

  private createController(a: ActiveCall, speech: Speech, opening: string | null): CallHandler {
    const pinHash = this.cfg.pinHash;
    const caller = normalizeNumber(a.call.remoteNumber) || "unbekannt";
    const live = speech.engine === "gemini-live";
    const incoming = a.call.direction === "in";
    let picked = "";
    if (incoming && a.focus) {
      try {
        const s = this.d.sessions.get(a.focus);
        picked = `Der Anrufer hat vor dem Anruf am Tischtelefon die Session ${this.refFor(a, a.focus)} ${asData(s.title ?? "ohne Titel")} gewählt. Wenn er nichts anderes sagt, geht es um sie.`;
      } catch {
        a.focus = null;
      }
    }
    const context = [
      `Heute ist ${new Date().toLocaleString("de-DE", { dateStyle: "full", timeStyle: "short" })}.`,
      incoming
        ? live
          ? `Eingehender Anruf von ${a.call.remoteNumber}.`
          : `Eingehender Anruf von ${a.call.remoteNumber}. Du hast schon mit "${GREETING}" begrüßt.`
        : `Du rufst ${a.call.remoteNumber} an. Anlass: ${a.info.reason}.`,
      picked,
      this.cfg.requirePin
        ? pinHash
          ? "Steuern ist bis zur PIN-Eingabe gesperrt. Erwähne das erst, wenn ein Werkzeug „Gesperrt“ meldet."
          : "Steuern ist gesperrt, weil keine PIN eingerichtet ist."
        : "Steuern ist ohne PIN erlaubt.",
    ]
      .filter(Boolean)
      .join("\n");
    const rec = a.record;
    const common = {
      checkPin: this.cfg.requirePin && pinHash ? (pin: string) => this.pinGuard.check(caller, () => verifyPin(pin, pinHash)) : null,
      opening,
      onTranscript: (role: "caller" | "forge", text: string) => rec.transcript.push({ role, text, ts: new Date().toISOString() }),
      onUnlock: () => {
        a.info.unlocked = true;
        this.emitState();
      },
      log: (m: string) => {
        rec.detail = m;
        this.d.log(`Telefon: ${m}`);
      },
    };
    if (speech.engine === "gemini-live") {
      a.controller = new LiveCallController(a.call, a.rtp!, {
        ...common,
        greeting: incoming ? (picked ? "Hallo, hier ist FORGE." : GREETING) : null,
        tools: this.toolsFor(a),
        createLive: (handlers) =>
          this.f.live({
            apiKey: speech.apiKey,
            model: this.cfg.liveModel,
            voice: this.cfg.geminiVoice,
            systemInstruction: `${phoneSystemPrompt("voice")}\n\n${context}`,
            handlers,
          }),
        timing: this.d.timing?.live,
      });
    } else {
      a.controller = new CallController(a.call, a.rtp!, {
        ...common,
        voice: speech.voice,
        greeting: incoming ? GREETING : null,
        createConversation: (cb) => this.f.conversation({ tools: this.toolsFor(a), context, cb }),
        timing: this.d.timing?.controller,
      });
    }
    return a.controller;
  }

  private async onIncoming(ua: SipUserAgent, call: SipCall) {
    const rec = this.newRecord("in", call.remoteNumber, null);
    const reject = (status: number, reason: string, detail: string) => {
      call.reject(status, reason);
      this.finishRecord(rec, "rejected", detail);
    };
    if (this.busy) return reject(486, "Busy Here", "FORGE telefoniert bereits.");
    if (this.ua !== ua) return reject(503, "Service Unavailable", "Telefon wird gerade neu verbunden.");
    if (!this.cfg.allowedCallers.some((n) => sameNumber(n, call.remoteNumber))) {
      this.d.log(`Telefon: Anruf von ${call.remoteNumber || "unbekannt"} abgewiesen (nicht freigegeben)`);
      return reject(403, "Forbidden", "Nummer ist nicht freigegeben.");
    }
    const offer = parseSdp(call.remoteSdp);
    const codec = offer && !offer.secure ? chooseCodec(offer) : null;
    if (!offer || codec === null) return reject(488, "Not Acceptable Here", "Audio-Format nicht unterstützt (kein G.711 oder verschlüsseltes RTP).");
    // A session key pressed on the desk phone just before: this call is about that session.
    const a = this.attach(call, rec, null, new Map(), String(Date.now()), this.desk.takePickup());
    try {
      const speech = await this.speech();
      if (ended(call)) return;
      const rtp = (a.rtp = this.f.rtp(ua.bindIp));
      await rtp.open();
      // The caller may have hung up while the port was opened; the end handler ran before that.
      if (ended(call)) return rtp.close();
      const direction = answerDirection(offer.direction);
      rtp.configure({ ip: offer.ip, port: offer.port }, codec, offer.dtmfPt, [ua.serverIp]);
      rtp.setDirection(direction);
      const sdp = buildSdp({ ip: ua.localIp, port: rtp.port, sessionId: a.sdp.session, version: a.sdp.version, codec, dtmfPt: offer.dtmfPt, direction });
      const controller = this.createController(a, speech, null);
      // Gemini connects while the answer goes out, so the greeting comes without a gap.
      if (speech.engine === "gemini-live") controller.prepare();
      call.accept(sdp);
      a.answered = true;
      a.info.state = "active";
      this.emitState();
      controller.begin();
    } catch (e) {
      const msg = errorText(e);
      this.d.log(`Telefon: Anruf nicht angenommen: ${msg}`);
      a.failure = msg;
      if (call.state === "ringing") call.reject(500, "Server Internal Error", msg);
      else void call.hangup("Technischer Fehler");
    }
  }

  /** Calls the user (notifications and test call); the first words are prepared while it rings. */
  private async dial(number: string, reason: string, opening: string, refs: Map<string, string>, focus: string | null) {
    if (this.busy) throw new ForgeError("SESSION_BUSY", "FORGE telefoniert bereits.");
    const ua = this.ua;
    if (!ua || this.registration !== "registered") throw new ForgeError("VALIDATION", "Das Telefon ist nicht an der Anlage angemeldet.");
    this.dialing = true;
    let rtp: RtpSession | null = null;
    let a: ActiveCall | null = null;
    try {
      // Fails early (e.g. no API key) before the phone rings.
      const speech = await this.speech();
      rtp = this.f.rtp(ua.bindIp);
      await rtp.open();
      if (this.ua !== ua) throw new Error("Das Telefon wurde inzwischen ausgeschaltet.");
      const session = String(Date.now());
      const call = ua.call(number, buildSdp({ ip: ua.localIp, port: rtp.port, sessionId: session, version: 1 }));
      a = this.attach(call, this.newRecord("out", number, reason), reason, refs, session, focus);
      if (focus) this.desk.select(focus);
      a.rtp = rtp;
      rtp = null;
      const active = a;
      const controller = this.createController(active, speech, opening);
      call.on("answered", (body) => {
        const offer = parseSdp(body);
        if (offer && active.rtp) {
          active.rtp.configure({ ip: offer.ip, port: offer.port }, chooseCodec(offer) ?? PT_PCMA, offer.dtmfPt, [ua.serverIp]);
          active.rtp.setDirection(answerDirection(offer.direction));
        }
        if (this.active === active) {
          active.info.state = "active";
          this.emitState();
        }
        try {
          controller.begin();
        } catch (e) {
          active.failure = errorText(e);
          this.d.log(`Telefon: Gespräch nicht gestartet: ${active.failure}`);
          void call.hangup("Technischer Fehler");
        }
      });
      controller.prepare();
    } catch (e) {
      rtp?.close();
      if (a) {
        a.failure = errorText(e);
        await a.call.hangup("Abgebrochen");
      }
      throw e;
    } finally {
      this.dialing = false;
    }
  }

  // ---------- notifications

  /** Watches session events: for the desk phone, and for the moments the user wants a call for. */
  onServerEvent(e: ServerEvent) {
    if (!this.cfg.enabled) return;
    if (e.event === "session.updated") this.desk.refresh();
    if (e.event !== "session.event") return;
    const b = e.payload.body;
    const sessionId = e.payload.sessionId;
    if (b.type === "turn.result" && !b.isError) this.desk.markUnheard(sessionId);
    else if (b.type === "user.message") this.desk.markHeard(sessionId);
    else if (b.type === "approval.request" || b.type === "approval.resolved") this.desk.refresh();
    if (!this.cfg.notifyNumber) return;
    let kind: NotifyKind | null = null;
    if (b.type === "turn.result") {
      const interrupted = b.isError && /interrupt|abort/i.test(`${b.subtype} ${b.text ?? ""}`);
      if (!interrupted) kind = b.isError ? "error" : "done";
    } else if (b.type === "approval.request") kind = "approval";
    else if (b.type === "error") kind = "error";
    else if (b.type === "notify" && b.urgent) kind = "notify";
    // An urgent notify means Claude needs the user: it follows the setting for decisions.
    if (!kind || !this.cfg.notifyOn[kind === "notify" ? "approval" : kind]) return;
    const key = `${sessionId}:${kind}`;
    const prev = this.notifyTimers.get(key);
    if (prev) clearTimeout(prev);
    this.notifyTimers.set(
      key,
      setTimeout(() => {
        this.notifyTimers.delete(key);
        void this.notify(sessionId, kind!, b).catch((err: unknown) => this.d.log(`Telefon: Anruf nicht möglich: ${errorText(err)}`));
      }, this.d.timing?.notifyDelayMs ?? NOTIFY_DELAY_MS[kind]),
    );
  }

  private async notify(sessionId: string, kind: NotifyKind, body: SessionEventBody) {
    if (this.busy || this.registration !== "registered" || !this.cfg.notifyNumber) return;
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
    const result = body.type === "turn.result" ? (body.text ?? lastAnswer(this.d.db, sessionId)) : lastAnswer(this.d.db, sessionId);
    const failure = body.type === "turn.result" ? (body.text ?? body.subtype) : body.type === "error" ? body.message : "";
    const what =
      body.type === "notify"
        ? `Claude Code in der Session S1 ${asData(title)} im Projekt ${project.name} möchte dich erreichen und lässt ausrichten: ${excerptData(body.message, 500)}`
        : kind === "done"
        ? `Die Session S1 ${asData(title)} im Projekt ${project.name} ist fertig. Letztes Ergebnis von Claude Code: ${excerptData(result, 1500)}`
        : kind === "approval"
          ? `Die Session S1 ${asData(title)} im Projekt ${project.name} wartet auf eine Entscheidung. ${pendingText(this.d.db, sessionId)}`
          : `In der Session S1 ${asData(title)} im Projekt ${project.name} ist ein Fehler aufgetreten: ${excerptData(failure, 1500)}`;
    const reason = kind === "notify" ? `Claude meldet sich: ${title}` : kind === "done" ? `Session fertig: ${title}` : kind === "approval" ? `Entscheidung nötig: ${title}` : `Fehler: ${title}`;
    this.lastNotifyAt = Date.now();
    await this.dial(
      this.cfg.notifyNumber,
      reason,
      `[FORGE: Du rufst den Nutzer an. ${what} Er hat gerade abgenommen. Sag „Hallo, hier ist FORGE.“ und in einem Satz, worum es geht, ohne Einzelheiten. Wartet etwas auf seine Entscheidung, sag in einem kurzen Satz, was zur Wahl steht. Dann warte, was er sagt.]`,
      refs,
      sessionId,
    );
  }

  // ---------- tools for Claude on the phone

  private toolsFor(a: ActiveCall): PhoneToolset {
    const sessions = this.d.sessions;
    const db = this.d.db;
    const locked = (): string | null => {
      if (!this.cfg.requirePin || a.info.unlocked) return null;
      return this.cfg.pinHash
        ? "Gesperrt. Der Anrufer muss zuerst seine PIN über die Telefontastatur eingeben und mit Raute bestätigen."
        : "Gesperrt. In FORGE ist keine PIN eingerichtet, deshalb ist Steuern am Telefon aus.";
    };
    const refFor = (id: string) => this.refFor(a, id);
    const resolve = (ref: string) => {
      const raw = ref.trim();
      if (!raw) throw new Error("Welche Session? Bitte ein Kürzel wie S1 oder einen Teil des Titels angeben.");
      const key = raw.toUpperCase().replace(/\s+/g, "");
      if (/^S?\d+$/.test(key)) {
        const r = key.startsWith("S") ? key : `S${key}`;
        const id = a.refs.get(r);
        if (!id) throw new Error(`${r} ist in diesem Gespräch nicht vergeben. Erst status aufrufen.`);
        return sessions.get(id);
      }
      const q = raw.toLowerCase();
      const all = sessions.listAll();
      const exact = all.filter((s) => (s.title ?? "").toLowerCase() === q);
      const hits = exact.length ? exact : all.filter((s) => (s.title ?? "").toLowerCase().includes(q) || s.projectName.toLowerCase().includes(q));
      if (!hits.length) throw new Error(`Keine Session zu „${raw}“ gefunden. Erst status aufrufen.`);
      if (hits.length > 1) {
        const names = hits.slice(0, 5).map((s) => `${refFor(s.id)} ${asData(s.title ?? "ohne Titel")}`);
        throw new Error(`Mehrere Sessions passen zu „${raw}“: ${names.join(", ")}. Bitte das Kürzel nehmen.`);
      }
      return hits[0]!;
    };
    const findProject = (name: string) => {
      const q = name.trim().toLowerCase();
      const all = this.d.projects.all().filter((p) => p.exists);
      if (!q) throw new Error(`Welches Projekt? Vorhanden: ${all.map((x) => x.name).join(", ")}.`);
      const exact = all.filter((x) => x.name.toLowerCase() === q);
      const hits = exact.length ? exact : all.filter((x) => x.name.toLowerCase().includes(q));
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1) throw new Error(`Mehrere Projekte passen zu „${name}“: ${hits.map((x) => x.name).join(", ")}.`);
      throw new Error(`Kein Projekt „${name}“. Vorhanden: ${all.map((x) => x.name).join(", ")}.`);
    };
    /** Runs a tool; errors become text for Claude. Steering tools (`steer`) need the PIN. */
    const run = async (steer: boolean, fn: () => Promise<string>): Promise<string> => {
      const l = steer ? locked() : null;
      if (l) return l;
      try {
        return await fn();
      } catch (e) {
        return `Fehler: ${errorText(e)}`;
      }
    };
    const projectChanged = (projectId: string) => this.d.emit({ event: "project.updated", payload: { projectId } });
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
        run(false, async () => {
          const live = sessions.listLive();
          const recent = sessions
            .listAll()
            .filter((s) => !s.live)
            .slice(0, 3);
          if (!live.length && !recent.length) return "Es gibt noch keine Sessions.";
          if (locked()) {
            // Before the PIN only counts: titles and results can be confidential.
            const working = live.filter((s) => s.status === "running" || s.status === "starting").length;
            const waiting = live.filter((s) => s.status === "waiting_approval").length;
            return `Aktive Sessions: ${live.length}, davon arbeiten ${working} und ${waiting} warten auf eine Entscheidung. Titel, Ergebnisse und Details gibt es erst nach der PIN.`;
          }
          const line = (s: (typeof live)[number]) => {
            const pending = s.status === "waiting_approval" ? ` Offen: ${pendingText(db, s.id, true)}` : "";
            return `${refFor(s.id)}: ${asData(s.title ?? "ohne Titel")} im Projekt ${s.projectName}, ${statusText(s)}.${pending}`;
          };
          return [live.length ? live.map(line).join("\n") : "Keine aktive Session.", recent.length ? `Zuletzt beendet:\n${recent.map(line).join("\n")}` : ""]
            .filter(Boolean)
            .join("\n");
        }),
      details: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          const project = this.d.projects.get(s.projectId);
          const last = lastAnswer(db, s.id);
          const setup = [s.model ? `Modell ${s.model}` : "", s.permissionMode ? `Modus ${s.permissionMode}` : ""].filter(Boolean).join(", ");
          return [
            `${refFor(s.id)}: ${asData(s.title ?? "ohne Titel")} im Projekt ${project.name}, ${statusText(s)}.${setup ? ` ${setup}.` : ""}`,
            `Letztes Ergebnis: ${last ? excerptData(last, 1500) : "noch keins"}`,
            s.status === "waiting_approval" ? `Offen: ${pendingText(db, s.id)}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }),
      sendMessage: (ref, text) =>
        run(true, async () => {
          const s = resolve(ref);
          if (!text.trim()) return "Fehler: Die Nachricht ist leer.";
          await sessions.send(s.id, text);
          return `An ${refFor(s.id)} gesendet. Claude arbeitet daran.`;
        }),
      startSession: (projectName, prompt, o) =>
        run(true, async () => {
          const found = findProject(projectName);
          if (!prompt.trim()) return "Fehler: Der Auftrag ist leer.";
          const model = o?.model?.trim() || undefined;
          if (!o?.agent) {
            const s = await sessions.start({ projectId: found.id, prompt, model, planOnly: o?.planOnly });
            a.focus = s.id;
            return `Neue Session ${refFor(s.id)} im Projekt ${found.name} gestartet.`;
          }
          // A parallel agent: own worktree and branch next to the project (as in the Agents tab).
          const root = found.parentId ? this.d.projects.get(found.parentId) : found;
          const branch = `agent/${slugify(prompt, 32)}-${Date.now().toString(36).slice(-4)}`;
          const wt = await this.d.worktrees.create(this.d.projects.requireExisting(root.id), branch);
          projectChanged(wt.id);
          const s = await sessions.start({ projectId: wt.id, prompt, model, planOnly: o?.planOnly });
          a.focus = s.id;
          return `Agent ${refFor(s.id)} im Projekt ${root.name} gestartet, in einem eigenen Worktree auf eigenem Branch.`;
        }),
      respond: (ref, decision, answers, feedback) =>
        run(true, async () => {
          const s = resolve(ref);
          const r = refFor(s.id);
          const req = openRequest(db, s.id);
          if (!req) return `${r} hat keine offene Anfrage.`;
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
          return decision === "allow" ? `Erledigt, ${r} arbeitet weiter.` : `Abgelehnt, ${r} bekommt die Rückmeldung.`;
        }),
      stop: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          await sessions.stop(s.id);
          return `${refFor(s.id)} gestoppt.`;
        }),
      close: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          sessions.close(s.id);
          return `${refFor(s.id)} geschlossen.`;
        }),
      sessionSettings: (ref, patch) =>
        run(true, async () => {
          const s = resolve(ref);
          const done: string[] = [];
          const model = patch.model?.trim();
          if (model) {
            await sessions.setModel(s.id, model);
            done.push(`Modell ${model}`);
          }
          if (patch.effort) {
            await sessions.setEffort(s.id, patch.effort);
            done.push(`Denkaufwand ${patch.effort}`);
          }
          if (patch.permissionMode) {
            await sessions.setPermissionMode(s.id, patch.permissionMode);
            done.push(`Modus ${patch.permissionMode}`);
          }
          if (!done.length) return "Fehler: Es wurde nichts zum Ändern angegeben.";
          return `${refFor(s.id)}: ${done.join(", ")} gesetzt.`;
        }),
      cancelAutoContinue: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          sessions.cancelAutoContinue(s.id);
          return `Automatisches Weitermachen von ${refFor(s.id)} abgebrochen.`;
        }),
      remote: (action) =>
        run(action !== "status", async () => {
          const st = action === "on" ? await sessions.remoteStart() : action === "off" ? await sessions.remoteStop() : sessions.remoteState();
          if (!st.enabled) return "Remote Control ist aus.";
          const ok = st.sessions.filter((x) => x.state !== "error").length;
          const failed = st.sessions.filter((x) => x.state === "error");
          return [
            `Remote Control ist an, ${ok} ${ok === 1 ? "Session ist" : "Sessions sind"} mit der Claude-App verbunden.`,
            failed.length ? `Nicht verbunden: ${failed.map((x) => `${refFor(x.sessionId)} (${x.message ?? "Fehler"})`).join(", ")}.` : "",
            st.sessions.length === 0 ? "Gerade läuft keine Session. Neue Sessions werden automatisch verbunden." : "",
          ]
            .filter(Boolean)
            .join(" ");
        }),
      devServer: (projectName, action) =>
        run(true, async () => {
          const p = findProject(projectName);
          if (action === "stop") {
            await this.d.devServers.stop(p.id);
            return `Dev-Server von ${p.name} gestoppt.`;
          }
          const st = action === "start" ? await this.d.devServers.start(p.id) : await this.d.devServers.state(p.id);
          if (st.status === "running") return `Dev-Server von ${p.name} läuft.`;
          const why = st.error ?? (st.exitCode !== null ? `Exit-Code ${st.exitCode}` : "");
          if (action === "start") return `Fehler: Der Dev-Server von ${p.name} ist nicht gestartet.${why ? ` ${why}` : ""}`;
          return st.status === "stopped" ? `Dev-Server von ${p.name} läuft nicht.` : `Dev-Server von ${p.name} ist beendet.${why ? ` ${why}` : ""}`;
        }),
      git: (projectName, action, o) =>
        run(true, async () => {
          const p = findProject(projectName);
          const git = this.d.git;
          if (action === "status") {
            const { summary: s } = await git.status(p.path);
            const sync = [s.ahead ? `${s.ahead} Commits nicht gepusht` : "", s.behind ? `${s.behind} Commits auf dem Server neuer` : ""].filter(Boolean);
            const parts = [`Branch ${s.branch ?? "keiner (detached)"}`, s.changedCount ? `${s.changedCount} geänderte Dateien` : "keine Änderungen", ...sync, s.conflicted ? "es gibt Konflikte" : ""];
            return `${p.name}: ${parts.filter(Boolean).join(", ")}.`;
          }
          if (action === "commit") {
            const st = await git.status(p.path);
            // Secrets and build output are never committed from the phone; the caller hears what was left out.
            const skipped = st.files.filter((f) => isSensitiveFile(f.path) || isArtifactPath(f.path)).map((f) => f.path);
            const paths = st.files.map((f) => f.path).filter((f) => !skipped.includes(f));
            if (!paths.length) return skipped.length ? `Nichts committet, geändert sind nur sensible Dateien oder Build-Artefakte: ${skipped.join(", ")}.` : `${p.name} hat keine Änderungen.`;
            const message = o?.message?.trim() || (await sessions.suggestCommitMessage(p.id, paths)).message;
            await git.commit(p.path, message, paths, false);
            projectChanged(p.id);
            return `Committet in ${p.name}: ${asData(message.split("\n")[0]!)}${skipped.length ? ` Ausgelassen: ${skipped.join(", ")}.` : ""}`;
          }
          if (action === "push") {
            const r = await git.push(p.path, o?.allowProtected === true);
            projectChanged(p.id);
            return `Branch ${r.branch} von ${p.name} gepusht.`;
          }
          await git.pull(p.path);
          projectChanged(p.id);
          return `${p.name} ist auf dem neuesten Stand.`;
        }),
      projects: () =>
        run(true, async () => {
          const all = this.d.projects.all().filter((p) => p.exists);
          if (!all.length) return "Es gibt keine Projekte.";
          const live = sessions.listLive();
          return all
            .map((p) => {
              const n = live.filter((s) => s.projectId === p.id).length;
              return `${p.name}${n ? `, ${n} aktive ${n === 1 ? "Session" : "Sessions"}` : ""}`;
            })
            .join("\n");
        }),
      usage: () =>
        run(false, async () => {
          const u = await sessions.planUsage(false);
          const limit = sessions.rateLimit();
          const reached = limit.status === "reached" ? `Limit erreicht${limit.resetsAt ? `, wieder frei ${spokenTime(limit.resetsAt)}` : ""}.` : "";
          if (!u.available || !u.windows.length) return reached || `Nutzung nicht verfügbar${u.error ? `: ${u.error}` : ""}.`;
          const windows = u.windows.map((w) => `${w.label}: ${Math.round(w.utilization)} Prozent${w.resetsAt ? `, zurückgesetzt ${spokenTime(w.resetsAt)}` : ""}`);
          return [reached, ...windows].filter(Boolean).join("\n");
        }),
    };
  }
}

/** Read through a function: TypeScript keeps a narrowed `call.state` across awaits, the call does not. */
function ended(call: SipCall): boolean {
  return call.state === "ended";
}
