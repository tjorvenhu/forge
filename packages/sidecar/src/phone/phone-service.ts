import { randomBytes, randomUUID } from "node:crypto";
import {
  ForgeError,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
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
import type { TestDbService } from "../devtools/test-db.js";
import type { DevToolsService } from "../devtools/dev-tools.js";
import type { KnowledgeStore } from "../knowledge/knowledge.js";
import type { GitHubService } from "../github/github.js";
import { removeWorktree } from "../projects/removal.js";
import { slugify, type WorktreeService } from "../automation/worktrees.js";
import { isArtifactPath, isSensitiveFile, type GitEngine } from "../git/git.js";
import { startIntegrationSession } from "../git/integration-prompt.js";
import { ZodError } from "zod";
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
import { geminiFunctionDeclarations, phoneSystemPrompt, type CallSettingsPatch } from "./tools.js";
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
  /** callbacks agreed on the phone ("call me back in five minutes and tell me …"); kept across restarts */
  callbacks?: ScheduledCallback[];
}

interface ScheduledCallback {
  id: string;
  number: string;
  /** what the user wants to hear then, in the words of the conversation partner */
  about: string;
  dueAt: string;
  createdAt: string;
}

/** a callback that cannot ring (line busy, not registered) is tried again for this long */
const CALLBACK_GRACE_MS = 15 * 60_000;
const CALLBACK_TICK_MS = 15_000;

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
  testDb?: TestDbService;
  /** test environment and test database settings; without it dev_settings is not available */
  devTools?: Pick<DevToolsService, "get" | "update">;
  knowledge?: KnowledgeStore;
  /** pull requests; without it pull_request is not available */
  github?: Pick<GitHubService, "prForBranch" | "createPr">;
  git: GitEngine;
  worktrees: WorktreeService;
  secrets: SecretStore;
  emit(e: ServerEvent): void;
  claude(): { path: string | null; env: Record<string, string>; cwd: string };
  log(message: string): void;
  /** true while the user works in the FORGE window; then FORGE does not call */
  userPresent?: () => boolean;
  factories?: Partial<PhoneFactories>;
  /** shorter waits in tests */
  timing?: {
    notifyDelayMs?: number;
    notifyCooldownMs?: number;
    pinLimits?: Partial<PinLimits>;
    controller?: CallControllerDeps["timing"];
    live?: LiveControllerDeps["timing"];
    callbackTickMs?: number;
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
  private callbackTicker: ReturnType<typeof setInterval> | null = null;
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
    this.startCallbackTicker();
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
    if (this.callbackTicker) clearInterval(this.callbackTicker);
    this.callbackTicker = null;
    await Promise.race([Promise.allSettled([this.disconnect(), this.desk.stop()]), limit]);
    clearTimeout(timer);
  }

  // ---------- callbacks agreed on the phone

  /** Checks due callbacks every few seconds; a long timer would stand still in standby. */
  private startCallbackTicker() {
    if (this.callbackTicker) return;
    this.callbackTicker = setInterval(() => void this.runDueCallbacks(), this.d.timing?.callbackTickMs ?? CALLBACK_TICK_MS);
    this.callbackTicker.unref?.();
  }

  private saveCallbacks(list: ScheduledCallback[]) {
    this.cfg = { ...this.cfg, callbacks: list };
    this.persist();
  }

  /** Agrees a callback; returns the time it rings. */
  scheduleCallback(number: string, minutes: number, about: string): Date {
    const due = new Date(Date.now() + minutes * 60_000);
    const list = [...(this.cfg.callbacks ?? []), { id: randomUUID(), number, about: about.trim(), dueAt: due.toISOString(), createdAt: new Date().toISOString() }];
    this.saveCallbacks(list);
    this.startCallbackTicker();
    return due;
  }

  private async runDueCallbacks() {
    const now = Date.now();
    const list = this.cfg.callbacks ?? [];
    // Too late to be of use (FORGE was off, line busy the whole time): dropped.
    const expired = list.filter((c) => now - Date.parse(c.dueAt) > CALLBACK_GRACE_MS);
    for (const c of expired) this.d.log(`Telefon: Rückruf an ${c.number} verfallen (${c.about})`);
    const live = list.filter((c) => !expired.includes(c));
    if (expired.length) this.saveCallbacks(live);
    const due = live.find((c) => Date.parse(c.dueAt) <= now);
    if (!due || !this.cfg.enabled || this.busy || this.registration !== "registered") return;
    this.saveCallbacks(live.filter((c) => c.id !== due.id));
    const asked = new Date(due.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    try {
      await this.dial(
        due.number,
        `Rückruf wie verabredet: ${due.about}`,
        `[FORGE: Du rufst den Nutzer wie verabredet zurück. Um ${asked} hat er darum gebeten und wollte dann wissen: ${asData(due.about)} Prüfe das jetzt mit den Werkzeugen, nicht aus der Erinnerung. Er hat gerade abgenommen. Sag „Hallo, hier ist FORGE, wie verabredet.“ und dann in ein bis zwei Sätzen das Ergebnis. Dann warte, was er sagt.]`,
        new Map(),
        null,
      );
    } catch (e) {
      // Not reached this time (e.g. line busy a moment ago): try again on a later tick.
      this.d.log(`Telefon: Rückruf an ${due.number} nicht möglich: ${errorText(e)}`);
      this.saveCallbacks([...(this.cfg.callbacks ?? []), due]);
    }
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
    // The user is on the line already: he hears it in this call, no matter which number FORGE would dial.
    if (b.type === "notify" && b.urgent && this.noteUrgent(sessionId, b.message)) return;
    if (!this.cfg.notifyNumber) return;
    let kind: NotifyKind | null = null;
    if (b.type === "turn.result") {
      const interrupted = b.isError && /interrupt|abort/i.test(`${b.subtype} ${b.text ?? ""}`);
      if (!interrupted) kind = b.isError ? "error" : "done";
    } else if (b.type === "approval.request") kind = "approval";
    else if (b.type === "error") kind = "error";
    else if (b.type === "notify" && b.urgent) kind = "notify";
    if (!kind || !this.wantsCall(kind)) return;
    this.scheduleNotify(sessionId, kind, b, this.d.timing?.notifyDelayMs ?? NOTIFY_DELAY_MS[kind]);
  }

  private wantsCall(kind: NotifyKind): boolean {
    // An urgent notify means Claude needs the user: it follows the setting for decisions.
    return this.cfg.notifyOn[kind === "notify" ? "approval" : kind];
  }

  private scheduleNotify(sessionId: string, kind: NotifyKind, body: SessionEventBody, delayMs: number) {
    const key = `${sessionId}:${kind}`;
    const prev = this.notifyTimers.get(key);
    if (prev) clearTimeout(prev);
    this.notifyTimers.set(
      key,
      setTimeout(() => {
        this.notifyTimers.delete(key);
        void this.notify(sessionId, kind, body).catch((err: unknown) => this.d.log(`Telefon: Anruf nicht möglich: ${errorText(err)}`));
      }, delayMs),
    );
  }

  /**
   * An urgent notify while the user is in a call: the conversation partner passes it on. Before the
   * PIN only that a session needs him; title and message can be confidential. False when no call is
   * talking.
   */
  private noteUrgent(sessionId: string, message: string): boolean {
    const a = this.active;
    if (!a?.answered || !a.controller) return false;
    let title: string;
    try {
      title = this.d.sessions.get(sessionId).title ?? "ohne Titel";
    } catch {
      return false;
    }
    const open = !this.cfg.requirePin || a.info.unlocked;
    a.controller.note(
      open
        ? `[FORGE: Claude Code in der Session ${this.refFor(a, sessionId)} ${asData(title)} meldet sich dringend und lässt ausrichten: ${excerptData(message, 500)} Sag es dem Anrufer bei der nächsten Gelegenheit in einem Satz.]`
        : "[FORGE: Eine Session meldet sich dringend. Sag dem Anrufer bei der nächsten Gelegenheit in einem Satz, dass eine Session ihn dringend braucht. Einzelheiten gibt es erst nach der PIN.]",
    );
    this.d.log("Telefon: dringende Meldung ins laufende Gespräch gegeben");
    return true;
  }

  private async notify(sessionId: string, kind: NotifyKind, body: SessionEventBody) {
    // Switched off in the meantime (also on the phone, with call_settings).
    if (!this.cfg.notifyNumber || !this.wantsCall(kind)) return;
    if (body.type === "notify" && this.noteUrgent(sessionId, body.message)) return;
    if (this.busy || this.registration !== "registered") {
      this.d.log(`Telefon: kein Anruf (${kind}), ${this.busy ? "die Leitung ist belegt" : "nicht an der Anlage angemeldet"}`);
      return;
    }
    const wait = (this.d.timing?.notifyCooldownMs ?? NOTIFY_COOLDOWN_MS) - (Date.now() - this.lastNotifyAt);
    if (wait > 0) {
      // Two calls in a row would be too much; this one comes when the pause is over, if it still matters then.
      this.d.log(`Telefon: Anruf (${kind}) verschoben, der letzte ist keine Minute her; neuer Versuch in ${Math.ceil(wait / 1000)} s`);
      this.scheduleNotify(sessionId, kind, body, wait);
      return;
    }
    // The user is at FORGE and sees it there; a call would only interrupt.
    if (this.d.userPresent?.()) {
      this.d.log(`Telefon: kein Rückruf (${kind}), FORGE ist im Vordergrund`);
      return;
    }
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
    /**
     * A project by name. Worktrees (agents) are named "<project> · <branch>"; one only counts when the
     * caller names its branch part, so "shop" means the project and not every agent of it.
     */
    const findProject = (name: string) => {
      const q = name.trim().toLowerCase();
      const all = this.d.projects.all().filter((p) => p.exists);
      const roots = all.filter((p) => !p.parentId);
      // Before the PIN no project names: like session titles they can be confidential.
      const known = () => (locked() ? "" : ` Vorhanden: ${roots.map((x) => x.name).join(", ")}.`);
      if (!q) throw new Error(`Welches Projekt?${known()}`);
      const exact = all.filter((x) => x.name.toLowerCase() === q);
      if (exact.length === 1) return exact[0]!;
      const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const namesBranch = (wt: (typeof all)[number]) => {
        const parent = words(all.find((p) => p.id === wt.parentId)?.name ?? "");
        const asked = parent && words(q).startsWith(parent) ? words(q).slice(parent.length).trim() : words(q);
        const own = words(wt.name);
        const branch = parent && own.startsWith(parent) ? own.slice(parent.length).trim() : own;
        return !!asked && branch.includes(asked);
      };
      const hits = exact.length ? exact : [...roots.filter((x) => x.name.toLowerCase().includes(q)), ...all.filter((x) => x.parentId && namesBranch(x))];
      if (hits.length === 1) return hits[0]!;
      const preferred = hits.filter((x) => !x.parentId);
      if (preferred.length === 1) return preferred[0]!;
      if (hits.length > 1) throw new Error(`Mehrere Projekte passen zu „${name}“${locked() ? "." : `: ${hits.map((x) => x.name).join(", ")}.`}`);
      throw new Error(`Kein Projekt „${name}“.${known()}`);
    };
    /** The project of a session (also an agent's worktree) when one is named, else the project by name. */
    const target = (projectName: string, o?: { session?: string }) => {
      if (!o?.session?.trim()) return findProject(projectName);
      const s = resolve(o.session);
      const p = this.d.projects.get(s.projectId);
      if (!p.exists) throw new Error(`Den Ordner von ${refFor(s.id)} gibt es nicht mehr.`);
      return p;
    };
    const minutesSince = (iso: string) => {
      const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
      return m < 1 ? "seit eben" : m === 1 ? "seit einer Minute" : `seit ${m} Minuten`;
    };
    const tail = (text: string, lines: number) => text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n");
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
    const removal = { projects: this.d.projects, sessions, worktrees: this.d.worktrees, devServers: this.d.devServers };
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
      details: (ref, o) =>
        run(true, async () => {
          const s = resolve(ref);
          const project = this.d.projects.get(s.projectId);
          const last = lastAnswer(db, s.id);
          const setup = [s.model ? `Modell ${s.model}` : "", s.permissionMode ? `Modus ${s.permissionMode}` : ""].filter(Boolean).join(", ");
          const kind = (taskType: string) => (/bash|shell/i.test(taskType) ? "Befehl" : /agent/i.test(taskType) ? "Subagent" : taskType);
          const tasks = [
            ...s.subagents.map((t) => `Subagent ${asData(t.description)}, ${minutesSince(t.startedAt)}${t.summary ? `, zuletzt: ${excerptData(t.summary, 200)}` : ""}`),
            ...s.background.map((t) => `Im Hintergrund: ${kind(t.taskType)} ${asData(t.description)}, ${minutesSince(t.startedAt)}${t.summary ? `, zuletzt: ${excerptData(t.summary, 200)}` : ""}`),
          ];
          const summary = o?.summary ? (await sessions.summarize(s.id)).summary : "";
          return [
            `${refFor(s.id)}: ${asData(s.title ?? "ohne Titel")} im Projekt ${project.name}, ${statusText(s)}.${setup ? ` ${setup}.` : ""}`,
            summary ? `Zusammenfassung des Verlaufs: ${excerptData(summary, 2000)}` : "",
            `Letztes Ergebnis: ${last ? excerptData(last, 1500) : "noch keins"}`,
            s.status === "waiting_approval" ? `Offen: ${pendingText(db, s.id)}` : "",
            tasks.length ? `Laufende Aufgaben:\n${tasks.join("\n")}` : "",
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
          const effort = o?.effort;
          if (!o?.agent) {
            const s = await sessions.start({ projectId: found.id, prompt, model, effort, planOnly: o?.planOnly });
            a.focus = s.id;
            return `Neue Session ${refFor(s.id)} im Projekt ${found.name} gestartet.`;
          }
          // A parallel agent: own worktree and branch next to the project (as in the Agents tab), from
          // where the named project or worktree stands.
          const root = found.parentId ? this.d.projects.get(found.parentId) : found;
          const branch = `agent/${slugify(prompt, 32)}-${Date.now().toString(36).slice(-4)}`;
          const wt = await this.d.worktrees.create(this.d.projects.requireExisting(root.id), branch, { fromDir: found.path });
          projectChanged(wt.id);
          let s;
          try {
            s = await sessions.start({ projectId: wt.id, prompt, model, effort, planOnly: o?.planOnly });
          } catch (e) {
            // Nothing was done in it yet: an empty worktree and branch would only be left to clean up by hand.
            await removeWorktree(wt.id, true, removal, { deleteBranch: true }).catch((err: unknown) => this.d.log(`Telefon: Worktree ${wt.name} nicht entfernt: ${errorText(err)}`));
            projectChanged(root.id);
            throw e;
          }
          a.focus = s.id;
          return `Agent ${refFor(s.id)} im Projekt ${root.name} gestartet, in einem eigenen Worktree auf eigenem Branch.`;
        }),
      respond: (ref, decision, answers, feedback, scope) =>
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
          // Questions and plans are answered once; only a tool approval can hold for the whole session.
          const forSession = scope === "session" && decision === "allow" && req.toolName !== "AskUserQuestion" && req.toolName !== "ExitPlanMode";
          sessions.respondApproval(s.id, req.requestId, decision, forSession ? "session" : "once", feedback, mapped);
          if (decision !== "allow") return `Abgelehnt, ${r} bekommt die Rückmeldung.`;
          return forSession ? `Erledigt, ${req.toolName} ist für den Rest von ${r} erlaubt.` : `Erledigt, ${r} arbeitet weiter.`;
        }),
      stop: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          if (!["starting", "running", "waiting_approval", "stopping"].includes(s.status)) return `${refFor(s.id)} arbeitet gerade nicht, da lief nichts zum Stoppen.`;
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
      backgroundTask: (ref, action, task) =>
        run(true, async () => {
          const s = resolve(ref);
          const r = refFor(s.id);
          const all = [
            ...s.background.map((t) => ({ taskId: t.taskId, toolUseId: t.toolUseId, description: t.description, background: true, command: /bash|shell/i.test(t.taskType) })),
            ...s.subagents.map((t) => ({ taskId: t.taskId, toolUseId: t.toolUseId, description: t.description, background: false, command: false })),
          ];
          const names = (list: typeof all) => list.map((t) => asData(t.description)).join(", ");
          const find = () => {
            if (!all.length) throw new Error(`${r} hat gerade keine Hintergrund-Aufgaben und keine Subagenten.`);
            const q = (task ?? "").trim().toLowerCase();
            if (!q && all.length === 1) return all[0]!;
            if (!q) throw new Error(`Welche Aufgabe? Laufend: ${names(all)}.`);
            const hits = all.filter((t) => t.taskId.toLowerCase() === q || t.description.toLowerCase().includes(q));
            if (hits.length === 1) return hits[0]!;
            throw new Error(hits.length ? `Mehrere Aufgaben passen: ${names(hits)}.` : `Keine Aufgabe „${task}“ bei ${r}. Laufend: ${names(all)}.`);
          };
          if (action === "to_background") {
            const t = task?.trim() ? find() : null;
            if (t?.background) return `${asData(t.description)} läuft schon im Hintergrund.`;
            const { moved } = await sessions.toBackground(s.id, t?.toolUseId ?? undefined);
            return moved ? `In den Hintergrund verschoben, ${r} arbeitet weiter.` : `Bei ${r} lief nichts im Vordergrund, das sich verschieben ließ.`;
          }
          const t = find();
          if (action === "stop") {
            await sessions.stopTask(s.id, t.taskId);
            return `${asData(t.description)} gestoppt, der Rest von ${r} läuft weiter.`;
          }
          if (!t.command) return `Eine Ausgabe gibt es nur für Befehle im Hintergrund. Was ${asData(t.description)} macht, steht in details.`;
          const out = await sessions.taskOutput(s.id, t.taskId);
          if (!out.output.trim()) return `${asData(t.description)} hat noch nichts ausgegeben.`;
          return `Letzte Ausgabe von ${asData(t.description)}: ${excerptData(tail(out.output, 30), 3000)}`;
        }),
      alwaysOnTop: (action) =>
        run(action !== "status", async () => {
          if (action !== "status") {
            const next = this.d.db.updateSettings({ alwaysOnTop: action === "on" });
            // The main window applies it to every FORGE window.
            this.d.emit({ event: "settings.updated", payload: next });
          }
          return this.d.db.getSettings().alwaysOnTop ? "FORGE bleibt im Vordergrund." : "FORGE bleibt nicht im Vordergrund.";
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
      devServer: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const dev = this.d.devServers;
          if (action === "output") {
            const out = dev.output(p.id);
            return out.trim() ? `Letzte Ausgabe des Dev-Servers von ${p.name}: ${excerptData(tail(out, 30), 3000)}` : `Der Dev-Server von ${p.name} hat noch nichts ausgegeben.`;
          }
          if (action === "stop" || action === "restart") await dev.stop(p.id);
          if (action === "stop") return `Dev-Server von ${p.name} gestoppt.`;
          const st = action === "status" ? await dev.state(p.id) : await dev.start(p.id);
          if (st.status === "running") return `Dev-Server von ${p.name} ${action === "restart" ? "neu gestartet" : "läuft"}.`;
          const why = st.error ?? (st.exitCode !== null ? `Exit-Code ${st.exitCode}` : "");
          const hint = " Was er ausgegeben hat, liefert dev_server mit output.";
          if (action !== "status") return `Fehler: Der Dev-Server von ${p.name} ist nicht gestartet.${why ? ` ${why}.` : ""}${hint}`;
          return st.status === "stopped" ? `Dev-Server von ${p.name} läuft nicht.` : `Dev-Server von ${p.name} ist beendet.${why ? ` ${why}.` : ""}${hint}`;
        }),
      testDatabase: (projectName, action, o) =>
        // A session named before the PIN would give its title away in errors.
        run(action !== "status" || !!o?.session?.trim(), async () => {
          const p = target(projectName, o);
          const db = this.d.testDb;
          if (!db) return "Fehler: Die Test-Datenbank ist hier nicht verfügbar.";
          if (action === "status") {
            const st = db.state(p.id);
            if (st.status === "running") return `Die Test-Datenbank von ${p.name} läuft.`;
            if (st.status === "installing") return `PostgreSQL für die Test-Datenbank wird gerade heruntergeladen${st.progress !== null ? `, ${Math.round(st.progress * 100)} Prozent` : ""}.`;
            if (st.status === "starting") return `Die Test-Datenbank von ${p.name} startet gerade.`;
            if (st.status === "stopping") return `Die Test-Datenbank von ${p.name} wird gerade gestoppt.`;
            if (st.status === "failed") return `Die Test-Datenbank von ${p.name} ist nicht gestartet: ${st.error ?? "unbekannter Fehler"}`;
            return st.initialized ? `Die Test-Datenbank von ${p.name} ist gestoppt.` : `${p.name} hat noch keine Test-Datenbank. Der erste Start legt sie an.`;
          }
          if (action === "log") {
            const log = db.log(p.id);
            return log.trim() ? `Letzte Zeilen aus dem Protokoll der Test-Datenbank von ${p.name}: ${excerptData(tail(log, 20), 2500)}` : `Das Protokoll der Test-Datenbank von ${p.name} ist leer.`;
          }
          if (action === "stop") {
            await db.stop(p.id);
            return `Test-Datenbank von ${p.name} gestoppt.`;
          }
          if (action === "reset") {
            const wasRunning = db.isRunning(p.id);
            await db.reset(p.id);
            if (wasRunning) await db.start(p.id);
            return `Test-Datenbank von ${p.name} geleert${wasRunning ? " und wieder gestartet" : ""}.`;
          }
          if (action === "restart") {
            await db.stop(p.id);
            await db.start(p.id);
            return `Test-Datenbank von ${p.name} neu gestartet.`;
          }
          await db.start(p.id);
          return `Test-Datenbank von ${p.name} läuft.`;
        }),
      devSettings: (projectName, patch, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const tools = this.d.devTools;
          if (!tools) return "Fehler: Die Dev-Werkzeuge sind hier nicht verfügbar.";
          const database = {
            ...(patch.withDevServer !== undefined ? { withDevServer: patch.withDevServer } : {}),
            ...(patch.port !== undefined ? { port: patch.port } : {}),
            ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
            ...(patch.envVar !== undefined ? { envVar: patch.envVar.trim() || null } : {}),
          };
          const changed = patch.useEnv !== undefined || Object.keys(database).length > 0;
          let cfg;
          try {
            cfg = changed ? tools.update(p.id, { useEnv: patch.useEnv, database }) : tools.get(p.id);
          } catch (e) {
            if (e instanceof ZodError) throw new Error(e.issues.map((i) => i.message).join("; "));
            throw e;
          }
          const d = cfg.database;
          const text = [
            `Test-Umgebung ${cfg.useEnv ? "geht an Dev-Server und Tests" : "ist aus"}.`,
            `Test-Datenbank auf Port ${d.port}, Name ${d.name}, ${d.withDevServer ? "startet mit dem Dev-Server" : "startet nicht mit dem Dev-Server"}, Verbindungs-URL ${d.envVar ? `in ${d.envVar}` : "wird nicht übergeben"}.`,
          ].join(" ");
          if (!changed) return `${p.name}: ${text}`;
          const restart = (patch.port !== undefined || !!patch.name?.trim()) && this.d.testDb?.isRunning(p.id) ? " Port und Name gelten ab dem nächsten Start der Datenbank." : "";
          // Agents share their project's settings and test database.
          return `Gespeichert${p.parentId ? " für das ganze Projekt samt Agenten" : ""}. ${text}${restart}`;
        }),
      knowledge: (projectName, query, id, remove) =>
        run(true, async () => {
          const p = findProject(projectName);
          const store = this.d.knowledge;
          if (!store) return "Fehler: Das Projektwissen ist hier nicht verfügbar.";
          if (remove) {
            const key = id?.trim();
            if (!key) return "Fehler: Zum Löschen brauche ich die Kennung des Eintrags (id).";
            return (await store.delete(p.id, key)) ? `Eintrag ${key} aus dem Projektwissen von ${p.name} gelöscht.` : `Fehler: Im Projektwissen von ${p.name} gibt es keinen Eintrag ${key}.`;
          }
          if (id?.trim()) {
            const e = await store.read(p.id, id.trim());
            return asData(`${e.title}. ${e.summary}\n${e.content.slice(0, 4000)}`);
          }
          const hits = store.search(p.id, query, 5);
          if (!hits.length) return store.list(p.id).length ? `Im Projektwissen von ${p.name} steht dazu nichts.` : `${p.name} hat noch kein Projektwissen.`;
          return asData(hits.map((h) => `${h.id}: ${h.title}. ${h.summary} ${h.snippet}`).join("\n"));
        }),
      rememberNote: (projectName, title, text) =>
        run(true, async () => {
          const p = findProject(projectName);
          const store = this.d.knowledge;
          if (!store) return "Fehler: Das Projektwissen ist hier nicht verfügbar.";
          const note = text.trim();
          if (!note) return "Fehler: Die Notiz ist leer.";
          const stamp = new Date().toLocaleDateString("de-DE");
          const near = store.similar(p.id, title)[0];
          if (near) {
            const e = await store.read(p.id, near.id);
            await store.save(p.id, { id: e.id, title: e.title, summary: e.summary, tags: e.tags, content: `${e.content.trimEnd()}\n\nNotiz vom Telefon (${stamp}): ${note}\n` });
            return `Notiz bei „${e.title}“ ergänzt.`;
          }
          const e = await store.save(p.id, { id: null, title: title.trim() || "Notiz", summary: note.length > 160 ? `${note.slice(0, 157)}...` : note, tags: ["telefon"], content: `Notiz vom Telefon (${stamp}): ${note}\n` });
          return `Notiz „${e.title}“ im Projektwissen von ${p.name} abgelegt.`;
        }),
      git: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const git = this.d.git;
          if (action === "status") {
            const { summary: s } = await git.status(p.path);
            const sync = [s.ahead ? `${s.ahead} Commits nicht gepusht` : "", s.behind ? `${s.behind} Commits auf dem Server neuer` : ""].filter(Boolean);
            const parts = [`Branch ${s.branch ?? "keiner (detached)"}`, s.changedCount ? `${s.changedCount} geänderte Dateien` : "keine Änderungen", ...sync, s.conflicted ? "es gibt Konflikte" : ""];
            return `${p.name}: ${parts.filter(Boolean).join(", ")}.`;
          }
          if (action === "log") {
            const commits = await git.log(p.path, 5);
            if (!commits.length) return `${p.name} hat noch keine Commits.`;
            const when = (iso: string) => new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
            return `Letzte Commits in ${p.name}:\n${commits.map((c) => `${asData(`${c.subject} (${c.author})`)} am ${when(c.date)}`).join("\n")}`;
          }
          if (action === "checkout") {
            const branch = o?.branch?.trim();
            if (!branch) return "Fehler: Auf welchen Branch? Bitte branch angeben.";
            const busy = sessions.listAll().some((x) => x.projectId === p.id && x.live && (x.status === "running" || x.status === "waiting_approval"));
            if (busy) return `Fehler: In ${p.name} arbeitet gerade eine Session. Erst stoppen, dann Branch wechseln.`;
            await git.checkout(p.path, branch, o?.create === true);
            projectChanged(p.id);
            return `${p.name} ist jetzt auf Branch ${branch}${o?.create ? ", neu angelegt" : ""}.`;
          }
          /** origin's commits did not go in automatically: Claude takes over, as in the Git tab */
          const handOver = async (e: unknown, push: boolean) => {
            const s = await startIntegrationSession(sessions, p.id, e, push);
            if (!s) throw e;
            projectChanged(p.id);
            a.focus = s.id;
            return `Die neuen Commits vom Server ließen sich nicht automatisch mit den eigenen zusammenführen. Claude führt sie in der neuen Session ${refFor(s.id)} zusammen${push ? " und pusht danach" : ""}.`;
          };
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
            let r: Awaited<ReturnType<GitEngine["push"]>>;
            try {
              r = await git.push(p.path, o?.allowProtected === true);
            } catch (e) {
              return handOver(e, true);
            }
            projectChanged(p.id);
            const took = r.integrated ? ` Vorher ${r.integrated.remoteCommits} neue Commits vom Server übernommen.` : "";
            return `Branch ${r.branch} von ${p.name} gepusht.${took}`;
          }
          let r: Awaited<ReturnType<GitEngine["pull"]>>;
          try {
            r = await git.pull(p.path);
          } catch (e) {
            return handOver(e, false);
          }
          projectChanged(p.id);
          return `${p.name}: ${r.output}`;
        }),
      pullRequest: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const gh = this.d.github;
          if (!gh) return "Fehler: GitHub ist hier nicht verfügbar.";
          const git = this.d.git;
          const head = await git.currentBranch(p.path);
          if (!head) return `Fehler: In ${p.name} ist kein Branch ausgecheckt.`;
          const pr = await gh.prForBranch(p.path);
          if (action === "status") {
            if (!pr) return `Für den Branch ${head} gibt es keinen Pull Request.`;
            const state = pr.state === "OPEN" ? (pr.draft ? "offen, als Entwurf" : "offen") : pr.state === "MERGED" ? "gemergt" : pr.state === "CLOSED" ? "geschlossen" : pr.state;
            const c = pr.checks;
            const checks = !c.total
              ? "keine CI-Checks"
              : c.failed
                ? `${c.failed} von ${c.total} Checks fehlgeschlagen`
                : c.pending
                  ? `${c.pending} von ${c.total} Checks laufen noch`
                  : `alle ${c.total} Checks grün`;
            const review =
              pr.reviewDecision === "APPROVED" ? ", im Review freigegeben" : pr.reviewDecision === "CHANGES_REQUESTED" ? ", im Review wurden Änderungen verlangt" : pr.reviewDecision === "REVIEW_REQUIRED" ? ", Review steht aus" : "";
            return `Pull Request ${pr.number} ${asData(pr.title)} von ${pr.head} nach ${pr.base}: ${state}, ${checks}${review}.`;
          }
          if (pr?.state === "OPEN") return `Für den Branch ${head} gibt es schon den offenen Pull Request ${pr.number} ${asData(pr.title)}.`;
          const base = await git.defaultBranch(p.path);
          if (head === base) return `Fehler: ${p.name} ist auf ${base}. Ein Pull Request braucht einen eigenen Branch.`;
          const draft = await sessions.suggestPullRequest(p.id);
          // The PR needs the branch on GitHub; pushing a feature branch is always allowed.
          await git.push(p.path, false);
          await gh.createPr(p.path, { title: draft.title, body: draft.body, base: draft.base, head: draft.head, draft: o?.draft === true });
          projectChanged(p.id);
          return `Pull Request ${asData(draft.title)} von ${draft.head} nach ${draft.base} angelegt${o?.draft ? ", als Entwurf" : ""}.`;
        }),
      removeAgent: (projectName, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          if (!p.parentId) return `Fehler: ${p.name} ist kein Agent-Worktree. Projekte lassen sich nur in FORGE entfernen.`;
          const r = await removeWorktree(p.id, o?.force === true, removal, { deleteBranch: o?.deleteBranch === true });
          projectChanged(p.parentId);
          const branch = r.deletedBranch
            ? ` Branch ${r.deletedBranch} gelöscht.`
            : r.branchError
              ? ` Der Branch ließ sich nicht löschen: ${r.branchError}`
              : " Der Branch mit seinen Commits bleibt.";
          return `Worktree ${p.name} entfernt, seine Session ist beendet.${branch}`;
        }),
      projects: () =>
        run(true, async () => {
          const all = this.d.projects.all().filter((p) => p.exists);
          if (!all.length) return "Es gibt keine Projekte.";
          const live = sessions.listLive();
          const lines = await Promise.all(
            all.map(async (p) => {
              const n = live.filter((s) => s.projectId === p.id).length;
              const branch = await this.d.git.currentBranch(p.path).catch(() => null);
              const dev = await this.d.devServers.state(p.id).then(
                (st) => st.status === "running",
                () => false,
              );
              return [p.name, branch ? `Branch ${branch}` : "", dev ? "Dev-Server läuft" : "", n ? `${n} aktive ${n === 1 ? "Session" : "Sessions"}` : ""].filter(Boolean).join(", ");
            }),
          );
          return lines.join("\n");
        }),
      search: (query) =>
        run(true, async () => {
          if (!query.trim()) return "Fehler: Wonach soll ich suchen?";
          const lines: string[] = [];
          const seen = new Set<string>();
          // One line per session, its best hit first.
          for (const h of db.searchEvents(query, 30)) {
            if (seen.has(h.sessionId) || lines.length >= 5) continue;
            seen.add(h.sessionId);
            const snippet = h.snippet.split(SEARCH_MARK_START).join("").split(SEARCH_MARK_END).join("");
            lines.push(`${refFor(h.sessionId)} ${asData(h.sessionTitle ?? "ohne Titel")} im Projekt ${h.projectName}: ${excerptData(snippet, 300)}`);
          }
          return lines.length ? lines.join("\n") : "Dazu steht in keiner Session etwas.";
        }),
      callSettings: (patch) =>
        run(Object.values(patch).some((v) => v !== undefined), async () => {
          const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as CallSettingsPatch;
          if (Object.keys(changes).length) await this.saveConfig({ notifyOn: { ...this.cfg.notifyOn, ...changes } });
          if (!this.cfg.notifyNumber) return "FORGE ruft von sich aus nicht an: In den Einstellungen ist keine Nummer dafür eingetragen.";
          const on = this.cfg.notifyOn;
          const list = [on.done ? "wenn eine Session fertig ist" : "", on.approval ? "wenn eine Entscheidung nötig ist oder Claude dringend etwas meldet" : "", on.error ? "bei Fehlern" : ""].filter(Boolean);
          return list.length ? `FORGE ruft an: ${list.join(", ")}.` : "FORGE ruft von sich aus nicht mehr an.";
        }),
      callBack: (minutes, about) =>
        run(false, async () => {
          if (!about.trim()) return "Fehler: Was soll ich beim Rückruf sagen?";
          // Back to the number of this call; only numbers FORGE may talk to anyway.
          const number = a.call.remoteNumber;
          const known = this.cfg.allowedCallers.some((n) => sameNumber(n, number)) || (this.cfg.notifyNumber && sameNumber(this.cfg.notifyNumber, number));
          const target = known ? number : this.cfg.notifyNumber;
          if (!target) return "Fehler: Für diese Nummer kann ich keinen Rückruf vereinbaren.";
          const due = this.scheduleCallback(target, minutes, about);
          return `Rückruf vereinbart für ${due.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr.`;
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
