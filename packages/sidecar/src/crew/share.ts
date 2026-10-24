import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import {
  CREW_SHARE_CHUNK_CHARS,
  CREW_SHARE_MAX_BYTES,
  EffortLevel,
  ForgeError,
  SessionEventBody,
  type CrewShare,
  type CrewShareMode,
  type CrewShareRequest,
  type Project,
  type Session,
} from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import type { CopyImport } from "../sessions/session-service.js";
import { open, randomId, seal } from "./crypto.js";
import { RelayLink, type Envelope } from "./link.js";
import { ShareMessage, type RoomMessage } from "./wire.js";
import { tr } from "../i18n/index.js";

/** events a copy carries at most (the newest) */
export const SHARE_EVENTS_MAX = 20_000;
/** no answer to a request after this long: it failed */
const ASK_TIMEOUT_MS = 90_000;
/** no chunk for this long while a copy transfers: it failed */
const TRANSFER_STALL_MS = 120_000;
/** a live view sends what happened this often */
const LIVE_FLUSH_MS = 1_000;
/** the viewer says it still watches this often; the sharer stops after LIVE_IDLE_MS without it */
const KEEP_MS = 4 * 60_000;
const LIVE_IDLE_MS = 10 * 60_000;
/** a live view ends after this long anyway */
const LIVE_MAX_MS = 4 * 3600_000;
const TRANSCRIPT_MAX_BYTES = 150 * 1024 * 1024;

/** The copy of a session, as it travels (gzipped JSON). */
const SharePayload = z.object({
  v: z.literal(1),
  mode: z.enum(["view", "takeover"]),
  session: z.object({
    title: z.string().max(500),
    model: z.string().max(100).nullable(),
    effort: EffortLevel.nullable(),
  }),
  /** the session's folder on the sharer's computer, to point paths of Claude's conversation here */
  cwd: z.string(),
  events: z.array(SessionEventBody).max(SHARE_EVENTS_MAX),
  /** takeover: Claude Code's transcript (JSONL) */
  transcript: z.object({ sessionId: z.string(), text: z.string() }).nullable(),
  /** takeover: the files as they are there */
  git: z
    .object({
      /** HEAD there; the copy's working tree differs from it by the uncommitted changes */
      head: z.string(),
      /** commit holding the working tree (equal to head when nothing was uncommitted) */
      snapshot: z.string(),
      /** commit both sides have (on origin); null: none known */
      base: z.string().nullable(),
      branch: z.string().nullable(),
      /** git bundle of base..snapshot (base64); null when the snapshot is the base itself */
      bundle: z.string().nullable(),
    })
    .nullable(),
});
type SharePayload = z.infer<typeof SharePayload>;

/** One crew as the share module needs it (crew-service.ts keeps the rest). */
export interface ShareCrew {
  id: string;
  projectId: string;
  selfId: string;
  relayUrl: string;
  /** current key and its id ("room:<epoch>") */
  key(): { kid: string; key: string } | null;
  keyFor(kid: string): string | null;
  shareAgents(): "ask" | "auto" | "off";
  setShareAgents(v: "auto"): void;
  memberName(id: string): string;
  /** title of an agent of a member as its presence says; null when unknown */
  agentTitle(member: string, agent: string): string | null;
  online(member: string): boolean;
  send(msg: RoomMessage): void;
  changed(): void;
  notice(kind: "share" | "shared", title: string, text: string, ref: string | null): void;
  project(): Project | null;
}

export interface ShareDeps {
  sessions: {
    get(id: string): Session | null;
    recentEvents(id: string, limit: number): SessionEventBody[];
    importCopy(o: CopyImport): Session;
    appendMirror(id: string, bodies: readonly SessionEventBody[]): void;
    setMirrorLive(id: string, live: boolean): void;
    endMirrors(): void;
  };
  /** commit with the working tree of `dir` on top of `head`; null when nothing is uncommitted */
  snapshot(dir: string, head: string): Promise<string | null>;
  /** a worktree of the project on a new branch that starts at `startAt` */
  worktree(parent: Project, branch: string, startAt: string): Promise<Project>;
  git: GitEngine;
  /** Claude Code's folder (~/.claude) */
  claudeDir: string;
  projects(): Project[];
}

export interface ShareHost {
  now(): number;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

/** A share we asked for (receiving side). */
interface Outgoing {
  crew: ShareCrew;
  share: CrewShare;
  link: RelayLink | null;
  room: string | null;
  chunks: string[];
  /** live batches arrive in order; later ones wait for the missing */
  liveNext: number;
  liveWaiting: Map<number, unknown[]>;
  timers: { ask?: NodeJS.Timeout; stall?: NodeJS.Timeout; keep?: NodeJS.Timeout };
}

/** A request for one of our sessions waiting for the user. */
interface Pending {
  crew: ShareCrew;
  request: CrewShareRequest;
  /** newest events the asker wants (a phone in the browser); undefined: SHARE_EVENTS_MAX */
  events?: number;
}

/** One of our sessions under live view. */
interface Watched {
  crew: ShareCrew;
  request: string;
  viewer: string;
  sessionId: string;
  link: RelayLink;
  room: string;
  n: number;
  buffer: SessionEventBody[];
  keptAt: number;
  startedAt: number;
  flush?: NodeJS.Timeout;
}

const slug = (s: string, max = 40) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "session";

/** Claude Code's folder for the transcripts of a working directory: every character but a-z, 0-9 becomes "-". */
export function claudeProjectDir(claudeDir: string, cwd: string): string {
  return path.join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/** Claude Code's transcript of a session, wherever its working directory was. */
function findTranscript(claudeDir: string, sessionId: string, cwd: string): string | null {
  const direct = path.join(claudeProjectDir(claudeDir, cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  const root = path.join(claudeDir, "projects");
  try {
    for (const d of readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {
    /* no projects folder */
  }
  return null;
}

/** A path as it appears inside JSON (backslashes doubled). */
const inJson = (p: string) => JSON.stringify(p).slice(1, -1);

/**
 * Sessions between crew members: a member asks another for one of its sessions, the owner answers
 * (or its setting does), and the copy travels gzipped in chunks through a room of its own on the
 * relay, sealed with the crew key. View: a read-only copy kept live with the owner's new events.
 * Takeover: the chat, Claude Code's transcript and the files (a git bundle of the working tree on top
 * of what origin has) land in a worktree here, so the next message goes on exactly where it was.
 */
export class CrewShares {
  private outgoing = new Map<string, Outgoing>();
  private pending = new Map<string, Pending>();
  private watched = new Map<string, Watched>();

  constructor(
    private readonly d: ShareDeps,
    private readonly host: ShareHost,
  ) {
    d.sessions.endMirrors();
  }

  /** What a crew view shows: requests waiting for us and the shares we asked for. */
  forCrew(crewId: string): { shareRequests: CrewShareRequest[]; shares: CrewShare[] } {
    return {
      shareRequests: [...this.pending.values()].filter((p) => p.crew.id === crewId).map((p) => p.request),
      shares: [...this.outgoing.values()].filter((o) => o.crew.id === crewId).map((o) => o.share),
    };
  }

  stop() {
    for (const o of this.outgoing.values()) this.closeOut(o);
    for (const w of this.watched.values()) this.closeWatch(w, null, false);
    this.outgoing.clear();
    this.watched.clear();
    this.pending.clear();
  }

  /** A crew went away (left, removed): everything of it stops. */
  dropCrew(crewId: string) {
    for (const [id, o] of this.outgoing) if (o.crew.id === crewId) {
      this.closeOut(o);
      this.outgoing.delete(id);
    }
    for (const w of [...this.watched.values()]) if (w.crew.id === crewId) this.closeWatch(w, null, false);
    for (const [id, p] of this.pending) if (p.crew.id === crewId) this.pending.delete(id);
  }

  private iso() {
    return new Date(this.host.now()).toISOString();
  }

  // ---------- asking (receiving side)

  ask(crew: ShareCrew, memberId: string, agentId: string, mode: CrewShareMode): CrewShare {
    const m = tr().core.crew;
    if (memberId === crew.selfId) throw new ForgeError("VALIDATION", m.shareOwn);
    if (!crew.online(memberId)) throw new ForgeError("CONFLICT", m.shareOffline(crew.memberName(memberId)));
    if (mode === "takeover" && !crew.project()?.gitEnabled) throw new ForgeError("CONFLICT", m.shareNeedsGit);
    const title = crew.agentTitle(memberId, agentId) ?? "Session";
    const id = randomId(12);
    const o: Outgoing = {
      crew,
      share: { id, member: memberId, agentId, agentTitle: title, mode, state: "asking", received: 0, total: null, sessionId: null, projectId: null, error: null, at: this.iso() },
      link: null,
      room: null,
      chunks: [],
      liveNext: 1,
      liveWaiting: new Map(),
      timers: {},
    };
    this.outgoing.set(id, o);
    crew.send({ t: "share_ask", request: id, to: memberId, agent: agentId, mode });
    o.timers.ask = setTimeout(() => {
      if (o.share.state === "asking") this.fail(o, m.shareNoAnswer(crew.memberName(memberId)));
    }, ASK_TIMEOUT_MS);
    crew.changed();
    return o.share;
  }

  /** Ends a live view (its copy stays) or gives up a share that did not finish. */
  stopShare(crewId: string, requestId: string): boolean {
    const o = this.outgoing.get(requestId);
    if (!o || o.crew.id !== crewId) return false;
    if (["asking", "transferring", "live"].includes(o.share.state)) o.crew.send({ t: "share_stop", request: requestId, to: o.share.member });
    this.closeOut(o);
    if (o.share.sessionId && o.share.mode === "view") this.d.sessions.setMirrorLive(o.share.sessionId, false);
    if (o.share.state !== "done" && o.share.state !== "failed" && o.share.state !== "declined") o.share = { ...o.share, state: "ended" };
    o.crew.changed();
    return true;
  }

  /** The mirror session was deleted here: its live view stops. */
  sessionGone(sessionId: string) {
    for (const o of this.outgoing.values()) if (o.share.sessionId === sessionId && o.share.state === "live") this.stopShare(o.crew.id, o.share.id);
    for (const w of [...this.watched.values()]) if (w.sessionId === sessionId) this.closeWatch(w, tr().core.crew.shareSessionGone, true);
  }

  private closeOut(o: Outgoing) {
    for (const t of Object.values(o.timers)) if (t) clearTimeout(t);
    o.timers = {};
    o.link?.stop();
    o.link = null;
  }

  private fail(o: Outgoing, error: string) {
    this.closeOut(o);
    o.share = { ...o.share, state: "failed", error };
    o.crew.changed();
  }

  private onAnswer(crew: ShareCrew, msg: Extract<RoomMessage, { t: "share_answer" }>) {
    const o = this.outgoing.get(msg.request);
    if (!o || o.crew.id !== crew.id || o.share.state !== "asking") return;
    if (o.timers.ask) clearTimeout(o.timers.ask);
    if (!msg.accept || !msg.room) {
      this.closeOut(o);
      o.share = { ...o.share, state: "declined", error: msg.reason ?? tr().core.crew.shareDeclined(crew.memberName(o.share.member)) };
      crew.changed();
      return;
    }
    o.room = msg.room;
    o.share = { ...o.share, state: "transferring", agentTitle: msg.title ?? o.share.agentTitle };
    o.link = new RelayLink({
      url: crew.relayUrl,
      room: msg.room,
      after: () => 0,
      fetch: this.host.fetch,
      log: this.host.log,
      onEnvelope: (e) => this.onShareEnvelope(o, e),
      onGap: () => {},
      onReady: () => {},
      onState: () => {},
    });
    o.link.start();
    this.stall(o);
    crew.changed();
  }

  private stall(o: Outgoing) {
    if (o.timers.stall) clearTimeout(o.timers.stall);
    o.timers.stall = setTimeout(() => {
      if (o.share.state === "transferring") this.fail(o, tr().core.crew.shareStalled);
    }, TRANSFER_STALL_MS);
  }

  private onShareEnvelope(o: Outgoing, e: Envelope) {
    if (e.from !== o.share.member || !o.room) return;
    const key = o.crew.keyFor(e.kid);
    const text = key ? open(key, e, `${o.room}|${e.kid}`) : null;
    let msg: ShareMessage;
    try {
      const parsed = text ? ShareMessage.safeParse(JSON.parse(text)) : null;
      if (!parsed?.success || parsed.data.request !== o.share.id) return;
      msg = parsed.data;
    } catch {
      return;
    }
    if (msg.t === "chunk") {
      if (o.share.state !== "transferring" || msg.i >= msg.n) return;
      if (o.chunks.length !== msg.n) o.chunks = Array.from({ length: msg.n }, (_, i) => o.chunks[i] ?? "");
      if (!o.chunks[msg.i]) o.chunks[msg.i] = msg.data;
      const received = o.chunks.filter(Boolean).length;
      o.share = { ...o.share, received, total: msg.n };
      this.stall(o);
      o.crew.changed();
      if (received === msg.n) void this.complete(o);
    } else if (msg.t === "live") {
      o.liveWaiting.set(msg.n, msg.events);
      this.drainLive(o);
    } else {
      if (o.share.state === "transferring") this.fail(o, msg.reason ?? tr().core.crew.shareStalled);
      else if (o.share.state === "live") {
        this.closeOut(o);
        if (o.share.sessionId) this.d.sessions.setMirrorLive(o.share.sessionId, false);
        o.share = { ...o.share, state: "ended", error: msg.reason };
        o.crew.changed();
      }
    }
  }

  private drainLive(o: Outgoing) {
    if (o.share.state !== "live" || !o.share.sessionId) return;
    for (let batch = o.liveWaiting.get(o.liveNext); batch; batch = o.liveWaiting.get(o.liveNext)) {
      o.liveWaiting.delete(o.liveNext);
      o.liveNext++;
      const bodies = batch.flatMap((b) => {
        const r = SessionEventBody.safeParse(b);
        return r.success ? [r.data] : [];
      });
      this.d.sessions.appendMirror(o.share.sessionId, bodies);
    }
  }

  private async complete(o: Outgoing) {
    const m = tr().core.crew;
    if (o.timers.stall) clearTimeout(o.timers.stall);
    o.share = { ...o.share, state: "importing" };
    o.crew.changed();
    let payload: SharePayload;
    try {
      const raw = gunzipSync(Buffer.from(o.chunks.join(""), "base64"), { maxOutputLength: 400 * 1024 * 1024 });
      const parsed = SharePayload.safeParse(JSON.parse(raw.toString("utf8")));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid");
      payload = parsed.data;
    } catch (e) {
      this.fail(o, m.shareBroken(e instanceof Error ? e.message : String(e)));
      return;
    }
    o.chunks = [];
    try {
      const session = payload.mode === "view" ? this.importView(o, payload) : await this.importTakeover(o, payload);
      o.share = { ...o.share, sessionId: session.id, projectId: session.projectId, state: payload.mode === "view" ? "live" : "done" };
      if (payload.mode === "takeover") this.closeOut(o);
      else {
        o.timers.keep = setInterval(() => o.crew.send({ t: "share_keep", request: o.share.id, to: o.share.member }), KEEP_MS);
        this.drainLive(o);
      }
      o.crew.changed();
      const who = o.crew.memberName(o.share.member);
      o.crew.notice("shared", payload.mode === "view" ? m.sharedViewTitle(who) : m.sharedTakeoverTitle(who), o.share.agentTitle, session.id);
    } catch (e) {
      this.fail(o, e instanceof Error ? e.message : String(e));
    }
  }

  private importView(o: Outgoing, p: SharePayload): Session {
    const project = o.crew.project();
    if (!project) throw new ForgeError("NOT_FOUND", tr().core.crew.projectMissing);
    const who = o.crew.memberName(o.share.member);
    return this.d.sessions.importCopy({
      projectId: project.id,
      cwd: project.path,
      title: `${who}: ${p.session.title}`,
      model: p.session.model,
      effort: p.session.effort,
      claudeSessionId: null,
      mirror: { crewId: o.crew.id, memberId: o.share.member, memberName: who, remoteSessionId: o.share.agentId, requestId: o.share.id, live: true, at: this.iso() },
      events: p.events,
    });
  }

  private async importTakeover(o: Outgoing, p: SharePayload): Promise<Session> {
    const m = tr().core.crew;
    const project = o.crew.project();
    if (!project) throw new ForgeError("NOT_FOUND", m.projectMissing);
    if (!p.git) throw new ForgeError("CONFLICT", m.shareNoFiles);
    const g = p.git;
    const git = (args: string[], dir = project.path) => this.d.git.exec(dir, args, undefined, 180_000);
    const has = async (sha: string) => (await git(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
    // The commits the copy builds on come from origin; fetch them if they are not here yet.
    if ((g.base && !(await has(g.base))) || (!g.bundle && !(await has(g.snapshot)))) await git(["fetch", "--quiet", "origin"]);
    const ref = `refs/forge-share/${o.share.id}`;
    if (g.bundle) {
      const file = path.join(os.tmpdir(), `forge-share-${o.share.id}.bundle`);
      writeFileSync(file, Buffer.from(g.bundle, "base64"));
      try {
        const r = await git(["fetch", "--quiet", "--no-tags", file, `${ref}:${ref}`]);
        if (r.code !== 0) throw new ForgeError("GIT_FAILED", m.shareFetchFailed((r.stderr || r.stdout).trim()));
      } finally {
        try {
          unlinkSync(file);
        } catch {
          /* gone already */
        }
      }
    }
    if (!(await has(g.snapshot))) throw new ForgeError("GIT_FAILED", m.shareMissingCommit);
    const who = o.crew.memberName(o.share.member);
    let branch = `crew/${slug(who, 20)}/${slug(p.session.title)}`;
    for (let i = 2; (await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).code === 0; i++) branch = `crew/${slug(who, 20)}/${slug(p.session.title)}-${i}`;
    const wt = await this.d.worktree(project, branch, g.snapshot);
    await git(["update-ref", "-d", ref]);
    // The member's uncommitted changes stay uncommitted here: HEAD is its HEAD, the files are its files.
    if (g.snapshot !== g.head) {
      const r = await git(["reset", "--mixed", "--quiet", g.head], wt.path);
      if (r.code !== 0) this.host.log?.(`crew share: reset failed: ${r.stderr.trim()}`);
    }
    let claudeSessionId: string | null = null;
    if (p.transcript) {
      claudeSessionId = randomUUID();
      // Its own id (a second takeover must not clash), paths of the member's folder pointing to this one.
      let text = p.transcript.text.split(p.transcript.sessionId).join(claudeSessionId);
      if (p.cwd && p.cwd !== wt.path) {
        text = text.split(inJson(p.cwd)).join(inJson(wt.path));
        text = text.split(inJson(p.cwd.replace(/\\/g, "/"))).join(inJson(wt.path.replace(/\\/g, "/")));
      }
      const dir = claudeProjectDir(this.d.claudeDir, wt.path);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${claudeSessionId}.jsonl`), text);
    }
    return this.d.sessions.importCopy({
      projectId: wt.id,
      cwd: wt.path,
      title: m.takenOverTitle(p.session.title, who),
      model: p.session.model,
      effort: p.session.effort,
      claudeSessionId,
      events: p.events,
    });
  }

  // ---------- being asked (sharing side)

  private onAsk(crew: ShareCrew, from: string, msg: Extract<RoomMessage, { t: "share_ask" }>) {
    const m = tr().core.crew;
    const s = this.d.sessions.get(msg.agent);
    const mine = s && !s.mirror && this.inCrew(crew, s.projectId);
    if (!s || !mine) {
      crew.send({ t: "share_answer", request: msg.request, to: from, accept: false, room: null, title: null, reason: m.shareNotFound });
      return;
    }
    const policy = crew.shareAgents();
    if (policy === "off") {
      crew.send({ t: "share_answer", request: msg.request, to: from, accept: false, room: null, title: null, reason: m.shareRefused(crew.memberName(crew.selfId)) });
      return;
    }
    const request: CrewShareRequest = { id: msg.request, from, agentId: msg.agent, agentTitle: s.title ?? "Session", mode: msg.mode, at: this.iso() };
    if (policy === "auto") {
      void this.accept(crew, request, msg.events);
      return;
    }
    this.pending.set(request.id, { crew, request, events: msg.events });
    crew.changed();
    const who = crew.memberName(from);
    crew.notice("share", msg.mode === "view" ? m.shareAskViewTitle(who) : m.shareAskTakeoverTitle(who), request.agentTitle, request.id);
  }

  private inCrew(crew: ShareCrew, projectId: string): boolean {
    const p = this.d.projects().find((x) => x.id === projectId);
    return !!p && (p.id === crew.projectId || p.parentId === crew.projectId);
  }

  respond(crew: ShareCrew, requestId: string, accept: boolean, always = false) {
    const p = this.pending.get(requestId);
    if (!p || p.crew.id !== crew.id) throw new ForgeError("NOT_FOUND", tr().core.crew.shareRequestGone);
    this.pending.delete(requestId);
    if (accept && always) crew.setShareAgents("auto");
    if (accept) void this.accept(crew, p.request, p.events);
    else crew.send({ t: "share_answer", request: requestId, to: p.request.from, accept: false, room: null, title: null, reason: tr().core.crew.shareDeclined(crew.memberName(crew.selfId)) });
    crew.changed();
  }

  private async accept(crew: ShareCrew, r: CrewShareRequest, events?: number) {
    const s = this.d.sessions.get(r.agentId);
    if (!s) return;
    const room = randomId(24);
    const link = new RelayLink({ url: crew.relayUrl, room, after: () => Number.MAX_SAFE_INTEGER, fetch: this.host.fetch, log: this.host.log, onEnvelope: () => {}, onGap: () => {}, onReady: () => {}, onState: () => {} });
    link.start();
    crew.send({ t: "share_answer", request: r.id, to: r.from, accept: true, room, title: s.title, reason: null });
    const post = (msg: ShareMessage): boolean => {
      const k = crew.key();
      if (!k) return false;
      link.post(crew.selfId, k.kid, seal(k.key, JSON.stringify(msg), `${room}|${k.kid}`));
      return true;
    };
    let watched: Watched | null = null;
    if (r.mode === "view") {
      // Events from now on are collected right away, so nothing falls between the copy and the live part.
      watched = { crew, request: r.id, viewer: r.from, sessionId: s.id, link, room, n: 0, buffer: [], keptAt: this.host.now(), startedAt: this.host.now() };
      this.watched.set(r.id, watched);
    }
    try {
      const payload = await this.build(s, r.mode, r.id, events);
      const zipped = gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64");
      if (zipped.length > CREW_SHARE_MAX_BYTES * 1.34) throw new ForgeError("VALIDATION", tr().core.crew.shareTooLarge(Math.round(zipped.length / 1.34 / 1024 / 1024)));
      const n = Math.max(1, Math.ceil(zipped.length / CREW_SHARE_CHUNK_CHARS));
      for (let i = 0; i < n; i++) post({ t: "chunk", request: r.id, i, n, data: zipped.slice(i * CREW_SHARE_CHUNK_CHARS, (i + 1) * CREW_SHARE_CHUNK_CHARS) });
      if (watched) this.scheduleFlush(watched);
      else this.closeLater(link);
    } catch (e) {
      post({ t: "end", request: r.id, reason: e instanceof Error ? e.message : String(e) });
      if (watched) this.watched.delete(r.id);
      this.closeLater(link);
    }
  }

  /** The outbox needs its time for large copies; the link closes once it is empty. */
  private closeLater(link: RelayLink) {
    const check = setInterval(() => {
      if (link.pending() === 0) {
        clearInterval(check);
        setTimeout(() => link.stop(), 2_000);
      }
    }, 1_000);
    setTimeout(() => {
      clearInterval(check);
      link.stop();
    }, 15 * 60_000);
  }

  private async build(s: Session, mode: CrewShareMode, requestId: string, limit = SHARE_EVENTS_MAX): Promise<SharePayload> {
    const payload: SharePayload = {
      v: 1,
      mode,
      session: { title: s.title ?? "Session", model: s.model, effort: s.effort },
      cwd: s.cwd,
      events: this.d.sessions.recentEvents(s.id, Math.min(limit, SHARE_EVENTS_MAX)).filter((b) => b.type !== "assistant.delta"),
      transcript: null,
      git: null,
    };
    if (mode === "view") return payload;
    if (s.claudeSessionId) {
      const file = findTranscript(this.d.claudeDir, s.claudeSessionId, s.cwd);
      if (file && statSync(file).size <= TRANSCRIPT_MAX_BYTES) payload.transcript = { sessionId: s.claudeSessionId, text: readFileSync(file, "utf8") };
    }
    payload.git = await this.gitCopy(s.cwd, requestId);
    return payload;
  }

  /**
   * HEAD, a commit with the working tree, the commit origin has and a bundle of what lies between,
   * under refs/forge-share/<request> (the name the receiver fetches).
   */
  private async gitCopy(dir: string, requestId: string): Promise<NonNullable<SharePayload["git"]>> {
    const m = tr().core.crew;
    const git = (args: string[]) => this.d.git.exec(dir, args, undefined, 180_000);
    const headR = await git(["rev-parse", "--verify", "HEAD"]);
    if (headR.code !== 0) throw new ForgeError("GIT_FAILED", m.shareNoCommit);
    const head = headR.stdout.trim();
    const snapshot = (await this.d.snapshot(dir, head)) ?? head;
    const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim() || null;
    let base: string | null = null;
    for (const candidate of [branch ? `origin/${branch}` : null, "origin/HEAD"]) {
      if (!candidate) continue;
      const r = await git(["merge-base", "HEAD", candidate]);
      if (r.code === 0 && r.stdout.trim()) {
        base = r.stdout.trim();
        break;
      }
    }
    let bundle: string | null = null;
    if (snapshot !== base) {
      const ref = `refs/forge-share/${requestId}`;
      const file = path.join(os.tmpdir(), `forge-share-${randomId(8)}.bundle`);
      try {
        await git(["update-ref", ref, snapshot]);
        const r = await git(["bundle", "create", file, ref, ...(base ? [`^${base}`] : [])]);
        if (r.code !== 0) throw new ForgeError("GIT_FAILED", m.shareBundleFailed((r.stderr || r.stdout).trim()));
        bundle = readFileSync(file).toString("base64");
      } finally {
        await git(["update-ref", "-d", ref]);
        try {
          unlinkSync(file);
        } catch {
          /* not written */
        }
      }
    }
    return { head, snapshot, base, branch, bundle };
  }

  // ---------- live view (sharing side)

  /** An event of one of our sessions: viewers of it get it within a second. */
  onSessionEvent(sessionId: string, body: SessionEventBody) {
    if (body.type === "assistant.delta") return;
    for (const w of this.watched.values()) {
      if (w.sessionId !== sessionId) continue;
      w.buffer.push(body);
      this.scheduleFlush(w);
    }
  }

  private scheduleFlush(w: Watched) {
    if (w.flush) return;
    w.flush = setTimeout(() => {
      w.flush = undefined;
      const now = this.host.now();
      if (now - w.keptAt > LIVE_IDLE_MS || now - w.startedAt > LIVE_MAX_MS) {
        this.closeWatch(w, tr().core.crew.shareLiveOver, true);
        return;
      }
      while (w.buffer.length) {
        const events = w.buffer.splice(0, 400);
        const k = w.crew.key();
        if (!k) break;
        w.n++;
        w.link.post(w.crew.selfId, k.kid, seal(k.key, JSON.stringify({ t: "live", request: w.request, n: w.n, events } satisfies ShareMessage), `${w.room}|${k.kid}`));
      }
    }, LIVE_FLUSH_MS);
  }

  private closeWatch(w: Watched, reason: string | null, tell: boolean) {
    if (w.flush) clearTimeout(w.flush);
    this.watched.delete(w.request);
    const k = w.crew.key();
    if (tell && k) w.link.post(w.crew.selfId, k.kid, seal(k.key, JSON.stringify({ t: "end", request: w.request, reason } satisfies ShareMessage), `${w.room}|${k.kid}`));
    this.closeLater(w.link);
  }

  // ---------- room messages

  onRoom(crew: ShareCrew, from: string, msg: RoomMessage) {
    if (!("to" in msg) || msg.to !== crew.selfId) return;
    switch (msg.t) {
      case "share_ask":
        this.onAsk(crew, from, msg);
        break;
      case "share_answer":
        if (this.outgoing.get(msg.request)?.share.member === from) this.onAnswer(crew, msg);
        break;
      case "share_stop": {
        const w = this.watched.get(msg.request);
        if (w && w.viewer === from) this.closeWatch(w, null, false);
        if (this.pending.get(msg.request)?.request.from === from) {
          this.pending.delete(msg.request);
          crew.changed();
        }
        break;
      }
      case "share_keep": {
        const w = this.watched.get(msg.request);
        if (w && w.viewer === from) w.keptAt = this.host.now();
        break;
      }
    }
  }
}
