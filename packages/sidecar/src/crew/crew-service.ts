import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CREW_COLORS,
  CREW_MAX_MEMBERS,
  CREW_ONLINE_MS,
  CREW_RELAY_URL,
  CrewProfile,
  ForgeError,
  isCrewAvatar,
  remoteIdentity,
  type Crew,
  type CrewAcceptTasks,
  type CrewAgent,
  type CrewFeedItem,
  type CrewInviteInfo,
  type CrewShare,
  type CrewShareAgents,
  type CrewShareMode,
  type CrewTask,
  type CrewTaskStatus,
  type Project,
  type ServerEvent,
  type Session,
  type SessionEventBody,
} from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import { tr } from "../i18n/index.js";
import { fingerprint, newKey, newKeyPair, open, randomId, seal, sharedKey, type Sealed } from "./crypto.js";
import { CrewShares, type ShareCrew, type ShareDeps } from "./share.js";
import { RelayLink, type Envelope, type LinkState } from "./link.js";
import { cardOf, CrewKeys, CrewRecord, crewView, mergeFeed, mergeMember, mergeTask, overlap, pruneTasks, type MemberEntry } from "./state.js";
import { decodeInvite, encodeInvite, InviteMessage, JoinGrant, RoomMessage, type InvitePayload, type MemberCard, type Presence, type TaskEntry } from "./wire.js";

/** Name of a crew's keys in the secret store; backups and the GitHub sync leave them out. */
export const CREW_SECRET_PREFIX = "crew-";
const INVITE_TTL_MS = 24 * 3600_000;
const PRESENCE_DEBOUNCE_MS = 1_500;
/** presence also goes out without changes, so the others see we are still there */
const HEARTBEAT_MS = 30_000;
const GIT_DEBOUNCE_MS = 2_500;
const EMIT_DEBOUNCE_MS = 150;
const SAVE_DEBOUNCE_MS = 500;
/** idle agents drop out of the presence after this long */
const AGENT_KEEP_MS = 6 * 3600_000;
const AGENT_FILES_MAX = 60;
/** a warning about a file another member works on comes once per session and file in this time */
const WARN_AGAIN_MS = 10 * 60_000;
/** news an agent has not picked up yet; older ones fall off */
const NEWS_MAX = 60;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface CrewDeps {
  /** folder for the crews (crew/<id>.json, profile.json) */
  dir: string;
  secrets: { get(name: string): Promise<string | null>; set(name: string, value: string | null): Promise<void> };
  projects: () => Project[];
  git: GitEngine;
  sessions: {
    get(sessionId: string): Session | null;
    start(projectId: string, prompt: string): Promise<Session>;
    /** a session of the project or one of its worktrees works or waits for a decision */
    busy(projectId: string): boolean;
  };
  emit(e: ServerEvent): void;
  /** sessions of members between installations (crew/share.ts); missing: not offered */
  share?: ShareDeps;
  /** the signed-in GitHub account's picture, shown to the others; missing or null: initials */
  avatar?: () => Promise<string | null>;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

interface News {
  n: number;
  text: string;
}

interface Live {
  rec: CrewRecord;
  keys: CrewKeys;
  link: RelayLink | null;
  connection: LinkState;
  error: string | null;
  /** our agents: session id -> what they do */
  agents: Map<string, CrewAgent>;
  git: { branch: string | null; files: string[]; ahead: number };
  /** what our agents should hear about, numbered */
  news: News[];
  newsN: number;
  timers: { save?: NodeJS.Timeout; presence?: NodeJS.Timeout; git?: NodeJS.Timeout; emit?: NodeJS.Timeout; pull?: NodeJS.Timeout; state?: NodeJS.Timeout };
  /** sessions started for a task: session id -> task id */
  taskSessions: Map<string, string>;
}

const excerpt = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const toIso = (ms: number) => new Date(ms).toISOString();

/**
 * Crews of this installation: the shared state of each one (members, what their agents do, tasks,
 * feed), kept in sync over the relay, plus what our own sessions in the crew's project do, told to
 * the others. Agents of every member learn about the others through FORGE tools, notes with the next
 * message and live notes after their tool calls.
 */
export class CrewService {
  private readonly crews = new Map<string, Live>();
  private profileCache: CrewProfile | null = null;
  private avatarUrl: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** session id -> news number it has seen */
  private readonly cursors = new Map<string, number>();
  /** session id + file -> when it was last warned about */
  private readonly warned = new Map<string, number>();
  private readonly now: () => number;
  private started = false;

  private readonly shares: CrewShares | null;

  constructor(private readonly d: CrewDeps) {
    this.now = d.now ?? Date.now;
    this.shares = d.share ? new CrewShares(d.share, { now: () => this.now(), fetch: d.fetch, log: d.log }) : null;
  }

  // ---------- lifecycle

  /** Loads the crews and connects them to their relays. */
  async start() {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.d.dir, { recursive: true });
    for (const f of readdirSync(this.d.dir)) {
      if (!f.endsWith(".json") || f === "profile.json") continue;
      try {
        const rec = CrewRecord.parse(JSON.parse(readFileSync(path.join(this.d.dir, f), "utf8")));
        const raw = await this.d.secrets.get(`${CREW_SECRET_PREFIX}${rec.id}`);
        const keys = raw ? CrewKeys.safeParse(JSON.parse(raw)) : null;
        if (!keys?.success) {
          this.d.log?.(`crew ${rec.id}: keys missing, skipped`);
          continue;
        }
        this.crews.set(rec.id, this.live(rec, keys.data));
      } catch (e) {
        this.d.log?.(`crew ${f}: unreadable (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    for (const c of this.crews.values()) {
      this.connect(c);
      this.scheduleGit(c, 0);
    }
    this.heartbeat = setInterval(() => {
      for (const c of this.crews.values()) {
        if (c.rec.membership === "member" && c.connection === "online") this.publishPresence(c);
        this.pruneAgents(c);
        this.scheduleEmit(c);
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    void this.loadAvatar();
  }

  /** The GitHub picture goes on our card in every crew; the others get it with the next hello. */
  private async loadAvatar() {
    const url = await this.d.avatar?.().catch(() => null);
    if (!isCrewAvatar(url) || url === this.avatarUrl) return;
    this.avatarUrl = url;
    for (const c of this.crews.values()) {
      const me = c.rec.members.find((m) => m.id === c.rec.selfId);
      if (!me || me.avatar === url) continue;
      me.avatar = url;
      this.save(c);
      if (c.rec.membership === "member") this.sendRoom(c, { t: "hello", member: this.selfCard(c) });
      this.scheduleEmit(c);
    }
  }

  stop() {
    this.started = false;
    this.shares?.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.crews.values()) {
      c.link?.stop();
      c.link = null;
      for (const t of Object.values(c.timers)) if (t) clearTimeout(t);
      if (c.timers.save) this.saveNow(c);
      c.timers = {};
    }
  }

  private live(rec: CrewRecord, keys: CrewKeys): Live {
    return { rec, keys, link: null, connection: "offline", error: null, agents: new Map(), git: { branch: null, files: [], ahead: 0 }, news: [], newsN: 0, timers: {}, taskSessions: new Map() };
  }

  private connect(c: Live) {
    if (c.link || c.rec.membership === "rejected" || !this.started) return;
    c.connection = "connecting";
    c.link = new RelayLink({
      url: c.rec.relayUrl,
      room: c.rec.roomId,
      after: () => c.rec.lastSeq,
      fetch: this.d.fetch,
      log: this.d.log,
      onEnvelope: (e) => this.receive(c, e),
      onGap: () => {
        // The relay forgot messages we did not see: the others send their whole state on hello.
        c.rec.lastSeq = 0;
      },
      onReady: () => this.ready(c),
      onState: (state, error) => {
        if (c.connection === state && c.error === error) return;
        c.connection = state;
        if (state === "online") c.error = null;
        else if (error) c.error = error;
        this.scheduleEmit(c);
      },
    });
    c.link.start();
  }

  /** Caught up with the room: say hello (the others answer with their state), or ask to join again. */
  private ready(c: Live) {
    if (c.rec.membership === "member") {
      this.sendRoom(c, { t: "hello", member: this.selfCard(c) });
      this.publishPresence(c);
    } else if (c.rec.membership === "pending" && c.rec.joinRequest) {
      this.sendJoinRequest(c);
    }
  }

  // ---------- profile

  async profile(): Promise<CrewProfile> {
    if (this.profileCache) return this.profileCache;
    const file = path.join(this.d.dir, "profile.json");
    let stored: Partial<CrewProfile> = {};
    try {
      if (existsSync(file)) stored = JSON.parse(readFileSync(file, "utf8")) as Partial<CrewProfile>;
    } catch {
      stored = {};
    }
    const parsed = CrewProfile.safeParse(stored);
    if (parsed.success) return (this.profileCache = parsed.data);
    const identity = await this.d.git.identity().catch(() => ({ name: null, email: null }));
    let user = "FORGE";
    try {
      user = os.userInfo().username || user;
    } catch {
      // No user info (some containers): the default name stays.
    }
    const profile: CrewProfile = {
      name: (typeof stored.name === "string" && stored.name.trim()) || identity.name?.trim() || user,
      color: typeof stored.color === "string" && /^#[0-9a-f]{6}$/i.test(stored.color) ? stored.color : CREW_COLORS[Math.floor(Math.random() * CREW_COLORS.length)]!,
      relayUrl: typeof stored.relayUrl === "string" ? stored.relayUrl : null,
    };
    await this.writeProfile(profile);
    return profile;
  }

  async setProfile(patch: { name?: string; color?: string; relayUrl?: string | null }): Promise<CrewProfile> {
    const next = { ...(await this.profile()), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as CrewProfile;
    await this.writeProfile(next);
    // Name and color reach every crew with the next hello.
    for (const c of this.crews.values()) {
      const me = c.rec.members.find((m) => m.id === c.rec.selfId);
      if (!me) continue;
      me.name = next.name;
      me.color = next.color;
      this.save(c);
      if (c.rec.membership === "member") this.sendRoom(c, { t: "hello", member: this.selfCard(c) });
      this.scheduleEmit(c);
    }
    return next;
  }

  private async writeProfile(p: CrewProfile) {
    this.profileCache = p;
    mkdirSync(this.d.dir, { recursive: true });
    await writeFile(path.join(this.d.dir, "profile.json"), JSON.stringify(p, null, 2), "utf8");
  }

  // ---------- queries

  list(projectId?: string): Crew[] {
    const root = projectId ? this.rootOf(projectId) : null;
    return [...this.crews.values()].filter((c) => !root || c.rec.projectId === root).map((c) => this.view(c));
  }

  get(crewId: string): Crew {
    return this.view(this.require(crewId));
  }

  /** The crew a project (or one of its worktrees) works in; only as a full member. */
  forProject(projectId: string): Crew | null {
    const c = this.liveFor(projectId);
    return c ? this.view(c) : null;
  }

  private liveFor(projectId: string): Live | null {
    const root = this.rootOf(projectId);
    for (const c of this.crews.values()) if (c.rec.projectId === root && c.rec.membership === "member") return c;
    return null;
  }

  private rootOf(projectId: string): string {
    const p = this.d.projects().find((x) => x.id === projectId);
    return p?.parentId ?? projectId;
  }

  private project(c: Live): Project | null {
    return this.d.projects().find((p) => p.id === c.rec.projectId) ?? null;
  }

  private view(c: Live): Crew {
    return crewView(c.rec, {
      projectName: this.project(c)?.name ?? "?",
      connection: c.link ? c.connection : "offline",
      error: c.error,
      now: this.now(),
      self: { presence: this.ownPresence(c) },
      ...(this.shares?.forCrew(c.rec.id) ?? {}),
    });
  }

  /** What the share module sees of a crew. */
  private shareCrew(c: Live): ShareCrew {
    return {
      id: c.rec.id,
      projectId: c.rec.projectId,
      selfId: c.rec.selfId,
      relayUrl: c.rec.relayUrl,
      key: () => {
        const key = c.keys.rooms[String(c.rec.epoch)];
        return key ? { kid: `room:${c.rec.epoch}`, key } : null;
      },
      keyFor: (kid) => (kid.startsWith("room:") ? (c.keys.rooms[kid.slice(5)] ?? null) : null),
      shareAgents: () => c.rec.shareAgents,
      setShareAgents: (v) => {
        c.rec.shareAgents = v;
        this.save(c);
      },
      memberName: (id) => this.memberName(c, id),
      agentTitle: (member, agent) => c.rec.members.find((x) => x.id === member)?.presence?.agents.find((a) => a.id === agent)?.title ?? null,
      online: (member) => {
        const x = c.rec.members.find((m) => m.id === member);
        return !!x && !x.left && x.lastSeen !== null && this.now() - x.lastSeen < CREW_ONLINE_MS;
      },
      send: (msg) => this.sendRoom(c, msg),
      changed: () => this.scheduleEmit(c),
      notice: (kind, title, text, ref) => this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind, title, text, ref } }),
      project: () => this.project(c),
    };
  }

  // ---------- sessions of other members (crew/share.ts)

  shareAsk(crewId: string, memberId: string, agentId: string, mode: CrewShareMode): CrewShare {
    const c = this.requireMember(crewId);
    if (!this.shares) throw new ForgeError("CONFLICT", tr().core.crew.notMember);
    return this.shares.ask(this.shareCrew(c), memberId, agentId, mode);
  }

  shareRespond(crewId: string, requestId: string, accept: boolean, always = false): Crew {
    const c = this.requireMember(crewId);
    this.shares?.respond(this.shareCrew(c), requestId, accept, always);
    return this.view(c);
  }

  shareStop(crewId: string, requestId: string): { ok: boolean } {
    this.require(crewId);
    return { ok: this.shares?.stopShare(crewId, requestId) ?? false };
  }

  private require(crewId: string): Live {
    const c = this.crews.get(crewId);
    if (!c) throw new ForgeError("NOT_FOUND", tr().core.crew.notFound);
    return c;
  }

  private requireMember(crewId: string): Live {
    const c = this.require(crewId);
    if (c.rec.membership !== "member") throw new ForgeError("CONFLICT", tr().core.crew.notMember);
    return c;
  }

  private self(c: Live): MemberEntry {
    return c.rec.members.find((m) => m.id === c.rec.selfId)!;
  }

  private selfCard(c: Live): MemberCard {
    return cardOf(this.self(c));
  }

  /** Name of a member; "?" for one we do not know (any more). */
  memberName(c: Live, id: string | null): string {
    if (!id) return "?";
    return c.rec.members.find((m) => m.id === id)?.name ?? "?";
  }

  // ---------- create, invite, join

  async create(projectId: string, name?: string): Promise<Crew> {
    const m = tr().core.crew;
    const project = this.d.projects().find((p) => p.id === projectId);
    if (!project) throw new ForgeError("NOT_FOUND", m.projectMissing);
    const root = project.parentId ?? project.id;
    if ([...this.crews.values()].some((c) => c.rec.projectId === root && c.rec.membership !== "rejected")) throw new ForgeError("CONFLICT", m.projectHasCrew(project.name));
    const profile = await this.profile();
    const at = toIso(this.now());
    const pair = newKeyPair();
    const selfId = randomId(9);
    const rec: CrewRecord = {
      v: 1,
      id: randomId(9),
      name: name?.trim() || project.name,
      nameAt: at,
      projectId: root,
      relayUrl: profile.relayUrl ?? CREW_RELAY_URL,
      roomId: randomId(18),
      createdAt: at,
      membership: "member",
      selfId,
      epoch: 1,
      lastSeq: 0,
      acceptTasks: "ask",
      shareAgents: "ask",
      autoPull: true,
      members: [{ id: selfId, name: profile.name, color: profile.color, pub: pair.pub, joinedAt: at, owner: true, ...(this.avatarUrl ? { avatar: this.avatarUrl } : {}), left: false, lastSeen: null, presence: null }],
      removed: [],
      tasks: [],
      feed: [],
      requests: [],
      invites: [],
      ownInvite: null,
      joinRequest: null,
      originSeen: null,
      behind: 0,
    };
    const c = this.live(rec, { pub: pair.pub, priv: pair.priv, rooms: { "1": newKey() }, invites: {} });
    this.crews.set(rec.id, c);
    await this.saveKeys(c);
    this.saveNow(c);
    this.connect(c);
    await this.makeInvite(c);
    this.scheduleGit(c, 0);
    this.scheduleEmit(c);
    return this.view(c);
  }

  async invite(crewId: string): Promise<{ code: string; expiresAt: string }> {
    const c = this.requireMember(crewId);
    return this.makeInvite(c);
  }

  private async makeInvite(c: Live): Promise<{ code: string; expiresAt: string }> {
    const project = this.project(c);
    const remoteUrl = project?.exists ? await this.d.git.remoteUrl(project.path).catch(() => null) : null;
    const id = randomId(9);
    const key = newKey();
    const expires = this.now() + INVITE_TTL_MS;
    const payload: InvitePayload = {
      v: 1,
      u: c.rec.relayUrl,
      r: c.rec.roomId,
      i: id,
      k: key,
      x: Math.floor(expires / 1000),
      n: c.rec.name.slice(0, 60),
      p: (project?.name ?? c.rec.name).slice(0, 200),
      o: remoteUrl ? remoteIdentity(remoteUrl) : null,
      c: remoteUrl ? stripCredentials(remoteUrl) : null,
      f: this.self(c).name.slice(0, 60),
    };
    const code = encodeInvite(payload);
    // The previous invite of ours stops working: its key is forgotten everywhere it went.
    const old = c.rec.ownInvite?.id;
    if (old) delete c.keys.invites[old];
    c.keys.invites[id] = key;
    c.rec.invites = [...c.rec.invites.filter((i) => i.id !== old), { id, expiresAt: toIso(expires), by: c.rec.selfId }];
    c.rec.ownInvite = { id, code, expiresAt: toIso(expires) };
    await this.saveKeys(c);
    this.save(c);
    this.sendRoom(c, { t: "invite", invite: { id, key, expiresAt: toIso(expires), by: c.rec.selfId } });
    this.scheduleEmit(c);
    return { code, expiresAt: toIso(expires) };
  }

  async inspect(code: string): Promise<CrewInviteInfo> {
    const p = decodeInvite(code);
    if (!p) throw new ForgeError("VALIDATION", tr().core.crew.inviteInvalid);
    const candidates = this.d.projects().filter((x) => !x.parentId && x.exists && x.gitEnabled);
    const ids: string[] = [];
    if (p.o) {
      const remotes = await Promise.all(candidates.map(async (x) => ({ id: x.id, url: await this.d.git.remoteUrl(x.path).catch(() => null) })));
      for (const r of remotes) if (r.url && remoteIdentity(r.url) === p.o) ids.push(r.id);
    }
    return {
      crewName: p.n,
      projectName: p.p,
      remote: p.o,
      cloneUrl: p.c,
      from: p.f,
      relayUrl: p.u,
      expiresAt: toIso(p.x * 1000),
      expired: p.x * 1000 < this.now(),
      projectIds: ids,
      joined: [...this.crews.values()].some((c) => c.rec.roomId === p.r && c.rec.membership !== "rejected"),
    };
  }

  async join(projectId: string, code: string): Promise<Crew> {
    const m = tr().core.crew;
    const p = decodeInvite(code);
    if (!p) throw new ForgeError("VALIDATION", m.inviteInvalid);
    if (p.x * 1000 < this.now()) throw new ForgeError("VALIDATION", m.inviteExpired);
    const project = this.d.projects().find((x) => x.id === projectId);
    if (!project) throw new ForgeError("NOT_FOUND", m.projectMissing);
    const root = project.parentId ?? project.id;
    // A rejected attempt makes room for a new one.
    for (const c of [...this.crews.values()]) if (c.rec.membership === "rejected" && (c.rec.roomId === p.r || c.rec.projectId === root)) await this.drop(c);
    if ([...this.crews.values()].some((c) => c.rec.roomId === p.r)) throw new ForgeError("CONFLICT", m.alreadyJoined);
    if ([...this.crews.values()].some((c) => c.rec.projectId === root)) throw new ForgeError("CONFLICT", m.projectHasCrew(project.name));
    const profile = await this.profile();
    const pair = newKeyPair();
    const at = toIso(this.now());
    const selfId = randomId(9);
    const rec: CrewRecord = {
      v: 1,
      id: randomId(9),
      name: p.n,
      nameAt: "",
      projectId: root,
      relayUrl: p.u,
      roomId: p.r,
      createdAt: at,
      membership: "pending",
      selfId,
      epoch: 0,
      lastSeq: 0,
      acceptTasks: "ask",
      shareAgents: "ask",
      autoPull: true,
      members: [{ id: selfId, name: profile.name, color: profile.color, pub: pair.pub, joinedAt: at, owner: false, ...(this.avatarUrl ? { avatar: this.avatarUrl } : {}), left: false, lastSeen: null, presence: null }],
      removed: [],
      tasks: [],
      feed: [],
      requests: [],
      invites: [{ id: p.i, expiresAt: toIso(p.x * 1000), by: "" }],
      ownInvite: null,
      joinRequest: { id: randomId(9), invite: p.i, code: fingerprint(pair.pub) },
      originSeen: null,
      behind: 0,
    };
    const c = this.live(rec, { pub: pair.pub, priv: pair.priv, rooms: {}, invites: { [p.i]: p.k } });
    this.crews.set(rec.id, c);
    await this.saveKeys(c);
    this.saveNow(c);
    // The request goes out once the stream is open (ready), so the answer cannot be missed.
    this.connect(c);
    this.scheduleEmit(c);
    return this.view(c);
  }

  private sendJoinRequest(c: Live) {
    const r = c.rec.joinRequest;
    if (!r) return;
    const me = this.self(c);
    this.sendInvite(c, r.invite, { t: "join_request", request: r.id, member: me.id, name: me.name, color: me.color, pub: c.keys.pub });
  }

  async respond(crewId: string, requestId: string, accept: boolean): Promise<Crew> {
    const m = tr().core.crew;
    const c = this.requireMember(crewId);
    const req = c.rec.requests.find((r) => r.id === requestId);
    if (!req) throw new ForgeError("NOT_FOUND", m.requestGone);
    if (!c.keys.invites[req.invite]) throw new ForgeError("CONFLICT", m.inviteExpired);
    c.rec.requests = c.rec.requests.filter((r) => r.id !== requestId);
    if (!accept) {
      this.sendInvite(c, req.invite, { t: "join_reject", request: req.id, by: c.rec.selfId });
    } else {
      const active = c.rec.members.filter((x) => !x.left).length;
      if (active >= CREW_MAX_MEMBERS) throw new ForgeError("CONFLICT", m.crewFull(CREW_MAX_MEMBERS));
      const at = toIso(this.now());
      mergeMember(c.rec, { id: req.member, name: req.name, color: req.color, pub: req.pub, joinedAt: at, owner: false }, null);
      const grant: JoinGrant = {
        roomKey: c.keys.rooms[String(c.rec.epoch)]!,
        epoch: c.rec.epoch,
        name: c.rec.name,
        nameAt: c.rec.nameAt,
        createdAt: c.rec.createdAt,
        members: c.rec.members.filter((x) => !x.left).map(cardOf),
      };
      const box = seal(sharedKey(c.keys, req.pub, `grant:${req.id}`), JSON.stringify(grant));
      this.sendInvite(c, req.invite, { t: "join_accept", request: req.id, by: c.rec.selfId, byPub: c.keys.pub, box });
      this.addFeed(c, { kind: "joined", from: req.member, agent: null, to: null, text: req.name, files: [] }, true);
    }
    this.save(c);
    this.scheduleEmit(c);
    return this.view(c);
  }

  async leave(crewId: string): Promise<{ ok: boolean }> {
    const c = this.require(crewId);
    if (c.rec.membership === "member") {
      this.sendRoom(c, { t: "leave", member: c.rec.selfId });
      // Give the goodbye a moment to leave before the link closes.
      await new Promise((r) => setTimeout(r, Math.min(1500, 200 + (c.link?.pending() ?? 0) * 200)));
    }
    await this.drop(c);
    return { ok: true };
  }

  private async drop(c: Live) {
    this.shares?.dropCrew(c.rec.id);
    c.link?.stop();
    c.link = null;
    for (const t of Object.values(c.timers)) if (t) clearTimeout(t);
    c.timers = {};
    this.crews.delete(c.rec.id);
    try {
      unlinkSync(path.join(this.d.dir, `${c.rec.id}.json`));
    } catch {
      // Never saved, or already gone.
    }
    await this.d.secrets.set(`${CREW_SECRET_PREFIX}${c.rec.id}`, null);
    this.d.emit({ event: "crew.updated", payload: { crewId: c.rec.id, projectId: c.rec.projectId, removed: true } });
  }

  async removeMember(crewId: string, memberId: string): Promise<Crew> {
    const m = tr().core.crew;
    const c = this.requireMember(crewId);
    if (!this.self(c).owner) throw new ForgeError("POLICY_DENIED", m.ownerOnly);
    if (memberId === c.rec.selfId) throw new ForgeError("VALIDATION", m.cannotRemoveSelf);
    const target = c.rec.members.find((x) => x.id === memberId && !x.left);
    if (!target) throw new ForgeError("NOT_FOUND", m.memberNotFound(memberId, c.rec.members.filter((x) => !x.left).map((x) => x.name).join(", ")));
    const epoch = c.rec.epoch + 1;
    const key = newKey();
    const keys: Record<string, Sealed> = {};
    for (const x of c.rec.members) {
      if (x.left || x.id === memberId || x.id === c.rec.selfId) continue;
      keys[x.id] = seal(sharedKey(c.keys, x.pub, `rekey:${epoch}`), key);
    }
    // Sealed with the old key: the removed member reads that it is out, but none of the new keys.
    this.sendRoom(c, { t: "rekey", epoch, removed: memberId, keys });
    this.applyRemoval(c, memberId);
    c.keys.rooms = { [String(c.rec.epoch)]: c.keys.rooms[String(c.rec.epoch)]!, [String(epoch)]: key };
    c.rec.epoch = epoch;
    await this.saveKeys(c);
    this.save(c);
    // Everything else from now on with the new key; invites made before stay with the members.
    this.sendRoom(c, this.stateMessage(c));
    this.scheduleEmit(c);
    return this.view(c);
  }

  private applyRemoval(c: Live, memberId: string) {
    if (!c.rec.removed.includes(memberId)) c.rec.removed.push(memberId);
    const x = c.rec.members.find((y) => y.id === memberId);
    if (x) x.left = true;
    c.rec.requests = c.rec.requests.filter((r) => r.member !== memberId);
  }

  update(crewId: string, patch: { name?: string; acceptTasks?: CrewAcceptTasks; autoPull?: boolean; shareAgents?: CrewShareAgents }): Crew {
    const c = this.require(crewId);
    if (patch.acceptTasks) c.rec.acceptTasks = patch.acceptTasks;
    if (patch.shareAgents) c.rec.shareAgents = patch.shareAgents;
    if (patch.autoPull !== undefined) {
      c.rec.autoPull = patch.autoPull;
      if (patch.autoPull && c.rec.behind > 0) this.schedulePull(c, 0);
    }
    if (patch.name && patch.name !== c.rec.name) {
      if (c.rec.membership !== "member") throw new ForgeError("CONFLICT", tr().core.crew.notMember);
      c.rec.name = patch.name;
      c.rec.nameAt = toIso(this.now());
      this.sendRoom(c, { t: "rename", name: c.rec.name, at: c.rec.nameAt });
    }
    this.save(c);
    this.scheduleEmit(c);
    return this.view(c);
  }

  // ---------- messages and tasks

  /** A message from the user or an agent (`agent`: its session title). `to`: member id or null for everyone. */
  message(crewId: string, text: string, to: string | null = null, agent: string | null = null): CrewFeedItem {
    const c = this.requireMember(crewId);
    if (to && !c.rec.members.some((x) => x.id === to && !x.left)) throw new ForgeError("NOT_FOUND", tr().core.crew.memberNotFound(to, this.memberList(c)));
    return this.addFeed(c, { kind: "message", from: c.rec.selfId, agent, to, text: text.trim(), files: [] }, true);
  }

  addTask(crewId: string, t: { title: string; detail?: string; assignee?: string | null }, source: CrewTask["source"] = "user"): CrewTask {
    const c = this.requireMember(crewId);
    if (t.assignee && !c.rec.members.some((x) => x.id === t.assignee && !x.left)) throw new ForgeError("NOT_FOUND", tr().core.crew.memberNotFound(t.assignee, this.memberList(c)));
    const at = toIso(this.now());
    const task: TaskEntry = {
      id: randomId(6),
      title: t.title.trim(),
      detail: t.detail?.trim() ?? "",
      status: "open",
      createdBy: c.rec.selfId,
      assignee: t.assignee ?? null,
      owner: null,
      note: null,
      source,
      createdAt: at,
      updatedAt: at,
    };
    this.putTask(c, task);
    return strip(task);
  }

  updateTask(
    crewId: string,
    taskId: string,
    patch: { title?: string; detail?: string; status?: CrewTaskStatus; assignee?: string | null; note?: string | null },
    agent: string | null = null,
  ): CrewTask {
    const c = this.requireMember(crewId);
    const cur = this.findTask(c, taskId);
    if (patch.assignee && !c.rec.members.some((x) => x.id === patch.assignee && !x.left)) throw new ForgeError("NOT_FOUND", tr().core.crew.memberNotFound(patch.assignee, this.memberList(c)));
    const next: TaskEntry = { ...cur, updatedAt: this.stamp(cur.updatedAt) };
    if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.detail !== undefined) next.detail = patch.detail.trim();
    if (patch.assignee !== undefined) next.assignee = patch.assignee;
    if (patch.note !== undefined) next.note = patch.note?.trim() || null;
    if (patch.status && patch.status !== cur.status) {
      next.status = patch.status;
      next.owner = patch.status === "open" ? null : { member: c.rec.selfId, agent: agent ?? (cur.owner?.member === c.rec.selfId ? cur.owner.agent : null) };
    } else if (patch.status === "in_progress" && agent) {
      next.owner = { member: c.rec.selfId, agent };
    }
    this.putTask(c, next);
    return strip(next);
  }

  removeTask(crewId: string, taskId: string): { ok: boolean } {
    const c = this.requireMember(crewId);
    const cur = this.findTask(c, taskId);
    this.putTask(c, { ...cur, deleted: true, updatedAt: this.stamp(cur.updatedAt) });
    return { ok: true };
  }

  /** A new session works on the task; it is ours and in progress from now on. */
  async startTask(crewId: string, taskId: string): Promise<{ sessionId: string }> {
    const c = this.requireMember(crewId);
    const task = this.findTask(c, taskId);
    const project = this.project(c);
    if (!project?.exists) throw new ForgeError("NOT_FOUND", tr().core.crew.projectMissing);
    const prompt = tr().core.crew.taskPrompt(this.memberName(c, task.createdBy), task.title, task.detail, task.id);
    const session = await this.d.sessions.start(project.id, prompt);
    c.taskSessions.set(session.id, task.id);
    this.updateTask(crewId, taskId, { status: "in_progress" }, session.title ?? excerpt(task.title, 80));
    return { sessionId: session.id };
  }

  /** Takes over what others pushed. */
  async pull(crewId: string): Promise<{ output: string }> {
    const c = this.requireMember(crewId);
    const project = this.project(c);
    if (!project?.exists) throw new ForgeError("NOT_FOUND", tr().core.crew.projectMissing);
    const before = c.rec.behind;
    const r = await this.d.git.pull(project.path);
    c.rec.behind = 0;
    this.save(c);
    this.d.emit({ event: "project.updated", payload: { projectId: project.id } });
    if (r.integrated) this.noteLocal(c, tr().core.crew.newsPulled(r.integrated.remoteCommits || before));
    this.scheduleGit(c, 0);
    this.scheduleEmit(c);
    return { output: r.output };
  }

  private findTask(c: Live, taskId: string): TaskEntry {
    const q = taskId.trim().toLowerCase();
    const t = c.rec.tasks.find((x) => !x.deleted && (x.id.toLowerCase() === q || x.id.toLowerCase().startsWith(q)));
    if (!t) throw new ForgeError("NOT_FOUND", tr().core.crew.taskNotFound(taskId));
    return t;
  }

  /** A time after `prev`, so our change wins even when the clocks of two members disagree a little. */
  private stamp(prev: string): string {
    const now = toIso(this.now());
    if (now > prev) return now;
    return toIso(new Date(prev).getTime() + 1);
  }

  private putTask(c: Live, task: TaskEntry) {
    mergeTask(c.rec.tasks, task);
    c.rec.tasks = pruneTasks(c.rec.tasks, this.now());
    this.sendRoom(c, { t: "task", task });
    this.save(c);
    this.scheduleEmit(c);
  }

  private addFeed(c: Live, item: Omit<CrewFeedItem, "id" | "ts">, broadcast: boolean): CrewFeedItem {
    const full: CrewFeedItem = { ...item, id: randomId(9), ts: toIso(this.now()) };
    c.rec.feed = mergeFeed(c.rec.feed, [full]).feed;
    if (broadcast) this.sendRoom(c, { t: "feed", item: full });
    this.save(c);
    this.scheduleEmit(c);
    return full;
  }

  private memberList(c: Live): string {
    return c.rec.members
      .filter((x) => !x.left)
      .map((x) => x.name)
      .join(", ");
  }

  // ---------- sending

  private sendRoom(c: Live, msg: RoomMessage) {
    if (c.rec.membership !== "member") return;
    const key = c.keys.rooms[String(c.rec.epoch)];
    if (!key || !c.link) return;
    const kid = `room:${c.rec.epoch}`;
    c.link.post(c.rec.selfId, kid, seal(key, JSON.stringify(msg), `${c.rec.roomId}|${kid}`));
  }

  private sendInvite(c: Live, inviteId: string, msg: InviteMessage) {
    const key = c.keys.invites[inviteId];
    if (!key || !c.link) return;
    const kid = `invite:${inviteId}`;
    c.link.post(c.rec.selfId, kid, seal(key, JSON.stringify(msg), `${c.rec.roomId}|${kid}`));
  }

  private stateMessage(c: Live): RoomMessage {
    const now = this.now();
    return {
      t: "state",
      name: c.rec.name,
      nameAt: c.rec.nameAt,
      members: c.rec.members.filter((x) => !x.left).map(cardOf),
      removed: c.rec.removed.slice(-64),
      tasks: c.rec.tasks.slice(-500),
      feed: c.rec.feed.slice(-200),
      invites: c.rec.invites
        .filter((i) => c.keys.invites[i.id] && new Date(i.expiresAt).getTime() > now)
        .slice(-32)
        .map((i) => ({ ...i, key: c.keys.invites[i.id]! })),
    };
  }

  // ---------- receiving

  private receive(c: Live, e: Envelope) {
    if (e.seq > c.rec.lastSeq) c.rec.lastSeq = e.seq;
    this.save(c);
    if (e.from === c.rec.selfId) return;
    if (e.kid.startsWith("room:")) {
      const key = c.keys.rooms[e.kid.slice(5)];
      if (!key) return;
      const text = open(key, e, `${c.rec.roomId}|${e.kid}`);
      const parsed = text ? RoomMessage.safeParse(safeJson(text)) : null;
      if (!parsed?.success) return;
      // After a removal, the old key only counts for the members that stayed.
      if (Number(e.kid.slice(5)) < c.rec.epoch && c.rec.removed.includes(e.from)) return;
      this.onRoom(c, e, parsed.data);
    } else if (e.kid.startsWith("invite:")) {
      const id = e.kid.slice(7);
      const key = c.keys.invites[id];
      if (!key) return;
      const text = open(key, e, `${c.rec.roomId}|${e.kid}`);
      const parsed = text ? InviteMessage.safeParse(safeJson(text)) : null;
      if (!parsed?.success) return;
      void this.onInvite(c, id, e, parsed.data);
    }
  }

  private seen(c: Live, from: string, ts: number) {
    const x = c.rec.members.find((m) => m.id === from);
    if (x) x.lastSeen = Math.max(x.lastSeen ?? 0, Math.min(ts, this.now()));
  }

  private onRoom(c: Live, e: Envelope, msg: RoomMessage) {
    if (c.rec.membership !== "member") return;
    if (c.rec.removed.includes(e.from) && msg.t !== "rekey") return;
    this.seen(c, e.from, e.ts);
    switch (msg.t) {
      case "hello": {
        if (msg.member.id !== e.from) return;
        const isNew = !c.rec.members.some((x) => x.id === e.from && !x.left);
        mergeMember(c.rec, msg.member, Math.min(e.ts, this.now()));
        if (isNew) this.noteLocal(c, tr().core.crew.newsJoined(msg.member.name));
        // Answer with what we know, a little later and only once for several hellos.
        if (c.timers.state) clearTimeout(c.timers.state);
        c.timers.state = setTimeout(() => {
          c.timers.state = undefined;
          this.sendRoom(c, this.stateMessage(c));
          this.publishPresence(c);
        }, 300 + Math.floor(Math.random() * 700));
        break;
      }
      case "state": {
        // Only the owner removes members; a list from anyone else cannot push members out.
        if (c.rec.members.find((x) => x.id === e.from)?.owner) for (const id of msg.removed) if (id !== c.rec.selfId) this.applyRemoval(c, id);
        for (const card of msg.members) if (card.id !== c.rec.selfId) mergeMember(c.rec, card, card.id === e.from ? Math.min(e.ts, this.now()) : null);
        if (msg.nameAt > c.rec.nameAt) {
          c.rec.name = msg.name;
          c.rec.nameAt = msg.nameAt;
        }
        for (const t of msg.tasks) this.takeTask(c, t, e.from);
        const { feed, added } = mergeFeed(c.rec.feed, msg.feed);
        c.rec.feed = feed;
        for (const item of added) this.feedArrived(c, item, true);
        for (const inv of msg.invites) this.takeInvite(c, inv);
        c.rec.tasks = pruneTasks(c.rec.tasks, this.now());
        break;
      }
      case "presence": {
        const x = c.rec.members.find((m) => m.id === e.from);
        if (!x) break;
        if (!x.presence || msg.presence.at > x.presence.at) {
          const before = x.presence;
          x.presence = msg.presence;
          this.presenceArrived(c, x, before);
        }
        break;
      }
      case "task":
        this.takeTask(c, msg.task, e.from);
        c.rec.tasks = pruneTasks(c.rec.tasks, this.now());
        break;
      case "feed": {
        const { feed, added } = mergeFeed(c.rec.feed, [msg.item]);
        c.rec.feed = feed;
        for (const item of added) this.feedArrived(c, item, false);
        break;
      }
      case "rename":
        if (msg.at > c.rec.nameAt) {
          c.rec.name = msg.name;
          c.rec.nameAt = msg.at;
        }
        break;
      case "invite":
        this.takeInvite(c, msg.invite);
        break;
      case "leave": {
        if (msg.member !== e.from) break;
        const x = c.rec.members.find((m) => m.id === e.from);
        if (x && !x.left) {
          x.left = true;
          this.noteLocal(c, tr().core.crew.newsLeft(x.name));
        }
        break;
      }
      case "rekey":
        void this.onRekey(c, e, msg);
        break;
      case "share_ask":
      case "share_answer":
      case "share_stop":
      case "share_keep":
        this.shares?.onRoom(this.shareCrew(c), e.from, msg);
        break;
    }
    this.save(c);
    this.scheduleEmit(c);
  }

  private takeInvite(c: Live, inv: { id: string; key: string; expiresAt: string; by: string }) {
    if (new Date(inv.expiresAt).getTime() < this.now() || c.keys.invites[inv.id]) return;
    c.keys.invites[inv.id] = inv.key;
    c.rec.invites = [...c.rec.invites.filter((i) => i.id !== inv.id), { id: inv.id, expiresAt: inv.expiresAt, by: inv.by }];
    void this.saveKeys(c);
  }

  private async onRekey(c: Live, e: Envelope, msg: Extract<RoomMessage, { t: "rekey" }>) {
    const from = c.rec.members.find((x) => x.id === e.from);
    if (!from?.owner || msg.epoch <= c.rec.epoch) return;
    if (msg.removed === c.rec.selfId) {
      this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "removed", title: tr().core.crew.removedTitle(c.rec.name), text: tr().core.crew.removedText(from.name), ref: null } });
      await this.drop(c);
      return;
    }
    const box = msg.keys[c.rec.selfId];
    const key = box ? open(sharedKey(c.keys, from.pub, `rekey:${msg.epoch}`), box) : null;
    if (!key) return;
    c.keys.rooms = { [String(c.rec.epoch)]: c.keys.rooms[String(c.rec.epoch)]!, [String(msg.epoch)]: key };
    c.rec.epoch = msg.epoch;
    const gone = c.rec.members.find((x) => x.id === msg.removed);
    this.applyRemoval(c, msg.removed);
    if (gone) this.noteLocal(c, tr().core.crew.newsLeft(gone.name));
    await this.saveKeys(c);
    this.save(c);
    this.scheduleEmit(c);
  }

  private async onInvite(c: Live, inviteId: string, e: Envelope, msg: InviteMessage) {
    const m = tr().core.crew;
    if (msg.t === "join_request") {
      if (c.rec.membership !== "member" || msg.member !== e.from) return;
      const inv = c.rec.invites.find((i) => i.id === inviteId);
      if (!inv || new Date(inv.expiresAt).getTime() < this.now()) return;
      if (c.rec.removed.includes(msg.member) || c.rec.members.some((x) => x.id === msg.member && !x.left)) return;
      if (c.rec.requests.some((r) => r.id === msg.request)) return;
      const code = fingerprint(msg.pub);
      c.rec.requests.push({ id: msg.request, name: msg.name, code, at: toIso(Math.min(e.ts, this.now())), pub: msg.pub, member: msg.member, invite: inviteId, color: msg.color });
      this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "request", title: m.requestTitle(msg.name), text: m.requestText(c.rec.name, code), ref: msg.request } });
    } else if (msg.t === "join_accept" || msg.t === "join_reject") {
      // Someone answered: the request is off the list of every member.
      c.rec.requests = c.rec.requests.filter((r) => r.id !== msg.request);
      if (c.rec.membership !== "pending" || c.rec.joinRequest?.id !== msg.request) {
        this.save(c);
        this.scheduleEmit(c);
        return;
      }
      if (msg.t === "join_reject") {
        c.rec.membership = "rejected";
        c.link?.stop();
        c.link = null;
        this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "rejected", title: m.rejectedTitle(c.rec.name), text: m.rejectedText, ref: null } });
      } else {
        const text = open(sharedKey(c.keys, msg.byPub, `grant:${msg.request}`), msg.box);
        const grant = text ? JoinGrant.safeParse(safeJson(text)) : null;
        if (!grant?.success) return;
        const g = grant.data;
        c.keys.rooms = { [String(g.epoch)]: g.roomKey };
        c.rec.epoch = g.epoch;
        c.rec.name = g.name;
        c.rec.nameAt = g.nameAt;
        c.rec.createdAt = g.createdAt;
        c.rec.membership = "member";
        c.rec.joinRequest = null;
        for (const card of g.members) if (card.id !== c.rec.selfId) mergeMember(c.rec, card, card.id === msg.by ? Math.min(e.ts, this.now()) : null);
        await this.saveKeys(c);
        this.sendRoom(c, { t: "hello", member: this.selfCard(c) });
        this.publishPresence(c);
        this.scheduleGit(c, 0);
        this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "joined", title: m.joinedTitle(c.rec.name), text: m.joinedText(this.memberName(c, msg.by)), ref: null } });
      }
      this.save(c);
      this.scheduleEmit(c);
    }
  }

  /** A task from another member; tells our agents and the user what concerns them. */
  private takeTask(c: Live, t: TaskEntry, from: string) {
    const before = c.rec.tasks.find((x) => x.id === t.id);
    const prev = before ? { ...before } : null;
    if (!mergeTask(c.rec.tasks, t)) return;
    const m = tr().core.crew;
    const who = this.memberName(c, from);
    const label = `"${excerpt(t.title, 120)}" (${t.id})`;
    if (t.deleted) {
      if (prev && !prev.deleted) this.noteLocal(c, m.newsTaskRemoved(who, label));
      return;
    }
    if (!prev || prev.deleted) this.noteLocal(c, m.newsTaskAdded(who, label, t.assignee ? this.memberName(c, t.assignee) : null));
    else if (prev.status !== t.status) {
      const by = t.owner ? `${this.memberName(c, t.owner.member)}${t.owner.agent ? ` (${t.owner.agent})` : ""}` : who;
      this.noteLocal(c, t.status === "done" ? m.newsTaskDone(by, label, t.note) : t.status === "in_progress" ? m.newsTaskTaken(by, label) : m.newsTaskReopened(who, label));
    }
    const forMe = t.assignee === c.rec.selfId && t.status === "open" && (prev?.assignee !== c.rec.selfId || prev.deleted);
    if (forMe) {
      this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "task", title: m.taskTitle(who), text: t.title, ref: t.id } });
      if (c.rec.acceptTasks === "auto") {
        void this.startTask(c.rec.id, t.id).catch((e: unknown) => this.d.log?.(`crew: task ${t.id} not started: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  }

  private feedArrived(c: Live, item: CrewFeedItem, catchingUp: boolean) {
    if (item.from === c.rec.selfId) return;
    const m = tr().core.crew;
    const who = `${this.memberName(c, item.from)}${item.agent ? ` (${item.agent})` : ""}`;
    switch (item.kind) {
      case "message":
        if (item.to && item.to !== c.rec.selfId) return;
        this.noteLocal(c, m.newsMessage(who, item.to === c.rec.selfId, item.text));
        if (!catchingUp || item.to === c.rec.selfId)
          this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "message", title: m.messageTitle(who), text: excerpt(item.text, 300), ref: item.id } });
        break;
      case "turn":
        this.noteLocal(c, m.newsTurn(who, item.text, item.files));
        break;
      case "push":
        this.noteLocal(c, m.newsPush(who, item.text, item.files));
        if (!catchingUp) this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "push", title: m.pushTitle(who), text: excerpt(item.text, 300), ref: item.id } });
        this.schedulePull(c, 1_500);
        break;
      case "joined":
        if (item.text) this.noteLocal(c, m.newsJoined(item.text));
        break;
      default:
        break;
    }
  }

  /** Another member's presence changed: warn our working agents about files both touch. */
  private presenceArrived(c: Live, member: MemberEntry, before: Presence | null) {
    const p = member.presence!;
    const theirs = [...p.files, ...p.agents.flatMap((a) => a.files)];
    const hadBefore = new Set(before ? [...before.files, ...before.agents.flatMap((a) => a.files)].map((f) => f.toLowerCase()) : []);
    const mine = [...this.ownPresence(c).files, ...[...c.agents.values()].flatMap((a) => a.files)];
    const fresh = overlap(theirs, mine).filter((f) => !hadBefore.has(f.toLowerCase()));
    if (fresh.length) this.noteLocal(c, tr().core.crew.newsOverlap(member.name, fresh.slice(0, 10)));
  }

  // ---------- our own work: sessions and git

  /** Every event of the app passes here (app.ts); sessions of crew projects become our presence. */
  onServerEvent(e: ServerEvent) {
    if (!this.crews.size) return;
    if (e.event === "session.event") {
      this.shares?.onSessionEvent(e.payload.sessionId, e.payload.body);
      this.onSessionEvent(e.payload.sessionId, e.payload.body);
    }
    else if (e.event === "session.updated") this.onSessionUpdated(e.payload);
    else if (e.event === "project.updated") {
      const c = this.liveFor(e.payload.projectId);
      if (c) this.scheduleGit(c, GIT_DEBOUNCE_MS);
    }
  }

  private agentOf(c: Live, s: Session): CrewAgent {
    let a = c.agents.get(s.id);
    if (!a) {
      const project = this.d.projects().find((p) => p.id === s.projectId);
      a = {
        id: s.id,
        title: s.title ?? "Session",
        status: "idle",
        task: null,
        files: [],
        lastResult: null,
        branch: project?.parentId ? (project.name.includes(" · ") ? project.name.slice(project.name.indexOf(" · ") + 3) : project.name) : null,
        updatedAt: toIso(this.now()),
      };
      c.agents.set(s.id, a);
    }
    return a;
  }

  private onSessionUpdated(s: Session) {
    // A copy of another member's session is not our work.
    if (s.mirror) return;
    const c = this.liveFor(s.projectId);
    if (!c) return;
    const a = this.agentOf(c, s);
    // Subagents in the background work on while the session itself waits.
    const helpers = s.subagents.length + s.background.filter((b) => b.taskType.includes("agent")).length;
    const status =
      s.status === "waiting_approval" ? "waiting" : s.status === "running" || s.status === "starting" || s.status === "stopping" || (s.live && helpers > 0) ? "working" : "idle";
    if (a.title === (s.title ?? a.title) && a.status === status) return;
    a.title = s.title ?? a.title;
    a.status = status;
    a.updatedAt = toIso(this.now());
    this.schedulePresence(c);
  }

  private onSessionEvent(sessionId: string, body: SessionEventBody) {
    if (body.type !== "user.message" && body.type !== "tool.use" && body.type !== "turn.result" && body.type !== "approval.request") return;
    const s = this.d.sessions.get(sessionId);
    if (!s || s.mirror) return;
    const c = this.liveFor(s.projectId);
    if (!c) return;
    const a = this.agentOf(c, s);
    const at = toIso(this.now());
    if (body.type === "user.message") {
      if (body.source === "auto" || body.text.trim().startsWith("/")) return;
      a.task = excerpt(body.text, 240);
      a.files = [];
      a.status = "working";
    } else if (body.type === "tool.use") {
      if (!EDIT_TOOLS.has(body.name)) return;
      const file = this.relativeFile(c, s, body.input);
      if (!file || a.files.includes(file)) return;
      a.files = [...a.files, file].slice(-AGENT_FILES_MAX);
    } else if (body.type === "approval.request") {
      a.status = "waiting";
    } else {
      a.status = "idle";
      if (body.text && !body.isError) a.lastResult = excerpt(body.text, 400);
      // A finished turn that did something goes into the feed: the others see what is done.
      if (!body.isError && !body.interrupted && (a.files.length || a.task)) {
        const text = [a.task ? excerpt(a.task, 200) : "", a.lastResult ? `→ ${excerpt(a.lastResult, 300)}` : ""].filter(Boolean).join("\n");
        if (text) this.addFeed(c, { kind: "turn", from: c.rec.selfId, agent: a.title, to: null, text, files: a.files.slice(0, 40) }, true);
      }
      const taskId = c.taskSessions.get(sessionId);
      if (taskId && !body.isError && !body.interrupted) {
        const t = c.rec.tasks.find((x) => x.id === taskId && !x.deleted);
        if (t && t.status === "in_progress" && t.owner?.member === c.rec.selfId) this.updateTask(c.rec.id, taskId, { status: "done", note: a.lastResult ? excerpt(a.lastResult, 300) : null }, a.title);
        c.taskSessions.delete(sessionId);
      }
      this.scheduleGit(c, 500);
      if (c.rec.behind > 0) this.schedulePull(c, 1_000);
    }
    a.updatedAt = at;
    this.schedulePresence(c);
  }

  /** Path of an edited file relative to the crew's project (worktrees map onto the same paths). */
  private relativeFile(c: Live, s: Session, input: Record<string, unknown>): string | null {
    const raw = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
    if (!raw) return null;
    const abs = path.resolve(s.cwd, raw);
    const project = this.d.projects().find((p) => p.id === s.projectId);
    const base = project?.path ?? this.project(c)?.path ?? s.cwd;
    const rel = path.relative(base, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.replace(/\\/g, "/");
  }

  private ownPresence(c: Live): Presence {
    const agents = [...c.agents.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 24);
    return { at: toIso(this.now()), branch: c.git.branch, files: c.git.files.slice(0, 400), ahead: c.git.ahead, agents };
  }

  private pruneAgents(c: Live) {
    const cutoff = toIso(this.now() - AGENT_KEEP_MS);
    for (const [id, a] of c.agents) if (a.status === "idle" && a.updatedAt < cutoff) c.agents.delete(id);
  }

  private schedulePresence(c: Live) {
    this.scheduleEmit(c);
    if (c.timers.presence) return;
    c.timers.presence = setTimeout(() => {
      c.timers.presence = undefined;
      this.publishPresence(c);
    }, PRESENCE_DEBOUNCE_MS);
  }

  private publishPresence(c: Live) {
    if (c.rec.membership !== "member") return;
    const p = this.ownPresence(c);
    const me = this.self(c);
    me.presence = p;
    me.lastSeen = this.now();
    this.sendRoom(c, { t: "presence", presence: p });
  }

  private scheduleGit(c: Live, ms: number) {
    if (c.timers.git) clearTimeout(c.timers.git);
    c.timers.git = setTimeout(() => {
      c.timers.git = undefined;
      void this.refreshGit(c).catch((e: unknown) => this.d.log?.(`crew git: ${e instanceof Error ? e.message : String(e)}`));
    }, ms);
  }

  /** Branch, files in work and unpushed commits of our checkout; notices our own pushes. */
  private async refreshGit(c: Live) {
    const project = this.project(c);
    if (!project?.exists || !project.gitEnabled || c.rec.membership !== "member") return;
    const git = this.d.git;
    const st = await git.status(project.path).catch(() => null);
    if (!st) return;
    const branch = st.summary.branch ?? null;
    const files = new Set(st.files.map((f) => f.path.replace(/\\/g, "/")));
    const remote = branch ? `refs/remotes/origin/${branch}` : null;
    const originSha = remote ? (await git.exec(project.path, ["rev-parse", "--verify", "-q", remote])).stdout.trim() || null : null;
    let ahead: number;
    if (originSha) {
      const unpushed = await git.exec(project.path, ["diff", "--name-only", "--relative", "-z", `${originSha}...HEAD`]);
      for (const f of unpushed.stdout.split("\0").filter(Boolean)) files.add(f);
      const counts = (await git.exec(project.path, ["rev-list", "--left-right", "--count", `HEAD...${originSha}`])).stdout.trim().split(/\s+/);
      ahead = Number(counts[0] ?? 0) || 0;
      c.rec.behind = Number(counts[1] ?? 0) || 0;
    } else {
      ahead = Number((await git.exec(project.path, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"])).stdout.trim()) || 0;
      c.rec.behind = 0;
    }
    if (branch && originSha) await this.noticeOwnPush(c, project.path, branch, originSha);
    const changed = c.git.branch !== branch || c.git.ahead !== ahead || c.git.files.join("\n") !== [...files].join("\n");
    c.git = { branch, files: [...files].slice(0, 400), ahead };
    this.save(c);
    if (changed) this.schedulePresence(c);
    else this.scheduleEmit(c);
  }

  /** origin/<branch> moved: what we pushed (commits by our git identity) goes to the feed. */
  private async noticeOwnPush(c: Live, dir: string, branch: string, sha: string) {
    const seen = c.rec.originSeen;
    c.rec.originSeen = { branch, sha };
    if (!seen || seen.branch !== branch || seen.sha === sha) return;
    const git = this.d.git;
    if ((await git.exec(dir, ["merge-base", "--is-ancestor", seen.sha, sha])).code !== 0) return;
    // The identity that applies in this repository (a local user.email beats the global one).
    const email = (await git.exec(dir, ["config", "--get", "user.email"])).stdout.trim().toLowerCase();
    if (!email) return;
    const log = await git.exec(dir, ["log", "--no-merges", "-n50", "--format=%x01%ae%x02%s", "--name-only", "--relative", `${seen.sha}..${sha}`]);
    const subjects: string[] = [];
    const files = new Set<string>();
    for (const block of log.stdout.split("\x01").filter(Boolean)) {
      const [head = "", ...rest] = block.split("\n");
      const [author = "", subject = ""] = head.split("\x02");
      if (author.toLowerCase() !== email) continue;
      subjects.push(subject.trim());
      for (const f of rest.map((l) => l.trim()).filter(Boolean)) files.add(f);
    }
    if (!subjects.length) return;
    this.addFeed(c, { kind: "push", from: c.rec.selfId, agent: null, to: null, text: `${branch}: ${subjects.slice(0, 8).join("\n")}${subjects.length > 8 ? `\n+${subjects.length - 8}` : ""}`, files: [...files].slice(0, 60) }, true);
  }

  private schedulePull(c: Live, ms: number) {
    if (c.timers.pull) clearTimeout(c.timers.pull);
    c.timers.pull = setTimeout(() => {
      c.timers.pull = undefined;
      void this.fetchAndPull(c).catch((e: unknown) => this.d.log?.(`crew pull: ${e instanceof Error ? e.message : String(e)}`));
    }, ms);
  }

  /**
   * After a member pushed: fetch, and with autoPull take the commits over while no session of the
   * project works (git pull: rebase, uncommitted work stashed and put back, conflicts abort).
   */
  private async fetchAndPull(c: Live) {
    const project = this.project(c);
    if (!project?.exists || !project.gitEnabled || c.rec.membership !== "member") return;
    const incoming = await this.d.git.incoming(project.path).catch(() => null);
    c.rec.behind = incoming?.behind ?? 0;
    const m = tr().core.crew;
    if (c.rec.behind > 0 && c.rec.autoPull && !this.d.sessions.busy(project.id)) {
      try {
        const r = await this.d.git.pull(project.path);
        const n = r.integrated?.remoteCommits ?? c.rec.behind;
        c.rec.behind = 0;
        this.noteLocal(c, m.newsPulled(n));
        this.addFeed(c, { kind: "pulled", from: c.rec.selfId, agent: null, to: null, text: String(n), files: [] }, false);
        this.d.emit({ event: "crew.notice", payload: { crewId: c.rec.id, projectId: c.rec.projectId, kind: "pulled", title: m.pulledTitle(c.rec.name), text: m.pulledText(n), ref: null } });
        this.d.emit({ event: "project.updated", payload: { projectId: project.id } });
      } catch (e) {
        this.noteLocal(c, m.newsBehind(c.rec.behind));
        this.d.log?.(`crew: auto pull failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (c.rec.behind > 0) {
      this.noteLocal(c, m.newsBehind(c.rec.behind));
    }
    this.save(c);
    this.scheduleGit(c, 0);
    this.scheduleEmit(c);
  }

  // ---------- what our agents hear

  /** A line for our agents; they get it with their next message or after their next tool call. */
  private noteLocal(c: Live, text: string) {
    c.news.push({ n: ++c.newsN, text });
    if (c.news.length > NEWS_MAX) c.news.splice(0, c.news.length - NEWS_MAX);
  }

  /**
   * The session's process starts: a new session hears only what comes after (its start context has the
   * rest); a resumed one keeps its place and hears what it missed meanwhile.
   */
  sessionStarted(sessionId: string, projectId: string) {
    const c = this.liveFor(projectId);
    if (c && !this.cursors.has(sessionId)) this.cursors.set(sessionId, c.newsN);
  }

  /** News for the session since it last heard, as one block; null when there is nothing new. */
  takeNews(sessionId: string, live: boolean): string | null {
    const s = this.d.sessions.get(sessionId);
    if (!s) return null;
    const c = this.liveFor(s.projectId);
    if (!c) return null;
    const from = this.cursors.get(sessionId) ?? c.newsN - 5;
    const items = c.news.filter((n) => n.n > from);
    this.cursors.set(sessionId, c.newsN);
    if (!items.length) return null;
    const m = tr().core.crew;
    const lines = items.map((n) => `- ${n.text}`);
    let text = lines.join("\n");
    if (text.length > 2500) text = `${text.slice(0, 2500)}\n- ${m.newsMore}`;
    return live ? m.liveNote(c.rec.name, text) : m.turnNote(c.rec.name, text);
  }

  /**
   * Before an edit: a hint when another member works on the same file. Once per session and file in
   * WARN_AGAIN_MS; null when nobody else touches it.
   */
  editWarning(sessionId: string, toolName: string, input: Record<string, unknown>): string | null {
    if (!EDIT_TOOLS.has(toolName)) return null;
    const s = this.d.sessions.get(sessionId);
    if (!s) return null;
    const c = this.liveFor(s.projectId);
    if (!c) return null;
    const file = this.relativeFile(c, s, input);
    if (!file) return null;
    const key = `${sessionId}\u0000${file.toLowerCase()}`;
    const last = this.warned.get(key);
    if (last && this.now() - last < WARN_AGAIN_MS) return null;
    const who: string[] = [];
    for (const m of c.rec.members) {
      if (m.left || m.id === c.rec.selfId || !m.presence) continue;
      const agent = m.presence.agents.find((a) => overlap(a.files, [file]).length);
      if (agent) who.push(tr().core.crew.warnAgent(m.name, agent.title, agent.status === "working", agent.task));
      else if (overlap(m.presence.files, [file]).length) who.push(tr().core.crew.warnMember(m.name));
    }
    if (!who.length) return null;
    this.warned.set(key, this.now());
    return tr().core.crew.editWarning(file, who.join("; "));
  }

  /** What another member's session is called in tools and notes: "Anna (Login-Seite)". */
  describeMember(crewId: string, memberId: string): string {
    const c = this.require(crewId);
    return this.memberName(c, memberId);
  }

  /** Resolves a member by id or (part of its) name, for tools and the phone. */
  resolveMember(crewId: string, ref: string): string {
    const c = this.require(crewId);
    const q = ref.trim().toLowerCase();
    const active = c.rec.members.filter((x) => !x.left);
    const hit = active.find((x) => x.id === ref) ?? active.find((x) => x.name.toLowerCase() === q) ?? active.find((x) => x.name.toLowerCase().startsWith(q));
    if (!hit) throw new ForgeError("NOT_FOUND", tr().core.crew.memberNotFound(ref, this.memberList(c)));
    return hit.id;
  }

  // ---------- persistence and events

  private save(c: Live) {
    if (c.timers.save) return;
    c.timers.save = setTimeout(() => {
      c.timers.save = undefined;
      this.saveNow(c);
    }, SAVE_DEBOUNCE_MS);
  }

  private saveNow(c: Live) {
    if (c.timers.save) clearTimeout(c.timers.save);
    c.timers.save = undefined;
    if (!this.crews.has(c.rec.id)) return;
    mkdirSync(this.d.dir, { recursive: true });
    void writeFile(path.join(this.d.dir, `${c.rec.id}.json`), JSON.stringify(c.rec), "utf8").catch((e: unknown) => this.d.log?.(`crew save: ${e instanceof Error ? e.message : String(e)}`));
  }

  private async saveKeys(c: Live) {
    await this.d.secrets.set(`${CREW_SECRET_PREFIX}${c.rec.id}`, JSON.stringify(c.keys));
  }

  private scheduleEmit(c: Live) {
    if (c.timers.emit) return;
    c.timers.emit = setTimeout(() => {
      c.timers.emit = undefined;
      if (this.crews.has(c.rec.id)) this.d.emit({ event: "crew.updated", payload: { crewId: c.rec.id, projectId: c.rec.projectId } });
    }, EMIT_DEBOUNCE_MS);
  }
}

function strip(t: TaskEntry): CrewTask {
  const { deleted: _d, ...rest } = t;
  return rest;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Clone URL without user and password; a token must not travel in an invite. */
export function stripCredentials(url: string): string {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u.replace(/^(https?:\/\/)[^/@]+@/i, "$1");
  // ssh://user:secret@host keeps the user (git@), not the secret.
  return u.replace(/^(ssh:\/\/[^/@:]+):[^/@]*@/i, "$1@");
}
