import type { Cdp } from "./browser.js";
import { isLocalUrl } from "./url.js";

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
    this.logs = [];
    this.blocked = [];
    this.status = null;
    this.inflight.clear();
    this.requests.clear();
    this.loading = true;
    const r = await this.send<{ errorText?: string }>("Page.navigate", { url }, loadMs);
    if (r.errorText) {
      this.loading = false;
      throw new Error(
        r.errorText === "net::ERR_CONNECTION_REFUSED"
          ? `Unter ${url} antwortet nichts (Verbindung abgelehnt). Läuft der Dev-Server?`
          : r.errorText === "net::ERR_BLOCKED_BY_CLIENT"
            ? `${url} leitet auf eine Adresse außerhalb dieses Rechners um; die Vorschau öffnet nur lokale Seiten.`
            : `Seite nicht ladbar: ${r.errorText}`,
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text ?? "Fehler im Skript der Seite.");
    return r.result.value as T;
  }

  async info(): Promise<{ title: string; url: string }> {
    return (await this.evaluate<{ title: string; url: string }>("({ title: document.title, url: location.href })").catch(() => null)) ?? { title: "", url: "" };
  }

  async screenshot(fullPage: boolean): Promise<Shot> {
    const m = await this.send<{ cssContentSize: { height: number }; cssVisualViewport: { pageX: number; pageY: number } }>("Page.getLayoutMetrics");
    const width = this.viewport.width;
    const fullHeight = Math.ceil(m.cssContentSize.height);
    const height = fullPage ? Math.max(1, Math.min(fullHeight, MAX_FULL_HEIGHT)) : this.viewport.height;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const x = fullPage ? 0 : m.cssVisualViewport.pageX;
    const y = fullPage ? 0 : m.cssVisualViewport.pageY;
    const { data } = await this.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 70, clip: { x, y, width, height, scale }, captureBeyondViewport: fullPage },
      30_000,
    );
    return { data, mimeType: "image/jpeg", width: Math.round(width * scale), height: Math.round(height * scale), cut: fullPage && fullHeight > MAX_FULL_HEIGHT };
  }

  /** Waits until the selector matches (visible: with a size), throws after `ms`. */
  async waitFor(selector: string, ms: number, visible = false): Promise<void> {
    const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; ${
      visible ? "const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;" : "return true;"
    } })()`;
    const end = Date.now() + ms;
    for (;;) {
      let found: boolean;
      try {
        found = await this.evaluate<boolean>(expr);
      } catch (e) {
        if (e instanceof Error && /SyntaxError|not a valid selector/i.test(e.message)) throw new Error(`Ungültiger CSS-Selektor: ${selector}`, { cause: e });
        found = false;
      }
      if (found) return;
      if (Date.now() >= end) throw new Error(`Kein ${visible ? "sichtbares " : ""}Element für „${selector}“ nach ${ms} ms.`);
      await sleep(100);
    }
  }

  async click(selector: string, ms: number) {
    await this.waitFor(selector, ms, true);
    const at = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!at) throw new Error(`Element „${selector}“ ist verschwunden.`);
    const base = { x: at.x, y: at.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  async type(selector: string, text: string, clear: boolean, ms: number) {
    await this.waitFor(selector, ms, true);
    await this.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "center" }); el.focus(); ${
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
    if (!k) throw new Error(`Unbekannte Taste „${spec}“. Möglich: ${Object.keys(KEYS).join(", ")}, einzelne Zeichen, mit Control+, Shift+, Alt+ oder Meta+ davor.`);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}
