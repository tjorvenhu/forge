import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionStatus } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import { digestAuthorization, parseChallenge } from "./digest.js";
import type { ApprovalRequest } from "./session-info.js";

/** What the desk phone needs to know about a session. */
export interface DeskSession {
  id: string;
  title: string | null;
  status: SessionStatus;
  projectName: string;
  updatedAt: string;
}

export interface DeskConfig {
  phoneIp: string;
  /** FORGE's address in the LAN, as the phone reaches it */
  localIp: string;
  httpPort: number;
  webUser: string;
  webPassword: string | null;
  /** line keys for sessions, in order */
  sessionKeys: number[];
  /** line keys set to "not used" */
  clearKeys: number[];
  leds: boolean;
  hotline: boolean;
  display: "lines" | "statusline" | "off";
  /** number the phone dials to reach FORGE (FORGE's extension) */
  forgeNumber: string;
  /** secret part of all URLs the phone calls */
  token: string;
}

export interface DeskDeps {
  /** sessions with a running Claude process, newest activity first */
  listSessions(): DeskSession[];
  pending(sessionId: string): ApprovalRequest | null;
  lastAnswer(sessionId: string): string;
  respond(sessionId: string, requestId: string, decision: "allow" | "deny"): void;
  /** the running call, if any, and the session it is about */
  call(): { active: boolean; sessionId: string | null };
  /** a session key was pressed while a call runs */
  onKeyInCall(sessionId: string): void;
  onReachability(): void;
  log(message: string): void;
  fetch?: typeof fetch;
  timing?: { debounceMs?: number; labelsDelayMs?: number };
}

type Led = "off" | "green" | "green-slow" | "orange" | "orange-slow" | "red-fast";

const LABEL_MAX = 12;
const DISPLAY_WIDTH = 24;
const REQUEST_TIMEOUT_MS = 3_000;
/** a key press counts for the next call from the desk phone within this time */
const PICKUP_WINDOW_MS = 45_000;

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function shorten(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1)).trimEnd()}…` : t;
}

/** Word wrap for the display, the last line marked when text is cut. */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  let used = 0;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > width && line) {
      out.push(line);
      if (out.length === maxLines) break;
      line = w.slice(0, width);
    } else line = next.slice(0, width);
    used++;
  }
  if (out.length < maxLines && line) out.push(line);
  if (used < words.length && out.length) {
    // Cut at a word boundary so the mark fits.
    let last = out.at(-1)!;
    while (last.length + 1 > width && last.includes(" ")) last = last.slice(0, last.lastIndexOf(" "));
    out[out.length - 1] = `${last.slice(0, width - 1)}…`;
  }
  return out;
}

/** The Yealink provisioning file FORGE hands out: session keys, hotline, push and remote-control rights. */
export function provisioningText(cfg: DeskConfig, labels: string[]): string {
  const base = `http://${cfg.localIp}:${cfg.httpPort}/desk/${cfg.token}`;
  const lines = [
    "#!version:1.0.0.1",
    "## FORGE: Tischtelefon, automatisch erzeugt. Andere Einstellungen des Telefons bleiben, wie sie sind.",
    `push_xml.server = ${cfg.localIp}`,
    "push_xml.block_in_calling = 0",
    "features.action_uri.enable = 1",
    `features.action_uri_limit_ip = ${cfg.localIp}`,
    "features.show_action_uri_option = 0",
    "features.action_uri_force_autop = 1",
    // The power LED belongs to FORGE: on while something waits for the user.
    "phone_setting.missed_call_power_led_flash.enable = 0",
    `features.hotline_number = ${cfg.hotline ? cfg.forgeNumber : ""}`,
    `features.hotline_delay = ${cfg.hotline ? 1 : 0}`,
    // FORGE needs no action URLs (it sees calls itself). Older setups (other scripts) left some that
    // would send every call event to a server that is gone.
    "action_url.outgoing_call = ",
    "action_url.incoming_call = ",
    "action_url.call_established = ",
    "action_url.call_terminated = ",
  ];
  cfg.sessionKeys.forEach((key, i) => {
    lines.push(`linekey.${key}.type = 27`, `linekey.${key}.value = ${base}/key/${i + 1}`, `linekey.${key}.label = ${labels[i] ?? "-"}`, `linekey.${key}.line = 1`);
  });
  for (const key of cfg.clearKeys) {
    if (!cfg.sessionKeys.includes(key)) lines.push(`linekey.${key}.type = 0`, `linekey.${key}.value = `, `linekey.${key}.label = `);
  }
  return `${lines.join("\n")}\n`;
}

/** LED commands for one key: all colours off, then the wanted one. */
export function ledItems(key: number, led: Led): string {
  const items = ["GREEN", "RED", "ORANGE"].map((c) => `<ExecuteItem URI="Led:LINE${key}_${c}=off"/>`);
  if (led !== "off") {
    const [color, speed] = led.split("-") as [string, string | undefined];
    const mode = speed === "fast" ? "fastflash" : speed === "slow" ? "slowflash" : "on";
    items.push(`<ExecuteItem URI="Led:LINE${key}_${color.toUpperCase()}=${mode}"/>`);
  }
  return items.join("");
}

/**
 * Yealink desk phone (tested setup: T53W) next to FORGE's phone line: one line key per running
 * session with name and status LED, a status text on the idle screen, approvals as a menu, and
 * picking up calls FORGE (hotline over the PBX). A session key selects the session the next call
 * is about; during a call it tells the conversation partner which session is meant.
 *
 * FORGE runs a small HTTP server for the phone (keys, provisioning). It answers only the phone's IP,
 * and every URL carries a random token. FORGE pushes LEDs and text to the phone's web interface.
 */
export class DeskPhone {
  private server: Server | null = null;
  private cfg: DeskConfig | null = null;
  /** session per key slot (index = slot) */
  private slots: Array<string | null> = [];
  /** sessions with a result the user has not heard or seen yet */
  private readonly unheard = new Set<string>();
  private selected: string | null = null;
  private pickup: { sessionId: string; at: number } | null = null;
  private lastPush = { leds: "", display: "" };
  /** labels the phone has; null until the first provisioning */
  private phoneLabels: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private labelsTimer: ReturnType<typeof setTimeout> | null = null;
  /** approval menus already shown (request ids) */
  private readonly menus = new Set<string>();
  reachable: boolean | null = null;
  message: string | null = null;

  constructor(private readonly d: DeskDeps) {}

  get running(): boolean {
    return this.server !== null;
  }

  get provisioningUrl(): string | null {
    return this.cfg ? `http://${this.cfg.localIp}:${this.cfg.httpPort}/desk/${this.cfg.token}/prov/` : null;
  }

  async start(cfg: DeskConfig): Promise<void> {
    await this.stop();
    this.cfg = cfg;
    this.lastPush = { leds: "", display: "" };
    // The phone may still show labels from before (last run, other setup): reload once.
    this.phoneLabels = "";
    const server = createServer((req, res) => void this.onRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(cfg.httpPort, cfg.localIp, () => resolve());
    });
    server.on("error", (e) => this.d.log(`Tischtelefon: HTTP-Server: ${e.message}`));
    // Port 0 (tests): the URLs need the port the OS picked.
    this.cfg = { ...cfg, httpPort: (server.address() as AddressInfo).port };
    this.server = server;
    this.reachable = null;
    this.message = null;
    this.refreshNow();
  }

  async stop(): Promise<void> {
    for (const t of [this.refreshTimer, this.labelsTimer]) if (t) clearTimeout(t);
    this.refreshTimer = this.labelsTimer = null;
    const server = this.server;
    this.server = null;
    this.cfg = null;
    this.reachable = null;
    this.message = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ---------- state from FORGE

  /** A session finished a turn: new for the user until they talk about it or send something. */
  markUnheard(sessionId: string) {
    this.unheard.add(sessionId);
    this.refresh();
  }

  markHeard(sessionId: string) {
    if (this.unheard.delete(sessionId)) this.refresh();
  }

  /** The session the user deals with now (callback about it, key pressed). */
  select(sessionId: string) {
    this.selected = sessionId;
    this.refresh();
  }

  /**
   * A call from the desk phone right after a key press is about that session. Returns it once; a
   * later call is a plain call again.
   */
  takePickup(): string | null {
    const p = this.pickup;
    this.pickup = null;
    if (!p || Date.now() - p.at > PICKUP_WINDOW_MS) return null;
    return p.sessionId;
  }

  /** Something changed (session status, call): LEDs, display and key labels follow shortly. */
  refresh() {
    if (!this.cfg || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshNow();
    }, this.d.timing?.debounceMs ?? 300);
  }

  /** Pushes everything again, also unchanged state (after the phone was unreachable, test button). */
  forceRefresh() {
    this.lastPush = { leds: "", display: "" };
    this.phoneLabels = "";
    this.refreshNow();
  }

  /** Shows a short message with a beep. */
  notice(title: string, text: string) {
    this.push(`<YealinkIPPhoneTextScreen Beep="yes" Timeout="6" destroyOnExit="yes"><Title>${escapeXml(title)}</Title><Text>${escapeXml(text)}</Text></YealinkIPPhoneTextScreen>`);
  }

  private refreshNow() {
    if (!this.cfg) return;
    const sessions = this.d.listSessions();
    this.assignSlots(sessions);
    for (const id of [...this.unheard]) if (!sessions.some((s) => s.id === id)) this.unheard.delete(id);
    const byId = new Map(sessions.map((s) => [s.id, s]));

    if (this.cfg.leds) {
      const items =
        this.cfg.sessionKeys.map((key, i) => ledItems(key, this.ledFor(this.slots[i] ? byId.get(this.slots[i]!) : undefined))).join("") +
        `<ExecuteItem URI="Led:POWER=${sessions.some((s) => this.unheard.has(s.id) || s.status === "waiting_approval") ? "on" : "off"}"/>`;
      if (items !== this.lastPush.leds) {
        this.lastPush.leds = items;
        this.push(`<YealinkIPPhoneExecute Beep="no">${items}</YealinkIPPhoneExecute>`);
      }
    }

    const display = this.displayXml(byId);
    if (display !== this.lastPush.display) {
      this.lastPush.display = display;
      this.push(display);
    }

    this.showApprovalMenus(sessions);

    const labels = this.labels(byId).join("\n");
    if (this.phoneLabels === null) this.phoneLabels = labels;
    else if (labels !== this.phoneLabels) this.scheduleLabels();
  }

  /** Keeps a session on its key as long as it runs; new sessions take free keys, newest first. */
  private assignSlots(sessions: DeskSession[]) {
    const n = this.cfg!.sessionKeys.length;
    const live = new Set(sessions.map((s) => s.id));
    this.slots = Array.from({ length: n }, (_, i) => (this.slots[i] && live.has(this.slots[i]!) ? this.slots[i]! : null));
    for (const s of sessions) {
      if (this.slots.includes(s.id)) continue;
      const free = this.slots.indexOf(null);
      if (free < 0) break;
      this.slots[free] = s.id;
    }
  }

  private ledFor(s: DeskSession | undefined): Led {
    if (!s) return "off";
    const call = this.d.call();
    if (call.active && call.sessionId === s.id) return "orange";
    if (s.status === "waiting_approval") return "red-fast";
    if (s.status === "running" || s.status === "starting" || s.status === "stopping") return "orange-slow";
    if (this.unheard.has(s.id)) return "green-slow";
    return "green";
  }

  private labels(byId: Map<string, DeskSession>): string[] {
    return this.slots.map((id) => {
      const s = id ? byId.get(id) : undefined;
      return s ? shorten((s.title ?? s.projectName).replace(/[\r\n=#]/g, " "), LABEL_MAX) : "-";
    });
  }

  private stateWord(s: DeskSession): string {
    if (s.status === "waiting_approval") return "wartet!";
    if (s.status === "running" || s.status === "starting") return "arbeitet";
    if (this.unheard.has(s.id)) return "neu";
    return "bereit";
  }

  /** The session picking up would be about: the selected one, else the most recently active. */
  private focus(byId: Map<string, DeskSession>): DeskSession | null {
    if (this.selected && byId.has(this.selected)) return byId.get(this.selected)!;
    return [...byId.values()][0] ?? null;
  }

  private displayXml(byId: Map<string, DeskSession>): string {
    const cfg = this.cfg!;
    const wrap = (msgs: string) => `<YealinkIPPhoneStatus Beep="no" SessionID="forge" Timeout="0">${msgs}</YealinkIPPhoneStatus>`;
    if (cfg.display === "off" || !byId.size) return wrap("");
    if (cfg.display === "statusline") {
      const compact = this.slots
        .map((id, i) => {
          const s = id ? byId.get(id) : undefined;
          if (!s) return "";
          const mark = s.status === "waiting_approval" ? "!" : s.status === "running" || s.status === "starting" ? "*" : this.unheard.has(s.id) ? "+" : "-";
          return `${s.id === this.selected ? ">" : ""}${i + 1}${mark}`;
        })
        .filter(Boolean)
        .join(" ");
      return wrap(`<Message Size="small">${escapeXml(compact)}</Message>`);
    }
    const lines: Array<{ text: string; color: string }> = [];
    const color = (s: DeskSession) => (s.status === "waiting_approval" ? "red" : s.status === "running" || s.status === "starting" ? "yellow" : this.unheard.has(s.id) ? "green" : "white");
    const call = this.d.call();
    const f = call.active && call.sessionId && byId.has(call.sessionId) ? byId.get(call.sessionId)! : this.focus(byId);
    if (call.active) {
      lines.push({ text: shorten(`● FORGE${f ? ` · ${f.title ?? f.projectName}` : ""}`, DISPLAY_WIDTH), color: "blue" });
    } else if (f) {
      lines.push({ text: shorten(`${f.title ?? f.projectName} · ${this.stateWord(f)}`, DISPLAY_WIDTH), color: color(f) });
      const req = f.status === "waiting_approval" ? this.d.pending(f.id) : null;
      const detail = req ? requestShort(req) : this.unheard.has(f.id) ? this.d.lastAnswer(f.id).replace(/[`*#_|>]/g, "") : "";
      for (const l of wrapText(detail, DISPLAY_WIDTH, 2)) lines.push({ text: l, color: color(f) });
      const other = [...byId.values()].find((s) => s.id !== f.id && (s.status === "waiting_approval" || this.unheard.has(s.id)));
      if (other) lines.push({ text: shorten(`+ ${other.title ?? other.projectName} ${this.stateWord(other)}`, DISPLAY_WIDTH), color: color(other) });
    }
    return wrap(lines.map((l) => `<Message Size="small" Color="${l.color}">${escapeXml(l.text)}</Message>`).join(""));
  }

  /** Tool approvals as a menu on the display: 1 allows, 2 denies. Questions and plans are for the call. */
  private showApprovalMenus(sessions: DeskSession[]) {
    const cfg = this.cfg!;
    if (this.d.call().active) return;
    for (const s of sessions) {
      if (s.status !== "waiting_approval") continue;
      const req = this.d.pending(s.id);
      if (!req || req.toolName === "AskUserQuestion" || req.toolName === "ExitPlanMode" || this.menus.has(req.requestId)) continue;
      this.menus.add(req.requestId);
      const url = (d: string) => escapeXml(`http://${cfg.localIp}:${cfg.httpPort}/desk/${cfg.token}/answer?s=${encodeURIComponent(s.id)}&r=${encodeURIComponent(req.requestId)}&d=${d}`);
      this.push(
        `<YealinkIPPhoneTextMenu style="numbered" Beep="yes" Timeout="0" destroyOnExit="yes"><Title>${escapeXml(shorten(`${s.title ?? s.projectName}: ${requestShort(req)}`, 60))}</Title>` +
          `<MenuItem><Prompt>Erlauben</Prompt><URI>${url("allow")}</URI></MenuItem><MenuItem><Prompt>Ablehnen</Prompt><URI>${url("deny")}</URI></MenuItem></YealinkIPPhoneTextMenu>`,
      );
      return;
    }
  }

  /** New key labels: the phone reloads its provisioning (no restart), not during a call. */
  private scheduleLabels() {
    if (this.labelsTimer) return;
    this.labelsTimer = setTimeout(() => {
      this.labelsTimer = null;
      if (!this.cfg) return;
      if (this.d.call().active) return this.scheduleLabels();
      const sessions = this.d.listSessions();
      this.assignSlots(sessions);
      const labels = this.labels(new Map(sessions.map((s) => [s.id, s]))).join("\n");
      if (labels === this.phoneLabels) return;
      this.phoneLabels = labels;
      this.command("AutoP");
    }, this.d.timing?.labelsDelayMs ?? 3_000);
  }

  // ---------- requests from the phone

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const cfg = this.cfg;
    const send = (code: number, body: string, type = "text/plain; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!cfg || from !== cfg.phoneIp) return send(403, "forbidden");
    const url = new URL(req.url ?? "/", "http://desk");
    const prefix = `/desk/${cfg.token}/`;
    if (!url.pathname.startsWith(prefix)) return send(404, "not found");
    const rest = url.pathname.slice(prefix.length);
    // Keys of type "XML browser" expect XML: a short confirmation, then back to the idle screen.
    const empty = `<YealinkIPPhoneTextScreen Beep="no" Timeout="1" destroyOnExit="yes"><Title>FORGE</Title><Text>OK</Text></YealinkIPPhoneTextScreen>`;

    if (rest.startsWith("prov/")) {
      // Newer firmware asks for .boot first; a 404 lets it fall back to the .cfg files.
      if (!rest.endsWith(".cfg")) return send(404, "not found");
      const sessions = this.d.listSessions();
      this.assignSlots(sessions);
      const labels = this.labels(new Map(sessions.map((s) => [s.id, s])));
      this.phoneLabels = labels.join("\n");
      this.d.log(`Tischtelefon: holt Konfiguration (${rest.slice(5)})`);
      return send(200, provisioningText(cfg, labels));
    }

    const key = /^key\/(\d+)$/.exec(rest);
    if (key) {
      const sessionId = this.slots[Number(key[1]) - 1] ?? null;
      send(200, empty, "text/xml; charset=utf-8");
      if (!sessionId) return;
      this.selected = sessionId;
      this.unheard.delete(sessionId);
      if (this.d.call().active) this.d.onKeyInCall(sessionId);
      else {
        // Not in a call: the key starts one about this session (the phone dials FORGE).
        this.pickup = { sessionId, at: Date.now() };
        if (cfg.forgeNumber) this.command(`number=${encodeURIComponent(cfg.forgeNumber)}`);
      }
      this.refresh();
      return;
    }

    if (rest === "answer") {
      const s = url.searchParams.get("s");
      const r = url.searchParams.get("r");
      const decision = url.searchParams.get("d");
      send(200, empty, "text/xml; charset=utf-8");
      if (!s || !r || (decision !== "allow" && decision !== "deny")) return;
      const open = this.d.pending(s);
      if (!open || open.requestId !== r) return this.notice(tr().phone.line.deskDone, tr().phone.line.deskNotOpen);
      try {
        this.d.respond(s, r, decision);
        this.d.log(`Tischtelefon: Freigabe ${decision === "allow" ? "erteilt" : "abgelehnt"}`);
      } catch (e) {
        this.notice(tr().phone.line.deskNotPossible, e instanceof Error ? e.message : String(e));
      }
      this.refresh();
      return;
    }
    send(404, "not found");
  }

  // ---------- requests to the phone

  /** Remote key / action URI, e.g. "AutoP" or "number=123". */
  private command(key: string) {
    void this.request("GET", `/servlet?key=${key}`);
  }

  private push(xml: string) {
    void this.request("POST", "/servlet?push=xml", `xml=${xml}`);
  }

  /**
   * Requests to the phone run without waiting; an unreachable phone must not slow FORGE down. The
   * phone's web login may want Basic or Digest; FORGE answers whatever it asks for.
   */
  private async request(method: "GET" | "POST", path: string, body?: string): Promise<void> {
    const cfg = this.cfg;
    if (!cfg) return;
    const f = this.d.fetch ?? fetch;
    const url = `http://${cfg.phoneIp}${path}`;
    const headers: Record<string, string> = { referer: `http://${cfg.phoneIp}/` };
    if (body !== undefined) headers["content-type"] = "text/xml; charset=utf-8";
    let error: string | null = null;
    try {
      let res = await f(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 401 && cfg.webPassword) {
        const auth = res.headers.get("www-authenticate") ?? "";
        const challenge = parseChallenge(auth);
        const authorization = challenge
          ? digestAuthorization(challenge, { username: cfg.webUser, password: cfg.webPassword, method, uri: path })
          : /^\s*basic/i.test(auth)
            ? `Basic ${Buffer.from(`${cfg.webUser}:${cfg.webPassword}`).toString("base64")}`
            : null;
        if (authorization) res = await f(url, { method, headers: { ...headers, authorization }, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      }
      if (res.status === 401) error = tr().phone.line.deskLoginRejected;
      else if (!res.ok) error = tr().phone.line.deskHttp(res.status);
    } catch (e) {
      error = e instanceof Error && e.name === "TimeoutError" ? tr().phone.line.deskNoAnswer : tr().phone.line.deskUnreachable;
    }
    if (this.cfg !== cfg) return;
    const was = this.reachable;
    this.reachable = error === null;
    this.message = error;
    if (was !== this.reachable) {
      this.d.log(error ? `Tischtelefon: ${error}` : "Tischtelefon: antwortet");
      this.d.onReachability();
      // Back after an outage: it missed LEDs and labels in the meantime.
      if (was === false && this.reachable) this.forceRefresh();
    }
  }
}

function requestShort(req: ApprovalRequest): string {
  if (req.toolName === "AskUserQuestion") return tr().phone.line.deskQuestion;
  if (req.toolName === "ExitPlanMode") return tr().phone.line.deskPlan;
  const subject = typeof req.input.command === "string" ? req.input.command : typeof req.input.file_path === "string" ? req.input.file_path : "";
  return `${req.toolName}${subject ? `: ${subject}` : ""}`;
}
