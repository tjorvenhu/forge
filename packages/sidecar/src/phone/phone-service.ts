import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  ForgeError,
  GIT_TAGS,
  matchingFiles,
  SEARCH_MARK_END,
  SEARCH_MARK_START,
  BackupPart,
  fillTemplate,
  findTemplates,
  knownTemplateValues,
  templatePlaceholders,
  type DeskPhoneConfig,
  type MethodName,
  type ParamsOf,
  type PhoneCallInfo,
  type PhoneCallRecord,
  type PhoneConfig,
  type PhoneNumberEntry,
  type PhoneEngine,
  type PhoneSetupIncomplete,
  type PhoneState,
  type Project,
  type PromptTemplate,
  type ResultOf,
  type ServerEvent,
  type SessionEventBody,
  type Settings,
  type UsageWindow,
} from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import { limitWarning } from "../claude/usage.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionService } from "../sessions/session-service.js";
import type { DevServerService } from "../devserver/dev-server.js";
import type { TestDbService } from "../devtools/test-db.js";
import type { DevToolsService } from "../devtools/dev-tools.js";
import type { KnowledgeStore } from "../knowledge/knowledge.js";
import type { GitHubService } from "../github/github.js";
import { removeWorktree } from "../projects/removal.js";
import { slugify, type WorktreeService } from "../automation/worktrees.js";
import type { AgentFinisher } from "../automation/agent-finish.js";
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
import { localIpTowards, SipUserAgent, type PhoneCall, type SipAccount, type SipCall } from "./sip-ua.js";
import { ForkedCall } from "./forked-call.js";
import {
  AUTOMATION_TAGS,
  geminiFunctionDeclarations,
  phoneSystemPrompt,
  POLICY_RULE_LABELS,
  type AutomationTag,
  type CallSettingsPatch,
  type ForgeSettingsPatch,
} from "./tools.js";
import { AUTO_MERGE_TAG } from "../automation/agent-auto-merge.js";
import { localDate, reportText } from "../reports/daily-report.js";
import { tokenMeter } from "../claude/token-meter.js";
import { DEFAULT_STT_MODEL, DEFAULT_TTS_MODEL, DEFAULT_VOICE, OpenAiVoice, type VoiceProvider } from "./voice.js";

/** longest daily report handed to the conversation partner */
const REPORT_MAX = 6000;

const SECRET_PASSWORD = "sip-password";
const SECRET_OPENAI = "openai-key";
const SECRET_GEMINI = "gemini-key";
const SECRET_DESK = "desk-password";
export const DEFAULT_DESK_PORT = 8766;
/** Claude on the phone: fast replies matter more than depth. */
const PHONE_MODEL = "haiku";
/** Groups merged at once when Claude tidies up the knowledge; each is its own Claude process. */
const AUTO_MERGE_PARALLEL = 3;
/** wait before calling, so a quick follow-up turn or an answer at the desk makes the call unnecessary */
const NOTIFY_DELAY_MS = { done: 5_000, error: 5_000, approval: 15_000, notify: 2_000 };
const NOTIFY_COOLDOWN_MS = 60_000;
const GREETING = "Hallo, hier ist FORGE. Was kann ich für dich tun?";
/** numbers in national notation (030 ...) belong to this country */
export const DEFAULT_COUNTRY_CODE = "49";
const SHUTDOWN_TIMEOUT_MS = 4000;

/** A FORGE RPC method as the UI calls it: same checks, defaults and side effects as in the app. */
export type PhoneRpc = <M extends MethodName>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>;

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
  allowedCallers: PhoneNumberEntry[];
  notifyNumbers: PhoneNumberEntry[];
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
  notifyNumbers: [],
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
  devTools?: Pick<DevToolsService, "get" | "update" | "envFiles" | "readEnvFile">;
  knowledge?: KnowledgeStore;
  /** pull requests; without it pull_request is not available */
  github?: Pick<GitHubService, "prForBranch" | "createPr">;
  git: GitEngine;
  worktrees: WorktreeService;
  /** merges or discards agents; without it finish_agent is not available */
  agentFinish?: Pick<AgentFinisher, "finish">;
  secrets: SecretStore;
  /** the rest of FORGE (projects, settings, extensions, backups, updates ...); without it those tools are not available */
  rpc?: PhoneRpc;
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
  call: PhoneCall;
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
  /** an irreversible deletion waiting for the caller to type its code on the keypad */
  confirm: PendingConfirm | null;
}

/**
 * Deleting a folder or a GitHub repository runs only after the caller typed a code on the keypad.
 * The model can misunderstand ("delete the remote branch" -> the repository) or be talked into it;
 * keypad digits never go through it.
 */
interface PendingConfirm {
  code: string;
  entered: string;
  expiresAt: number;
  run(): Promise<string>;
}

const CONFIRM_TTL_MS = 2 * 60_000;

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

/** The numbers of a list that count: switched on and not empty. */
export function activeNumbers(list: PhoneNumberEntry[]): string[] {
  return list.filter((n) => n.enabled && n.number.trim()).map((n) => n.number.trim());
}

/** Several numbers ring on one RTP port; this long only the answering one may send audio (early media of the others). */
const FORKED_EXACT_LATCH_MS = 400;

/** "Angerufen wird: Handy 0172 1, Büro 030 2 (aus)." for call_settings. */
function numberListing(what: string, list: PhoneNumberEntry[]): string {
  if (!list.length) return `${what}: keine Nummer eingetragen.`;
  const one = (n: PhoneNumberEntry) => [n.label, n.number].filter(Boolean).join(" ") + (n.enabled ? "" : " (aus)");
  return `${what}: ${asData(list.map(one).join(", "))}.`;
}

type LegacyNumbers = { notifyNumber?: string | null; allowedCallers?: Array<string | PhoneNumberEntry>; notifyNumbers?: PhoneNumberEntry[] };

/** Stored settings with defaults; settings from before the number lists become entries that are switched on. */
function loadConfig(raw: Partial<StoredConfig>): StoredConfig {
  const { notifyNumber, allowedCallers, notifyNumbers, ...stored } = raw as Partial<StoredConfig> & LegacyNumbers;
  const entry = (n: string | PhoneNumberEntry): PhoneNumberEntry => (typeof n === "string" ? { id: randomUUID(), number: n, label: "", enabled: true } : n);
  return {
    ...DEFAULTS,
    ...stored,
    desk: { ...DEFAULT_DESK, ...stored.desk },
    allowedCallers: (allowedCallers ?? []).map(entry),
    notifyNumbers: notifyNumbers ?? (notifyNumber?.trim() ? [entry(notifyNumber.trim())] : []),
  };
}

/** Trimmed, without empty numbers, every id once. */
function cleanNumbers(list: PhoneNumberEntry[]): PhoneNumberEntry[] {
  const ids = new Set<string>();
  return list
    .map((n) => ({ ...n, number: n.number.trim(), label: n.label.trim() }))
    .filter((n) => n.number)
    .map((n) => {
      const id = ids.has(n.id) ? randomUUID() : n.id;
      ids.add(id);
      return { ...n, id };
    });
}

/** A reset time as it is said on the phone: "um 14:30" today, else with the weekday. */
function spokenTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `heute um ${time}`;
  return `${d.toLocaleDateString("de-DE", { weekday: "long" })} um ${time}`;
}

/** The limit forecast of a usage window as said on the phone ("Reicht mein Limit noch?"). */
export function spokenForecast(w: UsageWindow): string {
  const f = w.forecast;
  if (!f) return "Prognose: noch zu wenig Messwerte oder kein Anstieg.";
  if (f.outcome === "limit" && f.limitAt) return `Bei diesem Tempo ist das Limit ${spokenTime(f.limitAt)} erreicht, vor dem Reset.`;
  return "Bei diesem Tempo reicht es bis zum Reset.";
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

/** "" and "default" clear a setting, so it falls back to the global one */
function clearable(v: string): string | null {
  const t = v.trim();
  return !t || t.toLowerCase() === "default" ? null : t;
}

/**
 * One match by exact value, else by a part of it; several or none is an error naming the candidates.
 * `what`: e.g. { none: "Kein Skill", many: "Skills" }; the first key is the name that is said.
 */
function pickOne<T>(items: T[], query: string, keys: (x: T) => string[], what: { none: string; many: string }): T {
  const q = query.trim().toLowerCase();
  const exact = items.filter((x) => keys(x).some((k) => k.toLowerCase() === q));
  const hits = exact.length ? exact : items.filter((x) => keys(x).some((k) => k.toLowerCase().includes(q)));
  if (q && hits.length === 1) return hits[0]!;
  const names = (xs: T[]) => xs.slice(0, 6).map((x) => keys(x)[0]).join(", ");
  if (q && hits.length > 1) throw new Error(`Mehrere ${what.many} passen zu „${query}“: ${asData(names(hits))}.`);
  const known = items.length ? ` Vorhanden: ${asData(names(items))}${items.length > 6 ? " und weitere" : ""}.` : "";
  throw new Error(q ? `${what.none} „${query}“.${known}` : `Welche? Bitte den Namen nennen.${known}`);
}

/** A spoken GitHub organisation ("vanturis") against the account's organisations; nothing spoken or the account itself: the personal account. */
async function resolveOwner(call: PhoneRpc, spoken: string | undefined): Promise<string | null> {
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const q = plain(spoken ?? "");
  if (!q) return null;
  const acc = await call("github.account", {});
  if (acc && plain(acc.login) === q) return null;
  const orgs = await call("github.orgs", {});
  return pickOne(orgs, q, (o) => [o.login, plain(o.login)], { none: "Keine GitHub-Organisation", many: "GitHub-Organisationen" }).login;
}

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function envNames(text: string): string[] {
  return text.split(/\r?\n/).flatMap((l) => {
    const m = ENV_LINE.exec(l);
    return m ? [m[1]!] : [];
  });
}

/** Sets a variable in .env text: replaces its line or appends one. */
function setEnvLine(text: string, name: string, line: string): string {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => ENV_LINE.exec(l)?.[1] === name);
  if (i >= 0) lines[i] = line;
  else {
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

function removeEnvLine(text: string, name: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => ENV_LINE.exec(l)?.[1] !== name)
    .join("\n");
}

type SessionsArgs = Parameters<PhoneToolset["sessions"]>;
const BACKUP_PARTS: Record<BackupPart, string> = { settings: "Einstellungen", projects: "Projekte", phone: "Telefon", claude: "Claude-Konfiguration", git: "Git-Identität", templates: "Vorlagen" };
const BACKUP_REASONS = { start: "beim Start", manual: "von Hand", "before-restore": "vor einer Wiederherstellung", import: "importiert" } as const;

/** A global setting as said on the phone. */
function settingText(s: Settings, key: keyof ForgeSettingsPatch | "alwaysOnTop"): string {
  const on = (v: boolean) => (v ? "an" : "aus");
  switch (key) {
    case "defaultModel":
      return `Standardmodell ${s.defaultModel ?? "von Claude Code"}`;
    case "defaultEffort":
      return `Denkaufwand ${s.defaultEffort ?? "von Claude Code"}`;
    case "defaultProfile":
      return `Profil neuer Projekte ${s.defaultProfile}`;
    case "defaultProjectDir":
      return s.defaultProjectDir ? `neue Projekte kommen nach ${asData(s.defaultProjectDir)}` : "kein Ordner für neue Projekte";
    case "sounds":
      return `Töne ${on(s.sounds)}`;
    case "desktopNotifications":
      return `Desktop-Benachrichtigungen ${on(s.desktopNotifications)}`;
    case "enterToSend":
      return s.enterToSend ? "Enter sendet" : "Enter macht eine neue Zeile";
    case "autoContinueAfterLimit":
      return `automatisch weitermachen nach einem Limit ${on(s.autoContinueAfterLimit)}`;
    case "idleCloseMinutes":
      return s.idleCloseMinutes > 0 ? `untätige Claude-Prozesse schließen nach ${s.idleCloseMinutes} Minuten` : "untätige Claude-Prozesse bleiben offen";
    case "updateChecks":
      return `Update-Prüfung ${on(s.updateChecks)}`;
    case "debugLogs":
      return `Debug-Logs ${on(s.debugLogs)}`;
    case "stripApiKey":
      return s.stripApiKey ? "ein API-Key aus der Umgebung geht nicht an Claude Code" : "ein API-Key aus der Umgebung geht an Claude Code";
    case "screenshotKey":
      return s.screenshotKey ? "die Druck-Taste öffnet das Snipping-Tool von FORGE" : "die Druck-Taste bleibt bei Windows";
    case "uiCompare":
      return `Vorher-Nachher-Bilder bei UI-Änderungen ${on(s.uiCompare)}`;
    case "alwaysOnTop":
      return `im Vordergrund bleiben ${on(s.alwaysOnTop)}`;
    case "policyRule":
    case "policyRuleOn":
      return s.disabledPolicyRules.length ? `Sperrliste: aus sind ${s.disabledPolicyRules.map((r) => POLICY_RULE_LABELS[r]).join(", ")}` : "Sperrliste: alle Regeln an";
  }
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
  /** last successful turn per session: its answer is what the "done" call tells */
  private readonly lastTurn = new Map<string, SessionEventBody>();
  private callbackTicker: ReturnType<typeof setInterval> | null = null;
  private lastNotifyAt = 0;
  private readonly f: PhoneFactories;
  private readonly pinGuard: PinGuard;
  private readonly desk: DeskPhone;

  constructor(private readonly d: PhoneDeps) {
    this.cfg = loadConfig(d.db.getPhoneSettings() as Partial<StoredConfig>);
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
    this.cfg = loadConfig(this.d.db.getPhoneSettings() as Partial<StoredConfig>);
    this.emitState();
    await this.init();
  }

  private persist() {
    this.d.db.setPhoneSettings(this.cfg as unknown as Record<string, unknown>);
  }

  /**
   * The settings other computers get through the sync. Whether the line and the desk phone run stays
   * with each computer (two registrations would ring both), as do the desk token, PIN failures and
   * agreed callbacks (they would ring twice). Null before anything was set up.
   */
  syncConfig(): Record<string, unknown> | null {
    const raw = this.d.db.getPhoneSettings();
    if (!Object.keys(raw).length) return null;
    const { enabled: _enabled, deskToken: _token, pinGuard: _guard, callbacks: _callbacks, desk, ...rest } = this.cfg;
    const { enabled: _deskEnabled, ...deskRest } = desk;
    return { ...rest, desk: deskRest };
  }

  /** Takes over settings from the sync, keeps the parts of this computer and reconnects. Refuses during a call. */
  async applySyncConfig(synced: Record<string, unknown>) {
    if (this.busy) throw new Error("FORGE telefoniert gerade; die Telefon-Einstellungen kommen beim nächsten Abgleich.");
    const cur = this.cfg;
    const desk = { ...cur.desk, ...((synced.desk as Partial<StoredDesk> | undefined) ?? {}), enabled: cur.desk.enabled };
    this.d.db.setPhoneSettings({ ...cur, ...synced, desk, enabled: cur.enabled, deskToken: cur.deskToken, pinGuard: cur.pinGuard, callbacks: cur.callbacks });
    await this.reload();
  }

  /** Secrets read again after the sync changed them; reconnects like a restore. */
  async secretsChanged() {
    if (!this.cfg.enabled) return;
    // During a call the new secrets take effect when it ends.
    if (this.busy) this.pendingReconnect = true;
    else await this.reconnect();
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
    next.allowedCallers = cleanNumbers(next.allowedCallers);
    next.notifyNumbers = cleanNumbers(next.notifyNumbers);
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

  /** The session the running call is about, if any. */
  callFocus(): string | null {
    return this.active?.focus ?? null;
  }

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
    for (const c of expired) this.d.log(`Telefon: Rückruf an ${c.number || "die Benachrichtigungsnummern"} verfallen (${c.about})`);
    const live = list.filter((c) => !expired.includes(c));
    if (expired.length) this.saveCallbacks(live);
    const due = live.find((c) => Date.parse(c.dueAt) <= now);
    if (!due || !this.cfg.enabled || this.busy || this.registration !== "registered") return;
    this.saveCallbacks(live.filter((c) => c.id !== due.id));
    const asked = new Date(due.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    try {
      await this.dial(
        due.number ? [due.number] : this.notifyTargets(),
        `Rückruf wie verabredet: ${due.about}`,
        `[FORGE: Du rufst den Nutzer wie verabredet zurück. Um ${asked} hat er darum gebeten und wollte dann wissen: ${asData(due.about)} Prüfe das jetzt mit den Werkzeugen, nicht aus der Erinnerung. Er hat gerade abgenommen. Sag „Hallo, hier ist FORGE, wie verabredet.“ und dann in ein bis zwei Sätzen das Ergebnis. Dann warte, was er sagt.]`,
        new Map(),
        null,
      );
    } catch (e) {
      // Not reached this time (e.g. line busy a moment ago): try again on a later tick.
      this.d.log(`Telefon: Rückruf an ${due.number || "die Benachrichtigungsnummern"} nicht möglich: ${errorText(e)}`);
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
    const numbers = activeNumbers(this.cfg.notifyNumbers);
    if (!numbers.length) throw new ForgeError("VALIDATION", "Bitte zuerst in den Einstellungen unter Telefon mindestens eine Nummer eintragen und einschalten, die FORGE anrufen soll.");
    await this.dial(
      numbers,
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
  private attach(call: PhoneCall, rec: PhoneCallRecord, reason: string | null, refs: Map<string, string>, sdpSession: string, focus: string | null): ActiveCall {
    const info: PhoneCallInfo = { id: rec.id, direction: call.direction, number: call.remoteNumber, state: "ringing", startedAt: rec.startedAt, unlocked: false, reason };
    const a: ActiveCall = { call, controller: null, focus, rtp: null, info, record: rec, refs, answered: false, failure: null, sdp: { session: sdpSession, version: 1 }, confirm: null };
    call.on("answered", () => {
      a.answered = true;
      // With several numbers ringing, only now is it known which one took the call.
      info.number = call.remoteNumber;
      rec.number = call.remoteNumber;
    });
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
        : // The reason holds session titles and the words of an agreed callback: data, not instructions.
          `Du rufst ${a.call.remoteNumber} an. Anlass: ${asData(a.info.reason ?? "")}.`,
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
      // Read at entry: on a call to several numbers the answering one is known only then.
      checkPin: this.cfg.requirePin && pinHash ? (pin: string) => this.pinGuard.check(normalizeNumber(a.call.remoteNumber) || "unbekannt", () => verifyPin(pin, pinHash)) : null,
      opening,
      onTranscript: (role: "caller" | "forge", text: string) => rec.transcript.push({ role, text, ts: new Date().toISOString() }),
      onUnlock: () => {
        a.info.unlocked = true;
        this.emitState();
      },
      onDigit: (digit: string) => this.confirmDigit(a, digit),
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
    if (!activeNumbers(this.cfg.allowedCallers).some((n) => sameNumber(n, call.remoteNumber))) {
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

  /**
   * Calls the user (notifications, test call, callbacks); the first words are prepared while it rings.
   * Several numbers ring at once; the first to answer takes the call, the others are cancelled.
   */
  private async dial(numbers: string[], reason: string, opening: string, refs: Map<string, string>, focus: string | null) {
    if (this.busy) throw new ForgeError("SESSION_BUSY", "FORGE telefoniert bereits.");
    if (!numbers.length) throw new ForgeError("VALIDATION", "Keine Nummer zum Anrufen eingeschaltet.");
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
      const offer = buildSdp({ ip: ua.localIp, port: rtp.port, sessionId: session, version: 1 });
      const forked = numbers.length > 1;
      const call: PhoneCall = forked ? new ForkedCall(numbers.map((n) => ua.call(n, offer))) : ua.call(numbers[0]!, offer);
      a = this.attach(call, this.newRecord("out", call.remoteNumber, reason), reason, refs, session, focus);
      if (focus) this.desk.select(focus);
      a.rtp = rtp;
      rtp = null;
      const active = a;
      const controller = this.createController(active, speech, opening);
      call.on("answered", (body) => {
        const offer = parseSdp(body);
        if (offer && active.rtp) {
          active.rtp.configure({ ip: offer.ip, port: offer.port }, chooseCodec(offer) ?? PT_PCMA, offer.dtmfPt, [ua.serverIp], forked ? FORKED_EXACT_LATCH_MS : 0);
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
    // "Fertig" only for the whole job: a turn that leaves background tasks or agents running is a step.
    if (e.event === "session.done" && this.notifyTargets().length && this.wantsCall("done")) {
      const id = e.payload.sessionId;
      this.scheduleNotify(id, "done", this.lastTurn.get(id) ?? null, this.d.timing?.notifyDelayMs ?? NOTIFY_DELAY_MS.done);
    }
    if (e.event !== "session.event") return;
    const b = e.payload.body;
    const sessionId = e.payload.sessionId;
    if (b.type === "turn.result" && !b.isError) {
      this.desk.markUnheard(sessionId);
      this.lastTurn.set(sessionId, b);
    }
    else if (b.type === "user.message") this.desk.markHeard(sessionId);
    else if (b.type === "approval.request" || b.type === "approval.resolved") this.desk.refresh();
    // The user is on the line already: he hears it in this call, no matter which number FORGE would dial.
    if (b.type === "notify" && b.urgent && this.noteUrgent(sessionId, b.message)) return;
    if (!this.notifyTargets().length) return;
    let kind: NotifyKind | null = null;
    if (b.type === "turn.result") {
      const interrupted = b.isError && /interrupt|abort/i.test(`${b.subtype} ${b.text ?? ""}`);
      if (b.isError && !interrupted) kind = "error";
    } else if (b.type === "approval.request") kind = "approval";
    else if (b.type === "error") kind = "error";
    else if (b.type === "notify" && b.urgent) kind = "notify";
    if (!kind || !this.wantsCall(kind)) return;
    this.scheduleNotify(sessionId, kind, b, this.d.timing?.notifyDelayMs ?? NOTIFY_DELAY_MS[kind]);
  }

  /** Switches one entry of a number list on or off, adds or removes it (call_settings); returns what changed. */
  private async changeNumber(c: NonNullable<CallSettingsPatch["numbers"]>): Promise<string> {
    const key = c.list === "allowed" ? "allowedCallers" : "notifyNumbers";
    const entries = this.cfg[key];
    const q = c.number.trim();
    if (!q) throw new Error("Welche Nummer? Bitte die Nummer oder ihre Bezeichnung nennen.");
    const found = entries.filter((n) => sameNumber(n.number, q) || (n.label && n.label.toLowerCase() === q.toLowerCase()));
    const name = (n: PhoneNumberEntry) => asData(n.label ? `${n.label} (${n.number})` : n.number);
    if (c.action === "add") {
      if (!normalizeNumber(q)) throw new Error("Das ist keine Telefonnummer.");
      const hit = found[0];
      const next = hit ? entries.map((n) => (n === hit ? { ...n, enabled: true } : n)) : [...entries, { id: randomUUID(), number: q, label: c.label?.trim() ?? "", enabled: true }];
      await this.saveConfig({ [key]: next });
      return hit ? `${name(hit)} stand schon in der Liste und ist jetzt eingeschaltet. ` : `${name(next.at(-1)!)} ist eingetragen und eingeschaltet. `;
    }
    if (!found.length) throw new Error(`Keine Nummer „${q}“ in der Liste. ${numberListing("Vorhanden", entries)}`);
    if (found.length > 1) throw new Error(`Mehrere Einträge passen zu „${q}“: ${found.map(name).join(", ")}. Bitte die Nummer nennen.`);
    const hit = found[0]!;
    if (c.action === "remove") {
      await this.saveConfig({ [key]: entries.filter((n) => n !== hit) });
      return `${name(hit)} ist gelöscht. `;
    }
    const on = c.action === "on";
    await this.saveConfig({ [key]: entries.map((n) => (n === hit ? { ...n, enabled: on } : n)) });
    return `${name(hit)} ist jetzt ${on ? "eingeschaltet" : "ausgeschaltet"}. `;
  }

  /** The switched-on numbers FORGE calls; all of them ring at once. */
  private notifyTargets(): string[] {
    return activeNumbers(this.cfg.notifyNumbers);
  }

  private wantsCall(kind: NotifyKind): boolean {
    // An urgent notify means Claude needs the user: it follows the setting for decisions.
    return this.cfg.notifyOn[kind === "notify" ? "approval" : kind];
  }

  private scheduleNotify(sessionId: string, kind: NotifyKind, body: SessionEventBody | null, delayMs: number) {
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

  /** Keypad digits for a pending deletion: the code and #, * cancels. False when none is pending. */
  private confirmDigit(a: ActiveCall, digit: string): boolean {
    const c = a.confirm;
    if (!c) return false;
    // Expired: the digits still belong to the code (the PIN is long entered), the caller hears why nothing happened.
    if (Date.now() > c.expiresAt && digit === "#") {
      a.confirm = null;
      a.controller?.note("[FORGE: Der Code war abgelaufen, nichts ist geändert. Sag ihm das in einem Satz; will er es noch, ruf das Werkzeug neu auf, dann gibt es einen neuen Code.]");
      return true;
    }
    if (digit === "*") {
      a.confirm = null;
      a.controller?.note("[FORGE: Der Anrufer hat mit Stern abgebrochen. Nichts ist geändert. Sag ihm das in einem Satz.]");
      return true;
    }
    if (digit !== "#") {
      if (c.entered.length < 8) c.entered += digit;
      return true;
    }
    a.confirm = null;
    if (c.entered !== c.code) {
      this.d.log("Telefon: Löschen nicht bestätigt (falscher Code)");
      a.controller?.note("[FORGE: Der Code war falsch. Nichts ist geändert. Sag ihm das in einem Satz; will er es noch, ruf das Werkzeug neu auf, dann gibt es einen neuen Code.]");
      return true;
    }
    this.d.log("Telefon: Löschen über die Tastatur bestätigt");
    void c
      .run()
      .catch((e: unknown) => `Fehler: ${errorText(e)}`)
      .then((result) => a.controller?.note(`[FORGE: Über die Tastatur bestätigt. Ergebnis: ${result} Sag ihm das in einem Satz.]`));
    return true;
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

  private async notify(sessionId: string, kind: NotifyKind, body: SessionEventBody | null) {
    // Switched off in the meantime (also on the phone, with call_settings).
    if (!this.notifyTargets().length || !this.wantsCall(kind)) return;
    if (body?.type === "notify" && this.noteUrgent(sessionId, body.message)) return;
    if (this.busy) {
      // Another call (often the one for a session that finished a moment earlier): this one follows
      // after it, if it still matters then.
      const retry = this.d.timing?.notifyCooldownMs ?? NOTIFY_COOLDOWN_MS;
      this.d.log(`Telefon: Anruf (${kind}) verschoben, die Leitung ist belegt; neuer Versuch in ${Math.ceil(retry / 1000)} s`);
      this.scheduleNotify(sessionId, kind, body, retry);
      return;
    }
    if (this.registration !== "registered") {
      this.d.log(`Telefon: kein Anruf (${kind}), nicht an der Anlage angemeldet`);
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
    const result = body?.type === "turn.result" ? (body.text ?? lastAnswer(this.d.db, sessionId)) : lastAnswer(this.d.db, sessionId);
    const failure = body?.type === "turn.result" ? (body.text ?? body.subtype) : body?.type === "error" ? body.message : "";
    const what =
      body?.type === "notify"
        ? `Claude Code in der Session S1 ${asData(title)} im Projekt ${project.name} möchte dich erreichen und lässt ausrichten: ${excerptData(body.message, 500)}`
        : kind === "done"
        ? `Die Session S1 ${asData(title)} im Projekt ${project.name} ist fertig. Letztes Ergebnis von Claude Code: ${excerptData(result, 1500)}`
        : kind === "approval"
          ? `Die Session S1 ${asData(title)} im Projekt ${project.name} wartet auf eine Entscheidung. ${pendingText(this.d.db, sessionId)}`
          : `In der Session S1 ${asData(title)} im Projekt ${project.name} ist ein Fehler aufgetreten: ${excerptData(failure, 1500)}`;
    const reason = kind === "notify" ? `Claude meldet sich: ${title}` : kind === "done" ? `Session fertig: ${title}` : kind === "approval" ? `Entscheidung nötig: ${title}` : `Fehler: ${title}`;
    this.lastNotifyAt = Date.now();
    await this.dial(
      this.notifyTargets(),
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
    /**
     * Irreversible actions (deleting folders, repositories, sessions, branches with commits, removing
     * from FORGE) run only after the caller typed a code on the keypad; see PendingConfirm. `what` is
     * what the model tells the caller. A pending code is never replaced silently.
     */
    const askKeypad = (what: string, act: () => Promise<string>, nothingYet = "noch ist nichts gelöscht"): string => {
      if (a.confirm && Date.now() <= a.confirm.expiresAt) {
        return "Fehler: Es wartet noch eine Bestätigung über die Tastatur. Der Anrufer tippt erst den Code oder bricht mit Stern ab, dann geht das Nächste.";
      }
      const code = String(randomInt(0, 1000)).padStart(3, "0");
      a.confirm = { code, entered: "", expiresAt: Date.now() + CONFIRM_TTL_MS, run: act };
      return `Bestätigung nötig, ${nothingYet}. Sag dem Anrufer: ${what}. Zum Bestätigen tippt er auf der Telefontastatur ${code.split("").join(" ")} und dann Raute, Stern bricht ab. Ein Ja im Gespräch reicht nicht, ruf das Werkzeug dafür nicht noch einmal auf. FORGE meldet sich, sobald er getippt hat.`;
    };
    const projectChanged = (projectId: string) => this.d.emit({ event: "project.updated", payload: { projectId } });
    const call: PhoneRpc = (method, params) => {
      if (!this.d.rpc) throw new Error("Das ist hier nicht verfügbar.");
      return this.d.rpc(method, params);
    };
    /** a project when one or a session is named, else null (global) */
    const optionalTarget = (projectName: string | undefined, o?: { session?: string }) => (projectName?.trim() || o?.session?.trim() ? target(projectName ?? "", o) : null);
    const projectText = (p: Project) =>
      [
        `Profil ${p.profile}`,
        `Standardmodell ${p.defaultModel ?? "wie global eingestellt"}`,
        `Denkaufwand ${p.defaultEffort ?? "wie global eingestellt"}`,
        p.testCommand ? `Testbefehl ${asData(p.testCommand)}` : "kein Testbefehl",
        p.devCommand ? `Dev-Befehl ${asData(p.devCommand)}` : "Dev-Befehl wird erkannt",
        p.gitEnabled ? "mit Git" : "ohne Git",
      ].join(", ");
    /** Git, pull requests and agents are refused for a project set up without git. */
    const gitOff = (p: Project) => `Fehler: ${p.name} ist ohne Git eingerichtet. Git lässt sich mit dem Werkzeug project, action settings, git true einschalten.`;
    /** the user's prompts in a session, oldest first, as far as they can be branched or rewound to */
    const prompts = async (sessionId: string) => {
      let list: Array<{ seq: number; uuid: string; text: string }> = [];
      for (const { seq, body } of await call("sessions.events", { sessionId })) {
        if (body.type === "user.message" && body.uuid) list.push({ seq, uuid: body.uuid, text: body.text });
        // An edited prompt and what followed it are no longer part of the conversation.
        else if (body.type === "message.edited") {
          const from = body.fromSeq;
          list = list.filter((p) => p.seq < from);
        }
      }
      return list;
    };
    const promptBack = async (sessionId: string, n: number) => {
      const list = await prompts(sessionId);
      const hit = list[list.length - n];
      if (!hit) throw new Error(list.length ? `${refFor(sessionId)} hat nur ${list.length} Nachrichten vom Anrufer.` : `${refFor(sessionId)} hat noch keine Nachricht vom Anrufer.`);
      return hit;
    };
    const backups = async () => (await call("backup.list", {})).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const updateText = (st: ResultOf<"app.updateState">) => {
      if (!st.installable) return `Das ist eine Entwicklungsversion von FORGE (${st.currentVersion}), sie bekommt keine Updates.`;
      if (st.phase === "error") return `Fehler: ${st.message ?? "Die Update-Prüfung ist fehlgeschlagen."}`;
      if (st.phase === "checking") return "Die Suche nach Updates läuft noch. Frag gleich noch einmal.";
      if (!st.latest || st.phase === "uptodate" || st.phase === "idle") return `FORGE ist aktuell, Version ${st.currentVersion}.`;
      const state =
        st.phase === "ready"
          ? " Es ist heruntergeladen und geprüft. Beim Installieren startet FORGE neu; laufende Sessions machen danach von selbst weiter."
          : st.phase === "downloading"
            ? " Es wird gerade heruntergeladen."
            : "";
      return `FORGE ${st.latest.version} ist verfügbar, installiert ist ${st.currentVersion}.${state}`;
    };
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
    /** Prompt templates: list, send with values for their placeholders, save, sort and delete. */
    const templateAction = async (action: SessionsArgs[0], o: SessionsArgs[1]): Promise<string> => {
      const s = o?.session?.trim() ? resolve(o.session) : null;
      const p = s ? this.d.projects.get(s.projectId) : o?.project?.trim() ? findProject(o.project) : null;
      const list = await call("templates.list", p ? { projectId: p.id } : { all: true });
      const names = new Map(this.d.projects.all().map((x) => [x.id, x.name]));
      const where = (t: PromptTemplate) => (t.projectId ? `nur ${names.get(t.projectId) ?? "ein Projekt"}` : "global");
      const pickTemplate = () => {
        const q = o?.template?.trim() ?? "";
        const hits = q ? findTemplates(q, list) : [];
        return hits.length === 1 ? hits[0]! : pickOne(hits.length > 1 ? hits : list, q, (t) => [t.name], { none: "Keine Vorlage", many: "Vorlagen" });
      };
      if (action === "templates") {
        if (!list.length) return p ? `Keine Vorlagen für ${p.name}, auch keine globalen.` : "Es gibt noch keine Vorlagen.";
        const lines = list.slice(0, 15).map((t) => {
          const holes = templatePlaceholders(t.text);
          return `${t.name} (${where(t)})${t.description ? `: ${t.description}` : ""}${holes.length ? `, Platzhalter ${holes.join(", ")}` : ""}`;
        });
        return `${list.length === 1 ? "1 Vorlage" : `${list.length} Vorlagen`}${list.length > 15 ? ", die ersten 15" : ""}:\n${asData(lines.join("\n"))}`;
      }
      if (action === "template_send") {
        const t = pickTemplate();
        if (!p) return "Fehler: An welche Session oder in welchem Projekt?";
        const status = await call("projects.get", { projectId: p.id }).catch(() => null);
        const given = Object.fromEntries((o?.values ?? []).map((v) => [v.name.replace(/[{}]/g, "").trim(), v.value]));
        const values = { ...knownTemplateValues(t.text, { project: p.name, branch: status?.git?.branch ?? null, date: localDate(new Date()) }), ...given };
        const filled = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v.trim()]));
        const missing = templatePlaceholders(t.text).filter((n) => !filled.get(n.toLowerCase()));
        if (missing.length) return `Fehler: Für die Vorlage ${asData(t.name)} fehlen Werte für ${asData(missing.join(", "))}. Frag den Anrufer danach und ruf das Werkzeug dann mit values noch einmal auf.`;
        const text = fillTemplate(t.text, values);
        if (s) {
          await call("sessions.send", { sessionId: s.id, text });
          a.focus = s.id;
          return `Vorlage ${asData(t.name)} an ${refFor(s.id)} gesendet. Claude arbeitet daran.`;
        }
        const started = await call("sessions.start", { projectId: p.id, prompt: text });
        a.focus = started.id;
        return `Neue Session ${refFor(started.id)} im Projekt ${p.name} mit der Vorlage ${asData(t.name)} gestartet.`;
      }
      if (action === "template_save") {
        const existing = o?.template?.trim() ? pickTemplate() : null;
        const name = o?.name?.trim() || existing?.name;
        const text = o?.text?.trim() || existing?.text;
        if (!name) return "Fehler: Wie soll die Vorlage heißen?";
        if (!text) return "Fehler: Was soll in der Vorlage stehen?";
        const projectId = existing && !p ? existing.projectId : (p?.id ?? null);
        const saved = await call("templates.save", { id: existing?.id ?? null, projectId, name, description: o?.description?.trim() || existing?.description || null, text });
        return `Vorlage ${asData(saved.name)} ${existing ? "geändert" : "angelegt"} (${where(saved)}).`;
      }
      const t = pickTemplate();
      if (action === "template_delete") {
        return askKeypad(`Die Vorlage ${asData(t.name)} (${where(t)}) wird gelöscht`, async () => {
          const r = await call("templates.delete", { id: t.id });
          return r.ok ? `Vorlage ${asData(t.name)} gelöscht.` : `Die Vorlage ${asData(t.name)} gab es schon nicht mehr.`;
        });
      }
      if (!o?.direction) return "Fehler: Nach oben oder nach unten?";
      const siblings = (await call("templates.list", t.projectId ? { projectId: t.projectId } : {})).filter((x) => x.projectId === t.projectId);
      const i = siblings.findIndex((x) => x.id === t.id);
      const j = o.direction === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= siblings.length) return `${asData(t.name)} steht schon ${o.direction === "up" ? "ganz oben" : "ganz unten"}.`;
      const ids = siblings.map((x) => x.id);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      await call("templates.reorder", { ids });
      return `${asData(t.name)} steht jetzt an Platz ${j + 1} von ${siblings.length} (${where(t)}).`;
    };

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
          let context = "";
          try {
            const c = await sessions.contextUsage(s.id);
            if (c) context = ` Kontext zu ${Math.round(c.percentage)} Prozent voll.`;
          } catch {
            // Only a measurement; details work without it.
          }
          return [
            `${refFor(s.id)}: ${asData(s.title ?? "ohne Titel")} im Projekt ${project.name}, ${statusText(s)}.${setup ? ` ${setup}.` : ""}${context}`,
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
          if (o?.agent && !found.gitEnabled) return `${gitOff(found)} Ohne Git gibt es keine parallelen Agenten, nur eine normale Session.`;
          if (!o?.agent) {
            const s = await sessions.start({ projectId: found.id, prompt, model, effort, planOnly: o?.planOnly });
            a.focus = s.id;
            return `Neue Session ${refFor(s.id)} im Projekt ${found.name} gestartet.`;
          }
          // A parallel agent: own worktree and branch next to the project (as in the Agents tab), from
          // where the named project or worktree stands.
          const root = found.parentId ? this.d.projects.get(found.parentId) : found;
          const branch = `agent/${slugify(prompt, 32)}-${Date.now().toString(36).slice(-4)}`;
          const wt = await this.d.worktrees.create(this.d.projects.requireExisting(root.id), branch, { fromDir: found.path, withChanges: o?.withChanges === true });
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
          const warning = await sessions.planUsage(false).then((u) => limitWarning(u), () => null);
          return `Agent ${refFor(s.id)} im Projekt ${root.name} gestartet, in einem eigenen Worktree auf eigenem Branch.${warning ? ` Hinweis: ${warning}` : ""}`;
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
      backgroundTask: (ref, action, task, text) =>
        run(true, async () => {
          const s = resolve(ref);
          const r = refFor(s.id);
          const all = [
            ...s.background.map((t) => ({ taskId: t.taskId, toolUseId: t.toolUseId, description: t.description, background: true, command: /bash|shell/i.test(t.taskType), summary: t.summary })),
            ...s.subagents.map((t) => ({ taskId: t.taskId, toolUseId: t.toolUseId, description: t.description, background: false, command: false, summary: t.summary })),
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
          if (action === "message" && !text?.trim()) throw new Error("Was soll in der Nachricht stehen? text fehlt.");
          const t = find();
          if (action === "message") {
            await sessions.messageTask(s.id, { taskId: t.taskId }, text!.trim());
            return t.command
              ? `Nachricht zu ${asData(t.description)} an ${r} geschickt. Ein Befehl liest keine Eingaben, Claude reagiert darauf.`
              : `Nachricht an ${asData(t.description)} geschickt, Claude gibt sie an den Subagenten weiter.`;
          }
          if (action === "stop") {
            await sessions.stopTask(s.id, t.taskId);
            return `${asData(t.description)} gestoppt, der Rest von ${r} läuft weiter.`;
          }
          // Subagents have no command output; their progress line is what they are doing now.
          if (!t.command) return t.summary ? `${asData(t.description)} zuletzt: ${excerptData(t.summary, 500)}` : `${asData(t.description)} hat noch keinen Zwischenstand gemeldet.`;
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
          let env: string | undefined;
          if (patch.envSet?.trim() || patch.envRemove?.trim() || patch.envFromFile?.trim()) {
            env = tools.get(p.id).env;
            const fromFile = patch.envFromFile?.trim();
            if (fromFile) {
              const files = await tools.envFiles(p.id);
              const file = pickOne(files, fromFile, (f) => [f, f.replace(/^\.env\.?/, "")], { none: "Keine .env-Datei", many: ".env-Dateien" });
              for (const line of (await tools.readEnvFile(p.id, file)).split(/\r?\n/)) {
                const name = ENV_LINE.exec(line)?.[1];
                if (name) env = setEnvLine(env, name, line.trim());
              }
            }
            const set = patch.envSet?.trim();
            if (set) {
              const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s.exec(set);
              if (!m) return "Fehler: Die Variable bitte als NAME=Wert angeben.";
              env = setEnvLine(env, m[1]!, `${m[1]}=${m[2]!.trim()}`);
            }
            const remove = patch.envRemove?.trim();
            if (remove) {
              if (!envNames(env).includes(remove)) return `Fehler: ${remove} steht nicht in der Test-Umgebung.`;
              env = removeEnvLine(env, remove);
            }
          }
          const changed = patch.useEnv !== undefined || Object.keys(database).length > 0 || env !== undefined;
          let cfg;
          try {
            cfg = changed ? tools.update(p.id, { useEnv: patch.useEnv, database, ...(env !== undefined ? { env } : {}) }) : tools.get(p.id);
          } catch (e) {
            if (e instanceof ZodError) throw new Error(e.issues.map((i) => i.message).join("; "), { cause: e });
            throw e;
          }
          const d = cfg.database;
          // Names only: values are often keys and passwords.
          const vars = envNames(cfg.env);
          const text = [
            `Test-Umgebung ${cfg.useEnv ? "geht an Dev-Server und Tests" : "ist aus"}.`,
            vars.length ? `Variablen: ${asData(vars.join(", "))}.` : "",
            `Test-Datenbank auf Port ${d.port}, Name ${d.name}, ${d.withDevServer ? "startet mit dem Dev-Server" : "startet nicht mit dem Dev-Server"}, Verbindungs-URL ${d.envVar ? `in ${d.envVar}` : "wird nicht übergeben"}.`,
          ]
            .filter(Boolean)
            .join(" ");
          if (!changed) return `${p.name}: ${text}`;
          // The settings belong to the project a worktree comes from; the UI keeps them under that id.
          projectChanged(p.parentId ?? p.id);
          const restart = (patch.port !== undefined || !!patch.name?.trim()) && this.d.testDb?.isRunning(p.id) ? " Port und Name gelten ab dem nächsten Start der Datenbank." : "";
          // Agents share their project's settings and test database.
          return `Gespeichert${p.parentId ? " für das ganze Projekt samt Agenten" : ""}. ${text}${restart}`;
        }),
      projectAutomation: (projectName, patch, o) =>
        run(true, async () => {
          const named = target(projectName, o);
          // auto-merge is read from the main project; on a worktree the switch would do nothing.
          const p = patch.tag === AUTO_MERGE_TAG && named.parentId ? this.d.projects.get(named.parentId) : named;
          const on = (tags: string[]) => (Object.keys(AUTOMATION_TAGS) as AutomationTag[]).filter((t) => tags.includes(t)).map((t) => AUTOMATION_TAGS[t]);
          const state = (tags: string[]) => (on(tags).length ? `An: ${on(tags).join(", ")}.` : "Keine Automatik an.");
          if (!patch.tag) return `${p.name}: ${state(p.tags)}`;
          if (patch.on && !p.gitEnabled && GIT_TAGS.includes(patch.tag)) return `${gitOff(p)} ${AUTOMATION_TAGS[patch.tag]} braucht Git.`;
          if (patch.on === undefined) return `${p.name}: ${AUTOMATION_TAGS[patch.tag]} ist ${p.tags.includes(patch.tag) ? "an" : "aus"}.`;
          const tags = patch.on ? [...new Set([...p.tags, patch.tag])] : p.tags.filter((t) => t !== patch.tag);
          const next = this.d.projects.update(p.id, { tags });
          projectChanged(p.id);
          return `${AUTOMATION_TAGS[patch.tag]} ist für ${p.name} ${patch.on ? "an" : "aus"}. ${state(next.tags)}`;
        }),
      knowledge: (projectName, query, id, remove, o) =>
        run(true, async () => {
          const p = findProject(projectName);
          const store = this.d.knowledge;
          if (!store) return "Fehler: Das Projektwissen ist hier nicht verfügbar.";
          if (o?.autoMerge) {
            const plan = await call("knowledge.mergePlan", { projectId: p.id });
            if (!plan.groups.length) return `Claude (${plan.model}) hat im Projektwissen von ${p.name} nichts gefunden, das sich zusammenführen lässt.`;
            const queue = [...plan.groups];
            const lines: string[] = [];
            const worker = async () => {
              for (let g = queue.shift(); g; g = queue.shift()) {
                try {
                  const draft = await call("knowledge.mergeDraft", { projectId: p.id, ids: g.ids });
                  const { entry, removed } = await call("knowledge.merge", { projectId: p.id, ids: g.ids, title: draft.title, summary: draft.summary, tags: draft.tags, content: draft.content });
                  lines.push(`Zusammengeführt in ${entry.id} (${entry.title}). Gelöscht: ${removed.join(", ")}.`);
                } catch (e) {
                  lines.push(`Nicht zusammengeführt: ${g.ids.join(", ")}. ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(AUTO_MERGE_PARALLEL, queue.length) }, worker));
            return `Claude (${plan.model}) hat ${plan.groups.length === 1 ? "eine Gruppe" : `${plan.groups.length} Gruppen`} gefunden. Alte Fassungen liegen im Git.\n${asData(lines.join("\n"))}`;
          }
          if (o?.merge?.length) {
            const ids = [...new Set(o.merge)];
            if (ids.length < 2) return "Fehler: Zum Zusammenführen brauche ich mindestens zwei Kennungen.";
            const draft = await call("knowledge.mergeDraft", { projectId: p.id, ids });
            const { entry, removed } = await call("knowledge.merge", { projectId: p.id, ids, title: draft.title, summary: draft.summary, tags: draft.tags, content: draft.content });
            return `Zusammengeführt in ${entry.id}: ${asData(entry.title)}. Gelöscht: ${removed.join(", ")}. Den Text hat Claude (${draft.model}) geschrieben; alte Fassungen liegen im Git.`;
          }
          if (o?.stale) {
            const { entries } = await call("knowledge.checkRefs", { projectId: p.id, refresh: false });
            const stale = entries.filter((e) => e.missing.length);
            if (!stale.length) return `Im Projektwissen von ${p.name} verweist kein Eintrag auf Dateien oder Bezeichner, die es nicht mehr gibt.`;
            const title = new Map(store.list(p.id).map((e) => [e.id, e.title]));
            return `${stale.length === 1 ? "Ein Eintrag verweist" : `${stale.length} Einträge verweisen`} auf etwas, das es nicht mehr gibt:\n${asData(
              stale
                .slice(0, 8)
                .map((e) => `${e.id} (${title.get(e.id) ?? e.id}): fehlt ${e.missing.slice(0, 4).map((m) => m.ref).join(", ")}${e.missing.length > 4 ? ` und ${e.missing.length - 4} weitere` : ""}`)
                .join("\n"),
            )}`;
          }
          if (o?.markChecked || o?.fix) {
            const key = id?.trim();
            if (!key) return "Fehler: Dafür brauche ich die Kennung des Eintrags (id).";
            if (o.markChecked) {
              const { verified } = await call("knowledge.markChecked", { projectId: p.id, id: key });
              return verified.length ? `Eintrag ${key} ist als geprüft markiert. Diese Verweise meldet FORGE nicht mehr: ${asData(verified.join(", "))}.` : `Eintrag ${key} hat keine fehlenden Verweise.`;
            }
            const draft = await call("knowledge.fixDraft", { projectId: p.id, id: key });
            const entry = await call("knowledge.save", { projectId: p.id, id: key, title: draft.title, summary: draft.summary, tags: draft.tags, content: draft.content });
            return `Claude (${draft.model}) hat ${entry.id} korrigiert: ${asData(entry.title)}. Die alte Fassung liegt im Git.`;
          }
          if (o?.cleanup) {
            const { overlaps, long } = await call("knowledge.cleanup", { projectId: p.id });
            if (!overlaps.length && !long.length) return `Im Projektwissen von ${p.name} überschneidet sich nichts, und kein Eintrag ist sehr lang.`;
            const title = new Map(store.list(p.id).map((e) => [e.id, e.title]));
            const name = (k: string) => `${k} (${title.get(k) ?? k})`;
            return asData(
              [
                ...overlaps.slice(0, 5).map((x) => `Überschneidung ${Math.round(x.score * 100)} %: ${name(x.a)} und ${name(x.b)}`),
                ...long.slice(0, 5).map((l) => `Sehr lang (${Math.round(l.chars / 1000)} KB): ${name(l.id)}`),
              ].join("\n"),
            );
          }
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
          if (action === "account") {
            const acc = await call("github.account", {});
            if (!acc) return "FORGE ist nicht bei GitHub angemeldet. Anmelden geht nur in FORGE am Rechner über den Browser.";
            const orgs = await call("github.orgs", {}).catch(() => []);
            const inOrgs = orgs.length ? ` Organisationen: ${asData(orgs.map((o) => o.login).join(", "))}.` : "";
            return `FORGE ist bei GitHub als ${acc.login} angemeldet${acc.name ? `, ${acc.name}` : ""}.${inOrgs}`;
          }
          if (action === "identity") {
            const name = o?.name?.trim();
            const email = o?.email?.trim();
            if (name || email) {
              if (!name || !email) return "Fehler: Für die Git-Identität brauche ich Name und E-Mail.";
              const id = await call("git.setIdentity", { name, email });
              return `Commits laufen jetzt unter ${id.name}, ${id.email}.`;
            }
            const id = await call("git.identity", {});
            return id.name || id.email ? `Commits laufen unter ${id.name ?? "ohne Namen"}, ${id.email ?? "ohne E-Mail"}.` : "Es ist keine Git-Identität eingerichtet.";
          }
          const p = target(projectName, o);
          if (!p.gitEnabled) return gitOff(p);
          const git = this.d.git;
          if (action === "fetch") {
            const { summary: s } = await call("git.fetch", { projectId: p.id });
            return s.behind ? `${p.name}: ${s.behind} neue Commits auf dem Server, noch nicht übernommen.` : `${p.name}: Auf dem Server gibt es nichts Neues.`;
          }
          if (action === "branches") {
            const list = await call("git.branches", { projectId: p.id });
            if (!list.length) return `${p.name} hat noch keine Branches.`;
            const current = list.find((b) => b.current)?.name;
            const others = list.filter((b) => !b.current).map((b) => b.name);
            const rest = others.length ? ` Weitere: ${asData(others.slice(0, 15).join(", "))}${others.length > 15 ? ` und ${others.length - 15} mehr` : ""}.` : "";
            return `${p.name}: ${list.length} ${list.length === 1 ? "Branch" : "Branches"}${current ? `, aktuell ${current}` : ""}.${rest}`;
          }
          if (action === "delete_branch") {
            const branch = o?.branch?.trim();
            if (!branch) return "Fehler: Welcher Branch? Bitte branch angeben.";
            const del = async () => {
              await call("git.deleteBranch", { projectId: p.id, branch, force: o?.force === true });
              return `Branch ${branch} in ${p.name} gelöscht.`;
            };
            // Without force git refuses a branch whose commits are nowhere else; with force they are gone.
            if (o?.force !== true) return await del();
            return askKeypad(`Der Branch ${asData(branch)} in ${p.name} wird gelöscht, auch wenn er Commits hat, die in keinem anderen Branch sind`, del);
          }
          if (action === "diff") {
            const st = await call("git.status", { projectId: p.id });
            if (!st.files.length) return `${p.name} hat keine Änderungen.`;
            if (!o?.path?.trim()) {
              const names = st.files.slice(0, 15).map((f) => f.path);
              return `Geändert in ${p.name}: ${asData(names.join(", "))}${st.files.length > 15 ? ` und ${st.files.length - 15} weitere` : ""}. Welche Datei?`;
            }
            const f = pickOne(st.files, o.path.replace(/\\/g, "/"), (x) => [x.path], { none: "Keine geänderte Datei", many: "geänderte Dateien" });
            if (f.kind === "untracked") return `${asData(f.path)} ist neu und noch nicht im Git.`;
            if (isSensitiveFile(f.path)) return `${asData(f.path)} ist geändert. Die Datei enthält Zugangsdaten, ihr Inhalt wird am Telefon nicht vorgelesen.`;
            const d = await call("git.diff", { projectId: p.id, path: f.path, staged: f.staged && !f.unstaged });
            if (d.binary) return `${asData(f.path)} ist eine Binärdatei.`;
            const lines = d.lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => `${l.kind === "add" ? "neu" : "weg"}: ${l.text}`);
            return `${asData(f.path)}: ${d.additions} ${d.additions === 1 ? "Zeile" : "Zeilen"} hinzu, ${d.deletions} entfernt.${lines.length ? ` ${excerptData(lines.slice(0, 60).join("\n"), 3000)}` : ""}`;
          }
          /** hash, position in the log (1 = newest) or words of the subject; null when the log has no such position */
          const commitHash = async (ref: string): Promise<string | null> => {
            if (!/^\d{1,2}$/.test(ref) && /^[0-9a-f]{7,40}$/i.test(ref)) return ref;
            const commits = await call("git.log", { projectId: p.id, limit: 30 });
            const c = /^\d{1,2}$/.test(ref) ? commits[Number(ref) - 1] : pickOne(commits, ref, (x) => [x.subject, x.shortHash], { none: "Kein Commit", many: "Commits" });
            return c?.hash ?? null;
          };
          if (action === "show") {
            const ref = o?.commit?.trim() || "1";
            const hash = await commitHash(ref);
            if (!hash) return `Fehler: ${p.name} hat keinen ${ref}. Commit.`;
            const d = await call("git.commitFiles", { projectId: p.id, commit: hash });
            if (o?.path?.trim()) {
              const f = pickOne(d.files, o.path.replace(/\\/g, "/"), (x) => [x.path], { none: "Keine Datei dieses Commits", many: "Dateien dieses Commits" });
              if (isSensitiveFile(f.path)) return `${asData(f.path)} enthält Zugangsdaten, ihr Inhalt wird am Telefon nicht vorgelesen.`;
              if (f.binary) return `${asData(f.path)} ist eine Binärdatei.`;
              const diff = await call("git.commitDiff", { projectId: p.id, commit: hash, path: f.path, origPath: f.origPath ?? undefined });
              const lines = diff.lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => `${l.kind === "add" ? "neu" : "weg"}: ${l.text}`);
              return `${asData(f.path)} in diesem Commit: ${diff.additions} ${diff.additions === 1 ? "Zeile" : "Zeilen"} hinzu, ${diff.deletions} entfernt.${lines.length ? ` ${excerptData(lines.slice(0, 60).join("\n"), 3000)}` : ""}`;
            }
            if (!d.files.length) return `Der Commit ändert in ${p.name} keine Dateien.`;
            const add = d.files.reduce((n, f) => n + f.additions, 0);
            const del = d.files.reduce((n, f) => n + f.deletions, 0);
            const names = d.files.slice(0, 15).map((f) => `${f.path} (+${f.additions} -${f.deletions})`);
            const rest = d.files.length > 15 ? ` und ${d.files.length - 15} weitere` : "";
            const body = d.body ? ` Beschreibung: ${excerptData(d.body, 1500)}` : "";
            return `Der Commit ändert ${d.files.length} ${d.files.length === 1 ? "Datei" : "Dateien"}, ${add} Zeilen hinzu, ${del} entfernt: ${asData(names.join(", "))}${rest}.${body}`;
          }
          if (action === "restore") {
            const ref = o?.commit?.trim();
            if (!ref) return "Fehler: Auf welchen Commit? Hash, Nummer aus dem Log oder Worte aus der Commit-Nachricht.";
            const hash = await commitHash(ref);
            if (!hash) return `Fehler: ${p.name} hat keinen ${ref}. Commit.`;
            const r = await call("git.restoreTo", { projectId: p.id, commit: hash });
            return `Dateien von ${p.name} auf den Stand von ${asData(r.subject)} gesetzt, ${r.changed} Dateien geändert und noch nicht committet.${r.stashed ? " Die offene Arbeit von vorher liegt im Stash." : ""}`;
          }
          if (action === "init") {
            await call("git.init", { projectId: p.id });
            return `${p.name} ist jetzt ein Git-Repository.`;
          }
          if (action === "publish") {
            const isPrivate = o?.private !== false;
            const owner = await resolveOwner(call, o?.owner);
            await call("github.publish", { projectId: p.id, private: isPrivate, name: o?.name?.trim() || undefined, owner: owner ?? undefined });
            return `${p.name} ist als ${isPrivate ? "privates" : "öffentliches"} Repository auf GitHub veröffentlicht${owner ? `, in der Organisation ${owner}` : ""}.`;
          }
          if (action === "status") {
            const { summary: s } = await git.status(p.path);
            const sync = [s.ahead ? `${s.ahead} Commits nicht gepusht` : "", s.behind ? `${s.behind} Commits auf dem Server neuer` : ""].filter(Boolean);
            const parts = [`Branch ${s.branch ?? "keiner (detached)"}`, s.changedCount ? `${s.changedCount} geänderte Dateien` : "keine Änderungen", ...sync, s.conflicted ? "es gibt Konflikte" : ""];
            return `${p.name}: ${parts.filter(Boolean).join(", ")}.`;
          }
          if (action === "log") {
            const commits = await git.log(p.path, 5);
            if (!commits.length) return `${p.name} hat noch keine Commits.`;
            return `Letzte Commits in ${p.name}:\n${commits.map((c) => `${asData(`${c.subject} (${c.author})`)} am ${dateTime(c.date)}`).join("\n")}`;
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
          if (!p.gitEnabled) return gitOff(p);
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
          if (!p.parentId) return `Fehler: ${p.name} ist kein Agent-Worktree. Projekte entfernt das Werkzeug project mit remove.`;
          const parentId = p.parentId;
          const removeIt = async () => {
            const r = await removeWorktree(p.id, o?.force === true, removal, { deleteBranch: o?.deleteBranch === true });
            projectChanged(parentId);
            const branch = r.deletedBranch
              ? ` Branch ${r.deletedBranch} gelöscht.`
              : r.branchError
                ? ` Der Branch ließ sich nicht löschen: ${r.branchError}`
                : " Der Branch mit seinen Commits bleibt.";
            return `Worktree ${p.name} entfernt, seine Session ist beendet.${branch}`;
          };
          if (o?.force !== true && o?.deleteBranch !== true) return await removeIt();
          const lost = [o?.force === true && "nicht committete Änderungen darin", o?.deleteBranch === true && "sein Branch mit den Commits"].filter(Boolean).join(" und ");
          return askKeypad(`Der Agent ${p.name} wird aufgeräumt, dabei gehen ${lost} verloren`, removeIt);
        }),
      finishAgent: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          if (!p.parentId) return `Fehler: ${p.name} ist kein Agent-Worktree.`;
          if (action === "review") {
            const r = await call("agents.review", { projectId: p.id });
            const facts = [
              `${r.ahead} ${r.ahead === 1 ? "Commit" : "Commits"} auf ${r.branch ?? "seinem Branch"}, ${r.filesChanged} ${r.filesChanged === 1 ? "Datei" : "Dateien"} geändert`,
              r.uncommitted ? `${r.uncommitted} nicht committete Änderungen, die beim Zusammenführen mit committet werden` : "",
              r.behind ? `${r.targetBranch ?? "das Ziel"} ist seitdem ${r.behind} Commits weiter` : "",
              r.busy ? "er arbeitet noch" : "",
            ].filter(Boolean);
            return [
              `Agent ${p.name}: ${facts.join(", ")}.`,
              r.commits.length ? `Letzte Commits: ${asData(r.commits.slice(0, 3).map((c) => c.subject).join("; "))}` : "",
              r.summary.trim() ? `Seine Zusammenfassung: ${excerptData(r.summary, 1500)}` : "",
              r.mergeBlocker ? `Zusammenführen geht gerade nicht: ${r.mergeBlocker}` : `Zusammenführen nach ${r.targetBranch ?? "seinem Ausgangs-Branch"} ist möglich.`,
            ]
              .filter(Boolean)
              .join("\n");
          }
          const finisher = this.d.agentFinish;
          if (!finisher) return "Fehler: Agenten abschließen ist hier nicht verfügbar.";
          const finish = async () => (await finisher.finish(p.id, action)).message;
          if (action === "merge") return await finish();
          return askKeypad(`Die Arbeit des Agenten ${p.name} wird verworfen, sein Worktree und sein Branch mit allen Commits werden gelöscht`, finish);
        }),
      projects: () =>
        run(true, async () => {
          const all = this.d.projects.all().filter((p) => p.exists);
          if (!all.length) return "Es gibt keine Projekte.";
          const live = sessions.listLive();
          const lines = await Promise.all(
            all.map(async (p) => {
              const n = live.filter((s) => s.projectId === p.id).length;
              const branch = p.gitEnabled ? await this.d.git.currentBranch(p.path).catch(() => null) : null;
              const dev = await this.d.devServers.state(p.id).then(
                (st) => st.status === "running",
                () => false,
              );
              return [p.name, branch ? `Branch ${branch}` : p.gitEnabled ? "" : "ohne Git", dev ? "Dev-Server läuft" : "", n ? `${n} aktive ${n === 1 ? "Session" : "Sessions"}` : ""].filter(Boolean).join(", ");
            }),
          );
          return lines.join("\n");
        }),
      project: (projectName, action, o) =>
        run(true, async () => {
          const parentDir = async () => {
            const dir = o?.path?.trim() || (await call("settings.get", {})).defaultProjectDir;
            if (!dir) throw new Error("In welchem Ordner? In den Einstellungen ist kein Ordner für neue Projekte eingetragen.");
            return dir;
          };
          if (action === "create") {
            const name = o?.name?.trim();
            if (!name) return "Fehler: Wie soll das Projekt heißen?";
            const withGitHub = !!o?.github && o.git !== false;
            const owner = withGitHub ? await resolveOwner(call, o?.owner) : null;
            const r = await call("projects.create", { name, parentDir: await parentDir(), gitInit: o?.git !== false, gitEnabled: o?.git !== false, github: withGitHub ? { private: o?.github === "private", owner } : null });
            projectChanged(r.project.id);
            const gh = !r.github
              ? ""
              : r.github.url
                ? ` Das ${o?.github === "public" ? "öffentliche" : "private"} GitHub-Repository ist angelegt${owner ? `, in der Organisation ${owner}` : ""}.`
                : ` Das GitHub-Repository ließ sich nicht anlegen: ${r.github.error ?? "unbekannter Fehler"}`;
            return `Projekt ${r.project.name} ${r.project.gitEnabled ? "" : "ohne Git "}angelegt.${gh}`;
          }
          if (action === "import") {
            const dir = o?.path?.trim();
            if (!dir) return "Fehler: Welcher Ordner? Bitte den Pfad nennen.";
            const withGitHub = !!o?.github && o.git !== false;
            const owner = withGitHub ? await resolveOwner(call, o?.owner) : null;
            const p = await call("projects.import", { path: dir, gitEnabled: o?.git !== false });
            projectChanged(p.id);
            const forcedGit = o?.git === false && p.gitEnabled ? " Der Ordner hat schon ein Git-Repository, deshalb mit Git." : "";
            const done = `Projekt ${p.name} ${p.gitEnabled ? "" : "ohne Git "}aufgenommen.${forcedGit}`;
            if (!withGitHub) return done;
            try {
              await call("github.publish", { projectId: p.id, private: o?.github === "private", owner: owner ?? undefined });
              projectChanged(p.id);
              return `${done} Das ${o?.github === "public" ? "öffentliche" : "private"} GitHub-Repository ist angelegt${owner ? `, in der Organisation ${owner}` : ""}.`;
            } catch (e) {
              return `${done} Das GitHub-Repository ließ sich nicht anlegen: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          if (action === "clone") {
            const raw = o?.url?.trim();
            if (!raw) return "Fehler: Welches Repository?";
            let url = raw;
            if (!/:\/\/|@|\.git$/i.test(raw)) {
              // A spoken name ("shop api") against the repositories of the GitHub account.
              const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
              const repos = await call("github.repos", {});
              const repo = pickOne(repos, plain(raw), (r) => [r.fullName, plain(r.fullName.split("/").pop() ?? ""), plain(r.fullName)], { none: "Kein GitHub-Repository", many: "GitHub-Repositorys" });
              url = repo.cloneUrl;
            }
            const p = await call("projects.clone", { url, parentDir: await parentDir(), dirName: o?.name?.trim() || undefined });
            projectChanged(p.id);
            return `${p.name} geklont und als Projekt aufgenommen.`;
          }
          const p = target(projectName, o);
          if (action === "info") return `${p.name}${p.favorite ? ", Favorit" : ""}${p.parentId ? ", Agent-Worktree" : ""}: ${projectText(p)}.`;
          if (action === "remove") {
            if (p.parentId) return `Fehler: ${p.name} ist ein Agent-Worktree. Den räumt remove_agent auf.`;
            const deleteFolder = o?.deleteFolder === true;
            const deleteGitHubRepo = o?.deleteGitHubRepo === true;
            const remove = async () => {
              const r = await call("projects.remove", { projectId: p.id, deleteFolder, deleteGitHubRepo });
              projectChanged(p.id);
              return [`Projekt ${p.name} aus FORGE entfernt.`, r.folderDeleted ? "Der Ordner ist gelöscht." : "Der Ordner bleibt.", r.githubDeleted ? "Das GitHub-Repository ist gelöscht." : ""]
                .filter(Boolean)
                .join(" ");
            };
            // Even without folder or repository: the session history in FORGE goes with it.
            if (!deleteFolder && !deleteGitHubRepo) return askKeypad(`Das Projekt ${p.name} wird aus FORGE entfernt, mit seiner Session-Historie in FORGE. Ordner und GitHub-Repository bleiben`, remove);
            const info = await call("projects.removalInfo", { projectId: p.id });
            if (deleteGitHubRepo && !info.githubRepo) return `Fehler: ${p.name} hat kein GitHub-Repository.`;
            if (deleteGitHubRepo && !info.githubSignedIn) return "Fehler: FORGE ist nicht bei GitHub angemeldet.";
            if (deleteGitHubRepo && !info.githubCanDelete) return "Fehler: GitHub verlangt dafür die Berechtigung delete_repo. Die lässt sich nur am Computer beim Entfernen des Projekts erteilen.";
            if (deleteFolder && info.folderBlocker) return `Fehler: ${info.folderBlocker}`;
            const what = [deleteFolder && `der Ordner des Projekts ${p.name} mit allen Dateien`, deleteGitHubRepo && `das GitHub-Repository ${asData(info.githubRepo ?? "")} mit Code, Issues und Pull Requests`]
              .filter(Boolean)
              .join(" und ");
            return askKeypad(`${what} würde endgültig gelöscht, das lässt sich nicht rückgängig machen`, remove);
          }
          if (action === "rename") {
            const name = o?.name?.trim();
            if (!name) return "Fehler: Wie soll das Projekt heißen?";
            const next = await call("projects.update", { projectId: p.id, name });
            projectChanged(p.id);
            return `${p.name} heißt jetzt ${next.name}.`;
          }
          if (action === "favorite") {
            const favorite = o?.favorite !== false;
            await call("projects.update", { projectId: p.id, favorite });
            projectChanged(p.id);
            return favorite ? `${p.name} ist jetzt ein Favorit.` : `${p.name} ist kein Favorit mehr.`;
          }
          const patch = {
            ...(o?.profile ? { profile: o.profile } : {}),
            ...(o?.defaultModel !== undefined ? { defaultModel: clearable(o.defaultModel) } : {}),
            ...(o?.defaultEffort ? { defaultEffort: o.defaultEffort === "default" ? null : o.defaultEffort } : {}),
            ...(o?.testCommand !== undefined ? { testCommand: o.testCommand.trim() || null } : {}),
            ...(o?.devCommand !== undefined ? { devCommand: o.devCommand.trim() || null } : {}),
            ...(o?.git !== undefined ? { gitEnabled: o.git } : {}),
          };
          if (!Object.keys(patch).length) return `${p.name}: ${projectText(p)}.`;
          const next = await call("projects.update", { projectId: p.id, ...patch });
          projectChanged(p.id);
          return `Gespeichert für ${next.name}: ${projectText(next)}.`;
        }),
      files: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const rel = (o?.path ?? "").trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
          if (action === "read") {
            if (!rel) return "Fehler: Welche Datei?";
            // Keys would go to the speech service and be read out, like the values of dev_settings.
            if (isSensitiveFile(rel)) return `Fehler: ${asData(rel)} enthält Zugangsdaten und wird am Telefon nicht vorgelesen.`;
            const f = await call("projects.readFile", { projectId: p.id, path: rel });
            if (f.binary) return `${asData(rel)} ist keine Textdatei.`;
            if (!f.content.trim()) return `${asData(rel)} ist leer.`;
            return `${asData(rel)}${f.truncated ? ", nur der Anfang" : ""}: ${excerptData(f.content, 4000)}`;
          }
          if (action === "find") {
            if (!rel) return "Fehler: Welche Datei?";
            const { files } = await call("projects.allFiles", { projectId: p.id });
            const hits = matchingFiles(files, rel);
            if (!hits.length) return `In ${p.name} gibt es keine Datei ${asData(rel)}.`;
            const shown = hits.slice(0, 10).map((f) => f.path);
            return `${hits.length === 1 ? "Gefunden" : `${hits.length} Treffer`}: ${asData(shown.join(", "))}${hits.length > 10 ? ` und ${hits.length - 10} weitere` : ""}.`;
          }
          const entries = await call("projects.listFiles", { projectId: p.id, dir: rel });
          if (!entries.length) return rel ? `Der Ordner ${asData(rel)} ist leer.` : `${p.name} ist leer.`;
          const list = (xs: string[]) => `${xs.slice(0, 40).join(", ")}${xs.length > 40 ? ` und ${xs.length - 40} weitere` : ""}`;
          const dirs = entries.filter((e) => e.isDir).map((e) => e.name);
          const files = entries.filter((e) => !e.isDir).map((e) => e.name);
          return asData([dirs.length ? `Ordner: ${list(dirs)}.` : "", files.length ? `Dateien: ${list(files)}.` : ""].filter(Boolean).join(" "));
        }),
      claudeMd: (projectName, action, o) =>
        run(true, async () => {
          const p = optionalTarget(projectName, o);
          if (action === "list") {
            const files = await call("config.memoryList", { projectId: p?.id });
            return files.map((f) => `${f.label}: ${f.exists ? "vorhanden" : "fehlt"}`).join("\n");
          }
          const scope = o?.scope ?? (p ? "project" : "global");
          if (scope !== "global" && !p) return "Fehler: Für welches Projekt?";
          const projectId = scope === "global" ? undefined : p?.id;
          const where = scope === "global" ? "Die globale CLAUDE.md" : scope === "local" ? `Die persönliche CLAUDE.local.md von ${p!.name}` : `Die CLAUDE.md von ${p!.name}`;
          const doc = await call("config.memoryRead", { projectId, scope });
          if (action === "read") return doc.content.trim() ? `${where}: ${excerptData(doc.content, 4000)}` : `${where} ist leer oder fehlt.`;
          const text = o?.text?.trim();
          if (!text) return "Fehler: Was soll ergänzt werden?";
          const content = doc.content.trim() ? `${doc.content.trimEnd()}\n\n${text}\n` : `${text}\n`;
          await call("config.memoryWrite", { projectId, scope, content, expectedMtimeMs: doc.mtimeMs });
          return `${where} ist ergänzt.`;
        }),
      sessions: (action, o) =>
        run(true, async () => {
          if (action === "day_report") {
            const p = o?.project?.trim() ? findProject(o.project) : null;
            const today = new Date();
            const date = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - Math.max(0, Math.round(o?.daysBack ?? 0))));
            if (o?.summary) {
              const r = await call("reports.dailySummary", { projectId: p?.id, date });
              return `Zusammenfassung von Claude: ${asData(r.summary)}`;
            }
            // One block for the whole report: titles, commit messages and questions in it are data.
            const text = reportText(await call("reports.daily", { projectId: p?.id, date }), { ref: refFor });
            return text.length > REPORT_MAX ? `${asData(text.slice(0, REPORT_MAX))} (gekürzt, insgesamt ${text.length} Zeichen; für mehr nach einem Projekt fragen oder eine Zusammenfassung holen)` : asData(text);
          }
          if (action === "templates" || action === "template_send" || action === "template_save" || action === "template_delete" || action === "template_move") {
            return templateAction(action, o);
          }
          if (action === "list") {
            const p = o?.project?.trim() ? findProject(o.project) : null;
            const query = o?.query?.trim().toLowerCase();
            let external = 0;
            let list: Array<{ id: string; title: string | null; status: string; live: boolean; updatedAt: string; projectName: string }>;
            if (p) {
              const r = await call("sessions.list", { projectId: p.id });
              external = r.external.length;
              list = r.sessions
                .filter((s) => (!query || (s.title ?? "").toLowerCase().includes(query)) && (!o?.status || s.status === o.status))
                .map((s) => ({ ...s, projectName: p.name }));
            } else list = await call("sessions.listAll", { query: query || undefined, status: o?.status });
            list = [...list].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
            const outside = external ? ` Außerdem ${external} Sessions aus dem Terminal, die FORGE nicht steuert.` : "";
            if (!list.length) return `Keine passende Session.${outside}`;
            const lines = list.slice(0, 10).map((s) => `${refFor(s.id)}: ${asData(s.title ?? "ohne Titel")}${p ? "" : ` im Projekt ${s.projectName}`}, ${statusText(s)}, zuletzt ${dateTime(s.updatedAt)}`);
            return `${list.length > 10 ? `${list.length} Sessions, die 10 neuesten:\n` : ""}${lines.join("\n")}${outside}`;
          }
          const transcripts = o?.keepTranscript === true ? "Die Verläufe bei Claude Code bleiben" : "Auch die Verläufe bei Claude Code werden gelöscht";
          if (action === "delete_all") {
            const all = await call("sessions.listAll", {});
            if (!all.length) return "Es gibt keine Sessions.";
            return askKeypad(`Alle ${all.length} Sessions werden gelöscht. ${transcripts}`, async () => {
              const r = await call("sessions.deleteAll", { deleteTranscript: o?.keepTranscript !== true });
              a.focus = null;
              return r.failed ? `${r.deleted.length} Sessions gelöscht, ${r.failed} nicht${r.error ? `: ${r.error}` : "."}` : `Alle ${r.deleted.length} Sessions gelöscht.`;
            });
          }
          const s = resolve(o?.session ?? "");
          const r = refFor(s.id);
          if (action === "delete") {
            return askKeypad(`Die Session ${r} ${asData(s.title ?? "ohne Titel")} wird gelöscht. ${transcripts}`, async () => {
              const res = await call("sessions.delete", { sessionId: s.id, deleteTranscript: o?.keepTranscript !== true });
              if (a.focus === s.id) a.focus = null;
              return res.deleted ? `${r} gelöscht${res.transcriptDeleted ? ", auch ihr Verlauf bei Claude Code" : ""}.` : `Fehler: ${r} ließ sich nicht löschen.`;
            });
          }
          if (action === "ui_compare" || action === "ui_compare_retake") {
            const c = await call("uiCompare.latest", { sessionId: s.id });
            if (!c) return `Zu ${r} gibt es keinen Vorher-Nachher-Vergleich. FORGE macht einen, wenn Claude UI-Dateien ändert, während der Dev-Server läuft.`;
            if (action === "ui_compare_retake") {
              await call("uiCompare.retake", { sessionId: s.id, compareId: c.id });
              return `Das Nachher-Bild des letzten Vergleichs von ${r} wird neu aufgenommen. Die Bilder gibt es nur am Computer.`;
            }
            const files = c.files.length === 1 ? "1 UI-Datei" : `${c.files.length} UI-Dateien`;
            const state = c.status === "ready" ? "Vorher- und Nachher-Bild liegen vor" : c.status === "capturing" ? "das Nachher-Bild wird gerade aufgenommen" : `das Nachher-Bild fehlt: ${asData(c.error ?? "unbekannter Fehler")}`;
            return `Letzter Vergleich von ${r} vom ${dateTime(c.createdAt)}, Seite ${asData(c.url)}, ${files} geändert (${asData(c.files.slice(0, 5).join(", "))}): ${state}. Die Bilder gibt es nur am Computer.`;
          }
          if (action === "rewind") {
            const prompt = await promptBack(s.id, o?.messagesBack ?? 1);
            const res = await call("sessions.rewind", { sessionId: s.id, messageUuid: prompt.uuid, dryRun: false });
            if (!res.canRewind) return `Fehler: ${r} lässt sich nicht zurückspulen${res.error ? `: ${res.error}` : "."}`;
            if (!res.filesChanged.length) return `Seit dieser Nachricht hat ${r} keine Dateien geändert, es gab nichts zurückzusetzen.`;
            return `Dateien von ${r} auf den Stand vor der Nachricht ${excerptData(prompt.text, 120)} zurückgesetzt, ${res.filesChanged.length} ${res.filesChanged.length === 1 ? "Datei" : "Dateien"} geändert. Der Verlauf bleibt.`;
          }
          if (action === "edit") {
            const text = o?.text?.trim();
            if (!text) return "Fehler: Wie soll die Nachricht neu lauten?";
            const prompt = await promptBack(s.id, o?.messagesBack ?? 1);
            await call("sessions.edit", { sessionId: s.id, seq: prompt.seq, text });
            return `Die Nachricht ${excerptData(prompt.text, 120)} in ${r} ist ersetzt. Claude macht mit dem neuen Text weiter; die Dateien sind unverändert.`;
          }
          const before = o?.messagesBack ? await promptBack(s.id, o.messagesBack) : null;
          const res = await call("sessions.fork", { sessionId: s.id, beforeSeq: before?.seq, rewindFiles: o?.rewindFiles === true });
          const files = res.filesChanged?.length ? ` ${res.filesChanged.length} Dateien sind auf den Stand davor zurückgesetzt.` : "";
          if (!res.session) return `Vor der ersten Nachricht gibt es nichts zu übernehmen, dafür einfach eine neue Session starten.${files}`;
          a.focus = res.session.id;
          const cut = before && res.prompt ? ` Die weggelassene Nachricht war: ${excerptData(res.prompt, 300)}` : "";
          return `Neuer Zweig ${refFor(res.session.id)} von ${r} angelegt. Er wartet und läuft mit send_message weiter.${files}${cut}`;
        }),
      extensions: (kind, action, o) =>
        run(true, async () => {
          const p = optionalTarget(o?.project, o);
          const projectId = p?.id;
          const name = () => {
            const n = o?.name?.trim();
            if (!n) throw new Error("Welcher Name?");
            return n;
          };
          const only = (actions: string) => `Fehler: Hier geht ${actions}.`;
          if (kind === "mcp") {
            if (action === "list") {
              const list = await call("mcp.list", { projectId });
              const state = { connected: "verbunden", failed: "Fehler", needs_auth: "braucht Anmeldung", unknown: "Zustand unbekannt" } as const;
              return list.length ? `MCP-Server: ${asData(list.map((m) => `${m.name} ${state[m.status]}`).join(", "))}` : "Keine MCP-Server eingerichtet.";
            }
            if (action !== "add" && action !== "remove") return only("bei MCP-Servern list, add und remove");
            const scope = o?.scope ?? (p ? "local" : "user");
            if (scope !== "user" && !p) return "Fehler: Für welches Projekt?";
            const where = scope === "user" ? "global" : scope === "project" ? `im Projekt ${p!.name}` : `nur lokal in ${p!.name}`;
            if (action === "add") {
              const serverTarget = o?.target?.trim();
              if (!serverTarget) return "Fehler: Welcher Befehl oder welche URL?";
              const transport = o?.transport ?? (/^https?:\/\//i.test(serverTarget) ? "http" : "stdio");
              const args = o?.args?.trim() ? o.args.trim().split(/\s+/) : [];
              const r = await call("mcp.add", { projectId, name: name(), scope, transport, target: serverTarget, args, env: {} });
              return r.ok ? `MCP-Server ${name()} ${where} hinzugefügt.` : `Fehler: ${excerptData(r.output, 400)}`;
            }
            const r = await call("mcp.remove", { projectId, name: name(), scope });
            return r.ok ? `MCP-Server ${name()} ${where} entfernt.` : `Fehler: ${excerptData(r.output, 400)}`;
          }
          if (kind === "skill" || kind === "agent") {
            const [one, many] = kind === "skill" ? ["Skill", "Skills"] : ["Subagent", "Subagenten"];
            const docs = await call("config.docs", { kind, projectId });
            if (action === "list") {
              if (!docs.length) return `Keine ${many}.`;
              return `${many}: ${asData(docs.map((d) => `${d.name}${d.scope === "project" ? " (Projekt)" : ""}${d.description ? `: ${d.description.slice(0, 160)}` : ""}`).join("\n"))}`;
            }
            if (action === "add") {
              const scope = o?.scope === "user" || !p ? "user" : "project";
              const docName = slugify(name(), 64);
              if (!docName) return "Fehler: Der Name braucht Buchstaben oder Ziffern.";
              await call("config.docCreate", { kind, scope, name: docName, description: o?.description?.trim() ?? "", projectId });
              return `${one} ${docName} ${scope === "project" ? `im Projekt ${p!.name}` : "global"} angelegt.`;
            }
            if (action !== "read" && action !== "remove") return only(`bei ${many} list, read, add und remove`);
            const doc = pickOne(docs, name(), (d) => [d.name, d.name.replace(/-/g, " ")], { none: `Kein ${one}`, many });
            if (action === "read") {
              const d = await call("config.docRead", { kind, scope: doc.scope, name: doc.name, projectId });
              return `${one} ${doc.name}: ${excerptData(d.content, 3000)}`;
            }
            await call("config.docDelete", { kind, scope: doc.scope, name: doc.name, projectId });
            return `${one} ${doc.name} gelöscht.`;
          }
          if (kind === "command") {
            if (action !== "list") return only("bei Commands nur list; ausführen lassen sie sich mit send_message an eine Session");
            const own = (await call("system.commands", { projectId })).filter((c) => !c.builtin);
            return own.length ? `Eigene Slash-Befehle: ${asData(own.map((c) => `${c.name}${c.description ? `: ${c.description.slice(0, 120)}` : ""}`).join("\n"))}` : "Keine eigenen Slash-Befehle.";
          }
          if (kind === "hook") {
            if (action !== "list" && action !== "read") return only("bei Hooks nur list und read; ändern lassen sie sich in FORGE");
            const scope = o?.scope ?? (p ? "project" : "user");
            if (scope !== "user" && !p) return "Fehler: Für welches Projekt?";
            const r = await call("config.hooksRead", { scope, projectId });
            let events: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(r.hooks || "{}");
              if (parsed && typeof parsed === "object") events = parsed as Record<string, unknown>;
            } catch {
              // Shown as text below.
            }
            const names = Object.entries(events).map(([e, v]) => `${e} (${Array.isArray(v) ? v.length : 1})`);
            if (!names.length && !r.hooks.trim().replace(/^\{\s*\}$/, "")) return `Keine Hooks ${scope === "user" ? "global" : `in ${p!.name}`}.`;
            return `Hooks ${scope === "user" ? "global" : `in ${p!.name}`}: ${asData(names.join(", "))}${action === "read" ? ` Inhalt: ${excerptData(r.hooks, 2000)}` : ""}`;
          }
          const catalog = await call("plugins.catalog", {});
          const pluginState = (x: (typeof catalog)[number]) => (!x.installed ? "nicht installiert" : x.enabled === false ? "installiert, aus" : "installiert");
          if (action === "list" || action === "read") {
            const q = (o?.query ?? o?.name ?? "").trim().toLowerCase();
            if (q) {
              const hits = catalog.filter((x) => `${x.name} ${x.description}`.toLowerCase().includes(q)).slice(0, 8);
              return hits.length ? asData(hits.map((x) => `${x.name}, ${pluginState(x)}: ${x.description.slice(0, 160)}`).join("\n")) : `Kein Plugin zu „${q}“ im Katalog.`;
            }
            const installed = catalog.filter((x) => x.installed);
            return installed.length ? `Plugins: ${asData(installed.map((x) => `${x.name}${x.enabled === false ? " (aus)" : ""}`).join(", "))}` : "Keine Plugins installiert.";
          }
          const plugin = pickOne(catalog, name(), (x) => [x.name, x.id], { none: "Kein Plugin", many: "Plugins" });
          if (action === "add") {
            if (plugin.installed) return `Plugin ${plugin.name} ist schon installiert.`;
            await call("plugins.install", { id: plugin.id });
            return `Plugin ${plugin.name} installiert.`;
          }
          if (!plugin.installed) return `Fehler: Plugin ${plugin.name} ist nicht installiert.`;
          if (action === "remove") {
            await call("plugins.uninstall", { id: plugin.id });
            return `Plugin ${plugin.name} deinstalliert.`;
          }
          await call("plugins.setEnabled", { id: plugin.id, enabled: action === "enable" });
          return `Plugin ${plugin.name} ist ${action === "enable" ? "an" : "aus"}.`;
        }),
      forgeSettings: (patch) =>
        run(true, async () => {
          const cur = await call("settings.get", {});
          const update: Partial<Settings> = {};
          const changed: Array<keyof ForgeSettingsPatch> = [];
          const flags = ["sounds", "desktopNotifications", "enterToSend", "autoContinueAfterLimit", "updateChecks", "debugLogs", "stripApiKey", "screenshotKey", "uiCompare"] as const;
          for (const k of flags) {
            const v = patch[k];
            if (v === undefined) continue;
            update[k] = v;
            changed.push(k);
          }
          if (patch.defaultModel !== undefined) {
            update.defaultModel = clearable(patch.defaultModel);
            changed.push("defaultModel");
          }
          if (patch.defaultEffort) {
            update.defaultEffort = patch.defaultEffort === "default" ? null : patch.defaultEffort;
            changed.push("defaultEffort");
          }
          if (patch.idleCloseMinutes !== undefined) {
            update.idleCloseMinutes = Math.min(1440, Math.max(0, Math.round(patch.idleCloseMinutes)));
            changed.push("idleCloseMinutes");
          }
          if (patch.defaultProfile) {
            update.defaultProfile = patch.defaultProfile;
            changed.push("defaultProfile");
          }
          if (patch.defaultProjectDir !== undefined) {
            update.defaultProjectDir = patch.defaultProjectDir.trim() || null;
            changed.push("defaultProjectDir");
          }
          const rule = patch.policyRule;
          if (rule && patch.policyRuleOn === undefined && !changed.length) return `Die Regel ${POLICY_RULE_LABELS[rule]} ist ${cur.disabledPolicyRules.includes(rule) ? "aus" : "an"}.`;
          if (rule && patch.policyRuleOn !== undefined) {
            const off = cur.disabledPolicyRules.filter((r) => r !== rule);
            update.disabledPolicyRules = patch.policyRuleOn ? off : [...off, rule];
            changed.push("policyRule");
          }
          if (!changed.length) return `${(["defaultModel", "defaultEffort", "defaultProfile", "defaultProjectDir", ...flags, "idleCloseMinutes", "alwaysOnTop", "policyRule"] as const).map((k) => settingText(cur, k)).join(", ")}.`;
          const next = await call("settings.update", update);
          return `Gespeichert: ${changed.map((k) => settingText(next, k)).join(", ")}.`;
        }),
      forgeSystem: (action, o) =>
        run(true, async () => {
          if (action === "diagnostics") {
            const d = await call("system.diagnostics", { refresh: true });
            const facts = [
              d.claude.found ? `Claude Code${d.claude.version ? ` ${d.claude.version}` : ""} ist da` : `Claude Code fehlt${d.claude.error ? `: ${d.claude.error}` : ""}`,
              !d.auth.checked ? "" : d.auth.loggedIn ? `angemeldet${d.auth.subscriptionType ? ` mit Abo ${d.auth.subscriptionType}` : ""}` : `nicht angemeldet${d.auth.error ? `: ${d.auth.error}` : ""}`,
              d.apiKeyEnvPresent ? (d.apiKeyStripped ? "ein API-Key in der Umgebung wird ausgeblendet" : "ein API-Key in der Umgebung geht an Claude Code") : "",
              d.git.found ? `Git${d.git.version ? ` ${d.git.version}` : ""} ist da` : "Git fehlt",
              d.gh.found ? (d.gh.authenticated === false ? "die GitHub-CLI ist nicht angemeldet" : "die GitHub-CLI ist da") : "die GitHub-CLI fehlt",
              d.python.found ? `${d.python.version ?? "Python"} ist da${d.python.bundled ? " (mitgeliefert)" : ""}` : "Python fehlt",
            ].filter(Boolean);
            const missing = d.capabilities.filter((c) => c.state === "unavailable").map((c) => c.label);
            return `${facts.join(", ")}.${missing.length ? ` Nicht verfügbar: ${missing.join(", ")}.` : ""}`;
          }
          if (action === "update_check") return updateText(await call("app.checkUpdate", {}));
          if (action === "update_download") return updateText(await call("app.downloadUpdate", {}));
          if (action === "update_install") {
            const st = await call("app.installUpdate", {});
            return `FORGE${st.latest ? ` ${st.latest.version}` : ""} wird jetzt installiert und startet neu, dieses Gespräch endet dabei. Offene Sessions gehen danach weiter, laufende machen von selbst dort weiter, wo sie waren.`;
          }
          if (action === "changelog") {
            const c = await call("app.changelog", {});
            if (!c) return "Gerade wird keine neue Version angeboten.";
            if (c.status === "writing") return "Claude fasst die Neuerungen gerade zusammen. Frag in ein paar Sekunden noch einmal.";
            if (c.status === "ready" && c.text) return `Neu in ${c.tag}: ${excerptData(c.text, 3000)}`;
            const notes = (await call("app.updateState", {})).latest?.notes;
            if (notes?.trim()) return `Neu in ${c.tag} laut Release-Notes: ${excerptData(notes, 3000)}`;
            if (c.commits.length) return `Änderungen in ${c.tag}: ${excerptData(c.commits.slice(0, 15).join("\n"), 3000)}`;
            return `Fehler: ${c.message ?? "Für diese Version gibt es keine Beschreibung."}`;
          }
          if (action === "claude_check") {
            const st = await call("claude.setupState", {});
            if (st.phase === "running" && st.task !== "login") return st.task === "install" ? "Claude Code wird gerade installiert." : "Claude Code wird gerade aktualisiert.";
            const last = st.task === "update" || st.task === "install" ? (st.phase === "error" ? ` Der letzte Versuch ist fehlgeschlagen: ${st.message ?? "unbekannter Fehler"}` : "") : "";
            const u = await call("claude.checkUpdate", {});
            if (!u.installed) return `Claude Code ist nicht installiert.${last}`;
            if (u.error) return `Installiert ist Claude Code ${u.installed}. Die neueste Version ließ sich nicht abfragen: ${u.error}${last}`;
            return `${u.available ? `Claude Code ${u.latest} ist verfügbar, installiert ist ${u.installed}.` : `Claude Code ist aktuell, Version ${u.installed}.`}${last}`;
          }
          if (action === "claude_update") {
            try {
              await call("claude.update", {});
            } catch (e) {
              if (!(e instanceof ForgeError && e.code === "CLAUDE_NOT_INSTALLED")) throw e;
              await call("claude.install", {});
              return "Claude Code wird installiert. Ob es geklappt hat, sagt claude_check.";
            }
            return "Claude Code wird aktualisiert. Laufende Sessions nutzen die neue Version erst nach einem Neustart.";
          }
          if (action === "claude_logout") {
            // Signing in again needs the browser at the computer, so the phone cannot undo this.
            return askKeypad(
              "Claude Code wird auf diesem Computer abgemeldet. Sessions brauchen danach eine neue Anmeldung, und die geht nur am Rechner",
              async () => {
                await call("claude.logout", {});
                return "Claude Code ist abgemeldet. Neu anmelden geht in FORGE am Rechner.";
              },
              "noch ist nichts geändert",
            );
          }
          if (action === "backup_create") {
            const b = await call("backup.create", {});
            return `Backup angelegt: ${b.parts.map((x) => x.label).join(", ")}.`;
          }
          if (action === "sync_on" || action === "sync_off") {
            const on = action === "sync_on";
            if (on && !(await call("github.account", {}))) return "Fehler: Dafür muss FORGE bei GitHub angemeldet sein. Die Anmeldung geht nur am Rechner.";
            await call("settings.update", { syncEnabled: on, syncAsked: true });
            return on ? "Der Abgleich über GitHub ist an. FORGE gleicht jetzt ab." : "Der Abgleich über GitHub ist aus. Das Repository auf GitHub bleibt.";
          }
          if (action === "sync_status" || action === "sync_now") {
            const st = action === "sync_now" ? await call("sync.now", {}) : await call("sync.status", {});
            if (st.phase === "off") return "Der Abgleich über GitHub ist aus.";
            if (st.phase === "no-github") return "Der Abgleich ist an, aber FORGE ist nicht bei GitHub angemeldet.";
            if (st.phase === "needs-passphrase") return `Der Abgleich wartet auf das Sync-Passwort. Das lässt sich nur in FORGE am Rechner eingeben.${st.error ? ` ${st.error}` : ""}`;
            const when = st.phase === "syncing" ? "FORGE gleicht gerade ab" : st.phase === "error" ? `Der letzte Abgleich ist fehlgeschlagen: ${st.error ?? "unbekannter Fehler"}` : st.lastSyncAt ? `Zuletzt abgeglichen ${dateTime(st.lastSyncAt)}` : "Noch nicht abgeglichen";
            const facts = [
              st.remote ? `${when}, zuletzt geschrieben von ${asData(st.remote.device)}` : when,
              st.available.length ? `Von anderen Computern fehlen hier noch: ${st.available.map((p) => asData(p.name)).join(", ")}` : "",
              st.localOnly.length ? `Nur noch auf diesem Computer, weil auf einem anderen entfernt: ${st.localOnly.map((x) => asData(x.label)).join(", ")}` : "",
            ].filter(Boolean);
            return `${facts.join(". ")}.`;
          }
          if (action === "sync_clone") {
            const st = await call("sync.status", {});
            const want = o?.project?.trim();
            if (!want) return "Fehler: Welches Projekt?";
            const hit = pickOne(st.available, want.toLowerCase(), (p) => [p.name.toLowerCase(), p.key], { none: "Kein fehlendes Projekt", many: "Fehlende Projekte" });
            const p = await call("sync.cloneProject", { key: hit.key });
            projectChanged(p.id);
            return `${p.name} ist jetzt auch auf diesem Computer.`;
          }
          const localOnlyItem = async () => {
            const st = await call("sync.status", {});
            return pickOne(st.localOnly, o!.project!.trim().toLowerCase(), (x) => [x.label.toLowerCase(), x.key], { none: "Nichts, das nur hier ist, heißt", many: "Einträge" });
          };
          if (action === "sync_keep") {
            if (!o?.project?.trim()) return "Fehler: Was soll wieder abgeglichen werden?";
            const item = await localOnlyItem();
            await call("sync.keep", { key: item.key });
            return `${item.label} wird wieder abgeglichen und geht auch auf die anderen Computer.`;
          }
          if (action === "sync_force") {
            const item = o?.project?.trim() ? await localOnlyItem() : null;
            const st = await call("sync.status", {});
            if (!st.enabled) return "Fehler: Der Abgleich über GitHub ist aus.";
            const removes = item ? [item] : st.localOnly;
            const what = item
              ? `${item.label} wird auf den Stand von GitHub gesetzt, also hier entfernt${item.kind === "project" ? " (nur aus FORGE, der Ordner bleibt, die Session-Historie in FORGE ist weg)" : ""}`
              : `Dieser Computer wird hart auf den Stand von GitHub gesetzt${removes.length ? `, entfernt werden hier: ${removes.map((x) => asData(x.label)).join(", ")} (Projekte nur aus FORGE, ihre Ordner bleiben)` : ""}`;
            // The projects named now are the ones removed; if that changed until the code, nothing happens.
            const expectRemove = item ? undefined : removes.filter((x) => x.kind === "project").map((x) => x.key);
            // Removing from FORGE takes the session history with it: confirmed on the keypad, like deleting.
            return askKeypad(
              `${what}. Vorher legt FORGE ein Backup an`,
              async () => {
                await call("sync.forceLocal", { key: item?.key, expectRemove });
                const later = " Telefon-Einstellungen von GitHub übernimmt FORGE erst nach diesem Gespräch.";
                return item ? `${item.label} ist auf dem Stand von GitHub.` : `Dieser Computer ist auf dem Stand von GitHub. Der Stand davor ist als Backup gesichert.${later}`;
              },
              "noch ist nichts geändert",
            );
          }
          if (action === "sync_versions" || action === "sync_restore") {
            const versions = await call("sync.versions", {});
            if (action === "sync_versions") {
              if (!versions.length) return "Auf GitHub liegt noch kein Stand.";
              return versions
                .slice(0, 5)
                .map((v, i) => `${i + 1}: ${dateTime(v.date)}${v.device ? `, von ${asData(v.device)}` : ""}`)
                .join("\n");
            }
            const nr = o?.backup?.trim();
            if (!nr) return "Fehler: Welcher Stand? Die Nummer aus sync_versions.";
            const v = /^\d+$/.test(nr) ? versions[Number(nr) - 1] : versions.find((x) => x.sha.startsWith(nr));
            if (!v) return `Fehler: Stand ${nr} gibt es nicht.`;
            // The phone settings reconnect the line and would end this call.
            const parts = (o?.parts ?? BackupPart.options).filter((x) => x !== "phone");
            const phone = o?.parts?.includes("phone") ? " Telefon-Einstellungen lassen sich nur in FORGE am Rechner zurückholen, sonst endet dieses Gespräch." : "";
            if (!parts.length) return `Fehler: Nichts zum Zurückholen.${phone}`;
            const r = await call("sync.restoreVersion", { sha: v.sha, parts });
            return `Stand vom ${dateTime(v.date)} zurückgeholt: ${r.restored.map((x) => BACKUP_PARTS[x]).join(", ")}. Der Stand davor ist als Backup gesichert. ${r.notes.join(" ")}${phone}`;
          }
          const list = await backups();
          if (action === "backup_list") {
            if (!list.length) return "Es gibt noch keine Backups.";
            return list
              .slice(0, 5)
              .map((b, i) => `${i + 1}: ${dateTime(b.createdAt)}, ${BACKUP_REASONS[b.reason]}, FORGE ${b.appVersion}`)
              .join("\n");
          }
          const key = o?.backup?.trim();
          if (!key) return "Fehler: Welches Backup? Die Nummer aus backup_list.";
          const b = /^\d+$/.test(key) ? list[Number(key) - 1] : list.find((x) => x.id === key);
          if (!b?.id) return `Fehler: Backup ${key} gibt es nicht.`;
          const inside = b.parts.map((x) => x.part);
          // Restoring the phone settings reconnects the line and would end this call.
          const parts = (o?.parts ?? inside).filter((x) => x !== "phone" && inside.includes(x));
          const phone = o?.parts?.includes("phone") ? " Telefon-Einstellungen lassen sich nur in FORGE am Rechner wiederherstellen, sonst endet dieses Gespräch." : "";
          if (!parts.length) return `Fehler: Davon ist in diesem Backup nichts enthalten.${phone}`;
          const r = await call("backup.restore", { id: b.id, parts });
          return `Backup vom ${dateTime(b.createdAt)} wiederhergestellt: ${r.restored.map((x) => BACKUP_PARTS[x]).join(", ")}. Der Stand davor ist als Backup gesichert.${r.notes.length ? ` ${r.notes.join(" ")}` : ""}${phone}`;
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
          const { numbers, ...times } = patch;
          const changes = Object.fromEntries(Object.entries(times).filter(([, v]) => v !== undefined)) as CallSettingsPatch;
          if (Object.keys(changes).length) await this.saveConfig({ notifyOn: { ...this.cfg.notifyOn, ...changes } });
          const changed = numbers ? await this.changeNumber(numbers) : "";
          const targets = this.notifyTargets();
          // The numbers themselves only after the PIN: they are personal.
          const lists = locked() ? "" : ` ${numberListing("Angerufen wird", this.cfg.notifyNumbers)} ${numberListing("Anrufen dürfen", this.cfg.allowedCallers)}`;
          if (!targets.length) return `${changed}FORGE ruft von sich aus nicht an: In den Einstellungen ist keine Nummer dafür eingetragen und eingeschaltet.${lists}`;
          const on = this.cfg.notifyOn;
          const list = [on.done ? "wenn eine Session fertig ist" : "", on.approval ? "wenn eine Entscheidung nötig ist oder Claude dringend etwas meldet" : "", on.error ? "bei Fehlern" : ""].filter(Boolean);
          const where = targets.length > 1 ? ` Es klingelt bei ${targets.length} Nummern gleichzeitig, wer zuerst abnimmt, hat das Gespräch.` : "";
          return `${changed}${list.length ? `FORGE ruft an: ${list.join(", ")}.${where}` : "FORGE ruft von sich aus nicht mehr an."}${lists}`;
        }),
      callBack: (minutes, about) =>
        run(false, async () => {
          if (!about.trim()) return "Fehler: Was soll ich beim Rückruf sagen?";
          // Back to the number of this call; only numbers FORGE may talk to anyway.
          const number = a.call.remoteNumber;
          const known = [...activeNumbers(this.cfg.allowedCallers), ...this.notifyTargets()].some((n) => sameNumber(n, number));
          // Otherwise the numbers for notifications ring, stored as "".
          if (!known && !this.notifyTargets().length) return "Fehler: Für diese Nummer kann ich keinen Rückruf vereinbaren.";
          const due = this.scheduleCallback(known ? number : "", minutes, about);
          return `Rückruf vereinbart für ${due.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr.`;
        }),
      usage: () =>
        run(false, async () => {
          const u = await sessions.planUsage(false);
          const limit = sessions.rateLimit();
          const reached = limit.status === "reached" ? `Limit erreicht${limit.resetsAt ? `, wieder frei ${spokenTime(limit.resetsAt)}` : ""}.` : "";
          const perSecond = Math.round(tokenMeter.rate());
          const rate = perSecond ? `Gerade ${perSecond} Tokens pro Sekunde über alle Sessions und Agenten.` : "Gerade gibt Claude keine Tokens aus.";
          if (!u.available || !u.windows.length) return [reached || `Nutzung nicht verfügbar${u.error ? `: ${u.error}` : ""}.`, rate].join("\n");
          const windows = u.windows.map((w) => `${w.label}: ${Math.round(w.utilization)} Prozent${w.resetsAt ? `, zurückgesetzt ${spokenTime(w.resetsAt)}` : ""}. ${spokenForecast(w)}`);
          return [reached, ...windows, rate].filter(Boolean).join("\n");
        }),
    };
  }
}

/** Read through a function: TypeScript keeps a narrowed `call.state` across awaits, the call does not. */
function ended(call: PhoneCall): boolean {
  return call.state === "ended";
}
