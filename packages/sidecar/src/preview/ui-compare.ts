import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type ServerEvent, type SessionEventBody, type UiCompare, type UiCompareShot } from "@forge/protocol";
import type { Capture } from "./preview.js";

/** Files whose change shows in the browser; a turn that touches none of them gets no comparison. */
export const UI_EXTENSIONS: ReadonlySet<string> = new Set([".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".html", ".astro"]);

/** Claude Code tools that write a file named in `file_path`. Changes through Bash are not seen. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write"]);

/** Time for the dev server's file watcher to pick up the last change before the after image loads the page fresh. */
export const SETTLE_MS = 1_500;
/** Comparisons older than this go away, also the ones of deleted sessions. */
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_KEPT = 100;
/** A before image without a comparison (sidecar ended mid-turn) is left over after this. */
const ORPHAN_MS = 6 * 60 * 60_000;

export interface UiCompareDeps {
  /** the data folder for the images, one subfolder per comparison */
  dir: string;
  enabled(): boolean;
  session(id: string): { projectId: string; cwd: string } | null;
  devServer(projectId: string): Promise<{ status: string; url: string | null }>;
  hasBrowser(): boolean;
  /** the page the session's preview tools showed last */
  lastViewed(sessionId: string): string | null;
  capture(projectId: string, url: string): Promise<Capture>;
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  /** lets drain() and shutdown wait for running captures */
  track(p: Promise<unknown>): void;
  settleMs?: number;
  now?: () => number;
}

interface Watch {
  id: string;
  projectId: string;
  cwd: string;
  before: Promise<UiCompareShot & { url: string } | null>;
  files: Set<string>;
}

export function isUiFile(file: string): boolean {
  return UI_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** The file an edit tool writes, relative to the session's folder; null for other tools and files outside it. */
export function editedFile(cwd: string, tool: string, input: Record<string, unknown>): string | null {
  if (!EDIT_TOOLS.has(tool) || typeof input.file_path !== "string" || !input.file_path) return null;
  const rel = path.relative(cwd, path.resolve(cwd, input.file_path));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** The page the comparison shows: the one Claude looked at last when it is on this machine, else the dev server's address. */
export function comparePage(lastViewed: string | null, devUrl: string): string {
  if (lastViewed) {
    try {
      const u = new URL(lastViewed);
      if ((u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return lastViewed;
    } catch {
      /* not a URL: the dev server's address */
    }
  }
  return devUrl;
}

const newId = (now: number) => `${now.toString(36)}-${randomBytes(4).toString("hex")}`;

/**
 * Before/after screenshots of the web app around a turn that changes UI files. The before image is
 * taken in the background when the turn starts (only with a running dev server and a browser); at the
 * end it becomes a comparison when UI files changed, otherwise it is thrown away. Images stay in the
 * data folder and never reach Claude.
 */
export class UiCompareService {
  private readonly watching = new Map<string, Watch>();
  /** comparisons whose after image is being taken; the files say "ready" or "failed" */
  private readonly busy = new Map<string, UiCompare>();

  constructor(private readonly deps: UiCompareDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private folder(id: string) {
    return path.join(this.deps.dir, id);
  }

  /** A turn started: takes the before image in the background, unless the session is watched already. */
  turnStarted(sessionId: string) {
    if (this.watching.has(sessionId) || !this.deps.enabled()) return;
    const rec = this.deps.session(sessionId);
    if (!rec) return;
    const id = newId(this.now());
    const before = this.takeBefore(id, sessionId, rec.projectId);
    this.watching.set(sessionId, { id, projectId: rec.projectId, cwd: rec.cwd, before, files: new Set() });
    this.deps.track(before);
  }

  private async takeBefore(id: string, sessionId: string, projectId: string): Promise<(UiCompareShot & { url: string }) | null> {
    try {
      const dev = await this.deps.devServer(projectId);
      if (dev.status !== "running" || !dev.url || !this.deps.hasBrowser()) return null;
      const shot = await this.deps.capture(projectId, comparePage(this.deps.lastViewed(sessionId), dev.url));
      return { ...(await this.save(id, "before", shot)), url: shot.url };
    } catch {
      // No comparison for this turn; the chat stays as it is.
      await rm(this.folder(id), { recursive: true, force: true }).catch(() => null);
      return null;
    }
  }

  private async save(id: string, side: "before" | "after", shot: Capture): Promise<UiCompareShot> {
    const dir = this.folder(id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${side}.jpg`);
    await writeFile(file, Buffer.from(shot.data, "base64"));
    return { width: shot.width, height: shot.height, path: file, takenAt: new Date(this.now()).toISOString() };
  }

  /** A tool call of the running turn; edits of UI files make the turn a comparison. */
  toolUsed(sessionId: string, tool: string, input: Record<string, unknown>) {
    const w = this.watching.get(sessionId);
    if (!w) return;
    const file = editedFile(w.cwd, tool, input);
    if (file && isUiFile(file)) w.files.add(file);
  }

  /** The turn ended (done, failed or stopped): the after image when UI files changed, else the before image goes. */
  turnEnded(sessionId: string) {
    const w = this.watching.get(sessionId);
    if (!w) return;
    this.watching.delete(sessionId);
    this.deps.track(this.finish(sessionId, w));
  }

  /** The session's process ended without a turn result: nothing to compare. */
  drop(sessionId: string) {
    const w = this.watching.get(sessionId);
    if (!w) return;
    this.watching.delete(sessionId);
    this.deps.track(w.before.then(() => rm(this.folder(w.id), { recursive: true, force: true })));
  }

  private async finish(sessionId: string, w: Watch) {
    const before = await w.before;
    if (!before || !w.files.size) {
      await rm(this.folder(w.id), { recursive: true, force: true }).catch(() => null);
      return;
    }
    const { url, ...shot } = before;
    const compare: UiCompare = {
      id: w.id,
      sessionId,
      projectId: w.projectId,
      url,
      files: [...w.files].sort(),
      createdAt: new Date(this.now()).toISOString(),
      status: "capturing",
      before: shot,
      after: null,
      error: null,
    };
    await this.writeMeta(compare);
    this.deps.record(sessionId, { type: "ui.compare", compareId: compare.id, url, files: compare.files });
    await this.takeAfter(compare);
    await this.prune().catch(() => null);
  }

  private async takeAfter(compare: UiCompare) {
    this.busy.set(compare.id, compare);
    this.deps.emit({ event: "uiCompare.updated", payload: compare });
    let next: UiCompare;
    try {
      await new Promise((r) => setTimeout(r, this.deps.settleMs ?? SETTLE_MS));
      const dev = await this.deps.devServer(compare.projectId);
      if (dev.status !== "running") throw new Error("Der Dev-Server läuft nicht mehr.");
      if (!this.deps.hasBrowser()) throw new Error("Kein Browser für die Vorschau gefunden.");
      const shot = await this.deps.capture(compare.projectId, compare.url);
      next = { ...compare, status: "ready", after: await this.save(compare.id, "after", shot), error: null };
    } catch (e) {
      next = { ...compare, status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    this.busy.delete(compare.id);
    await this.writeMeta(next).catch(() => null);
    this.deps.emit({ event: "uiCompare.updated", payload: next });
    return next;
  }

  private writeMeta(c: UiCompare) {
    return writeFile(path.join(this.folder(c.id), "meta.json"), JSON.stringify(c));
  }

  private async readMeta(id: string): Promise<UiCompare | null> {
    const busy = this.busy.get(id);
    if (busy) return busy;
    try {
      return JSON.parse(await readFile(path.join(this.folder(id), "meta.json"), "utf8")) as UiCompare;
    } catch {
      return null;
    }
  }

  async get(sessionId: string, compareId: string): Promise<UiCompare> {
    const c = await this.readMeta(compareId);
    if (!c || c.sessionId !== sessionId) throw new ForgeError("NOT_FOUND", "Vergleich nicht mehr vorhanden. FORGE räumt Bilder nach 14 Tagen weg.");
    return c;
  }

  async image(sessionId: string, compareId: string, side: "before" | "after") {
    const c = await this.get(sessionId, compareId);
    const shot = side === "before" ? c.before : c.after;
    if (!shot) throw new ForgeError("NOT_FOUND", "Das Nachher-Bild gibt es noch nicht.");
    try {
      return { mediaType: "image/jpeg", base64: (await readFile(shot.path)).toString("base64") };
    } catch {
      throw new ForgeError("NOT_FOUND", "Bild nicht mehr vorhanden.");
    }
  }

  /** Takes the after image again in the background; the state comes as uiCompare.updated. */
  async retake(sessionId: string, compareId: string): Promise<UiCompare> {
    const c = await this.get(sessionId, compareId);
    if (c.status === "capturing") return c;
    const next: UiCompare = { ...c, status: "capturing", error: null };
    this.busy.set(c.id, next);
    this.deps.track(this.takeAfter(next));
    return next;
  }

  /** The newest comparison, optionally of one session or project. */
  async latest(filter: { sessionId?: string; projectId?: string }): Promise<UiCompare | null> {
    const ids = (await readdir(this.deps.dir).catch(() => [] as string[])).sort().reverse();
    for (const id of ids) {
      const c = await this.readMeta(id);
      if (!c) continue;
      if (filter.sessionId && c.sessionId !== filter.sessionId) continue;
      if (filter.projectId && c.projectId !== filter.projectId) continue;
      return c;
    }
    return null;
  }

  /** Removes comparisons older than 14 days, all beyond the newest 100 and before images left without one. */
  async prune() {
    const now = this.now();
    const ids = (await readdir(this.deps.dir).catch(() => [] as string[])).sort().reverse();
    const active = new Set([...this.watching.values()].map((w) => w.id));
    let kept = 0;
    for (const id of ids) {
      if (active.has(id) || this.busy.has(id)) continue;
      const dir = this.folder(id);
      const meta = await this.readMeta(id);
      const born = meta ? Date.parse(meta.createdAt) : ((await stat(dir).catch(() => null))?.mtimeMs ?? now);
      const old = meta ? now - born > MAX_AGE_MS || ++kept > MAX_KEPT : now - born > ORPHAN_MS;
      if (old) await rm(dir, { recursive: true, force: true }).catch(() => null);
    }
  }
}
