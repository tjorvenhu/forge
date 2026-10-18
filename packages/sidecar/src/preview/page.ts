import { CdpTimeout, type Cdp } from "./browser.js";
import { isLocalUrl } from "./url.js";
import { tr } from "../i18n/index.js";

export interface PageLogEntry {
  kind: "console" | "exception" | "network";
  /** console: error, warning, log, info, debug; network: status or "fehlgeschlagen" */
  level: string;
  text: string;
}

export interface Shot {
  data: string;
  mimeType: "image/jpeg";
  /** pixels of the image */
  width: number;
  height: number;
  /** full page cut at MAX_FULL_HEIGHT */
  cut: boolean;
}

/** Claude scales larger images down anyway; bigger ones only cost upload time. */
export const MAX_EDGE = 1568;
const MAX_FULL_HEIGHT = 6000;
/** The first request to a dev server may compile the page first (Next.js, Vite): that can take a while. */
export const NAVIGATE_MS = 60_000;
const MAX_LOG = 300;
const MAX_ENTRY = 500;

const clip = (s: string, n = MAX_ENTRY) => (s.length > n ? `${s.slice(0, n)} …` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

function remoteText(o: RemoteObject): string {
  if (o.value !== undefined) return typeof o.value === "string" ? o.value : JSON.stringify(o.value);
  return o.unserializableValue ?? o.description ?? o.type ?? "";
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string; key?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " ", key: " " },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

/** "Control+Enter", "Shift+Tab", "a" → the parts of a CDP key event; null for an unknown key. */
export function parseKey(spec: string): { key: string; code: string; keyCode: number; text?: string; modifiers: number } | null {
  const parts = spec.split("+").map((p) => p.trim());
  const name = parts.pop() ?? "";
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m];
    if (!bit) return null;
    modifiers |= bit;
  }
  // With Control or Meta held a key is a shortcut, not typed text.
  const typed = (t: string | undefined) => (modifiers & (2 | 4) ? undefined : t);
  const canon = Object.keys(KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  if (canon) {
    const k = KEYS[canon]!;
    return { key: k.key ?? canon, code: k.code, keyCode: k.keyCode, text: typed(k.text), modifiers };
  }
  if ([...name].length !== 1) return null;
  const upper = name.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : "";
  const keyCode = /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0;
  return { key: name, code, keyCode, text: typed(name), modifiers };
}

/**
 * Runs in the page: the elements a selector names. Besides CSS it takes the Playwright forms Claude
 * writes out of habit: text=Anmelden, button:has-text("Speichern"), xpath=//button and a trailing
 * >> nth=1. Text matches are case-insensitive; text= gives the innermost elements holding the text.
 */
const FIND_ALL = `(sel) => {
  let nth = null;
  const n = /^(.*?)\\s*>>\\s*nth=(-?\\d+)\\s*$/.exec(sel);
  if (n) { sel = n[1]; nth = Number(n[2]); }
  const text = (e) => (e.innerText || e.textContent || "").toLowerCase();
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\\1$/, "$2").toLowerCase();
  let list;
  if (/^xpath=/.test(sel) || sel.startsWith("//")) {
    const r = document.evaluate(sel.replace(/^xpath=/, ""), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    list = [];
    for (let i = 0; i < r.snapshotLength; i++) list.push(r.snapshotItem(i));
  } else if (/^text=/.test(sel)) {
    const t = unquote(sel.slice(5));
    const hits = [...document.querySelectorAll("body *")].filter((e) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName) && text(e).includes(t));
    list = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
  } else {
    const h = /^(.*?):has-text\\((["'])(.*?)\\2\\)(.*)$/.exec(sel);
    list = h
      ? [...document.querySelectorAll((h[1] || "*") + h[4])].filter((e) => text(e).includes(h[3].toLowerCase()))
      : [...document.querySelectorAll(sel)];
  }
  if (nth !== null) list = [nth < 0 ? list[list.length + nth] : list[nth]].filter(Boolean);
  return list;
}`;

/** Expression for the first element `selector` names; with `visible` the first one with a size. */
export function findElement(selector: string, visible: boolean): string {
  const pick = visible ? ".find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })" : "[0]";
  return `((${FIND_ALL})(${JSON.stringify(selector)})${pick} ?? null)`;
}

/** One tab of the preview browser: navigation, what the page logged, screenshots and simple input. */
export class PreviewPage {
  logs: PageLogEntry[] = [];
  /** HTTP status of the last document in the main frame */
  status: number | null = null;
  /** non-local documents the page tried to open */
  blocked: string[] = [];
  private mainFrame = "";
  private loading = false;
  private readonly inflight = new Set<string>();
  private readonly requests = new Map<string, string>();
  private readonly waiters = new Set<() => void>();
  private readonly off: () => void;
  viewport = { width: 1280, height: 800 };

  private constructor(
    private readonly cdp: Cdp,
    private readonly targetId: string,
    private readonly session: string,
  ) {
    this.off = cdp.on((method, params, sessionId) => {
      if (sessionId === this.session) this.onEvent(method, params);
    });
  }

  static async open(cdp: Cdp): Promise<PreviewPage> {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = new PreviewPage(cdp, targetId, sessionId);
    await Promise.all(["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"].map((m) => page.send(m)));
    // Documents (pages, iframes, redirects) only on this machine; scripts, fonts and API calls still load.
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
    const tree = await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    page.mainFrame = tree.frameTree.frame.id;
    await page.setViewport(page.viewport.width, page.viewport.height);
    return page;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, this.session, timeoutMs);
  }

  /**
   * Makes this the foreground tab. A headless browser draws only the foreground tab: in a background
   * one captureScreenshot waits for a frame that never comes, and animation frames and timers stall.
   */
  async activate() {
    await this.send("Page.bringToFront", {}, 5_000);
  }

  async close() {
    this.off();
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }, undefined, 2_000).catch(() => null);
  }

  private log(entry: PageLogEntry) {
    this.logs.push({ ...entry, text: clip(entry.text) });
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
  }

  private wake() {
    for (const w of this.waiters) w();
  }

  private onEvent(method: string, p: Record<string, unknown>) {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const args = (p.args as RemoteObject[] | undefined) ?? [];
        const frame = (p.stackTrace as { callFrames?: Array<{ url: string; lineNumber: number }> } | undefined)?.callFrames?.[0];
        const where = frame?.url ? ` (${frame.url}:${frame.lineNumber + 1})` : "";
        const type = String(p.type ?? "log");
        this.log({ kind: "console", level: type === "warning" ? "warning" : type, text: args.map(remoteText).join(" ") + where });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = (p.exceptionDetails ?? {}) as { text?: string; exception?: RemoteObject; url?: string; lineNumber?: number };
        const text = d.exception?.description ?? (d.exception ? remoteText(d.exception) : d.text) ?? "Unbekannter Fehler";
        this.log({ kind: "exception", level: "error", text: text + (d.url ? ` (${d.url}:${(d.lineNumber ?? 0) + 1})` : "") });
        break;
      }
      case "Log.entryAdded": {
        const e = (p.entry ?? {}) as { level?: string; text?: string; source?: string; url?: string };
        // Network errors come from the Network events with method and status.
        if (e.source === "network" || (e.level !== "error" && e.level !== "warning")) break;
        this.log({ kind: "console", level: e.level, text: `${e.text ?? ""}${e.url ? ` (${e.url})` : ""}` });
        break;
      }
      case "Network.requestWillBeSent": {
        const id = String(p.requestId);
        const req = (p.request ?? {}) as { url?: string; method?: string };
        this.requests.set(id, `${req.method ?? "GET"} ${req.url ?? ""}`);
        this.inflight.add(id);
        break;
      }
      case "Network.responseReceived": {
        const res = (p.response ?? {}) as { status?: number; statusText?: string; url?: string };
        if (p.type === "Document" && p.frameId === this.mainFrame && typeof res.status === "number") this.status = res.status;
        if (typeof res.status === "number" && res.status >= 400) {
          const req = this.requests.get(String(p.requestId)) ?? res.url ?? "";
          this.log({ kind: "network", level: String(res.status), text: `${req} → ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` });
        }
        break;
      }
      case "Network.loadingFinished":
        this.inflight.delete(String(p.requestId));
        this.wake();
        break;
      case "Network.loadingFailed": {
        const id = String(p.requestId);
        this.inflight.delete(id);
        const why = p.canceled ? "abgebrochen" : String(p.blockedReason ?? p.errorText ?? "fehlgeschlagen");
        this.log({ kind: "network", level: "fehlgeschlagen", text: `${this.requests.get(id) ?? id} → ${why}` });
        this.wake();
        break;
      }
      case "Fetch.requestPaused": {
        const url = String((p.request as { url?: string } | undefined)?.url ?? "");
        const ok = isLocalUrl(url) || /^(about|data|blob):/i.test(url);
        if (!ok) this.blocked.push(url);
        void this.send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => null);
        break;
      }
      case "Page.frameStartedLoading":
        if (p.frameId === this.mainFrame) this.loading = true;
        break;
      case "Page.frameStoppedLoading":
        if (p.frameId === this.mainFrame) {
          this.loading = false;
          this.wake();
        }
        break;
      case "Page.loadEventFired":
        this.loading = false;
        this.wake();
        break;
      case "Page.javascriptDialogOpening": {
        // An open alert or confirm blocks the page: evaluate and screenshots would wait for it forever.
        // Confirm and prompt are declined, so a click never deletes something on its own.
        const type = String(p.type ?? "alert");
        const accept = type === "alert" || type === "beforeunload";
        this.log({ kind: "console", level: "warning", text: tr().core.preview.jsDialog(type, String(p.message ?? ""), accept) });
        void this.send("Page.handleJavaScriptDialog", { accept }).catch(() => null);
        break;
      }
    }
  }

  /** Resolves when `done()` holds, or false after `ms`. */
  private until(done: () => boolean, ms: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => {
        if (!done()) return;
        finish(true);
      };
      const finish = (v: boolean) => {
        clearTimeout(timer);
        clearInterval(poll);
        this.waiters.delete(check);
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), ms);
      // Quiet periods have no event that would wake us.
      const poll = setInterval(check, 100);
      this.waiters.add(check);
    });
  }

  /** Waits for a running navigation and then for the network to rest a moment (both bounded). */
  async settle(loadMs: number, idleMs = 3_000): Promise<{ loaded: boolean }> {
    const loaded = await this.until(() => !this.loading, loadMs);
    let quietSince = this.inflight.size ? 0 : Date.now();
    await this.until(() => {
      if (this.inflight.size) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      return !!quietSince && Date.now() - quietSince >= 400;
    }, idleMs);
    await this.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))", true, 2_000).catch(() => null);
    return { loaded };
  }

  async navigate(url: string, loadMs: number): Promise<{ loaded: boolean }> {
    // Only the fragment differs: the browser would just scroll, without a fresh load, log or status.
    const target = new URL(url);
    if (target.hash) {
      const current = (await this.info()).url;
      if (current && current.split("#")[0] === url.split("#")[0]) await this.send("Page.navigate", { url: "about:blank" }, 5_000).catch(() => null);
    }
    this.logs = [];
    this.blocked = [];
    this.status = null;
    this.inflight.clear();
    this.requests.clear();
    this.loading = true;
    let r: { errorText?: string };
    try {
      r = await this.send<{ errorText?: string }>("Page.navigate", { url }, NAVIGATE_MS);
    } catch (e) {
      if (!(e instanceof CdpTimeout)) throw e;
      this.loading = false;
      throw new Error(tr().core.preview.navigateTimeout(url, NAVIGATE_MS / 1000), { cause: e });
    }
    if (r.errorText) {
      this.loading = false;
      throw new Error(
        r.errorText === "net::ERR_CONNECTION_REFUSED"
          ? tr().core.preview.connectionRefused(url)
          : r.errorText === "net::ERR_BLOCKED_BY_CLIENT"
            ? tr().core.preview.redirectedOutside(url)
            : tr().core.preview.pageNotLoadable(r.errorText),
      );
    }
    return this.settle(loadMs);
  }

  async setViewport(width: number, height: number) {
    this.viewport = { width, height };
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async evaluate<T = unknown>(expression: string, awaitPromise = false, timeoutMs = 10_000): Promise<T> {
    const r = await this.send<{ result: RemoteObject; exceptionDetails?: { text?: string; exception?: RemoteObject } }>(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      timeoutMs,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? tr().core.preview.pageScriptError);
    return r.result.value as T;
  }

  async info(): Promise<{ title: string; url: string }> {
    return (await this.evaluate<{ title: string; url: string }>("({ title: document.title, url: location.href })").catch(() => null)) ?? { title: "", url: "" };
  }

  private async capture(x: number, y: number, width: number, height: number, scale: number, beyond: boolean): Promise<string> {
    const { data } = await this.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 70, clip: { x, y, width, height, scale }, captureBeyondViewport: beyond },
      30_000,
    );
    return data;
  }

  /** The visible part of the page. */
  async screenshot(): Promise<Shot> {
    const m = await this.send<{ cssVisualViewport: { pageX: number; pageY: number } }>("Page.getLayoutMetrics");
    const { width, height } = this.viewport;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const data = await this.capture(m.cssVisualViewport.pageX, m.cssVisualViewport.pageY, width, height, scale, false);
    return { data, mimeType: "image/jpeg", width: Math.round(width * scale), height: Math.round(height * scale), cut: false };
  }

  /**
   * The whole page in parts of at most MAX_EDGE pixels height, at the viewport's width. One image of a
   * long page would be shrunk until the text is unreadable (a phone page 6000 px high: 102 px wide).
   */
  async fullPage(): Promise<Shot[]> {
    const m = await this.send<{ cssContentSize: { height: number } }>("Page.getLayoutMetrics");
    const width = this.viewport.width;
    const fullHeight = Math.max(1, Math.ceil(m.cssContentSize.height));
    const height = Math.min(fullHeight, MAX_FULL_HEIGHT);
    const scale = Math.min(1, MAX_EDGE / width);
    const part = Math.floor(MAX_EDGE / scale);
    const shots: Shot[] = [];
    for (let y = 0; y < height; y += part) {
      const h = Math.min(part, height - y);
      const data = await this.capture(0, y, width, h, scale, true);
      shots.push({ data, mimeType: "image/jpeg", width: Math.round(width * scale), height: Math.round(h * scale), cut: fullHeight > MAX_FULL_HEIGHT });
    }
    return shots;
  }

  /** Waits until the selector matches (visible: with a size), throws after `ms`. */
  async waitFor(selector: string, ms: number, visible = false): Promise<void> {
    const expr = `!!${findElement(selector, visible)}`;
    const end = Date.now() + ms;
    for (;;) {
      let found: boolean;
      try {
        found = await this.evaluate<boolean>(expr);
      } catch (e) {
        if (e instanceof Error && /SyntaxError|not a valid (selector|XPath)/i.test(e.message)) throw new Error(tr().core.preview.invalidSelector(selector), { cause: e });
        found = false;
      }
      if (found) return;
      if (Date.now() >= end) throw new Error(tr().core.preview.noElement(selector, visible, ms));
      await sleep(100);
    }
  }

  async click(selector: string, ms: number) {
    await this.waitFor(selector, ms, true);
    const at = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = ${findElement(selector, true)}; if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!at) throw new Error(tr().core.preview.elementGone(selector));
    const base = { x: at.x, y: at.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  async type(selector: string, text: string, clear: boolean, ms: number) {
    await this.waitFor(selector, ms, true);
    await this.evaluate(
      `(() => { const el = ${findElement(selector, true)}; el.scrollIntoView({ block: "center" }); el.focus(); ${
        clear
          ? "if (typeof el.select === 'function') el.select(); else { const s = getSelection(); const r = document.createRange(); r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r); }"
          : ""
      } })()`,
    );
    if (text) await this.send("Input.insertText", { text });
    else if (clear) await this.press("Delete");
  }

  async press(spec: string) {
    const k = parseKey(spec);
    if (!k) throw new Error(tr().core.preview.unknownKey(spec, Object.keys(KEYS).join(", ")));
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}
