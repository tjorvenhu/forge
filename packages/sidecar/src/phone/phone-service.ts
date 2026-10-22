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
  SUPPORT_LINKS,
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
import type { ChatWindowState } from "../util/chat-windows.js";
import { asData, PhoneAgent, type PhoneToolset } from "./phone-agent.js";
import { bestByName, excerptData, nameScore, lastAnswer, openRequest, pendingText, questionTexts } from "./session-info.js";
import { DEFAULT_PIN_LIMITS, hashPin, PinGuard, verifyPin, type PinGuardState, type PinLimits } from "./pin-guard.js";
import { RtpSession } from "./rtp.js";
import { answerDirection, buildSdp, chooseCodec, parseSdp, PT_PCMA } from "./sdp.js";
import type { SecretStore } from "./secrets.js";
import { localIpTowards, SipUserAgent, type PhoneCall, type SipAccount, type SipCall } from "./sip-ua.js";
import { ForkedCall } from "./forked-call.js";
import {
  AUTOMATION_TAG_IDS,
  automationTagLabel,
  geminiFunctionDeclarations,
  phoneSystemPrompt,
  policyRuleLabel,
  type CallSettingsPatch,
  type ForgeSettingsPatch,
} from "./tools.js";
import { tr } from "../i18n/index.js";
import { AUTO_MERGE_TAG } from "../automation/agent-auto-merge.js";
import { localDate, reportText } from "../reports/daily-report.js";
import { tokenMeter } from "../claude/token-meter.js";
import { DEFAULT_STT_MODEL, DEFAULT_TTS_MODEL, DEFAULT_VOICE, OpenAiVoice, type VoiceProvider } from "./voice.js";

/** longest daily report handed to the conversation partner */
const REPORT_MAX = 6000;
/** ended sessions named in the overview at the start of a call */
const OVERVIEW_RECENT = 5;
/** last answer of a running session in that overview */
const OVERVIEW_ANSWER_MAX = 300;
/** sessions whose history Claude reads for a question on the phone */
const ASK_SESSIONS = 3;
/** words of the question looked up one by one */
const ASK_WORDS = 12;
/** longest answer handed back to the conversation partner */
const ASK_ANSWER_MAX = 1500;

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
  /** the desktop's chat windows; without it chat_window is not available */
  chatWindows?: Pick<ChatWindowState, "get" | "request">;
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
  const m = tr().phone;
  if (!list.length) return m.callSettings.listNone(what);
  const one = (n: PhoneNumberEntry) => [n.label, n.number].filter(Boolean).join(" ") + (n.enabled ? "" : m.callSettings.listOff);
  return m.callSettings.listing(what, asData(list.map(one).join(", ")));
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
  const m = tr().phone;
  const d = new Date(iso);
  const time = d.toLocaleTimeString(m.locale, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return m.time.today(time);
  return m.time.weekday(d.toLocaleDateString(m.locale, { weekday: "long" }), time);
}

/** The limit forecast of a usage window as said on the phone ("Reicht mein Limit noch?"). */
export function spokenForecast(w: UsageWindow): string {
  const m = tr().phone;
  const f = w.forecast;
  if (!f) return m.time.forecastNone;
  if (f.outcome === "limit" && f.limitAt) return m.time.forecastLimit(spokenTime(f.limitAt));
  return m.time.forecastOk;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(tr().phone.locale, { dateStyle: "short", timeStyle: "short" });
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
  const m = tr().phone;
  const q = query.trim().toLowerCase();
  const exact = items.filter((x) => keys(x).some((k) => k.toLowerCase() === q));
  const hits = exact.length ? exact : items.filter((x) => keys(x).some((k) => k.toLowerCase().includes(q)));
  if (q && hits.length === 1) return hits[0]!;
  const names = (xs: T[]) => xs.slice(0, 6).map((x) => keys(x)[0]).join(", ");
  if (q && hits.length > 1) throw new Error(m.common.pickMany(what.many, query, asData(names(hits))));
  const known = items.length ? m.common.pickKnown(asData(names(items)), items.length > 6) : "";
  throw new Error(q ? m.common.pickNone(what.none, query, known) : m.common.pickWhich(known));
}

function statusText(s: { status: string; live: boolean }): string {
  const m = tr().phone.common.status;
  return s.status === "running" || s.status === "starting"
    ? m.working
    : s.status === "waiting_approval"
      ? m.waiting
      : s.status === "idle" && s.live
        ? m.idle
        : s.status === "error"
          ? m.error
          : m.ended;
}

/** A spoken GitHub organisation ("vanturis") against the account's organisations; nothing spoken or the account itself: the personal account. */
async function resolveOwner(call: PhoneRpc, spoken: string | undefined): Promise<string | null> {
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const q = plain(spoken ?? "");
  if (!q) return null;
  const acc = await call("github.account", {});
  if (acc && plain(acc.login) === q) return null;
  const orgs = await call("github.orgs", {});
  const what = tr().phone.common.what;
  return pickOne(orgs, q, (o) => [o.login, plain(o.login)], { none: what.githubOrgNone, many: what.githubOrgMany }).login;
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

/** A global setting as said on the phone. */
function settingText(s: Settings, key: keyof ForgeSettingsPatch | "alwaysOnTop"): string {
  const m = tr().phone;
  switch (key) {
    case "defaultModel":
      return m.settings.defaultModel(s.defaultModel);
    case "defaultEffort":
      return m.settings.defaultEffort(s.defaultEffort);
    case "defaultProfile":
      return m.settings.defaultProfile(s.defaultProfile);
    case "defaultProjectDir":
      return s.defaultProjectDir ? m.settings.projectDir(asData(s.defaultProjectDir)) : m.settings.noProjectDir;
    case "language":
      return m.settings.language(m.settings.languageNames[s.language]);
    case "sounds":
      return m.settings.sounds(s.sounds);
    case "desktopNotifications":
      return m.settings.desktopNotifications(s.desktopNotifications);
    case "enterToSend":
      return s.enterToSend ? m.settings.enterSends : m.settings.enterNewLine;
    case "autoContinueAfterLimit":
      return m.settings.autoContinue(s.autoContinueAfterLimit);
    case "idleCloseMinutes":
      return s.idleCloseMinutes > 0 ? m.settings.idleClose(s.idleCloseMinutes) : m.settings.idleOpen;
    case "longSessionTokens":
      return s.longSessionTokens > 0 ? m.settings.longSession(Math.round(s.longSessionTokens / 1000)) : m.settings.longSessionOff;
    case "updateChecks":
      return m.settings.updateChecks(s.updateChecks);
    case "updateChannel":
      return m.settings.updateChannel(s.updateChannel);
    case "learnTemplates":
      return m.settings.learnTemplates(s.learnTemplates);
    case "usageStats":
      return m.settings.usageStats(s.usageStats);
    case "debugLogs":
      return m.settings.debugLogs(s.debugLogs);
    case "stripApiKey":
      return s.stripApiKey ? m.settings.stripApiKey : m.settings.passApiKey;
    case "screenshotKey":
      return s.screenshotKey ? m.settings.screenshotKey : m.settings.windowsScreenshot;
    case "uiCompare":
      return m.settings.uiCompare(s.uiCompare);
    case "alwaysOnTop":
      return m.settings.alwaysOnTop(s.alwaysOnTop);
    case "policyRule":
    case "policyRuleOn":
      return s.disabledPolicyRules.length ? m.settings.policyOff(s.disabledPolicyRules.map((r) => policyRuleLabel(r)).join(", ")) : m.settings.policyAllOn;
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
        if (!c.path) throw new ForgeError("CLAUDE_NOT_INSTALLED", tr().phone.line.claudeNotFound);
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
    if (this.busy) throw new Error(tr().phone.line.syncDuringCall);
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
      throw new ForgeError("VALIDATION", tr().phone.line.notSetUp(missing), details);
    }
    this.persistEnabled(true);
    await this.startDesk();
    await this.connect().catch((e: unknown) => this.fail(e));
    return this.state();
  }

  private missingSetup(): string | null {
    const m = tr().phone.line;
    if (!this.cfg.server || !this.cfg.username) return m.missingServer;
    if (!this.d.secrets.has(SECRET_PASSWORD)) return m.missingSipPassword;
    if (this.cfg.engine === "gemini-live") {
      if (!this.d.secrets.has(SECRET_GEMINI)) return m.missingGeminiLive;
      return null;
    }
    if (this.cfg.speechProvider === "openai" && !this.d.secrets.has(SECRET_OPENAI)) return m.missingOpenAi;
    if (this.cfg.speechProvider === "gemini" && !this.d.secrets.has(SECRET_GEMINI)) return m.missingGemini;
    if (!this.d.claude().path) return m.missingClaude;
    return null;
  }

  private fail(e: unknown) {
    this.registration = "failed";
    const msg = errorText(e);
    this.message = /ENOTFOUND|EAI_AGAIN/.test(msg) ? tr().phone.line.serverNotFound(this.cfg.server) : msg.slice(0, 300);
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
      this.desk.message = /EADDRINUSE/.test(msg) ? tr().phone.line.deskPortBusy(c.httpPort) : msg;
    }
    this.emitState();
  }

  /** Shows a test message on the desk phone and sends keys, LEDs and display again. */
  async deskTest(): Promise<PhoneState> {
    const m = tr().phone.line;
    if (!this.desk.running) throw new ForgeError("VALIDATION", this.desk.message ?? m.deskOff);
    this.desk.notice("FORGE", m.deskTest);
    this.desk.forceRefresh();
    return this.state();
  }

  /** A session key on the desk phone during a call: the conversation is about that session now. */
  private keyInCall(sessionId: string) {
    const a = this.active;
    if (!a?.controller) return;
    let title = tr().phone.untitled;
    try {
      title = this.d.sessions.get(sessionId).title ?? title;
    } catch {
      return;
    }
    a.focus = sessionId;
    a.controller.note(tr().phone.notes.deskKey(this.refFor(a, sessionId), asData(title)));
    this.desk.refresh();
  }

  /**
   * The sessions as the conversation partner knows them from the start, so "the login thing" or "what
   * is it doing" needs no lookup first: running ones with their last answer, then the newest ended ones.
   */
  private overview(a: ActiveCall): string {
    const m = tr().phone;
    const live = this.d.sessions.listLive();
    const recent = this.d.sessions
      .listAll()
      .filter((s) => !s.live)
      .slice(0, OVERVIEW_RECENT);
    if (!live.length && !recent.length) return m.status.none;
    const line = (s: (typeof recent)[number], withLast: boolean) => {
      const pending = s.status === "waiting_approval" ? m.status.open(pendingText(this.d.db, s.id, true)) : "";
      const last = withLast ? lastAnswer(this.d.db, s.id) : "";
      return m.status.line(this.refFor(a, s.id), asData(s.title ?? m.untitled), s.projectName, statusText(s), pending) + (last ? m.context.lastAnswer(excerptData(last, OVERVIEW_ANSWER_MAX)) : "");
    };
    return [live.length ? live.map((s) => line(s, true)).join("\n") : m.status.noActive, recent.length ? m.status.recent(recent.map((s) => line(s, false)).join("\n")) : ""]
      .filter(Boolean)
      .join("\n");
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
    if (!password) throw new Error(tr().phone.line.missingSipPassword);
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
    const m = tr().phone;
    const asked = new Date(due.createdAt).toLocaleTimeString(m.locale, { hour: "2-digit", minute: "2-digit" });
    try {
      await this.dial(
        due.number ? [due.number] : this.notifyTargets(),
        m.dial.callbackReason(due.about),
        m.dial.callbackOpening(asked, asData(due.about)),
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
    await this.active?.call.hangup(tr().phone.call.hungUpInForge);
    return this.state();
  }

  async testCall(): Promise<PhoneState> {
    const numbers = activeNumbers(this.cfg.notifyNumbers);
    const m = tr().phone;
    if (!numbers.length) throw new ForgeError("VALIDATION", m.line.noNumberForTest);
    await this.dial(
      numbers,
      m.dial.testReason,
      m.dial.testOpening,
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
      if (!apiKey) throw new Error(tr().phone.line.missingGemini);
      return { engine: "gemini-live", apiKey };
    }
    if (this.cfg.speechProvider === "gemini") {
      const key = await this.d.secrets.get(SECRET_GEMINI);
      if (!key) throw new Error(tr().phone.line.missingGemini);
      return { engine: "claude", voice: this.f.geminiVoice(key, { voice: this.cfg.geminiVoice, sttModel: this.cfg.geminiSttModel, ttsModel: this.cfg.geminiTtsModel }) };
    }
    const key = await this.d.secrets.get(SECRET_OPENAI);
    if (!key) throw new Error(tr().phone.line.missingOpenAi);
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
    const m = tr().phone;
    const pinHash = this.cfg.pinHash;
    const live = speech.engine === "gemini-live";
    const incoming = a.call.direction === "in";
    let picked = "";
    if (incoming && a.focus) {
      try {
        const s = this.d.sessions.get(a.focus);
        picked = m.context.picked(this.refFor(a, a.focus), asData(s.title ?? m.untitled));
      } catch {
        a.focus = null;
      }
    }
    const context = [
      m.context.today(new Date().toLocaleString(m.locale, { dateStyle: "full", timeStyle: "short" })),
      incoming
        ? live
          ? m.context.incomingLive(a.call.remoteNumber)
          : m.context.incoming(a.call.remoteNumber, m.greeting)
        : // The reason holds session titles and the words of an agreed callback: data, not instructions.
          m.context.outgoing(a.call.remoteNumber, asData(a.info.reason ?? "")),
      picked,
      this.cfg.requirePin ? (pinHash ? m.context.pinLocked : m.context.noPin) : m.context.open,
      // Before the PIN no titles or results: they can be confidential. The overview follows the unlock.
      this.cfg.requirePin ? "" : m.context.overview(this.overview(a)),
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
        return m.notes.overview(this.overview(a));
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
        greeting: incoming ? (picked ? m.greetingShort : m.greeting) : null,
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
        greeting: incoming ? m.greeting : null,
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
    const line = tr().phone.line;
    if (this.busy) return reject(486, "Busy Here", line.busy);
    if (this.ua !== ua) return reject(503, "Service Unavailable", line.reconnecting);
    if (!activeNumbers(this.cfg.allowedCallers).some((n) => sameNumber(n, call.remoteNumber))) {
      this.d.log(`Telefon: Anruf von ${call.remoteNumber || "unbekannt"} abgewiesen (nicht freigegeben)`);
      return reject(403, "Forbidden", line.notAllowed);
    }
    const offer = parseSdp(call.remoteSdp);
    const codec = offer && !offer.secure ? chooseCodec(offer) : null;
    if (!offer || codec === null) return reject(488, "Not Acceptable Here", line.codecUnsupported);
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
      else void call.hangup(tr().phone.call.technicalError);
    }
  }

  /**
   * Calls the user (notifications, test call, callbacks); the first words are prepared while it rings.
   * Several numbers ring at once; the first to answer takes the call, the others are cancelled.
   */
  private async dial(numbers: string[], reason: string, opening: string, refs: Map<string, string>, focus: string | null) {
    const line = tr().phone.line;
    if (this.busy) throw new ForgeError("SESSION_BUSY", line.busy);
    if (!numbers.length) throw new ForgeError("VALIDATION", line.noNumberOn);
    const ua = this.ua;
    if (!ua || this.registration !== "registered") throw new ForgeError("VALIDATION", line.notRegistered);
    this.dialing = true;
    let rtp: RtpSession | null = null;
    let a: ActiveCall | null = null;
    try {
      // Fails early (e.g. no API key) before the phone rings.
      const speech = await this.speech();
      rtp = this.f.rtp(ua.bindIp);
      await rtp.open();
      if (this.ua !== ua) throw new Error(line.switchedOff);
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
          void call.hangup(tr().phone.call.technicalError);
        }
      });
      controller.prepare();
    } catch (e) {
      rtp?.close();
      if (a) {
        a.failure = errorText(e);
        await a.call.hangup(tr().phone.call.cancelled);
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
    const m = tr().phone.callSettings;
    if (!q) throw new Error(m.whichNumber);
    const found = entries.filter((n) => sameNumber(n.number, q) || (n.label && n.label.toLowerCase() === q.toLowerCase()));
    const name = (n: PhoneNumberEntry) => asData(n.label ? `${n.label} (${n.number})` : n.number);
    if (c.action === "add") {
      if (!normalizeNumber(q)) throw new Error(m.notANumber);
      const hit = found[0];
      const next = hit ? entries.map((n) => (n === hit ? { ...n, enabled: true } : n)) : [...entries, { id: randomUUID(), number: q, label: c.label?.trim() ?? "", enabled: true }];
      await this.saveConfig({ [key]: next });
      return hit ? m.alreadyListed(name(hit)) : m.added(name(next.at(-1)!));
    }
    if (!found.length) throw new Error(m.notFound(q, numberListing(m.present, entries)));
    if (found.length > 1) throw new Error(m.many(q, found.map(name).join(", ")));
    const hit = found[0]!;
    if (c.action === "remove") {
      await this.saveConfig({ [key]: entries.filter((n) => n !== hit) });
      return m.removed(name(hit));
    }
    const on = c.action === "on";
    await this.saveConfig({ [key]: entries.map((n) => (n === hit ? { ...n, enabled: on } : n)) });
    return m.switched(name(hit), on);
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
      a.controller?.note(tr().phone.notes.codeExpired);
      return true;
    }
    if (digit === "*") {
      a.confirm = null;
      a.controller?.note(tr().phone.notes.codeCancelled);
      return true;
    }
    if (digit !== "#") {
      if (c.entered.length < 8) c.entered += digit;
      return true;
    }
    a.confirm = null;
    if (c.entered !== c.code) {
      this.d.log("Telefon: Löschen nicht bestätigt (falscher Code)");
      a.controller?.note(tr().phone.notes.codeWrong);
      return true;
    }
    this.d.log("Telefon: Löschen über die Tastatur bestätigt");
    void c
      .run()
      .catch((e: unknown) => tr().phone.error(errorText(e)))
      .then((result) => a.controller?.note(tr().phone.notes.confirmed(result)));
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
    const m = tr().phone;
    let title: string;
    try {
      title = this.d.sessions.get(sessionId).title ?? m.untitled;
    } catch {
      return false;
    }
    const open = !this.cfg.requirePin || a.info.unlocked;
    a.controller.note(open ? m.notes.urgent(this.refFor(a, sessionId), asData(title), excerptData(message, 500)) : m.notes.urgentLocked);
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
    const m = tr().phone;
    const title = session.title ?? m.untitled;
    const result = body?.type === "turn.result" ? (body.text ?? lastAnswer(this.d.db, sessionId)) : lastAnswer(this.d.db, sessionId);
    const failure = body?.type === "turn.result" ? (body.text ?? body.subtype) : body?.type === "error" ? body.message : "";
    const what =
      body?.type === "notify"
        ? m.dial.notifyWhat(asData(title), project.name, excerptData(body.message, 500))
        : kind === "done"
        ? m.dial.doneWhat(asData(title), project.name, excerptData(result, 1500))
        : kind === "approval"
          ? m.dial.approvalWhat(asData(title), project.name, pendingText(this.d.db, sessionId))
          : m.dial.errorWhat(asData(title), project.name, excerptData(failure, 1500));
    const reason =
      kind === "notify" ? m.dial.notifyReason(title) : kind === "done" ? m.dial.doneReason(title) : kind === "approval" ? m.dial.approvalReason(title) : m.dial.errorReason(title);
    this.lastNotifyAt = Date.now();
    await this.dial(
      this.notifyTargets(),
      reason,
      m.dial.opening(what),
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
      return this.cfg.pinHash ? tr().phone.common.locked : tr().phone.common.lockedNoPin;
    };
    const refFor = (id: string) => this.refFor(a, id);
    const resolve = (ref: string) => {
      const m = tr().phone;
      const raw = ref.trim();
      if (!raw) throw new Error(m.common.whichSession);
      const key = raw.toUpperCase().replace(/\s+/g, "");
      if (/^S?\d+$/.test(key)) {
        const r = key.startsWith("S") ? key : `S${key}`;
        const id = a.refs.get(r);
        if (!id) throw new Error(m.common.refUnknown(r));
        return sessions.get(id);
      }
      const q = raw.toLowerCase();
      const all = sessions.listAll();
      const exact = all.filter((s) => (s.title ?? "").toLowerCase() === q);
      let hits = exact.length ? exact : all.filter((s) => (s.title ?? "").toLowerCase().includes(q) || s.projectName.toLowerCase().includes(q));
      if (!hits.length) {
        // Spoken names are often misheard; a close title still means that session.
        const { best, close } = bestByName(raw, all, (s) => `${s.title ?? ""} ${s.projectName}`);
        hits = best ? [best] : close;
      }
      if (!hits.length) throw new Error(m.common.noSession(raw));
      if (hits.length > 1) {
        const names = hits.slice(0, 5).map((s) => `${refFor(s.id)} ${asData(s.title ?? m.untitled)}`);
        throw new Error(m.common.manySessions(raw, names.join(", ")));
      }
      return hits[0]!;
    };
    /**
     * A project by name. Worktrees (agents) are named "<project> · <branch>"; one only counts when the
     * caller names its branch part, so "shop" means the project and not every agent of it.
     */
    const findProject = (name: string) => {
      const m = tr().phone.common;
      const q = name.trim().toLowerCase();
      const all = this.d.projects.all().filter((p) => p.exists);
      const roots = all.filter((p) => !p.parentId);
      // Before the PIN no project names: like session titles they can be confidential.
      const known = () => (locked() ? "" : m.known(roots.map((x) => x.name).join(", ")));
      if (!q) throw new Error(m.whichProject(known()));
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
      if (hits.length > 1) throw new Error(m.manyProjects(name, locked() ? null : hits.map((x) => x.name).join(", ")));
      throw new Error(m.noProject(name, known()));
    };
    /** The project of a session (also an agent's worktree) when one is named, else the project by name. */
    const target = (projectName: string, o?: { session?: string }) => {
      if (!o?.session?.trim()) return findProject(projectName);
      const s = resolve(o.session);
      const p = this.d.projects.get(s.projectId);
      if (!p.exists) throw new Error(tr().phone.common.folderGone(refFor(s.id)));
      return p;
    };
    const minutesSince = (iso: string) => {
      const m = tr().phone.common;
      const n = Math.round((Date.now() - Date.parse(iso)) / 60_000);
      return n < 1 ? m.justNow : n === 1 ? m.oneMinute : m.minutes(n);
    };
    const tail = (text: string, lines: number) => text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n");
    /** Runs a tool; errors become text for Claude. Steering tools (`steer`) need the PIN. */
    const run = async (steer: boolean, fn: () => Promise<string>): Promise<string> => {
      const l = steer ? locked() : null;
      if (l) return l;
      try {
        return await fn();
      } catch (e) {
        return tr().phone.error(errorText(e));
      }
    };
    /**
     * Irreversible actions (deleting folders, repositories, sessions, branches with commits, removing
     * from FORGE) run only after the caller typed a code on the keypad; see PendingConfirm. `what` is
     * what the model tells the caller. A pending code is never replaced silently.
     */
    const askKeypad = (what: string, act: () => Promise<string>, nothingYet?: string): string => {
      const m = tr().phone.common;
      if (a.confirm && Date.now() <= a.confirm.expiresAt) return m.keypadBusy;
      const code = String(randomInt(0, 1000)).padStart(3, "0");
      a.confirm = { code, entered: "", expiresAt: Date.now() + CONFIRM_TTL_MS, run: act };
      return m.keypad(nothingYet ?? m.nothingDeleted, what, code.split("").join(" "));
    };
    const projectChanged = (projectId: string) => this.d.emit({ event: "project.updated", payload: { projectId } });
    const call: PhoneRpc = (method, params) => {
      if (!this.d.rpc) throw new Error(tr().phone.common.unavailable);
      return this.d.rpc(method, params);
    };
    /** a project when one or a session is named, else null (global) */
    const optionalTarget = (projectName: string | undefined, o?: { session?: string }) => (projectName?.trim() || o?.session?.trim() ? target(projectName ?? "", o) : null);
    const projectText = (p: Project) => {
      const m = tr().phone.projects;
      return [
        m.profile(p.profile),
        m.model(p.defaultModel),
        m.effort(p.defaultEffort),
        p.testCommand ? m.testCommand(asData(p.testCommand)) : m.noTestCommand,
        p.devCommand ? m.devCommand(asData(p.devCommand)) : m.devDetected,
        p.gitEnabled ? m.withGit : m.withoutGit,
        ...(p.parentId || p.agentsEnabled ? [] : [m.withoutAgents]),
        ...(p.group ? [m.group(p.group)] : []),
      ].join(", ");
    };
    /** Git, pull requests and agents are refused for a project set up without git. */
    const gitOff = (p: Project) => tr().phone.common.gitOff(p.name);
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
      const m = tr().phone.common;
      if (!hit) throw new Error(list.length ? m.onlyMessages(refFor(sessionId), list.length) : m.noMessage(refFor(sessionId)));
      return hit;
    };
    const backups = async () => (await call("backup.list", {})).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const updateText = (st: ResultOf<"app.updateState">) => {
      const m = tr().phone.system;
      if (!st.installable) return m.devVersion(st.currentVersion);
      if (st.phase === "error") return tr().phone.error(st.message ?? m.updateCheckFailed);
      if (st.phase === "checking") return m.checking;
      if (!st.latest || st.phase === "uptodate" || st.phase === "idle") return m.upToDate(st.currentVersion);
      const state = st.phase === "ready" ? m.ready : st.phase === "downloading" ? m.downloading : "";
      return m.available(st.latest.version, st.currentVersion, state) + (st.channel === "dev" ? m.devUpdate : "");
    };
    const installText = (st: ResultOf<"app.installState">) => {
      const m = tr().phone.system;
      if (!st.checkable) return m.installDev;
      if (st.complete === null) return m.installChecking;
      if (st.complete) return m.installComplete;
      const what = m.installIncomplete(st.problems.map((p) => p.label).join(", "));
      if (st.phase === "searching") return m.installSearching(what);
      const inst = st.installer;
      if (!inst) return `${what} ${st.message ?? m.noInstaller}`;
      const from = inst.source === "local" ? m.installerLocal(inst.version) : m.installerRemote(inst.version, inst.size ? Math.max(1, Math.round(inst.size / 1048576)) : null);
      const then = inst.then ? m.installerThen(inst.then) : "";
      return m.installRepairHint(what, from, then);
    };
    const removal = { projects: this.d.projects, sessions, worktrees: this.d.worktrees, devServers: this.d.devServers };
    /** Prompt templates: list, send with values for their placeholders, save, sort and delete. */
    const templateAction = async (action: SessionsArgs[0], o: SessionsArgs[1]): Promise<string> => {
      const m = tr().phone;
      const s = o?.session?.trim() ? resolve(o.session) : null;
      const p = s ? this.d.projects.get(s.projectId) : o?.project?.trim() ? findProject(o.project) : null;
      const list = await call("templates.list", p ? { projectId: p.id } : { all: true });
      const names = new Map(this.d.projects.all().map((x) => [x.id, x.name]));
      const where = (t: PromptTemplate) => (t.projectId ? m.templates.onlyProject(names.get(t.projectId) ?? m.templates.aProject) : m.templates.global);
      const pickTemplate = () => {
        const q = o?.template?.trim() ?? "";
        const hits = q ? findTemplates(q, list) : [];
        return hits.length === 1 ? hits[0]! : pickOne(hits.length > 1 ? hits : list, q, (t) => [t.name], { none: m.common.what.templateNone, many: m.common.what.templateMany });
      };
      if (action === "templates") {
        if (!list.length) return p ? m.templates.noneFor(p.name) : m.templates.none;
        const lines = list.slice(0, 15).map((t) => {
          const holes = templatePlaceholders(t.text);
          return `${t.name} (${where(t)}${t.learned ? m.templates.learned : ""})${t.description ? `: ${t.description}` : ""}${holes.length ? m.templates.placeholders(holes.join(", ")) : ""}`;
        });
        return `${m.templates.count(list.length, list.length > 15)}:\n${asData(lines.join("\n"))}`;
      }
      if (action === "template_send") {
        const t = pickTemplate();
        if (!p) return m.templates.whereTo;
        const status = await call("projects.get", { projectId: p.id }).catch(() => null);
        const given = Object.fromEntries((o?.values ?? []).map((v) => [v.name.replace(/[{}]/g, "").trim(), v.value]));
        const values = { ...knownTemplateValues(t.text, { project: p.name, branch: status?.git?.branch ?? null, date: localDate(new Date()) }), ...given };
        const filled = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v.trim()]));
        const missing = templatePlaceholders(t.text).filter((n) => !filled.get(n.toLowerCase()));
        if (missing.length) return m.templates.missingValues(asData(t.name), asData(missing.join(", ")));
        const text = fillTemplate(t.text, values);
        if (s) {
          await call("sessions.send", { sessionId: s.id, text });
          a.focus = s.id;
          return m.templates.sent(asData(t.name), refFor(s.id));
        }
        const started = await call("sessions.start", { projectId: p.id, prompt: text });
        a.focus = started.id;
        return m.templates.started(refFor(started.id), p.name, asData(t.name));
      }
      if (action === "template_save") {
        const existing = o?.template?.trim() ? pickTemplate() : null;
        const name = o?.name?.trim() || existing?.name;
        const text = o?.text?.trim() || existing?.text;
        if (!name) return m.templates.whatName;
        if (!text) return m.templates.whatText;
        const projectId = existing && !p ? existing.projectId : (p?.id ?? null);
        const saved = await call("templates.save", { id: existing?.id ?? null, projectId, name, description: o?.description?.trim() || existing?.description || null, text });
        return m.templates.saved(asData(saved.name), !!existing, where(saved));
      }
      const t = pickTemplate();
      if (action === "template_delete") {
        return askKeypad(m.templates.confirmDelete(asData(t.name), where(t)), async () => {
          const r = await call("templates.delete", { id: t.id });
          return r.ok ? m.templates.deleted(asData(t.name)) : m.templates.gone(asData(t.name));
        });
      }
      if (!o?.direction) return m.templates.upOrDown;
      const siblings = (await call("templates.list", t.projectId ? { projectId: t.projectId } : {})).filter((x) => x.projectId === t.projectId);
      const i = siblings.findIndex((x) => x.id === t.id);
      const j = o.direction === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= siblings.length) return m.templates.atEdge(asData(t.name), o.direction === "up");
      const ids = siblings.map((x) => x.id);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      await call("templates.reorder", { ids });
      return m.templates.moved(asData(t.name), j + 1, siblings.length, where(t));
    };

    return {
      status: () =>
        run(false, async () => {
          const live = sessions.listLive();
          const recent = sessions
            .listAll()
            .filter((s) => !s.live)
            .slice(0, 3);
          const m = tr().phone;
          if (!live.length && !recent.length) return m.status.none;
          if (locked()) {
            // Before the PIN only counts: titles and results can be confidential.
            const working = live.filter((s) => s.status === "running" || s.status === "starting").length;
            const waiting = live.filter((s) => s.status === "waiting_approval").length;
            return m.status.lockedCounts(live.length, working, waiting);
          }
          const line = (s: (typeof live)[number]) => {
            const pending = s.status === "waiting_approval" ? m.status.open(pendingText(db, s.id, true)) : "";
            return m.status.line(refFor(s.id), asData(s.title ?? m.untitled), s.projectName, statusText(s), pending);
          };
          return [live.length ? live.map(line).join("\n") : m.status.noActive, recent.length ? m.status.recent(recent.map(line).join("\n")) : ""]
            .filter(Boolean)
            .join("\n");
        }),
      details: (ref, o) =>
        run(true, async () => {
          const m = tr().phone;
          const s = resolve(ref);
          const project = this.d.projects.get(s.projectId);
          const last = lastAnswer(db, s.id);
          const setup = [s.model ? m.details.model(s.model) : "", s.permissionMode ? m.details.mode(s.permissionMode) : ""].filter(Boolean).join(", ");
          const kind = (taskType: string) => (/bash|shell/i.test(taskType) ? m.details.command : /agent/i.test(taskType) ? m.details.subagentKind : taskType);
          const tasks = [
            ...s.subagents.map((t) => m.details.subagent(asData(t.description), minutesSince(t.startedAt), t.summary ? excerptData(t.summary, 200) : "")),
            ...s.background.map((t) => m.details.background(kind(t.taskType), asData(t.description), minutesSince(t.startedAt), t.summary ? excerptData(t.summary, 200) : "")),
          ];
          const summary = o?.summary ? (await sessions.summarize(s.id)).summary : "";
          let context = "";
          try {
            const c = await sessions.contextUsage(s.id);
            if (c) context = m.details.context(Math.round(c.percentage));
          } catch {
            // Only a measurement; details work without it.
          }
          return [
            m.details.head(refFor(s.id), asData(s.title ?? m.untitled), project.name, statusText(s), setup, context),
            summary ? m.details.summary(excerptData(summary, 2000)) : "",
            m.details.last(last ? excerptData(last, 1500) : null),
            s.status === "waiting_approval" ? m.details.open(pendingText(db, s.id)) : "",
            tasks.length ? m.details.tasks(tasks.join("\n")) : "",
          ]
            .filter(Boolean)
            .join("\n");
        }),
      sendMessage: (ref, text) =>
        run(true, async () => {
          const s = resolve(ref);
          if (!text.trim()) return tr().phone.session.emptyMessage;
          await sessions.send(s.id, text);
          return tr().phone.session.sent(refFor(s.id));
        }),
      startSession: (projectName, prompt, o) =>
        run(true, async () => {
          const m = tr().phone.session;
          const found = findProject(projectName);
          if (!prompt.trim()) return m.emptyPrompt;
          const model = o?.model?.trim() || undefined;
          const effort = o?.effort;
          if (o?.agent && !found.gitEnabled) return m.agentNeedsGit(gitOff(found));
          if (o?.agent && !(found.parentId ? this.d.projects.get(found.parentId) : found).agentsEnabled) return m.agentsOff(found.name);
          if (!o?.agent) {
            const s = await sessions.start({ projectId: found.id, prompt, model, effort, planOnly: o?.planOnly });
            a.focus = s.id;
            return m.started(refFor(s.id), found.name);
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
          return m.agentStarted(refFor(s.id), root.name, warning);
        }),
      respond: (ref, decision, answers, feedback, scope) =>
        run(true, async () => {
          const m = tr().phone.session;
          const s = resolve(ref);
          const r = refFor(s.id);
          const req = openRequest(db, s.id);
          if (!req) return m.noRequest(r);
          let mapped: Record<string, string> | undefined;
          if (req.toolName === "AskUserQuestion" && decision === "allow") {
            const questions = questionTexts(req.input);
            const given = Object.entries(answers ?? {});
            if (!given.length) return m.needAnswers;
            mapped = {};
            given.forEach(([q, v], i) => {
              const exact = questions.find((x) => x === q) ?? questions.find((x) => x.toLowerCase().includes(q.toLowerCase())) ?? questions[i];
              if (exact) mapped![exact] = v;
            });
          }
          // Questions and plans are answered once; only a tool approval can hold for the whole session.
          const forSession = scope === "session" && decision === "allow" && req.toolName !== "AskUserQuestion" && req.toolName !== "ExitPlanMode";
          sessions.respondApproval(s.id, req.requestId, decision, forSession ? "session" : "once", feedback, mapped);
          if (decision !== "allow") return m.denied(r);
          return forSession ? m.allowedForSession(req.toolName, r) : m.allowed(r);
        }),
      stop: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          if (!["starting", "running", "waiting_approval", "stopping"].includes(s.status)) return tr().phone.session.notRunning(refFor(s.id));
          await sessions.stop(s.id);
          return tr().phone.session.stopped(refFor(s.id));
        }),
      close: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          sessions.close(s.id);
          return tr().phone.session.closed(refFor(s.id));
        }),
      sessionSettings: (ref, patch) =>
        run(true, async () => {
          const m = tr().phone.session;
          const s = resolve(ref);
          const done: string[] = [];
          const model = patch.model?.trim();
          if (model) {
            await sessions.setModel(s.id, model);
            done.push(m.model(model));
          }
          if (patch.effort) {
            await sessions.setEffort(s.id, patch.effort);
            done.push(m.effort(patch.effort));
          }
          if (patch.permissionMode) {
            await sessions.setPermissionMode(s.id, patch.permissionMode);
            done.push(m.mode(patch.permissionMode));
          }
          if (!done.length) return m.nothingToChange;
          return m.settingsSet(refFor(s.id), done.join(", "));
        }),
      cancelAutoContinue: (ref) =>
        run(true, async () => {
          const s = resolve(ref);
          sessions.cancelAutoContinue(s.id);
          return tr().phone.session.autoContinueCancelled(refFor(s.id));
        }),
      backgroundTask: (ref, action, task, text) =>
        run(true, async () => {
          const m = tr().phone.tasks;
          const s = resolve(ref);
          const r = refFor(s.id);
          const all = [
            ...s.background.map((t) => ({ taskId: t.taskId, toolUseId: t.toolUseId, description: t.description, background: true, command: /bash|shell/i.test(t.taskType), summary: t.summary })),
            ...s.subagents.map((t) => ({ taskId: t.taskId, toolUseId: t.toolUseId, description: t.description, background: false, command: false, summary: t.summary })),
          ];
          const names = (list: typeof all) => list.map((t) => asData(t.description)).join(", ");
          const find = () => {
            if (!all.length) throw new Error(m.none(r));
            const q = (task ?? "").trim().toLowerCase();
            if (!q && all.length === 1) return all[0]!;
            if (!q) throw new Error(m.which(names(all)));
            const hits = all.filter((t) => t.taskId.toLowerCase() === q || t.description.toLowerCase().includes(q));
            if (hits.length === 1) return hits[0]!;
            throw new Error(hits.length ? m.many(names(hits)) : m.notFound(task ?? "", r, names(all)));
          };
          if (action === "to_background") {
            const t = task?.trim() ? find() : null;
            if (t?.background) return m.alreadyBackground(asData(t.description));
            const { moved } = await sessions.toBackground(s.id, t?.toolUseId ?? undefined);
            return moved ? m.moved(r) : m.nothingToMove(r);
          }
          if (action === "message" && !text?.trim()) throw new Error(m.noText);
          const t = find();
          if (action === "message") {
            await sessions.messageTask(s.id, { taskId: t.taskId }, text!.trim());
            return t.command ? m.messageCommand(asData(t.description), r) : m.messageAgent(asData(t.description));
          }
          if (action === "stop") {
            await sessions.stopTask(s.id, t.taskId);
            return m.stopped(asData(t.description), r);
          }
          // Subagents have no command output; their progress line is what they are doing now.
          if (!t.command) return t.summary ? m.lastSummary(asData(t.description), excerptData(t.summary, 500)) : m.noSummary(asData(t.description));
          const out = await sessions.taskOutput(s.id, t.taskId);
          if (!out.output.trim()) return m.noOutput(asData(t.description));
          return m.output(asData(t.description), excerptData(tail(out.output, 30), 3000));
        }),
      alwaysOnTop: (action) =>
        run(action !== "status", async () => {
          if (action !== "status") {
            const next = this.d.db.updateSettings({ alwaysOnTop: action === "on" });
            // The main window applies it to itself; chat windows are pinned one by one.
            this.d.emit({ event: "settings.updated", payload: next });
          }
          return this.d.db.getSettings().alwaysOnTop ? tr().phone.windows.onTop : tr().phone.windows.notOnTop;
        }),
      chatWindow: (action, ref) =>
        // Also status before the PIN: it names session titles.
        run(true, async () => {
          const windows = this.d.chatWindows;
          const m = tr().phone.windows;
          if (!windows) return m.desktopOnly;
          const st = windows.get();
          if (action === "status") {
            if (!st.sessions.length) return m.none;
            const one = (id: string) => {
              const s = sessions.listAll().find((x) => x.id === id);
              const name = s ? `${refFor(id)} ${asData(s.title ?? tr().phone.untitled)}` : m.deleted;
              return st.pinned.includes(id) ? m.pinned(name) : name;
            };
            return m.list(st.sessions.map(one).join(", "));
          }
          const s = resolve(ref ?? "");
          const r = refFor(s.id);
          const open = st.sessions.includes(s.id);
          const pinned = st.pinned.includes(s.id);
          const target = { projectId: s.projectId, sessionId: s.id, title: s.title };
          if (action === "open") {
            if (open) return m.alreadyOpen(r);
            windows.request("open", target);
            return m.opening(r);
          }
          if (action === "close") {
            if (!open) return m.notOpen(r);
            windows.request("close", target);
            return m.closed(r);
          }
          if (action === "pin") {
            if (pinned) return m.alreadyPinned(r);
            windows.request("pin", target);
            return open ? m.pinnedNow(r) : m.openPinned(r);
          }
          if (!pinned) return m.notPinned(r);
          windows.request("unpin", target);
          return m.unpinned(r);
        }),
      remote: (action) =>
        run(action !== "status", async () => {
          const st = action === "on" ? await sessions.remoteStart() : action === "off" ? await sessions.remoteStop() : sessions.remoteState();
          const m = tr().phone.remote;
          if (!st.enabled) return m.off;
          const ok = st.sessions.filter((x) => x.state !== "error").length;
          const failed = st.sessions.filter((x) => x.state === "error");
          return [
            m.on(ok),
            failed.length ? m.failed(failed.map((x) => `${refFor(x.sessionId)} (${x.message ?? m.error})`).join(", ")) : "",
            st.sessions.length === 0 ? m.noneRunning : "",
          ]
            .filter(Boolean)
            .join(" ");
        }),
      devServer: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const dev = this.d.devServers;
          const m = tr().phone.dev;
          if (action === "setup" || action === "prepare") {
            if (!p.parentId) return m.notAgent(p.name);
            const st = action === "prepare" ? await call("worktrees.prepare", { projectId: p.id }) : await call("worktrees.setup", { projectId: p.id });
            if (!st) return m.noSetup(p.name);
            const steps = st.steps.filter((x) => x.status !== "pending").map((x) => `${x.label}: ${m.stepWord[x.status]}${x.detail ? ` (${excerptData(x.detail, 300)})` : ""}`);
            const head = action === "prepare" ? m.prepareRestarted(p.name) : st.status === "running" ? m.setupRunning(p.name) : st.status === "failed" ? m.setupFailed(p.name) : m.setupDone(p.name);
            return [head, ...steps, st.devPort ? m.devPort(st.devPort) : ""].filter(Boolean).join(" ");
          }
          if (action === "output") {
            const out = dev.output(p.id);
            return out.trim() ? m.output(p.name, excerptData(tail(out, 30), 3000)) : m.noOutput(p.name);
          }
          if (action === "stop" || action === "restart") await dev.stop(p.id);
          if (action === "stop") return m.stopped(p.name);
          const st = action === "status" ? await dev.state(p.id) : await dev.start(p.id);
          if (st.status === "running") return m.running(p.name, action === "restart", st.url || null);
          const why = st.error ?? (st.exitCode !== null ? m.exitCode(st.exitCode) : "");
          if (action !== "status") return m.notStarted(p.name, why, m.hint);
          return st.status === "stopped" ? m.notRunning(p.name) : m.ended(p.name, why, m.hint);
        }),
      testDatabase: (projectName, action, o) =>
        // A session named before the PIN would give its title away in errors.
        run(action !== "status" || !!o?.session?.trim(), async () => {
          const p = target(projectName, o);
          const db = this.d.testDb;
          const m = tr().phone.testDb;
          if (!db) return m.unavailable;
          if (action === "status") {
            const st = db.state(p.id);
            if (st.status === "running") return m.running(p.name);
            if (st.status === "installing") return m.installing(st.progress !== null ? Math.round(st.progress * 100) : null);
            if (st.status === "starting") return m.starting(p.name);
            if (st.status === "stopping") return m.stopping(p.name);
            if (st.status === "failed") return m.failed(p.name, st.error ?? null);
            return st.initialized ? m.stoppedState(p.name) : m.none(p.name);
          }
          if (action === "log") {
            const log = db.log(p.id);
            return log.trim() ? m.log(p.name, excerptData(tail(log, 20), 2500)) : m.logEmpty(p.name);
          }
          if (action === "stop") {
            await db.stop(p.id);
            return m.stopped(p.name);
          }
          if (action === "reset") {
            const wasRunning = db.isRunning(p.id);
            await db.reset(p.id);
            if (wasRunning) await db.start(p.id);
            return m.reset(p.name, wasRunning);
          }
          if (action === "restart") {
            await db.stop(p.id);
            await db.start(p.id);
            return m.restarted(p.name);
          }
          await db.start(p.id);
          return m.started(p.name);
        }),
      devSettings: (projectName, patch, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const tools = this.d.devTools;
          const ds = tr().phone.devSettings;
          if (!tools) return ds.unavailable;
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
              const file = pickOne(files, fromFile, (f) => [f, f.replace(/^\.env\.?/, "")], { none: tr().phone.common.what.envNone, many: tr().phone.common.what.envMany });
              for (const line of (await tools.readEnvFile(p.id, file)).split(/\r?\n/)) {
                const name = ENV_LINE.exec(line)?.[1];
                if (name) env = setEnvLine(env, name, line.trim());
              }
            }
            const set = patch.envSet?.trim();
            if (set) {
              const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s.exec(set);
              if (!m) return ds.envFormat;
              env = setEnvLine(env, m[1]!, `${m[1]}=${m[2]!.trim()}`);
            }
            const remove = patch.envRemove?.trim();
            if (remove) {
              if (!envNames(env).includes(remove)) return ds.envMissing(remove);
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
            ds.useEnv(cfg.useEnv),
            vars.length ? ds.vars(asData(vars.join(", "))) : "",
            ds.database(d.port, d.name, d.withDevServer, d.envVar || null),
          ]
            .filter(Boolean)
            .join(" ");
          if (!changed) return `${p.name}: ${text}`;
          // The settings belong to the project a worktree comes from; the UI keeps them under that id.
          projectChanged(p.parentId ?? p.id);
          const restart = (patch.port !== undefined || !!patch.name?.trim()) && this.d.testDb?.isRunning(p.id) ? ds.nextStart : "";
          // Agents share their project's settings and test database.
          return ds.saved(!!p.parentId, text, restart);
        }),
      projectAutomation: (projectName, patch, o) =>
        run(true, async () => {
          const named = target(projectName, o);
          // auto-merge is read from the main project; on a worktree the switch would do nothing.
          const p = patch.tag === AUTO_MERGE_TAG && named.parentId ? this.d.projects.get(named.parentId) : named;
          const am = tr().phone.automation;
          const on = (tags: string[]) => AUTOMATION_TAG_IDS.filter((t) => tags.includes(t)).map((t) => automationTagLabel(t));
          const state = (tags: string[]) => (on(tags).length ? am.on(on(tags).join(", ")) : am.none);
          if (!patch.tag) return `${p.name}: ${state(p.tags)}`;
          if (patch.on && !p.gitEnabled && GIT_TAGS.includes(patch.tag)) return am.needsGit(gitOff(p), automationTagLabel(patch.tag));
          if (patch.on === undefined) return am.state(p.name, automationTagLabel(patch.tag), p.tags.includes(patch.tag));
          const tags = patch.on ? [...new Set([...p.tags, patch.tag])] : p.tags.filter((t) => t !== patch.tag);
          const next = this.d.projects.update(p.id, { tags });
          projectChanged(p.id);
          return am.switched(automationTagLabel(patch.tag), p.name, !!patch.on, state(next.tags));

        }),
      knowledge: (projectName, query, id, remove, o) =>
        run(true, async () => {
          const p = findProject(projectName);
          const store = this.d.knowledge;
          const kn = tr().phone.knowledge;
          if (!store) return kn.unavailable;
          if (o?.autoMerge) {
            const plan = await call("knowledge.mergePlan", { projectId: p.id });
            if (!plan.groups.length) return kn.nothingToMerge(plan.model, p.name);
            const queue = [...plan.groups];
            const lines: string[] = [];
            const worker = async () => {
              for (let g = queue.shift(); g; g = queue.shift()) {
                try {
                  const draft = await call("knowledge.mergeDraft", { projectId: p.id, ids: g.ids });
                  const { entry, removed } = await call("knowledge.merge", { projectId: p.id, ids: g.ids, title: draft.title, summary: draft.summary, tags: draft.tags, content: draft.content });
                  lines.push(kn.mergedLine(entry.id, entry.title, removed.join(", ")));
                } catch (e) {
                  lines.push(kn.notMergedLine(g.ids.join(", "), e instanceof Error ? e.message : String(e)));
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(AUTO_MERGE_PARALLEL, queue.length) }, worker));
            return kn.autoMerged(plan.model, plan.groups.length, asData(lines.join("\n")));
          }
          if (o?.merge?.length) {
            const ids = [...new Set(o.merge)];
            if (ids.length < 2) return kn.needTwo;
            const draft = await call("knowledge.mergeDraft", { projectId: p.id, ids });
            const { entry, removed } = await call("knowledge.merge", { projectId: p.id, ids, title: draft.title, summary: draft.summary, tags: draft.tags, content: draft.content });
            return kn.merged(entry.id, asData(entry.title), removed.join(", "), draft.model);
          }
          if (o?.stale) {
            const { entries } = await call("knowledge.checkRefs", { projectId: p.id, refresh: false });
            const stale = entries.filter((e) => e.missing.length);
            if (!stale.length) return kn.noStale(p.name);
            const title = new Map(store.list(p.id).map((e) => [e.id, e.title]));
            return kn.stale(
              stale.length,
              asData(
                stale
                  .slice(0, 8)
                  .map((e) => kn.staleLine(e.id, title.get(e.id) ?? e.id, e.missing.slice(0, 4).map((x) => x.ref).join(", "), e.missing.length - 4))
                  .join("\n"),
              ),
            );
          }
          if (o?.markChecked || o?.fix) {
            const key = id?.trim();
            if (!key) return kn.needId;
            if (o.markChecked) {
              const { verified } = await call("knowledge.markChecked", { projectId: p.id, id: key });
              return verified.length ? kn.checked(key, asData(verified.join(", "))) : kn.noMissing(key);
            }
            const draft = await call("knowledge.fixDraft", { projectId: p.id, id: key });
            const entry = await call("knowledge.save", { projectId: p.id, id: key, title: draft.title, summary: draft.summary, tags: draft.tags, content: draft.content });
            return kn.fixed(draft.model, entry.id, asData(entry.title));
          }
          if (o?.cleanup) {
            const { overlaps, long } = await call("knowledge.cleanup", { projectId: p.id });
            if (!overlaps.length && !long.length) return kn.clean(p.name);
            const title = new Map(store.list(p.id).map((e) => [e.id, e.title]));
            const name = (k: string) => `${k} (${title.get(k) ?? k})`;
            return asData(
              [
                ...overlaps.slice(0, 5).map((x) => kn.overlap(Math.round(x.score * 100), name(x.a), name(x.b))),
                ...long.slice(0, 5).map((l) => kn.long(Math.round(l.chars / 1000), name(l.id))),
              ].join("\n"),
            );
          }
          if (remove) {
            const key = id?.trim();
            if (!key) return kn.needIdDelete;
            return (await store.delete(p.id, key)) ? kn.deleted(key, p.name) : kn.notFound(p.name, key);
          }
          if (id?.trim()) {
            const e = await store.read(p.id, id.trim());
            return asData(`${e.title}. ${e.summary}\n${e.content.slice(0, 4000)}`);
          }
          const hits = store.search(p.id, query, 5);
          if (!hits.length) return store.list(p.id).length ? kn.nothing(p.name) : kn.empty(p.name);
          return asData(hits.map((h) => `${h.id}: ${h.title}. ${h.summary} ${h.snippet}`).join("\n"));
        }),
      rememberNote: (projectName, title, text) =>
        run(true, async () => {
          const p = findProject(projectName);
          const store = this.d.knowledge;
          const kn = tr().phone.knowledge;
          if (!store) return kn.unavailable;
          const note = text.trim();
          if (!note) return kn.emptyNote;
          const stamp = new Date().toLocaleDateString(tr().phone.locale);
          const near = store.similar(p.id, title)[0];
          if (near) {
            const e = await store.read(p.id, near.id);
            await store.save(p.id, { id: e.id, title: e.title, summary: e.summary, tags: e.tags, content: `${e.content.trimEnd()}\n\n${kn.noteLine(stamp, note)}\n` });
            return kn.noteAdded(e.title);
          }
          const e = await store.save(p.id, { id: null, title: title.trim() || kn.noteTitle, summary: note.length > 160 ? `${note.slice(0, 157)}...` : note, tags: [kn.noteTag], content: `${kn.noteLine(stamp, note)}\n` });
          return kn.noteSaved(e.title, p.name);
        }),
      git: (projectName, action, o) =>
        run(true, async () => {
          const gm = tr().phone.git;
          if (action === "account") {
            const acc = await call("github.account", {});
            if (!acc) return gm.notSignedIn;
            const orgs = await call("github.orgs", {}).catch(() => []);
            const inOrgs = orgs.length ? gm.orgs(asData(orgs.map((o) => o.login).join(", "))) : "";
            return gm.account(acc.login, acc.name || null, inOrgs);
          }
          if (action === "identity") {
            const name = o?.name?.trim();
            const email = o?.email?.trim();
            if (name || email) {
              if (!name || !email) return gm.identityNeedsBoth;
              const id = await call("git.setIdentity", { name, email });
              return gm.identitySet(id.name ?? "", id.email ?? "");
            }
            const id = await call("git.identity", {});
            return id.name || id.email ? gm.identity(id.name ?? null, id.email ?? null) : gm.noIdentity;
          }
          const p = target(projectName, o);
          if (!p.gitEnabled) return gitOff(p);
          const git = this.d.git;
          if (action === "fetch") {
            const inc = await call("git.incoming", { projectId: p.id });
            if (!inc) {
              const { summary: s } = await call("git.fetch", { projectId: p.id });
              return s.behind ? gm.behind(p.name, s.behind) : gm.upToDate(p.name);
            }
            const own = [inc.ahead ? gm.notPushed(inc.ahead) : "", inc.changedCount ? gm.changedCount(inc.changedCount) : ""].filter(Boolean).join(", ");
            if (!inc.behind) return gm.upToDate(p.name);
            const subjects = inc.commits.slice(0, 5).map((c) => `${c.subject} (${c.author})`);
            return gm.incoming(p.name, inc.branch, inc.behind, asData(subjects.join("; ")), own);
          }
          if (action === "reset_to_remote") {
            const busy = sessions.listAll().some((x) => x.projectId === p.id && x.live && (x.status === "running" || x.status === "waiting_approval"));
            if (busy) return gm.sessionBusyReset(p.name);
            const branch = (await git.currentBranch(p.path)) ?? "";
            return askKeypad(gm.confirmReset(p.name, branch), async () => {
              const r = await call("git.resetToRemote", { projectId: p.id });
              return gm.resetDone(p.name, r.branch, r.stashed, r.backupBranch);
            });
          }
          if (action === "branches") {
            const list = await call("git.branches", { projectId: p.id });
            if (!list.length) return gm.noBranches(p.name);
            const current = list.find((b) => b.current)?.name;
            const others = list.filter((b) => !b.current).map((b) => b.name);
            const rest = others.length ? gm.otherBranches(asData(others.slice(0, 15).join(", ")), others.length - 15) : "";
            return gm.branches(p.name, list.length, current, rest);
          }
          if (action === "delete_branch") {
            const branch = o?.branch?.trim();
            if (!branch) return gm.whichBranch;
            const del = async () => {
              await call("git.deleteBranch", { projectId: p.id, branch, force: o?.force === true });
              return gm.branchDeleted(branch, p.name);
            };
            // Without force git refuses a branch whose commits are nowhere else; with force they are gone.
            if (o?.force !== true) return await del();
            return askKeypad(gm.confirmDeleteBranch(asData(branch), p.name), del);
          }
          if (action === "diff") {
            const st = await call("git.status", { projectId: p.id });
            if (!st.files.length) return gm.noChanges(p.name);
            if (!o?.path?.trim()) {
              const names = st.files.slice(0, 15).map((f) => f.path);
              return gm.changedFiles(p.name, asData(names.join(", ")), st.files.length - 15);
            }
            const f = pickOne(st.files, o.path.replace(/\\/g, "/"), (x) => [x.path], { none: tr().phone.common.what.changedNone, many: tr().phone.common.what.changedMany });
            if (f.kind === "untracked") return gm.untracked(asData(f.path));
            if (isSensitiveFile(f.path)) return gm.sensitiveChanged(asData(f.path));
            const d = await call("git.diff", { projectId: p.id, path: f.path, staged: f.staged && !f.unstaged });
            if (d.binary) return gm.binary(asData(f.path));
            const lines = d.lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => `${l.kind === "add" ? gm.added : gm.removed}: ${l.text}`);
            return gm.diff(asData(f.path), d.additions, d.deletions, lines.length ? excerptData(lines.slice(0, 60).join("\n"), 3000) : "");
          }
          /** hash, position in the log (1 = newest) or words of the subject; null when the log has no such position */
          const commitHash = async (ref: string): Promise<string | null> => {
            if (!/^\d{1,2}$/.test(ref) && /^[0-9a-f]{7,40}$/i.test(ref)) return ref;
            const commits = await call("git.log", { projectId: p.id, limit: 30 });
            const c = /^\d{1,2}$/.test(ref) ? commits[Number(ref) - 1] : pickOne(commits, ref, (x) => [x.subject, x.shortHash], { none: tr().phone.common.what.commitNone, many: tr().phone.common.what.commitMany });
            return c?.hash ?? null;
          };
          if (action === "show") {
            const ref = o?.commit?.trim() || "1";
            const hash = await commitHash(ref);
            if (!hash) return gm.noCommit(p.name, ref);
            const d = await call("git.commitFiles", { projectId: p.id, commit: hash });
            if (o?.path?.trim()) {
              const f = pickOne(d.files, o.path.replace(/\\/g, "/"), (x) => [x.path], { none: tr().phone.common.what.commitFileNone, many: tr().phone.common.what.commitFileMany });
              if (isSensitiveFile(f.path)) return gm.sensitive(asData(f.path));
              if (f.binary) return gm.binary(asData(f.path));
              const diff = await call("git.commitDiff", { projectId: p.id, commit: hash, path: f.path, origPath: f.origPath ?? undefined });
              const lines = diff.lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => `${l.kind === "add" ? gm.added : gm.removed}: ${l.text}`);
              return gm.commitFileDiff(asData(f.path), diff.additions, diff.deletions, lines.length ? excerptData(lines.slice(0, 60).join("\n"), 3000) : "");
            }
            if (!d.files.length) return gm.commitNoFiles(p.name);
            const add = d.files.reduce((n, f) => n + f.additions, 0);
            const del = d.files.reduce((n, f) => n + f.deletions, 0);
            const names = d.files.slice(0, 15).map((f) => `${f.path} (+${f.additions} -${f.deletions})`);
            const rest = d.files.length > 15 ? tr().phone.common.andMore(d.files.length - 15) : "";
            const body = d.body ? gm.commitBody(excerptData(d.body, 1500)) : "";
            return gm.commitFiles(d.files.length, add, del, asData(names.join(", ")), rest, body);
          }
          if (action === "restore") {
            const ref = o?.commit?.trim();
            if (!ref) return gm.whichCommit;
            const hash = await commitHash(ref);
            if (!hash) return gm.noCommit(p.name, ref);
            const r = await call("git.restoreTo", { projectId: p.id, commit: hash });
            return gm.restored(p.name, asData(r.subject), r.changed, !!r.stashed);
          }
          if (action === "init") {
            await call("git.init", { projectId: p.id });
            return gm.initialized(p.name);
          }
          if (action === "publish") {
            const isPrivate = o?.private !== false;
            const owner = await resolveOwner(call, o?.owner);
            await call("github.publish", { projectId: p.id, private: isPrivate, name: o?.name?.trim() || undefined, owner: owner ?? undefined });
            return gm.published(p.name, isPrivate, owner);
          }
          if (action === "status") {
            const { summary: s } = await git.status(p.path);
            const sync = [s.ahead ? gm.notPushed(s.ahead) : "", s.behind ? gm.newerOnServer(s.behind) : ""].filter(Boolean);
            const parts = [gm.branch(s.branch ?? null), s.changedCount ? gm.changedCount(s.changedCount) : gm.clean, ...sync, s.conflicted ? gm.conflicts : ""];
            return gm.status(p.name, parts.filter(Boolean).join(", "));
          }
          if (action === "log") {
            const commits = await git.log(p.path, 5);
            if (!commits.length) return gm.noCommits(p.name);
            return gm.log(p.name, commits.map((c) => gm.logLine(asData(`${c.subject} (${c.author})`), dateTime(c.date))).join("\n"));
          }
          if (action === "checkout") {
            const branch = o?.branch?.trim();
            if (!branch) return gm.whichCheckout;
            const busy = sessions.listAll().some((x) => x.projectId === p.id && x.live && (x.status === "running" || x.status === "waiting_approval"));
            if (busy) return gm.sessionBusy(p.name);
            await git.checkout(p.path, branch, o?.create === true);
            projectChanged(p.id);
            return gm.checkedOut(p.name, branch, o?.create === true);
          }
          /** origin's commits did not go in automatically: Claude takes over, as in the Git tab */
          const handOver = async (e: unknown, push: boolean) => {
            const s = await startIntegrationSession(sessions, p.id, e, push);
            if (!s) throw e;
            projectChanged(p.id);
            a.focus = s.id;
            return gm.handOver(refFor(s.id), push);
          };
          if (action === "commit") {
            const st = await git.status(p.path);
            // Secrets and build output are never committed from the phone; the caller hears what was left out.
            const skipped = st.files.filter((f) => isSensitiveFile(f.path) || isArtifactPath(f.path)).map((f) => f.path);
            const paths = st.files.map((f) => f.path).filter((f) => !skipped.includes(f));
            if (!paths.length) return skipped.length ? gm.onlySkipped(skipped.join(", ")) : gm.noChanges(p.name);
            const message = o?.message?.trim() || (await sessions.suggestCommitMessage(p.id, paths)).message;
            await git.commit(p.path, message, paths, false);
            projectChanged(p.id);
            return gm.committed(p.name, asData(message.split("\n")[0]!), skipped.join(", "));
          }
          if (action === "push") {
            let r: Awaited<ReturnType<GitEngine["push"]>>;
            try {
              r = await git.push(p.path, o?.allowProtected === true);
            } catch (e) {
              return handOver(e, true);
            }
            projectChanged(p.id);
            const took = r.integrated ? gm.integrated(r.integrated.remoteCommits) : "";
            return gm.pushed(r.branch, p.name, took);
          }
          let r: Awaited<ReturnType<GitEngine["pull"]>>;
          try {
            r = await git.pull(p.path, o?.merge === true ? "merge" : "rebase");
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
          const pm = tr().phone.pr;
          if (!gh) return pm.unavailable;
          const git = this.d.git;
          const head = await git.currentBranch(p.path);
          if (!head) return pm.noBranch(p.name);
          const pr = await gh.prForBranch(p.path);
          if (action === "status") {
            if (!pr) return pm.none(head);
            const state = pr.state === "OPEN" ? (pr.draft ? pm.openDraft : pm.open) : pr.state === "MERGED" ? pm.merged : pr.state === "CLOSED" ? pm.closed : pr.state;
            const c = pr.checks;
            const checks = !c.total
              ? pm.noChecks
              : c.failed
                ? pm.checksFailed(c.failed, c.total)
                : c.pending
                  ? pm.checksPending(c.pending, c.total)
                  : pm.checksGreen(c.total);
            const review = pr.reviewDecision === "APPROVED" ? pm.approved : pr.reviewDecision === "CHANGES_REQUESTED" ? pm.changesRequested : pr.reviewDecision === "REVIEW_REQUIRED" ? pm.reviewRequired : "";
            return pm.status(pr.number, asData(pr.title), pr.head, pr.base, state, checks, review);
          }
          if (pr?.state === "OPEN") return pm.exists(head, pr.number, asData(pr.title));
          const base = await git.defaultBranch(p.path);
          if (head === base) return pm.onBase(p.name, base);
          const draft = await sessions.suggestPullRequest(p.id);
          // The PR needs the branch on GitHub; pushing a feature branch is always allowed.
          await git.push(p.path, false);
          await gh.createPr(p.path, { title: draft.title, body: draft.body, base: draft.base, head: draft.head, draft: o?.draft === true });
          projectChanged(p.id);
          return pm.created(asData(draft.title), draft.head, draft.base, !!o?.draft);
        }),
      removeAgent: (projectName, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const ag = tr().phone.agents;
          if (!p.parentId) return ag.notWorktreeRemove(p.name);
          const parentId = p.parentId;
          const removeIt = async () => {
            const r = await removeWorktree(p.id, o?.force === true, removal, { deleteBranch: o?.deleteBranch === true });
            projectChanged(parentId);
            const branch = r.deletedBranch ? ag.branchDeleted(r.deletedBranch) : r.branchError ? ag.branchError(r.branchError) : ag.branchKept;
            return ag.removed(p.name, branch);
          };
          if (o?.force !== true && o?.deleteBranch !== true) return await removeIt();
          const lost = [o?.force === true && ag.lostChanges, o?.deleteBranch === true && ag.lostBranch].filter(Boolean).join(ag.and);
          return askKeypad(ag.confirmRemove(p.name, lost), removeIt);
        }),
      finishAgent: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const ag = tr().phone.agents;
          if (!p.parentId) return ag.notWorktree(p.name);
          if (action === "review") {
            const r = await call("agents.review", { projectId: p.id });
            const facts = [
              ag.commits(r.ahead, r.branch ?? null, r.filesChanged),
              r.uncommitted ? ag.uncommitted(r.uncommitted) : "",
              r.behind ? ag.behind(r.targetBranch ?? null, r.behind) : "",
              r.busy ? ag.busy : "",
            ].filter(Boolean);
            return [
              ag.review(p.name, facts.join(", ")),
              r.commits.length ? ag.lastCommits(asData(r.commits.slice(0, 3).map((c) => c.subject).join("; "))) : "",
              r.summary.trim() ? ag.summary(excerptData(r.summary, 1500)) : "",
              r.mergeBlocker ? ag.blocked(r.mergeBlocker) : ag.canMerge(r.targetBranch ?? null),
            ]
              .filter(Boolean)
              .join("\n");
          }
          const finisher = this.d.agentFinish;
          if (!finisher) return ag.finishUnavailable;
          const finish = async () => (await finisher.finish(p.id, action)).message;
          if (action === "merge") return await finish();
          return askKeypad(ag.confirmDiscard(p.name), finish);
        }),
      projects: () =>
        run(true, async () => {
          const all = this.d.projects.all().filter((p) => p.exists);
          const pj = tr().phone.projects;
          if (!all.length) return pj.none;
          const live = sessions.listLive();
          const lines = await Promise.all(
            all.map(async (p) => {
              const n = live.filter((s) => s.projectId === p.id).length;
              const branch = p.gitEnabled ? await this.d.git.currentBranch(p.path).catch(() => null) : null;
              const dev = await this.d.devServers.state(p.id).then(
                (st) => st.status === "running",
                () => false,
              );
              return [p.name, p.group ? pj.group(p.group) : "", branch ? pj.branch(branch) : p.gitEnabled ? "" : pj.noGit, dev ? pj.devRunning : "", n ? pj.active(n) : ""].filter(Boolean).join(", ");
            }),
          );
          return lines.join("\n");
        }),
      project: (projectName, action, o) =>
        run(true, async () => {
          const pj = tr().phone.projects;
          const parentDir = async () => {
            const dir = o?.path?.trim() || (await call("settings.get", {})).defaultProjectDir;
            if (!dir) throw new Error(pj.whichFolder);
            return dir;
          };
          if (action === "create") {
            const name = o?.name?.trim();
            if (!name) return pj.whatName;
            const withGitHub = !!o?.github && o.git !== false;
            const owner = withGitHub ? await resolveOwner(call, o?.owner) : null;
            const r = await call("projects.create", { name, parentDir: await parentDir(), gitInit: o?.git !== false, gitEnabled: o?.git !== false, github: withGitHub ? { private: o?.github === "private", owner } : null });
            projectChanged(r.project.id);
            const gh = !r.github ? "" : r.github.url ? pj.githubCreated(o?.github === "public", owner) : pj.githubFailed(r.github.error ?? null);
            return pj.created(r.project.name, r.project.gitEnabled, gh);
          }
          if (action === "import") {
            const dir = o?.path?.trim();
            if (!dir) return pj.whichDir;
            const withGitHub = !!o?.github && o.git !== false;
            const owner = withGitHub ? await resolveOwner(call, o?.owner) : null;
            const p = await call("projects.import", { path: dir, gitEnabled: o?.git !== false });
            projectChanged(p.id);
            const forcedGit = o?.git === false && p.gitEnabled ? pj.forcedGit : "";
            const done = pj.imported(p.name, p.gitEnabled, forcedGit);
            if (!withGitHub) return done;
            try {
              await call("github.publish", { projectId: p.id, private: o?.github === "private", owner: owner ?? undefined });
              projectChanged(p.id);
              return `${done}${pj.githubCreated(o?.github === "public", owner)}`;
            } catch (e) {
              return `${done}${pj.githubFailed(e instanceof Error ? e.message : String(e))}`;
            }
          }
          if (action === "clone") {
            const raw = o?.url?.trim();
            if (!raw) return pj.whichRepo;
            let url = raw;
            if (!/:\/\/|@|\.git$/i.test(raw)) {
              // A spoken name ("shop api") against the repositories of the GitHub account.
              const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
              const repos = await call("github.repos", {});
              const repo = pickOne(repos, plain(raw), (r) => [r.fullName, plain(r.fullName.split("/").pop() ?? ""), plain(r.fullName)], { none: tr().phone.common.what.repoNone, many: tr().phone.common.what.repoMany });
              url = repo.cloneUrl;
            }
            const p = await call("projects.clone", { url, parentDir: await parentDir(), dirName: o?.name?.trim() || undefined });
            projectChanged(p.id);
            return pj.cloned(p.name);
          }
          if (action === "rename_group" || action === "dissolve_group") {
            const from = o?.group?.trim();
            if (!from) return pj.whichGroup;
            const to = action === "rename_group" ? o?.name?.trim() : null;
            if (to === "" || to === undefined) return pj.whatGroupName;
            const members = this.d.projects.all().filter((x) => x.group?.toLowerCase() === from.toLowerCase());
            const { count } = await call("projects.renameGroup", { from, to });
            for (const x of members) projectChanged(x.id);
            const name = members[0]?.group ?? from;
            return to ? pj.groupRenamed(name, to, count) : pj.groupDissolved(name, count);
          }
          const p = target(projectName, o);
          if (action === "group") {
            // A worktree shows under its project's group, so the project is the one that moves.
            const next = await call("projects.update", { projectId: p.parentId ?? p.id, group: o?.group?.trim() || null });
            projectChanged(next.id);
            return next.group ? pj.grouped(next.name, next.group) : pj.ungrouped(next.name);
          }
          if (action === "info") return pj.info(p.name, !!p.favorite, !!p.parentId, projectText(p));
          if (action === "remove") {
            if (p.parentId) return pj.isWorktree(p.name);
            const deleteFolder = o?.deleteFolder === true;
            const deleteGitHubRepo = o?.deleteGitHubRepo === true;
            const remove = async () => {
              const r = await call("projects.remove", { projectId: p.id, deleteFolder, deleteGitHubRepo });
              projectChanged(p.id);
              return [pj.removed(p.name), r.folderDeleted ? pj.folderDeleted : pj.folderKept, r.githubDeleted ? pj.repoDeleted : ""]
                .filter(Boolean)
                .join(" ");
            };
            // Even without folder or repository: the session history in FORGE goes with it.
            if (!deleteFolder && !deleteGitHubRepo) return askKeypad(pj.confirmRemove(p.name), remove);
            const info = await call("projects.removalInfo", { projectId: p.id });
            if (deleteGitHubRepo && !info.githubRepo) return pj.noRepo(p.name);
            if (deleteGitHubRepo && !info.githubSignedIn) return pj.notSignedIn;
            if (deleteGitHubRepo && !info.githubCanDelete) return pj.needsDeleteRepo;
            if (deleteFolder && info.folderBlocker) return tr().phone.error(info.folderBlocker);
            const what = [deleteFolder && pj.deleteFolder(p.name), deleteGitHubRepo && pj.deleteRepo(asData(info.githubRepo ?? ""))]
              .filter(Boolean)
              .join(pj.and);
            return askKeypad(pj.confirmDelete(what), remove);
          }
          if (action === "rename") {
            const name = o?.name?.trim();
            if (!name) return pj.whatName;
            const next = await call("projects.update", { projectId: p.id, name });
            projectChanged(p.id);
            return pj.renamed(p.name, next.name);
          }
          if (action === "favorite") {
            const favorite = o?.favorite !== false;
            await call("projects.update", { projectId: p.id, favorite });
            projectChanged(p.id);
            return favorite ? pj.favorite(p.name) : pj.noFavorite(p.name);
          }
          const patch = {
            ...(o?.profile ? { profile: o.profile } : {}),
            ...(o?.defaultModel !== undefined ? { defaultModel: clearable(o.defaultModel) } : {}),
            ...(o?.defaultEffort ? { defaultEffort: o.defaultEffort === "default" ? null : o.defaultEffort } : {}),
            ...(o?.testCommand !== undefined ? { testCommand: o.testCommand.trim() || null } : {}),
            ...(o?.devCommand !== undefined ? { devCommand: o.devCommand.trim() || null } : {}),
            ...(o?.git !== undefined ? { gitEnabled: o.git } : {}),
            ...(o?.agents !== undefined ? { agentsEnabled: o.agents } : {}),
          };
          if (!Object.keys(patch).length) return pj.settings(p.name, projectText(p));
          const next = await call("projects.update", { projectId: p.id, ...patch });
          projectChanged(p.id);
          const saved = pj.saved(next.name, projectText(next));
          return p.agentsEnabled && !next.agentsEnabled ? `${saved} ${pj.agentsOffWarning}` : saved;
        }),
      files: (projectName, action, o) =>
        run(true, async () => {
          const p = target(projectName, o);
          const fm = tr().phone.files;
          const rel = (o?.path ?? "").trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
          if (action === "read") {
            if (!rel) return fm.whichFile;
            // Keys would go to the speech service and be read out, like the values of dev_settings.
            if (isSensitiveFile(rel)) return fm.sensitive(asData(rel));
            const f = await call("projects.readFile", { projectId: p.id, path: rel });
            if (f.binary) return fm.notText(asData(rel));
            if (!f.content.trim()) return fm.empty(asData(rel));
            return fm.content(asData(rel), !!f.truncated, excerptData(f.content, 4000));
          }
          if (action === "find") {
            if (!rel) return fm.whichFile;
            const { files } = await call("projects.allFiles", { projectId: p.id });
            const hits = matchingFiles(files, rel);
            if (!hits.length) return fm.noMatch(p.name, asData(rel));
            const shown = hits.slice(0, 10).map((f) => f.path);
            return fm.found(hits.length, asData(shown.join(", ")), hits.length - 10);
          }
          const entries = await call("projects.listFiles", { projectId: p.id, dir: rel });
          if (!entries.length) return rel ? fm.emptyDir(asData(rel)) : fm.emptyProject(p.name);
          const list = (xs: string[]) => `${xs.slice(0, 40).join(", ")}${xs.length > 40 ? tr().phone.common.andMore(xs.length - 40) : ""}`;
          const dirs = entries.filter((e) => e.isDir).map((e) => e.name);
          const files = entries.filter((e) => !e.isDir).map((e) => e.name);
          return asData([dirs.length ? fm.dirs(list(dirs)) : "", files.length ? fm.list(list(files)) : ""].filter(Boolean).join(" "));
        }),
      claudeMd: (projectName, action, o) =>
        run(true, async () => {
          const p = optionalTarget(projectName, o);
          const cm = tr().phone.claudeMd;
          if (action === "list") {
            const files = await call("config.memoryList", { projectId: p?.id });
            return files.map((f) => `${f.label}: ${f.exists ? cm.exists : cm.missing}`).join("\n");
          }
          const scope = o?.scope ?? (p ? "project" : "global");
          if (scope !== "global" && !p) return tr().phone.common.whichFor;
          const projectId = scope === "global" ? undefined : p?.id;
          const where = scope === "global" ? cm.global : scope === "local" ? cm.local(p!.name) : cm.project(p!.name);
          const doc = await call("config.memoryRead", { projectId, scope });
          if (action === "read") return doc.content.trim() ? cm.read(where, excerptData(doc.content, 4000)) : cm.empty(where);
          const text = o?.text?.trim();
          if (!text) return cm.whatToAdd;
          const content = doc.content.trim() ? `${doc.content.trimEnd()}\n\n${text}\n` : `${text}\n`;
          await call("config.memoryWrite", { projectId, scope, content, expectedMtimeMs: doc.mtimeMs });
          return cm.added(where);
        }),
      sessions: (action, o) =>
        run(true, async () => {
          const sm = tr().phone.sessions;
          if (action === "day_report") {
            const p = o?.project?.trim() ? findProject(o.project) : null;
            const today = new Date();
            const date = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - Math.max(0, Math.round(o?.daysBack ?? 0))));
            if (o?.summary) {
              const r = await call("reports.dailySummary", { projectId: p?.id, date });
              return sm.summary(asData(r.summary));
            }
            // One block for the whole report: titles, commit messages and questions in it are data.
            const text = reportText(await call("reports.daily", { projectId: p?.id, date }), { ref: refFor });
            return text.length > REPORT_MAX ? sm.reportCut(asData(text.slice(0, REPORT_MAX)), text.length) : asData(text);
          }
          if (action === "template_learn") return (await call("templates.learn", {})).message;
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
            const outside = external ? sm.external(external) : "";
            if (!list.length) return sm.noMatch(outside);
            const lines = list.slice(0, 10).map((s) => sm.line(refFor(s.id), asData(s.title ?? tr().phone.untitled), p ? null : s.projectName, statusText(s), dateTime(s.updatedAt)));
            return `${list.length > 10 ? sm.newest(list.length) : ""}${lines.join("\n")}${outside}`;
          }
          const transcripts = o?.keepTranscript === true ? sm.keepTranscripts : sm.deleteTranscripts;
          if (action === "delete_all") {
            const all = await call("sessions.listAll", {});
            if (!all.length) return sm.none;
            return askKeypad(sm.confirmDeleteAll(all.length, transcripts), async () => {
              const r = await call("sessions.deleteAll", { deleteTranscript: o?.keepTranscript !== true });
              a.focus = null;
              return r.failed ? sm.deletedSome(r.deleted.length, r.failed, r.error ?? null) : sm.deletedAll(r.deleted.length);
            });
          }
          const s = resolve(o?.session ?? "");
          const r = refFor(s.id);
          if (action === "delete") {
            return askKeypad(sm.confirmDelete(r, asData(s.title ?? tr().phone.untitled), transcripts), async () => {
              const res = await call("sessions.delete", { sessionId: s.id, deleteTranscript: o?.keepTranscript !== true });
              if (a.focus === s.id) a.focus = null;
              return res.deleted ? sm.deleted(r, !!res.transcriptDeleted) : sm.notDeleted(r);
            });
          }
          if (action === "ui_compare" || action === "ui_compare_retake") {
            const c = await call("uiCompare.latest", { sessionId: s.id });
            if (!c) return sm.noCompare(r);
            if (action === "ui_compare_retake") {
              await call("uiCompare.retake", { sessionId: s.id, compareId: c.id });
              return sm.retake(r);
            }
            const files = sm.uiFiles(c.files.length);
            const state = c.status === "ready" ? sm.compareReady : c.status === "capturing" ? sm.compareCapturing : sm.compareFailed(asData(c.error ?? sm.unknownError));
            return sm.compare(r, dateTime(c.createdAt), asData(c.url), files, asData(c.files.slice(0, 5).join(", ")), state);
          }
          if (action === "rewind") {
            const prompt = await promptBack(s.id, o?.messagesBack ?? 1);
            const res = await call("sessions.rewind", { sessionId: s.id, messageUuid: prompt.uuid, dryRun: false });
            if (!res.canRewind) return sm.cannotRewind(r, res.error ?? null);
            if (!res.filesChanged.length) return sm.nothingToRewind(r);
            return sm.rewound(r, excerptData(prompt.text, 120), res.filesChanged.length);
          }
          if (action === "edit") {
            const text = o?.text?.trim();
            if (!text) return sm.editText;
            const prompt = await promptBack(s.id, o?.messagesBack ?? 1);
            await call("sessions.edit", { sessionId: s.id, seq: prompt.seq, text });
            return sm.edited(excerptData(prompt.text, 120), r);
          }
          if (action === "handoff") {
            const tokens = s.context?.totalTokens;
            const next = await call("sessions.handoff", { sessionId: s.id });
            a.focus = next.id;
            const size = tokens ? sm.handoffSize(Math.round(tokens / 1000)) : "";
            return sm.handedOff(r, refFor(next.id), size);
          }
          const before = o?.messagesBack ? await promptBack(s.id, o.messagesBack) : null;
          const res = await call("sessions.fork", { sessionId: s.id, beforeSeq: before?.seq, rewindFiles: o?.rewindFiles === true });
          const files = res.filesChanged?.length ? sm.forkFiles(res.filesChanged.length) : "";
          if (!res.session) return sm.forkNothing(files);
          a.focus = res.session.id;
          const cut = before && res.prompt ? sm.forkCut(excerptData(res.prompt, 300)) : "";
          return sm.forked(refFor(res.session.id), r, files, cut);
        }),
      extensions: (kind, action, o) =>
        run(true, async () => {
          const p = optionalTarget(o?.project, o);
          const xm = tr().phone.extensions;
          const projectId = p?.id;
          const name = () => {
            const n = o?.name?.trim();
            if (!n) throw new Error(xm.whichName);
            return n;
          };
          const only = (actions: string) => xm.only(actions);
          if (kind === "mcp") {
            if (action === "list") {
              const list = await call("mcp.list", { projectId });
              const state = xm.mcpState;
              return list.length ? xm.mcpList(asData(list.map((m) => `${m.name} ${state[m.status]}`).join(", "))) : xm.mcpNone;
            }
            if (action !== "add" && action !== "remove") return only(xm.mcpOnly);
            const scope = o?.scope ?? (p ? "local" : "user");
            if (scope !== "user" && !p) return tr().phone.common.whichFor;
            const where = scope === "user" ? xm.global : scope === "project" ? xm.inProject(p!.name) : xm.localIn(p!.name);
            if (action === "add") {
              const serverTarget = o?.target?.trim();
              if (!serverTarget) return xm.whichTarget;
              const transport = o?.transport ?? (/^https?:\/\//i.test(serverTarget) ? "http" : "stdio");
              const args = o?.args?.trim() ? o.args.trim().split(/\s+/) : [];
              const r = await call("mcp.add", { projectId, name: name(), scope, transport, target: serverTarget, args, env: {} });
              return r.ok ? xm.mcpAdded(name(), where) : tr().phone.error(excerptData(r.output, 400));
            }
            const r = await call("mcp.remove", { projectId, name: name(), scope });
            return r.ok ? xm.mcpRemoved(name(), where) : tr().phone.error(excerptData(r.output, 400));
          }
          if (kind === "skill" || kind === "agent") {
            const [one, many] = kind === "skill" ? [xm.skill, xm.skills] : [xm.agent, xm.agents];
            const docs = await call("config.docs", { kind, projectId });
            if (action === "list") {
              if (!docs.length) return xm.none(many);
              return xm.docList(many, asData(docs.map((d) => `${d.name}${d.scope === "project" ? xm.projectMark : ""}${d.description ? `: ${d.description.slice(0, 160)}` : ""}`).join("\n")));
            }
            if (action === "add") {
              const scope = o?.scope === "user" || !p ? "user" : "project";
              const docName = slugify(name(), 64);
              if (!docName) return xm.nameNeedsLetters;
              await call("config.docCreate", { kind, scope, name: docName, description: o?.description?.trim() ?? "", projectId });
              return xm.docCreated(one, docName, scope === "project" ? xm.inProject(p!.name) : xm.global);
            }
            if (action !== "read" && action !== "remove") return only(xm.docOnly(many));
            const doc = pickOne(docs, name(), (d) => [d.name, d.name.replace(/-/g, " ")], { none: xm.docNone(one), many });
            if (action === "read") {
              const d = await call("config.docRead", { kind, scope: doc.scope, name: doc.name, projectId });
              return xm.docRead(one, doc.name, excerptData(d.content, 3000));
            }
            await call("config.docDelete", { kind, scope: doc.scope, name: doc.name, projectId });
            return xm.docDeleted(one, doc.name);
          }
          if (kind === "command") {
            if (action !== "list") return only(xm.commandOnly);
            const own = (await call("system.commands", { projectId })).filter((c) => !c.builtin);
            return own.length ? xm.commands(asData(own.map((c) => `${c.name}${c.description ? `: ${c.description.slice(0, 120)}` : ""}`).join("\n"))) : xm.noCommands;
          }
          if (kind === "hook") {
            if (action !== "list" && action !== "read") return only(xm.hookOnly);
            const scope = o?.scope ?? (p ? "project" : "user");
            if (scope !== "user" && !p) return tr().phone.common.whichFor;
            const r = await call("config.hooksRead", { scope, projectId });
            let events: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(r.hooks || "{}");
              if (parsed && typeof parsed === "object") events = parsed as Record<string, unknown>;
            } catch {
              // Shown as text below.
            }
            const names = Object.entries(events).map(([e, v]) => `${e} (${Array.isArray(v) ? v.length : 1})`);
            const hookWhere = scope === "user" ? xm.global : xm.hooksIn(p!.name);
            if (!names.length && !r.hooks.trim().replace(/^\{\s*\}$/, "")) return xm.noHooks(hookWhere);
            return xm.hooks(hookWhere, asData(names.join(", ")), action === "read" ? excerptData(r.hooks, 2000) : "");
          }
          const catalog = await call("plugins.catalog", {});
          const pluginState = (x: (typeof catalog)[number]) => (!x.installed ? xm.notInstalled : x.enabled === false ? xm.installedOff : xm.installed);
          if (action === "list" || action === "read") {
            const q = (o?.query ?? o?.name ?? "").trim().toLowerCase();
            if (q) {
              const hits = catalog.filter((x) => `${x.name} ${x.description}`.toLowerCase().includes(q)).slice(0, 8);
              return hits.length ? asData(hits.map((x) => `${x.name}, ${pluginState(x)}: ${x.description.slice(0, 160)}`).join("\n")) : xm.noPlugin(q);
            }
            const installed = catalog.filter((x) => x.installed);
            return installed.length ? xm.plugins(asData(installed.map((x) => `${x.name}${x.enabled === false ? xm.pluginOff : ""}`).join(", "))) : xm.noPlugins;
          }
          const plugin = pickOne(catalog, name(), (x) => [x.name, x.id], { none: tr().phone.common.what.pluginNone, many: tr().phone.common.what.pluginMany });
          if (action === "add") {
            if (plugin.installed) return xm.alreadyInstalled(plugin.name);
            await call("plugins.install", { id: plugin.id });
            return xm.pluginInstalled(plugin.name);
          }
          if (!plugin.installed) return xm.pluginNotInstalled(plugin.name);
          if (action === "remove") {
            await call("plugins.uninstall", { id: plugin.id });
            return xm.pluginRemoved(plugin.name);
          }
          await call("plugins.setEnabled", { id: plugin.id, enabled: action === "enable" });
          return xm.pluginSwitched(plugin.name, action === "enable");
        }),
      forgeSettings: (patch) =>
        run(true, async () => {
          const cur = await call("settings.get", {});
          const update: Partial<Settings> = {};
          const changed: Array<keyof ForgeSettingsPatch> = [];
          const flags = ["sounds", "desktopNotifications", "enterToSend", "autoContinueAfterLimit", "updateChecks", "debugLogs", "stripApiKey", "screenshotKey", "uiCompare", "learnTemplates", "usageStats"] as const;
          for (const k of flags) {
            const v = patch[k];
            if (v === undefined) continue;
            update[k] = v;
            changed.push(k);
          }
          if (patch.usageStats !== undefined) update.usageStatsAsked = true;
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
          if (patch.longSessionTokens !== undefined) {
            update.longSessionTokens = Math.min(2_000_000, Math.max(0, Math.round(patch.longSessionTokens)));
            changed.push("longSessionTokens");
          }
          if (patch.updateChannel) {
            update.updateChannel = patch.updateChannel;
            changed.push("updateChannel");
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
          if (rule && patch.policyRuleOn === undefined && !changed.length) return tr().phone.settings.rule(policyRuleLabel(rule), !cur.disabledPolicyRules.includes(rule));
          if (rule && patch.policyRuleOn !== undefined) {
            const off = cur.disabledPolicyRules.filter((r) => r !== rule);
            update.disabledPolicyRules = patch.policyRuleOn ? off : [...off, rule];
            changed.push("policyRule");
          }
          if (!changed.length) return `${(["defaultModel", "defaultEffort", "defaultProfile", "defaultProjectDir", ...flags, "updateChannel", "idleCloseMinutes", "longSessionTokens", "alwaysOnTop", "policyRule"] as const).map((k) => settingText(cur, k)).join(", ")}.`;
          const next = await call("settings.update", update);
          return tr().phone.settings.saved(changed.map((k) => settingText(next, k)).join(", "));
        }),
      forgeSystem: (action, o) =>
        run(true, async () => {
          const sy = tr().phone.system;
          if (action === "diagnostics") {
            const d = await call("system.diagnostics", { refresh: true });
            const facts = [
              d.claude.found ? sy.claudeThere(d.claude.version || null) : sy.claudeMissing(d.claude.error || null),
              !d.auth.checked ? "" : d.auth.loggedIn ? sy.signedIn(d.auth.subscriptionType || null) : sy.notSignedIn(d.auth.error || null),
              d.apiKeyEnvPresent ? (d.apiKeyStripped ? sy.apiKeyHidden : sy.apiKeyPassed) : "",
              d.git.found ? sy.gitThere(d.git.version || null) : sy.gitMissing,
              d.gh.found ? (d.gh.authenticated === false ? sy.ghNotSignedIn : sy.ghThere) : sy.ghMissing,
              d.python.found ? sy.pythonThere(d.python.version ?? null, !!d.python.bundled) : sy.pythonMissing,
            ].filter(Boolean);
            const missing = d.capabilities.filter((c) => c.state === "unavailable").map((c) => c.label);
            return sy.diagnostics(facts.join(", "), missing.join(", "));
          }
          if (action === "update_check") return updateText(await call("app.checkUpdate", {}));
          if (action === "update_download") return updateText(await call("app.downloadUpdate", {}));
          if (action === "update_install") {
            const st = await call("app.installUpdate", {});
            return sy.installing(st.latest ? st.latest.version : null);
          }
          if (action === "install_check") return installText(await call("app.checkInstall", {}));
          if (action === "support") {
            const bare = (url: string) => url.replace(/^https:\/\//, "");
            const given = await call("app.donations", {}).catch(() => null);
            const euros = given ? new Intl.NumberFormat(tr().phone.locale, { style: "currency", currency: "EUR" }).format(given.cents / 100) : null;
            const sum = given ? sy.donated(euros ?? "", given.count) : "";
            return sy.support(bare(SUPPORT_LINKS.donate), sum, bare(SUPPORT_LINKS.feedback));
          }
          if (action === "dev_status" || action === "dev_promote") {
            const dev = await call("app.devChannel", { refresh: true });
            const channel = (await call("settings.get", {})).updateChannel;
            if (!dev.allowed) return sy.devNotAllowed(dev.message ?? "");
            if (dev.ahead === null) return sy.devUnknown(dev.message ?? "");
            if (action === "dev_promote" && channel !== "dev") return sy.devPromoteOff;
            if (action === "dev_status" || dev.ahead === 0) return sy.devStatus(channel === "dev", dev.ahead, dev.behind ?? 0, dev.commits.slice(0, 5).join("; "));
            // Changes main for everyone on the stable channel: only after the code on the keypad.
            return askKeypad(
              sy.confirmPromote(dev.ahead),
              async () => {
                const r = await call("app.promoteDev", { release: true });
                return sy.promoted(r.mode === "fast-forward", r.releaseStarted);
              },
              tr().phone.common.nothingChanged,
            );
          }
          if (action === "install_repair") {
            const st = await call("app.checkInstall", {});
            if (!st.checkable || st.complete !== false || !st.installer) return installText(st);
            // The restart ends this call: only after the code on the keypad.
            return askKeypad(
              sy.confirmRepair(st.installer.version),
              async () => {
                await call("app.repairInstall", {});
                return sy.repairing;
              },
              tr().phone.common.nothingChanged,
            );
          }
          if (action === "changelog") {
            const c = await call("app.changelog", {});
            if (!c) return sy.noNewVersion;
            if (c.status === "writing") return sy.writingChangelog;
            if (c.status === "ready" && c.text) return sy.changelog(c.tag, excerptData(c.text, 3000));
            const notes = (await call("app.updateState", {})).latest?.notes;
            if (notes?.trim()) return sy.releaseNotes(c.tag, excerptData(notes, 3000));
            if (c.commits.length) return sy.commits(c.tag, excerptData(c.commits.slice(0, 15).join("\n"), 3000));
            return tr().phone.error(c.message ?? sy.noDescription);
          }
          if (action === "claude_check") {
            const st = await call("claude.setupState", {});
            if (st.phase === "running" && st.task !== "login") return st.task === "install" ? sy.claudeInstalling : sy.claudeUpdating;
            const last = st.task === "update" || st.task === "install" ? (st.phase === "error" ? sy.lastFailed(st.message ?? null) : "") : "";
            const u = await call("claude.checkUpdate", {});
            if (!u.installed) return sy.claudeNotInstalled(last);
            if (u.error) return sy.claudeLatestUnknown(u.installed, u.error, last);
            return `${u.available ? sy.claudeAvailable(u.latest ?? "", u.installed) : sy.claudeCurrent(u.installed)}${last}`;
          }
          if (action === "claude_update") {
            try {
              await call("claude.update", {});
            } catch (e) {
              if (!(e instanceof ForgeError && e.code === "CLAUDE_NOT_INSTALLED")) throw e;
              await call("claude.install", {});
              return sy.claudeInstallStarted;
            }
            return sy.claudeUpdateStarted;
          }
          if (action === "claude_logout") {
            // Signing in again needs the browser at the computer, so the phone cannot undo this.
            return askKeypad(
              sy.confirmLogout,
              async () => {
                await call("claude.logout", {});
                return sy.loggedOut;
              },
              tr().phone.common.nothingChanged,
            );
          }
          if (action === "backup_create") {
            const b = await call("backup.create", {});
            return sy.backupCreated(b.parts.map((x) => x.label).join(", "));
          }
          if (action === "sync_on" || action === "sync_off") {
            const on = action === "sync_on";
            if (on && !(await call("github.account", {}))) return sy.syncNeedsGitHub;
            await call("settings.update", { syncEnabled: on, syncAsked: true });
            return on ? sy.syncOn : sy.syncOffKept;
          }
          if (action === "sync_status" || action === "sync_now") {
            const st = action === "sync_now" ? await call("sync.now", {}) : await call("sync.status", {});
            if (st.phase === "off") return sy.syncOff;
            if (st.phase === "no-github") return sy.syncNoGitHub;
            if (st.phase === "needs-passphrase") return sy.syncPassphrase(st.error ?? "");
            const when = st.phase === "syncing" ? sy.syncing : st.phase === "error" ? sy.syncFailed(st.error ?? null) : st.lastSyncAt ? sy.lastSync(dateTime(st.lastSyncAt)) : sy.neverSynced;
            const facts = [
              st.remote ? sy.writtenBy(when, asData(st.remote.device)) : when,
              st.available.length ? sy.missingHere(st.available.map((p) => asData(p.name)).join(", ")) : "",
              st.localOnly.length ? sy.onlyHere(st.localOnly.map((x) => asData(x.label)).join(", ")) : "",
            ].filter(Boolean);
            return sy.syncFacts(facts.join(". "));
          }
          if (action === "sync_clone") {
            const st = await call("sync.status", {});
            const want = o?.project?.trim();
            if (!want) return sy.whichProject;
            const hit = pickOne(st.available, want.toLowerCase(), (p) => [p.name.toLowerCase(), p.key], { none: tr().phone.common.what.missingNone, many: tr().phone.common.what.missingMany });
            const p = await call("sync.cloneProject", { key: hit.key });
            projectChanged(p.id);
            return sy.cloned(p.name);
          }
          const localOnlyItem = async () => {
            const st = await call("sync.status", {});
            return pickOne(st.localOnly, o!.project!.trim().toLowerCase(), (x) => [x.label.toLowerCase(), x.key], { none: tr().phone.common.what.localNone, many: tr().phone.common.what.localMany });
          };
          if (action === "sync_keep") {
            if (!o?.project?.trim()) return sy.whatToKeep;
            const item = await localOnlyItem();
            await call("sync.keep", { key: item.key });
            return sy.kept(item.label);
          }
          if (action === "sync_force") {
            const item = o?.project?.trim() ? await localOnlyItem() : null;
            const st = await call("sync.status", {});
            if (!st.enabled) return sy.syncIsOff;
            const removes = item ? [item] : st.localOnly;
            const what = item
              ? sy.forceItem(item.label, item.kind === "project")
              : sy.forceAll(removes.length ? removes.map((x) => asData(x.label)).join(", ") : null);
            // The projects named now are the ones removed; if that changed until the code, nothing happens.
            const expectRemove = item ? undefined : removes.filter((x) => x.kind === "project").map((x) => x.key);
            // Removing from FORGE takes the session history with it: confirmed on the keypad, like deleting.
            return askKeypad(
              sy.forceConfirm(what),
              async () => {
                await call("sync.forceLocal", { key: item?.key, expectRemove });
                const later = sy.phoneLater;
                return item ? sy.forcedItem(item.label) : sy.forcedAll(later);
              },
              tr().phone.common.nothingChanged,
            );
          }
          if (action === "sync_versions" || action === "sync_restore") {
            const versions = await call("sync.versions", {});
            if (action === "sync_versions") {
              if (!versions.length) return sy.noVersions;
              return versions
                .slice(0, 5)
                .map((v, i) => sy.versionLine(i + 1, dateTime(v.date), v.device ? asData(v.device) : null))
                .join("\n");
            }
            const nr = o?.backup?.trim();
            if (!nr) return sy.whichVersion;
            const v = /^\d+$/.test(nr) ? versions[Number(nr) - 1] : versions.find((x) => x.sha.startsWith(nr));
            if (!v) return sy.noVersion(nr);
            // The phone settings reconnect the line and would end this call.
            const parts = (o?.parts ?? BackupPart.options).filter((x) => x !== "phone");
            const phone = o?.parts?.includes("phone") ? sy.phoneRestoreSync : "";
            if (!parts.length) return sy.nothingToRestore(phone);
            const r = await call("sync.restoreVersion", { sha: v.sha, parts });
            return sy.restoredVersion(dateTime(v.date), r.restored.map((x) => sy.backupParts[x]).join(", "), r.notes.join(" "), phone);
          }
          const list = await backups();
          if (action === "backup_list") {
            if (!list.length) return sy.noBackups;
            return list
              .slice(0, 5)
              .map((b, i) => sy.backupLine(i + 1, dateTime(b.createdAt), sy.backupReasons[b.reason], b.appVersion))
              .join("\n");
          }
          const key = o?.backup?.trim();
          if (!key) return sy.whichBackup;
          const b = /^\d+$/.test(key) ? list[Number(key) - 1] : list.find((x) => x.id === key);
          if (!b?.id) return sy.noBackup(key);
          const inside = b.parts.map((x) => x.part);
          // Restoring the phone settings reconnects the line and would end this call.
          const parts = (o?.parts ?? inside).filter((x) => x !== "phone" && inside.includes(x));
          const phone = o?.parts?.includes("phone") ? sy.phoneRestoreBackup : "";
          if (!parts.length) return sy.notInBackup(phone);
          const r = await call("backup.restore", { id: b.id, parts });
          return sy.restoredBackup(dateTime(b.createdAt), r.restored.map((x) => sy.backupParts[x]).join(", "), r.notes.join(" "), phone);
        }),
      search: (query, o) =>
        run(true, async () => {
          const sr = tr().phone.search;
          if (!query.trim()) return sr.what;
          const plain = (snippet: string) => snippet.split(SEARCH_MARK_START).join("").split(SEARCH_MARK_END).join("");
          if (o?.session?.trim()) {
            // In one session: its places, newest first.
            const s = resolve(o.session);
            const hits = db.searchEvents(query, 5, { sessionId: s.id, phrase: o.phrase, order: "time" });
            if (!hits.length) return sr.noneInSession(refFor(s.id));
            return [sr.sessionHeader(refFor(s.id), asData(s.title ?? tr().phone.untitled)), ...hits.map((h) => sr.sessionLine(dateTime(h.ts), sr.roles[h.role], excerptData(plain(h.snippet), 300)))].join("\n");
          }
          const p = o?.project?.trim() ? findProject(o.project) : null;
          const lines: string[] = [];
          const seen = new Set<string>();
          // One line per session, its best hit first.
          for (const h of db.searchEvents(query, 30, { projectId: p?.id, phrase: o?.phrase })) {
            if (seen.has(h.sessionId) || lines.length >= 5) continue;
            seen.add(h.sessionId);
            lines.push(sr.line(refFor(h.sessionId), asData(h.sessionTitle ?? tr().phone.untitled), h.projectName, excerptData(plain(h.snippet), 300)));
          }
          if (lines.length) return lines.join("\n");
          return p ? sr.noneInProject(p.name) : sr.none;
        }),
      ask: (question, o) =>
        run(true, async () => {
          const ak = tr().phone.ask;
          if (!question.trim()) return ak.what;
          const all = sessions.listAll();
          let picked: Array<{ id: string; title: string | null }>;
          if (o?.session?.trim()) picked = [resolve(o.session)];
          else {
            const p = o?.project?.trim() ? findProject(o.project) : null;
            const projectOf = new Map(this.d.projects.all().map((x) => [x.id, x.parentId ?? x.id]));
            const candidates = p ? all.filter((s) => s.projectId === p.id || projectOf.get(s.projectId) === p.id) : all;
            const score = new Map<string, number>();
            const add = (id: string, n: number) => score.set(id, (score.get(id) ?? 0) + n);
            const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, ASK_WORDS);
            for (const w of words) {
              // Word by word: a spoken question rarely has all its words in one place. A word found in many sessions says little.
              const ids = new Set(db.searchEvents(w, 100, { projectId: p?.id }).map((h) => h.sessionId));
              for (const id of ids) add(id, 1 / ids.size);
              for (const s of candidates) add(s.id, nameScore(w, s.title ?? ""));
            }
            if (a.focus) add(a.focus, 0.5);
            for (const s of candidates) if (s.live) add(s.id, 0.2);
            const ranked = candidates.filter((s) => (score.get(s.id) ?? 0) > 0).sort((x, y) => (score.get(y.id) ?? 0) - (score.get(x.id) ?? 0));
            // Nothing fits: the newest sessions are still the best guess for "what is going on".
            picked = (ranked.length ? ranked : candidates).slice(0, ASK_SESSIONS);
          }
          if (!picked.length) return ak.noSessions;
          const label = (s: { id: string; title: string | null }) => `${refFor(s.id)} ${s.title ?? tr().phone.untitled}`;
          const { answer } = await sessions.answerQuestion(question, picked.map((s) => ({ id: s.id, label: label(s) })));
          if (picked.length === 1) a.focus = picked[0]!.id;
          return ak.answer(asData(picked.map(label).join(", ")), excerptData(answer, ASK_ANSWER_MAX));
        }),
      callSettings: (patch) =>
        run(Object.values(patch).some((v) => v !== undefined), async () => {
          const cs = tr().phone.callSettings;
          const { numbers, ...times } = patch;
          const changes = Object.fromEntries(Object.entries(times).filter(([, v]) => v !== undefined)) as CallSettingsPatch;
          if (Object.keys(changes).length) await this.saveConfig({ notifyOn: { ...this.cfg.notifyOn, ...changes } });
          const changed = numbers ? await this.changeNumber(numbers) : "";
          const targets = this.notifyTargets();
          // The numbers themselves only after the PIN: they are personal.
          const lists = locked() ? "" : ` ${numberListing(cs.called, this.cfg.notifyNumbers)} ${numberListing(cs.allowed, this.cfg.allowedCallers)}`;
          if (!targets.length) return cs.noTargets(changed, lists);
          const on = this.cfg.notifyOn;
          const list = [on.done ? cs.whenDone : "", on.approval ? cs.whenApproval : "", on.error ? cs.whenError : ""].filter(Boolean);
          const where = targets.length > 1 ? cs.parallel(targets.length) : "";
          return `${changed}${list.length ? cs.calls(list.join(", "), where) : cs.noCalls}${lists}`;
        }),
      callBack: (minutes, about) =>
        run(false, async () => {
          if (!about.trim()) return tr().phone.callBack.what;
          // Back to the number of this call; only numbers FORGE may talk to anyway.
          const number = a.call.remoteNumber;
          const known = [...activeNumbers(this.cfg.allowedCallers), ...this.notifyTargets()].some((n) => sameNumber(n, number));
          // Otherwise the numbers for notifications ring, stored as "".
          if (!known && !this.notifyTargets().length) return tr().phone.callBack.notForNumber;
          const due = this.scheduleCallback(known ? number : "", minutes, about);
          return tr().phone.callBack.agreed(due.toLocaleTimeString(tr().phone.locale, { hour: "2-digit", minute: "2-digit" }));
        }),
      usage: () =>
        run(false, async () => {
          const u = await sessions.planUsage(false);
          const um = tr().phone.usage;
          const limit = sessions.rateLimit();
          const reached = limit.status === "reached" ? um.reached(limit.resetsAt ? spokenTime(limit.resetsAt) : null) : "";
          const perSecond = Math.round(tokenMeter.rate());
          const rate = perSecond ? um.rate(perSecond) : um.noRate;
          if (!u.available || !u.windows.length) return [reached || um.unavailable(u.error ?? null), rate].join("\n");
          const windows = u.windows.map((w) => um.window(w.label, Math.round(w.utilization), w.resetsAt ? spokenTime(w.resetsAt) : null, spokenForecast(w)));
          return [reached, ...windows, rate].filter(Boolean).join("\n");
        }),
    };
  }
}

/** Read through a function: TypeScript keeps a narrowed `call.state` across awaits, the call does not. */
function ended(call: PhoneCall): boolean {
  return call.state === "ended";
}
