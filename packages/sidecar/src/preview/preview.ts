import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolOutput } from "../claude/runtime.js";
import { CdpTimeout, findBrowser as defaultFindBrowser, launchBrowser, noBrowser, type BrowserProcess, type Cdp } from "./browser.js";
import { PreviewPage, type PageLogEntry, type Shot } from "./page.js";
import { isLocalUrl, previewUrl } from "./url.js";
import { tr } from "../i18n/index.js";

export const LOAD_MS = 20_000;
export const STEP_MS = 5_000;
export const MAX_STEP_MS = 15_000;
const STEPS_TOTAL_MS = 90_000;
const IDLE_MS = 5 * 60_000;
const MAX_LOG_LINES = 60;
/** A browser killed a moment ago may still hold its kept profile. */
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_RETRY_MS = 500;
/** In the kept profile: the session cookies, which a browser drops when it ends. */
export const SESSION_COOKIES_FILE = "forge-session-cookies.json";

export interface PreviewDeps {
  /** state of the project's dev server (status and the local address it printed) */
  devServer(projectId: string): Promise<{ status: string; url: string | null }>;
  findBrowser?: () => string | null;
  /** `profile`: the project's kept profile, or none for a throwaway one */
  launch?: (exe: string, profile?: string) => Promise<BrowserProcess>;
  /**
   * A profile folder per project that outlives the browser: logins and the app's storage stay when
   * it closes after IDLE_MS or hangs. Without it every browser starts empty.
   */
  profileDir?: (projectId: string) => string;
  idleMs?: number;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
}

/**
 * The session cookies of local pages as they go to Storage.setCookies. A browser keeps them only while
 * it runs, and many apps log in with one (no Max-Age); persistent cookies stay in the profile anyway.
 */
async function sessionCookies(cdp: Cdp): Promise<string> {
  const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>("Storage.getCookies", {}, undefined, 2_000);
  const local = cookies.filter((c) => c.session && isLocalUrl(`http://${c.domain.replace(/^\./, "")}/`));
  return JSON.stringify(
    local.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(c.priority ? { priority: c.priority } : {}),
      ...(c.sourceScheme ? { sourceScheme: c.sourceScheme } : {}),
      ...(c.sourcePort ? { sourcePort: c.sourcePort } : {}),
    })),
  );
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
  /** the kept profile, and the session cookies last written there */
  profile?: string;
  cookies?: string;
}

/** "2 Fehler, 1 Warnung; 1 unbehandelte Ausnahme; 3 fehlgeschlagene Anfragen" */
export function logSummary(logs: PageLogEntry[]): string {
  const errors = logs.filter((l) => l.kind === "console" && l.level === "error").length;
  const warnings = logs.filter((l) => l.kind === "console" && l.level === "warning").length;
  const others = logs.filter((l) => l.kind === "console" && l.level !== "error" && l.level !== "warning").length;
  const exceptions = logs.filter((l) => l.kind === "exception").length;
  const network = logs.filter((l) => l.kind === "network").length;
  const t = tr().core.preview;
  const parts = [
    errors || warnings || others ? [errors && t.errors(errors), warnings && t.warnings(warnings), others && t.otherMessages(others)].filter(Boolean).join(", ") : "",
    exceptions ? t.exceptions(exceptions) : "",
    network ? t.failedRequests(network) : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : t.noMessages;
}

/** The page's log for Claude: exceptions, errors and warnings first, other messages last and fewest. */
export function formatLogs(logs: PageLogEntry[]): string[] {
  const out: string[] = [];
  const t = tr().core.preview;
  const section = (title: string, entries: PageLogEntry[], max: number, line: (l: PageLogEntry) => string) => {
    if (!entries.length) return;
    out.push(`${title}:`);
    const shown = entries.length > max ? entries.slice(-max) : entries;
    if (entries.length > max) out.push(`  ${t.olderOmitted(entries.length - max)}`);
    for (const l of shown) out.push(`- ${line(l)}`);
  };
  const exceptions = logs.filter((l) => l.kind === "exception");
  const important = logs.filter((l) => l.kind === "console" && (l.level === "error" || l.level === "warning"));
  const rest = logs.filter((l) => l.kind === "console" && l.level !== "error" && l.level !== "warning");
  const network = logs.filter((l) => l.kind === "network");
  section(t.sectionExceptions, exceptions, 15, (l) => l.text);
  section(t.sectionConsole, important, 25, (l) => `[${l.level}] ${l.text}`);
  section(t.sectionRequests, network, 20, (l) => l.text);
  section(t.sectionOther, rest, Math.max(5, MAX_LOG_LINES - out.length), (l) => `[${l.level}] ${l.text}`);
  return out;
}

/** "Screenshot: 390x1568 JPEG, ganze Seite in 4 Teilen …"; the card reads the size of the first image from it. */
function shotLine(shots: Shot[], requested: { width: number; height: number }, fullPage: boolean): string {
  const s = shots[0]!;
  const t = tr().core.preview;
  const notes = [s.cut ? t.shotCut : "", s.width < requested.width ? t.shotScaled : ""].filter(Boolean);
  // "Screenshot: WxH" stays the same in every language: the card reads the size from it.
  return `Screenshot: ${s.width}x${s.height} JPEG${fullPage ? t.shotFullPage(shots.length) : ""}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

const take = async (page: PreviewPage, fullPage: boolean): Promise<Shot[]> => (fullPage ? page.fullPage() : [await page.screenshot()]);
const asImages = (shots: Shot[]) => shots.map((s) => ({ data: s.data, mimeType: s.mimeType }));

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
    if (this.closed) throw new Error(tr().core.preview.closing);
    const have = this.open.get(projectId);
    if (have) {
      clearTimeout(have.timer);
      if (have.browser.alive) return have;
      this.open.delete(projectId);
      have.browser.killSync();
    }
    const exe = (this.deps.findBrowser ?? defaultFindBrowser)();
    if (!exe) throw new Error(noBrowser());
    const profile = this.deps.profileDir?.(projectId);
    const launch = this.deps.launch ?? ((x: string, p?: string) => launchBrowser(x, undefined, p));
    let browser: BrowserProcess | null = null;
    for (let attempt = 1; !browser; attempt++) {
      try {
        browser = await launch(exe, profile);
      } catch (e) {
        if (!profile || attempt >= LAUNCH_ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, LAUNCH_RETRY_MS));
      }
    }
    try {
      const inst: Instance = { browser, page: await PreviewPage.open(browser.cdp), profile };
      if (profile) inst.cookies = await this.restoreCookies(browser.cdp, profile);
      this.open.set(projectId, inst);
      return inst;
    } catch (e) {
      browser.killSync();
      throw e;
    }
  }

  /** Puts the session cookies of the last browser back; returns what was put back. */
  private async restoreCookies(cdp: Cdp, profile: string): Promise<string> {
    let saved: string;
    try {
      saved = readFileSync(path.join(profile, SESSION_COOKIES_FILE), "utf8");
    } catch {
      return "";
    }
    try {
      const cookies = JSON.parse(saved) as unknown[];
      if (cookies.length) await cdp.send("Storage.setCookies", { cookies }, undefined, 2_000);
      return saved;
    } catch {
      // A broken file or cookies the browser does not take: the app asks for a login again.
      return "";
    }
  }

  /** Writes the session cookies into the kept profile when they changed, so a killed browser loses none. */
  private async keepCookies(projectId: string) {
    const inst = this.open.get(projectId);
    if (!inst?.profile || !inst.browser.alive) return;
    try {
      const now = await sessionCookies(inst.browser.cdp);
      if (now === inst.cookies) return;
      writeFileSync(path.join(inst.profile, SESSION_COOKIES_FILE), now);
      inst.cookies = now;
    } catch {
      // the browser hangs or the folder is gone; the cookies of the last write stay
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

  /**
   * A DevTools call went unanswered: the browser or the page in it hangs and would make every later
   * call wait just as long. The browser goes; the next call starts a fresh one.
   */
  private hung(projectId: string, e: unknown): never {
    if (!(e instanceof CdpTimeout)) throw e;
    const inst = this.open.get(projectId);
    if (inst) {
      this.open.delete(projectId);
      clearTimeout(inst.timer);
      inst.browser.killSync();
    }
    throw new Error(
      tr().core.preview.hung(e.method),
      { cause: e },
    );
  }

  /** Runs `fn` on the project's page; the browser stays for the next call. */
  private withPage<T>(projectId: string, fn: (page: PreviewPage) => Promise<T>): Promise<T> {
    return this.exclusive(projectId, async () => {
      try {
        const { page } = await this.instance(projectId);
        // The comparison tab may have been in front last.
        await page.activate();
        return await fn(page);
      } catch (e) {
        return this.hung(projectId, e);
      } finally {
        await this.keepCookies(projectId);
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
      throw new Error(tr().core.preview.devServerNoUrl);
    throw new Error(tr().core.preview.noDevServer);
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
    const t = tr().core.preview;
    return [
      t.title(info.title),
      t.address(info.url),
      t.httpStatus(page.status),
      loaded ? "" : t.notLoaded(LOAD_MS / 1000),
      page.blocked.length ? t.blocked(page.blocked.slice(0, 3).join(", ")) : "",
    ].filter(Boolean);
  }

  screenshot(projectId: string, t: PreviewTarget & { fullPage?: boolean }): Promise<ToolOutput> {
    return this.withPage(projectId, async (page) => {
      const { loaded } = await this.load(page, projectId, t, false);
      const shots = await take(page, t.fullPage === true);
      const text = [
        ...(await this.header(page, loaded, t.viewer)),
        tr().core.preview.consoleLine(logSummary(page.logs), page.logs.length > 0),
        shotLine(shots, page.viewport, t.fullPage === true),
      ];
      return { text: text.join("\n"), images: asImages(shots) };
    });
  }

  console(projectId: string, t: PreviewTarget & { reload?: boolean }): Promise<string> {
    return this.withPage(projectId, async (page) => {
      const { loaded, navigated } = await this.load(page, projectId, t, t.reload !== true);
      return [
        ...(await this.header(page, loaded, t.viewer)),
        navigated ? tr().core.preview.freshlyLoaded : tr().core.preview.sinceLoad,
        tr().core.preview.summary(logSummary(page.logs)),
        ...formatLogs(page.logs),
      ].join("\n");
    });
  }

  interact(projectId: string, t: PreviewTarget & { steps: PreviewStep[]; stepMs?: number; screenshot?: boolean; fullPage?: boolean }): Promise<ToolOutput> {
    const problems = t.steps.map((s, i) => [i + 1, stepProblem(s)] as const).filter(([, p]) => p);
    if (problems.length) return Promise.reject(new Error(problems.map(([i, p]) => tr().core.preview.stepProblem(i, p!)).join(" ")));
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
          lines.push(tr().core.preview.stepTimedOut(label, STEPS_TOTAL_MS / 1000));
          break;
        }
        try {
          await runStep(page, s, stepMs);
          lines.push(`${label}: ok`);
        } catch (e) {
          failed = i + 1;
          lines.push(tr().core.preview.stepFailed(label, e instanceof Error ? e.message : String(e)));
          break;
        }
      }
      const logs = page.logs.slice(before);
      const text = [
        ...(await this.header(page, loaded, t.viewer)),
        tr().core.preview.steps,
        ...lines,
        failed !== null ? tr().core.preview.aborted(failed, t.steps.length) : tr().core.preview.allDone(t.steps.length),
        tr().core.preview.consoleDuringSteps(logSummary(logs)),
        ...formatLogs(logs).slice(0, 20),
      ];
      if (t.screenshot === false) return { text: text.join("\n") };
      const shots = await take(page, t.fullPage === true);
      text.push(shotLine(shots, page.viewport, t.fullPage === true));
      return { text: text.join("\n"), images: asImages(shots) };
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
        await inst.compare.activate();
        await inst.compare.navigate(target, LOAD_MS);
        const shot = await inst.compare.screenshot();
        const info = await inst.compare.info();
        return { ...shot, url: info.url || target };
      } catch (e) {
        return this.hung(projectId, e);
      } finally {
        await this.keepCookies(projectId);
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
      return `type ${s.selector ?? ""} ${tr().core.preview.quote((s.text ?? "").length > 40 ? `${s.text!.slice(0, 40)} …` : (s.text ?? ""))}`;
    case "press":
      return `press ${s.key ?? ""}`;
    case "wait":
      return s.selector ? `wait ${s.selector}` : `wait ${s.ms ?? 0} ms`;
  }
}

/** Checks a step before anything runs, so a typo does not stop a sequence halfway. */
export function stepProblem(s: PreviewStep): string | null {
  if ((s.action === "click" || s.action === "type") && !s.selector?.trim()) return tr().core.preview.needsSelector(s.action);
  if (s.action === "type" && s.text === undefined && !s.clear) return tr().core.preview.typeNeedsText;
  if (s.action === "press" && !s.key?.trim()) return tr().core.preview.pressNeedsKey;
  if (s.action === "wait" && s.ms === undefined && !s.selector?.trim()) return tr().core.preview.waitNeedsMsOrSelector;
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
