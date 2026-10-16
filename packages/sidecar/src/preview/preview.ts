import type { ToolOutput } from "../claude/runtime.js";
import { findBrowser as defaultFindBrowser, launchBrowser, NO_BROWSER, type BrowserProcess } from "./browser.js";
import { PreviewPage, type PageLogEntry, type Shot } from "./page.js";
import { isLocalUrl, previewUrl } from "./url.js";

export const LOAD_MS = 20_000;
export const STEP_MS = 5_000;
export const MAX_STEP_MS = 15_000;
const STEPS_TOTAL_MS = 90_000;
const IDLE_MS = 5 * 60_000;
const MAX_LOG_LINES = 60;

export interface PreviewDeps {
  /** state of the project's dev server (status and the local address it printed) */
  devServer(projectId: string): Promise<{ status: string; url: string | null }>;
  findBrowser?: () => string | null;
  launch?: (exe: string) => Promise<BrowserProcess>;
  idleMs?: number;
}

export interface PreviewTarget {
  url?: string | null;
  path?: string | null;
  width?: number | null;
  height?: number | null;
  /** the session asking; its last page is where the before/after comparison looks */
  viewer?: string | null;
}

/** A screenshot for the before/after comparison and the address it shows. */
export interface Capture extends Shot {
  url: string;
}

export interface PreviewStep {
  action: "click" | "type" | "press" | "wait";
  selector?: string;
  text?: string;
  key?: string;
  ms?: number;
  clear?: boolean;
}

interface Instance {
  browser: BrowserProcess;
  page: PreviewPage;
  /** a tab of its own for comparison shots, so Claude's open page, log and viewport stay as they are */
  compare?: PreviewPage;
  timer?: ReturnType<typeof setTimeout>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 Fehler, 1 Warnung; 1 unbehandelte Ausnahme; 3 fehlgeschlagene Anfragen" */
export function logSummary(logs: PageLogEntry[]): string {
  const errors = logs.filter((l) => l.kind === "console" && l.level === "error").length;
  const warnings = logs.filter((l) => l.kind === "console" && l.level === "warning").length;
  const others = logs.filter((l) => l.kind === "console" && l.level !== "error" && l.level !== "warning").length;
  const exceptions = logs.filter((l) => l.kind === "exception").length;
  const network = logs.filter((l) => l.kind === "network").length;
  const parts = [
    errors || warnings || others ? [errors && plural(errors, "Fehler", "Fehler"), warnings && plural(warnings, "Warnung", "Warnungen"), others && plural(others, "weitere Meldung", "weitere Meldungen")].filter(Boolean).join(", ") : "",
    exceptions ? plural(exceptions, "unbehandelte Ausnahme", "unbehandelte Ausnahmen") : "",
    network ? plural(network, "fehlgeschlagene Anfrage", "fehlgeschlagene Anfragen") : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "keine Meldungen";
}

/** The page's log for Claude: exceptions, errors and warnings first, other messages last and fewest. */
export function formatLogs(logs: PageLogEntry[]): string[] {
  const out: string[] = [];
  const section = (title: string, entries: PageLogEntry[], max: number, line: (l: PageLogEntry) => string) => {
    if (!entries.length) return;
    out.push(`${title}:`);
    const shown = entries.length > max ? entries.slice(-max) : entries;
    if (entries.length > max) out.push(`  (${entries.length - max} ältere ausgelassen)`);
    for (const l of shown) out.push(`- ${line(l)}`);
  };
  const exceptions = logs.filter((l) => l.kind === "exception");
  const important = logs.filter((l) => l.kind === "console" && (l.level === "error" || l.level === "warning"));
  const rest = logs.filter((l) => l.kind === "console" && l.level !== "error" && l.level !== "warning");
  const network = logs.filter((l) => l.kind === "network");
  section("Unbehandelte Ausnahmen", exceptions, 15, (l) => l.text);
  section("Fehler und Warnungen der Konsole", important, 25, (l) => `[${l.level}] ${l.text}`);
  section("Fehlgeschlagene Anfragen", network, 20, (l) => l.text);
  section("Weitere Konsolenmeldungen", rest, Math.max(5, MAX_LOG_LINES - out.length), (l) => `[${l.level}] ${l.text}`);
  return out;
}

function shotLine(s: Shot, requested: { width: number; height: number }, fullPage: boolean): string {
  const notes = [s.cut ? "ganze Seite nach 6000 Pixeln abgeschnitten" : "", s.width < requested.width ? "verkleinert" : ""].filter(Boolean);
  return `Screenshot: ${s.width}x${s.height} JPEG${fullPage ? ", ganze Seite" : ""}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/**
 * Headless Edge (or Chrome) per project for the preview tools. A browser stays open for the next
 * call and goes away after a few idle minutes or with the sidecar; calls of one project run in order.
 */
export class PreviewService {
  private readonly open = new Map<string, Instance>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** session -> the page its preview tools showed last */
  private readonly viewed = new Map<string, string>();
  private closed = false;

  constructor(private readonly deps: PreviewDeps) {}

  private exclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const run = prev.catch(() => null).then(fn);
    const tail = run.catch(() => null);
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return run;
  }

  private async instance(projectId: string): Promise<Instance> {
    if (this.closed) throw new Error("FORGE wird beendet.");
    const have = this.open.get(projectId);
    if (have) {
      clearTimeout(have.timer);
      if (have.browser.alive) return have;
      this.open.delete(projectId);
      have.browser.killSync();
    }
    const exe = (this.deps.findBrowser ?? defaultFindBrowser)();
    if (!exe) throw new Error(NO_BROWSER);
    const browser = await (this.deps.launch ?? launchBrowser)(exe);
    try {
      const inst = { browser, page: await PreviewPage.open(browser.cdp) };
      this.open.set(projectId, inst);
      return inst;
    } catch (e) {
      browser.killSync();
      throw e;
    }
  }

  private idle(projectId: string) {
    const inst = this.open.get(projectId);
    if (!inst) return;
    clearTimeout(inst.timer);
    if (!inst.browser.alive) {
      this.open.delete(projectId);
      inst.browser.killSync();
      return;
    }
    inst.timer = setTimeout(() => void this.exclusive(projectId, () => this.close(projectId)), this.deps.idleMs ?? IDLE_MS);
    inst.timer.unref?.();
  }

  /** Runs `fn` on the project's page; the browser stays for the next call. */
  private withPage<T>(projectId: string, fn: (page: PreviewPage) => Promise<T>): Promise<T> {
    return this.exclusive(projectId, async () => {
      try {
        return await fn((await this.instance(projectId)).page);
      } finally {
        this.idle(projectId);
      }
    });
  }

  /** The page to load, or null to stay on the open one (only when `keep` allows it and nothing was asked for). */
  private async resolve(projectId: string, t: PreviewTarget, current: string | null, keep: boolean): Promise<string | null> {
    const open = current && isLocalUrl(current) ? current : null;
    if (t.url?.trim()) return previewUrl({ url: t.url, path: t.path });
    if (keep && open && !t.path?.trim()) return null;
    const dev = await this.deps.devServer(projectId);
    if (dev.url) return previewUrl({ base: dev.url, path: t.path });
    if (open) return previewUrl({ base: open, path: t.path });
    if (dev.status === "running")
      throw new Error("Der Dev-Server läuft, hat aber noch keine Adresse ausgegeben. Warte kurz und prüfe dev_environment, oder gib die url an (z. B. http://localhost:3000).");
    throw new Error("Für dieses Projekt läuft kein Dev-Server. Starte ihn mit dev_control (target dev-server, action start) oder gib eine lokale url an.");
  }

  private async load(page: PreviewPage, projectId: string, t: PreviewTarget, keep: boolean): Promise<{ loaded: boolean; navigated: boolean }> {
    if (t.width || t.height) await page.setViewport(t.width ?? page.viewport.width, t.height ?? page.viewport.height);
    const url = await this.resolve(projectId, t, (await page.info()).url, keep);
    if (!url) return { loaded: true, navigated: false };
    return { ...(await page.navigate(url, LOAD_MS)), navigated: true };
  }

  private async header(page: PreviewPage, loaded: boolean, viewer: string | null | undefined): Promise<string[]> {
    const info = await page.info();
    if (viewer && isLocalUrl(info.url)) this.viewed.set(viewer, info.url);
    return [
      `Titel: ${info.title || "(ohne Titel)"}`,
      `Adresse: ${info.url}`,
      `HTTP-Status: ${page.status ?? "unbekannt"}`,
      loaded ? "" : `Hinweis: Die Seite hat nach ${LOAD_MS / 1000} s noch nicht fertig geladen; der Stand ist der von diesem Moment.`,
      page.blocked.length ? `Blockiert (Seiten außerhalb dieses Rechners): ${page.blocked.slice(0, 3).join(", ")}` : "",
    ].filter(Boolean);
  }

  screenshot(projectId: string, t: PreviewTarget & { fullPage?: boolean }): Promise<ToolOutput> {
    return this.withPage(projectId, async (page) => {
      const { loaded } = await this.load(page, projectId, t, false);
      const shot = await page.screenshot(t.fullPage === true);
      const text = [
        ...(await this.header(page, loaded, t.viewer)),
        `Konsole: ${logSummary(page.logs)}${page.logs.length ? " (Einzelheiten mit preview_console)" : ""}`,
        shotLine(shot, page.viewport, t.fullPage === true),
      ];
      return { text: text.join("\n"), images: [{ data: shot.data, mimeType: shot.mimeType }] };
    });
  }

  console(projectId: string, t: PreviewTarget & { reload?: boolean }): Promise<string> {
    return this.withPage(projectId, async (page) => {
      const { loaded, navigated } = await this.load(page, projectId, t, t.reload !== true);
      return [
        ...(await this.header(page, loaded, t.viewer)),
        navigated ? "Seite frisch geladen." : "Meldungen der zuletzt geöffneten Seite seit dem Laden.",
        `Zusammenfassung: ${logSummary(page.logs)}`,
        ...formatLogs(page.logs),
      ].join("\n");
    });
  }

  interact(projectId: string, t: PreviewTarget & { steps: PreviewStep[]; stepMs?: number; screenshot?: boolean; fullPage?: boolean }): Promise<ToolOutput> {
    const problems = t.steps.map((s, i) => [i + 1, stepProblem(s)] as const).filter(([, p]) => p);
    if (problems.length) return Promise.reject(new Error(problems.map(([i, p]) => `Schritt ${i}: ${p}`).join(" ")));
    return this.withPage(projectId, async (page) => {
      const { loaded } = await this.load(page, projectId, t, true);
      const stepMs = Math.min(Math.max(t.stepMs ?? STEP_MS, 100), MAX_STEP_MS);
      const before = page.logs.length;
      const lines: string[] = [];
      const end = Date.now() + STEPS_TOTAL_MS;
      let failed: number | null = null;
      for (const [i, s] of t.steps.entries()) {
        const label = `${i + 1}. ${describeStep(s)}`;
        if (Date.now() > end) {
          failed = i + 1;
          lines.push(`${label}: nicht ausgeführt, Zeitlimit von ${STEPS_TOTAL_MS / 1000} s für alle Schritte erreicht`);
          break;
        }
        try {
          await runStep(page, s, stepMs);
          lines.push(`${label}: ok`);
        } catch (e) {
          failed = i + 1;
          lines.push(`${label}: Fehler: ${e instanceof Error ? e.message : String(e)}`);
          break;
        }
      }
      const logs = page.logs.slice(before);
      const text = [
        ...(await this.header(page, loaded, t.viewer)),
        "Schritte:",
        ...lines,
        failed !== null ? `Abgebrochen nach Schritt ${failed} von ${t.steps.length}.` : `Alle ${t.steps.length} Schritte ausgeführt.`,
        `Konsole während der Schritte: ${logSummary(logs)}`,
        ...formatLogs(logs).slice(0, 20),
      ];
      if (t.screenshot === false) return { text: text.join("\n") };
      const shot = await page.screenshot(t.fullPage === true);
      text.push(shotLine(shot, page.viewport, t.fullPage === true));
      return { text: text.join("\n"), images: [{ data: shot.data, mimeType: shot.mimeType }] };
    });
  }

  /** Edge or Chrome is installed; without one the comparison stays quiet instead of failing. */
  hasBrowser(): boolean {
    return !!(this.deps.findBrowser ?? defaultFindBrowser)();
  }

  /** The local page a session's preview tools showed last, or null. */
  lastViewed(viewer: string): string | null {
    return this.viewed.get(viewer) ?? null;
  }

  /**
   * Loads a local page fresh in the comparison tab (default viewport) and takes a screenshot. Runs in
   * the project's queue like the tools, but on its own tab: Claude's page is not touched.
   */
  async capture(projectId: string, url: string): Promise<Capture> {
    const target = previewUrl({ url });
    return this.exclusive(projectId, async () => {
      try {
        const inst = await this.instance(projectId);
        inst.compare ??= await PreviewPage.open(inst.browser.cdp);
        await inst.compare.navigate(target, LOAD_MS);
        const shot = await inst.compare.screenshot(false);
        const info = await inst.compare.info();
        return { ...shot, url: info.url || target };
      } finally {
        this.idle(projectId);
      }
    });
  }

  private async close(projectId: string) {
    const inst = this.open.get(projectId);
    if (!inst) return;
    this.open.delete(projectId);
    clearTimeout(inst.timer);
    await inst.browser.close();
  }

  /** Closes every preview browser properly; for the sidecar's shutdown while there is time. */
  async closeAll() {
    this.closed = true;
    await Promise.allSettled([...this.open.keys()].map((id) => this.exclusive(id, () => this.close(id))));
  }

  /** Ends what is left right away (after closeAll ran out of time). */
  shutdown() {
    this.closed = true;
    for (const inst of this.open.values()) {
      clearTimeout(inst.timer);
      inst.browser.killSync();
    }
    this.open.clear();
  }
}

export function describeStep(s: PreviewStep): string {
  switch (s.action) {
    case "click":
      return `click ${s.selector ?? ""}`;
    case "type":
      return `type ${s.selector ?? ""} „${(s.text ?? "").length > 40 ? `${s.text!.slice(0, 40)} …` : (s.text ?? "")}“`;
    case "press":
      return `press ${s.key ?? ""}`;
    case "wait":
      return s.selector ? `wait ${s.selector}` : `wait ${s.ms ?? 0} ms`;
  }
}

/** Checks a step before anything runs, so a typo does not stop a sequence halfway. */
export function stepProblem(s: PreviewStep): string | null {
  if ((s.action === "click" || s.action === "type") && !s.selector?.trim()) return `${s.action} braucht selector.`;
  if (s.action === "type" && s.text === undefined && !s.clear) return "type braucht text.";
  if (s.action === "press" && !s.key?.trim()) return "press braucht key.";
  if (s.action === "wait" && s.ms === undefined && !s.selector?.trim()) return "wait braucht ms oder selector.";
  return null;
}

async function runStep(page: PreviewPage, s: PreviewStep, stepMs: number) {
  switch (s.action) {
    case "click":
      await page.click(s.selector!, stepMs);
      await new Promise((r) => setTimeout(r, 150));
      await page.settle(LOAD_MS, 2_000);
      return;
    case "type":
      await page.type(s.selector!, s.text ?? "", s.clear === true, stepMs);
      await page.settle(stepMs, 1_000);
      return;
    case "press":
      await page.press(s.key!);
      await new Promise((r) => setTimeout(r, 150));
      await page.settle(LOAD_MS, 2_000);
      return;
    case "wait":
      if (s.selector?.trim()) await page.waitFor(s.selector, s.ms ?? stepMs);
      else await new Promise((r) => setTimeout(r, Math.min(s.ms ?? 0, MAX_STEP_MS)));
      return;
  }
}
