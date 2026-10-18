import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tr } from "../i18n/index.js";
import { killTree } from "../util/proc.js";

/** Where Edge and Chrome live, Edge first: it ships with every Windows 11. */
export function browserCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const roots = [...new Set([env["ProgramFiles(x86)"], env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA].filter((r): r is string => !!r))];
    return [
      ...roots.map((r) => path.win32.join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...roots.map((r) => path.win32.join(r, "Google", "Chrome", "Application", "chrome.exe")),
    ];
  }
  if (platform === "darwin")
    return ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  return ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  return browserCandidates(env, platform).find((p) => exists(p)) ?? null;
}

export const noBrowser = () => tr().core.preview.noBrowser;

type Listener = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void;

/** A DevTools call that got no answer in time; the browser or the page in it may hang. */
export class CdpTimeout extends Error {
  constructor(readonly method: string) {
    super(tr().core.preview.browserNoAnswer(method));
  }
}

/** Chrome DevTools Protocol over Node's built-in WebSocket; one connection, pages as flat sessions. */
export class Cdp {
  private next = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<Listener>();
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => this.onMessage(String(e.data)));
    ws.addEventListener("close", () => this.fail(new Error(tr().core.preview.browserDisconnected)));
  }

  static connect(url: string, timeoutMs: number): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(tr().core.preview.browserNoDevTools));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(tr().core.preview.browserConnectFailed));
      });
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(tr().core.preview.browserDisconnected));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeout(method));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    if (this.closed) return;
    this.ws.close();
    this.fail(new Error(tr().core.preview.browserDisconnected));
  }

  private onMessage(raw: string) {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? tr().core.preview.browserError));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
  }

  private fail(e: Error) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}

export interface BrowserProcess {
  cdp: Cdp;
  readonly alive: boolean;
  /** Browser.close, then the process tree and a temporary profile (a kept one stays) */
  close(): Promise<void>;
  /** for the sidecar's shutdown: no waiting, nothing left running */
  killSync(): void;
}

/** Windows releases the files of a killed browser only a moment after taskkill returns. */
function removeTempProfile(dir: string, attempts = 1) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (i < attempts - 1) Atomics.wait(pause, 0, 0, 100);
    }
  }
  // Still locked: sweepProfiles takes it on a later start.
}

const PROFILE_PREFIX = "forge-preview-";
const STALE_PROFILE_MS = 6 * 60 * 60_000;

/**
 * Profiles left behind: Windows keeps a killed browser's folder locked for a moment, and a crashed
 * sidecar never got to clean up. Empty ones go at once; others only when old and their lockfile is
 * free (a running browser, maybe of another FORGE, holds it open).
 */
export function sweepProfiles(dir = os.tmpdir(), now = Date.now()) {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(PROFILE_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const profile = path.join(dir, name);
    try {
      if (readdirSync(profile).length) {
        if (now - statSync(profile).mtimeMs < STALE_PROFILE_MS) continue;
        rmSync(path.join(profile, "lockfile"), { force: true });
      }
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // in use or already gone
    }
  }
}

/** Kept profiles (one folder per project id in `dir`) of projects that are gone. */
export function pruneProfiles(dir: string, keep: ReadonlySet<string>) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // a browser still has it open; the next start tries again
    }
  }
}

/** A kept profile caches what the dev server sends; this bounds it. */
const KEPT_CACHE_BYTES = 50 * 1024 * 1024;

/**
 * Starts the browser headless. Port 0 lets the browser pick a free port; it writes the port and the
 * browser's WebSocket path into DevToolsActivePort in the profile. `keepProfile`: a folder of its own
 * that outlives the browser (logins, localStorage of the app); otherwise a throwaway one in TEMP.
 */
export async function launchBrowser(exe: string, timeoutMs = 20_000, keepProfile?: string): Promise<BrowserProcess> {
  sweepProfiles();
  let profile: string;
  if (keepProfile) {
    mkdirSync(keepProfile, { recursive: true });
    // From the last run; read before the new browser writes its own, it would point at a dead port.
    rmSync(path.join(keepProfile, "DevToolsActivePort"), { force: true });
    profile = keepProfile;
  } else profile = mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  const removeProfile = (dir: string, attempts = 1) => {
    if (!keepProfile) removeTempProfile(dir, attempts);
  };
  const args = [
    "--headless=new",
    `--user-data-dir=${profile}`,
    ...(keepProfile ? [`--disk-cache-size=${KEPT_CACHE_BYTES}`] : []),
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-breakpad",
    "--disable-features=Translate,OptimizationHints,MediaRouter,EdgeCollections,msEdgeSidebarV2",
    "--mute-audio",
    "--hide-scrollbars",
    "about:blank",
  ];
  let child: ChildProcess;
  try {
    child = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  } catch (e) {
    removeProfile(profile);
    throw new Error(tr().core.preview.browserStartFailed(e instanceof Error ? e.message : String(e)), { cause: e });
  }
  let exited = false;
  let spawnError: Error | null = null;
  child.on("exit", () => (exited = true));
  child.on("error", (e) => {
    spawnError = e;
    exited = true;
  });

  const killSync = () => {
    killTree(child, { sync: true });
    removeProfile(profile, 20);
  };

  const portFile = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let wsUrl: string | null = null;
  while (!wsUrl) {
    if (exited) {
      removeProfile(profile);
      throw new Error(tr().core.preview.browserExited(spawnError ? (spawnError as Error).message : null));
    }
    if (Date.now() > deadline) {
      killSync();
      throw new Error(tr().core.preview.browserNoPort(Math.round(timeoutMs / 1000)));
    }
    try {
      const [port, wsPath] = readFileSync(portFile, "utf8").split(/\r?\n/);
      if (port && wsPath) wsUrl = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
    } catch {
      // not written yet
    }
    if (!wsUrl) await new Promise((r) => setTimeout(r, 100));
  }

  let cdp: Cdp;
  try {
    cdp = await Cdp.connect(wsUrl, Math.max(2_000, deadline - Date.now()));
  } catch (e) {
    killSync();
    throw e;
  }

  return {
    cdp,
    get alive() {
      return !exited && !cdp.closed;
    },
    async close() {
      if (!exited) {
        await cdp.send("Browser.close", {}, undefined, 2_000).catch(() => null);
        await new Promise<void>((r) => {
          if (exited) return r();
          const t = setTimeout(r, 3_000);
          child.once("exit", () => {
            clearTimeout(t);
            r();
          });
        });
      }
      cdp.close();
      killSync();
    },
    killSync() {
      cdp.close();
      killSync();
    },
  };
}
