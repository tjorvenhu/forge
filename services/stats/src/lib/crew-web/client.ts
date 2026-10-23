import { fingerprint, gunzipBase64, newKeyPair, open, randomId, seal, sharedKey, type KeyPair, type Sealed } from "./crypto";
import { RelayLink, type LinkState } from "./link";
import {
  decodeInvite,
  MAX_MEMBERS,
  ONLINE_MS,
  parseGrant,
  parseInviteMessage,
  parseRoom,
  parseShare,
  safeJson,
  type CrewAgent,
  type Envelope,
  type FeedItem,
  type InviteMessage,
  type MemberCard,
  type Presence,
  type RoomMessage,
  type TaskEntry,
  type TaskStatus,
} from "./wire";

/**
 * A crew member in the browser. It joins with an invite like a FORGE installation (its own X25519 key,
 * a member lets it in after comparing the check code), keeps the crew's state in localStorage and
 * talks to the room on the relay directly. It has no project and no agents: it watches, writes, plans
 * tasks, lets others in and can follow a member's session live.
 */

const FEED_MAX = 200;
const DONE_TASKS_MAX = 150;
const HEARTBEAT_MS = 30_000;
const ASK_TIMEOUT_MS = 90_000;
const TRANSFER_STALL_MS = 120_000;
const KEEP_MS = 4 * 60_000;
/** what a live view asks for; a phone does not need the whole session */
export const WATCH_EVENTS = 400;
const WATCH_EVENTS_MAX = 1500;
/** the colors FORGE offers (packages/protocol CREW_COLORS); a member's color is data, not a theme color */
export const CREW_COLORS = ["#3e8cf0", "#30a46c", "#8e4ec6", "#ef7d32", "#d6409f", "#0fa3b8", "#d6a10b", "#e5484d"] as const;
const STORE_PREFIX = "forge.crew.web.";
const INDEX_KEY = "forge.crew.web";

export interface Storage {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export const browserStorage: Storage = {
  get: (k) => globalThis.localStorage?.getItem(k) ?? null,
  set: (k, v) => (v === null ? globalThis.localStorage?.removeItem(k) : globalThis.localStorage?.setItem(k, v)),
};

export type Membership = "pending" | "member" | "rejected" | "removed";

interface MemberEntry extends MemberCard {
  left: boolean;
  lastSeen: number | null;
  presence: Presence | null;
}

interface RequestEntry {
  id: string;
  name: string;
  code: string;
  at: string;
  pub: string;
  member: string;
  invite: string;
  color: string;
}

/** What the browser keeps of a crew (localStorage, one key per crew). */
export interface WebCrewRecord {
  v: 1;
  id: string;
  relayUrl: string;
  roomId: string;
  name: string;
  nameAt: string;
  project: string;
  remote: string | null;
  membership: Membership;
  selfId: string;
  epoch: number;
  lastSeq: number;
  keys: KeyPair & { rooms: Record<string, string>; invites: Record<string, string> };
  members: MemberEntry[];
  removed: string[];
  tasks: TaskEntry[];
  feed: FeedItem[];
  invites: Array<{ id: string; expiresAt: string; by: string }>;
  requests: RequestEntry[];
  joinRequest: { id: string; invite: string; code: string } | null;
  createdAt: string;
}

export interface MemberView {
  id: string;
  name: string;
  color: string;
  self: boolean;
  owner: boolean;
  web: boolean;
  online: boolean;
  lastSeen: string | null;
  branch: string | null;
  files: string[];
  ahead: number;
  agents: CrewAgent[];
}

export type WatchState = "asking" | "transferring" | "live" | "declined" | "failed" | "ended";

export interface WatchView {
  id: string;
  member: string;
  agentId: string;
  title: string;
  state: WatchState;
  received: number;
  total: number | null;
  error: string | null;
  /** session events (FORGE's SessionEventBody), oldest first */
  events: unknown[];
}

export interface CrewView {
  id: string;
  name: string;
  project: string;
  remote: string | null;
  membership: Membership;
  joinCode: string | null;
  connection: LinkState;
  error: string | null;
  selfId: string;
  members: MemberView[];
  tasks: TaskEntry[];
  feed: FeedItem[];
  requests: Array<{ id: string; name: string; code: string; at: string }>;
  watch: WatchView | null;
}

/** Errors the UI turns into its own words. */
export class CrewWebError extends Error {
  constructor(readonly code: "invalid" | "expired" | "joined" | "unsupported" | "full" | "gone" | "offline" | "notMember") {
    super(code);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export function mergeTask(tasks: TaskEntry[], incoming: TaskEntry): boolean {
  const i = tasks.findIndex((t) => t.id === incoming.id);
  if (i < 0) {
    tasks.push(incoming);
    return true;
  }
  const cur = tasks[i]!;
  if (incoming.updatedAt > cur.updatedAt || (incoming.updatedAt === cur.updatedAt && JSON.stringify(incoming) > JSON.stringify(cur))) {
    tasks[i] = incoming;
    return true;
  }
  return false;
}

function pruneTasks(tasks: TaskEntry[], now: number): TaskEntry[] {
  const cutoff = iso(now - 14 * 24 * 3600_000);
  const kept = tasks.filter((t) => !t.deleted || t.updatedAt > cutoff);
  const done = kept.filter((t) => t.status === "done" && !t.deleted).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const drop = new Set(done.slice(DONE_TASKS_MAX).map((t) => t.id));
  return kept.filter((t) => !drop.has(t.id));
}

function mergeFeed(feed: FeedItem[], items: FeedItem[]): FeedItem[] {
  const known = new Set(feed.map((f) => f.id));
  const added = items.filter((i) => !known.has(i.id));
  if (!added.length) return feed;
  return [...feed, ...added].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1)).slice(-FEED_MAX);
}

function mergeMember(rec: WebCrewRecord, card: MemberCard, seen: number | null) {
  if (rec.removed.includes(card.id)) return;
  const cur = rec.members.find((m) => m.id === card.id);
  if (!cur) {
    rec.members.push({ ...card, web: !!card.web, left: false, lastSeen: seen, presence: null });
    return;
  }
  cur.name = card.name;
  cur.color = card.color;
  cur.pub = card.pub;
  cur.web = !!card.web;
  cur.left = false;
  if (seen !== null) cur.lastSeen = Math.max(cur.lastSeen ?? 0, seen);
}

const cardOf = (m: MemberEntry): MemberCard => ({ id: m.id, name: m.name, color: m.color, pub: m.pub, joinedAt: m.joinedAt, owner: m.owner, ...(m.web ? { web: true } : {}) });

interface Watch {
  view: WatchView;
  room: string | null;
  link: RelayLink | null;
  chunks: string[];
  liveNext: number;
  liveWaiting: Map<number, unknown[]>;
  timers: { ask?: ReturnType<typeof setTimeout>; stall?: ReturnType<typeof setTimeout>; keep?: ReturnType<typeof setInterval> };
}

export interface ClientOptions {
  storage?: Storage;
  fetch?: typeof fetch;
  now?: () => number;
}

export class CrewWebClient {
  private link: RelayLink | null = null;
  private connection: LinkState = "offline";
  private error: string | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: CrewView | null = null;
  private timers: { heartbeat?: ReturnType<typeof setInterval>; state?: ReturnType<typeof setTimeout>; save?: ReturnType<typeof setTimeout>; emit?: ReturnType<typeof setTimeout> } = {};
  /** envelopes are opened one after the other: WebCrypto is async, the order matters (join, rekey) */
  private queue: Promise<void> = Promise.resolve();
  private watchState: Watch | null = null;
  private readonly storage: Storage;
  private readonly now: () => number;

  constructor(
    private rec: WebCrewRecord,
    private readonly o: ClientOptions = {},
  ) {
    this.storage = o.storage ?? browserStorage;
    this.now = o.now ?? Date.now;
  }

  get id() {
    return this.rec.id;
  }

  /** the relay room, the same for every member: an invite to it is one we already took */
  get roomId() {
    return this.rec.roomId;
  }

  // ---------- crews in storage

  static list(o: ClientOptions = {}): CrewWebClient[] {
    const storage = o.storage ?? browserStorage;
    const ids = (safeJson(storage.get(INDEX_KEY)) as string[] | null) ?? [];
    const out: CrewWebClient[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const rec = safeJson(storage.get(STORE_PREFIX + id)) as WebCrewRecord | null;
      if (rec && rec.v === 1 && rec.id === id) out.push(new CrewWebClient(rec, o));
    }
    return out;
  }

  /** Asks to join with an invite code (or a link holding one); a member of the crew lets us in. */
  static async join(code: string, profile: { name: string; color: string }, o: ClientOptions = {}): Promise<CrewWebClient> {
    const storage = o.storage ?? browserStorage;
    const now = (o.now ?? Date.now)();
    const p = decodeInvite(code);
    if (!p) throw new CrewWebError("invalid");
    if (p.x * 1000 < now) throw new CrewWebError("expired");
    const existing = CrewWebClient.list(o).find((c) => c.rec.roomId === p.r);
    if (existing && existing.rec.membership !== "rejected" && existing.rec.membership !== "removed") throw new CrewWebError("joined");
    if (existing) existing.forget();
    let pair: KeyPair;
    try {
      pair = await newKeyPair();
    } catch {
      throw new CrewWebError("unsupported");
    }
    const selfId = randomId(9);
    const at = iso(now);
    const rec: WebCrewRecord = {
      v: 1,
      id: randomId(9),
      relayUrl: p.u,
      roomId: p.r,
      name: p.n,
      nameAt: "",
      project: p.p,
      remote: p.o,
      membership: "pending",
      selfId,
      epoch: 0,
      lastSeq: 0,
      keys: { ...pair, rooms: {}, invites: { [p.i]: p.k } },
      members: [{ id: selfId, name: profile.name.trim().slice(0, 60), color: profile.color, pub: pair.pub, joinedAt: at, owner: false, web: true, left: false, lastSeen: null, presence: null }],
      removed: [],
      tasks: [],
      feed: [],
      invites: [{ id: p.i, expiresAt: iso(p.x * 1000), by: "" }],
      requests: [],
      joinRequest: { id: randomId(9), invite: p.i, code: await fingerprint(pair.pub) },
      createdAt: at,
    };
    const c = new CrewWebClient(rec, o);
    c.saveNow();
    const ids = ((safeJson(storage.get(INDEX_KEY)) as string[] | null) ?? []).filter((x) => x !== rec.id);
    storage.set(INDEX_KEY, JSON.stringify([...ids, rec.id]));
    return c;
  }

  // ---------- lifecycle

  start() {
    if (this.link || this.rec.membership === "rejected" || this.rec.membership === "removed") return;
    this.connection = "connecting";
    this.link = new RelayLink({
      url: this.rec.relayUrl,
      room: this.rec.roomId,
      after: () => this.rec.lastSeq,
      fetch: this.o.fetch,
      onEnvelope: (e) => {
        this.queue = this.queue.then(() => this.receive(e)).catch(() => {});
      },
      onGap: () => {
        this.rec.lastSeq = 0;
      },
      onReady: () => {
        this.queue = this.queue.then(() => this.ready()).catch(() => {});
      },
      onState: (state, error) => {
        this.connection = state;
        if (state === "online") this.error = null;
        else if (error) this.error = error;
        this.changed();
      },
    });
    this.link.start();
    this.timers.heartbeat = setInterval(() => {
      if (this.rec.membership === "member" && this.connection === "online") void this.publishPresence();
      // "online" of the others depends on the time; the view is computed again.
      this.changed();
    }, HEARTBEAT_MS);
  }

  stop() {
    this.stopWatch();
    this.link?.stop();
    this.link = null;
    this.connection = "offline";
    for (const t of Object.values(this.timers)) if (t) clearTimeout(t);
    if (this.timers.save) this.saveNow();
    this.timers = {};
  }

  /** The page became visible again or the network came back. */
  wake() {
    this.link?.nudge();
    if (this.rec.membership === "member" && this.connection === "online") void this.publishPresence();
    // A locked phone sent no keep-alive meanwhile: say right away that we still watch.
    const w = this.watchState;
    if (w) {
      w.link?.nudge();
      if (w.view.state === "live") void this.sendRoom({ t: "share_keep", request: w.view.id, to: w.view.member });
    }
  }

  /** Leaves the crew (members read the goodbye) and forgets it here. */
  async leave() {
    if (this.rec.membership === "member") {
      await this.sendRoom({ t: "leave", member: this.rec.selfId });
      await new Promise((r) => setTimeout(r, Math.min(1500, 200 + (this.link?.pending() ?? 0) * 200)));
    }
    this.forget();
  }

  /** Removes the crew from this browser without telling anyone (rejected, removed, or after leave). */
  forget() {
    this.stop();
    this.storage.set(STORE_PREFIX + this.rec.id, null);
    const ids = ((safeJson(this.storage.get(INDEX_KEY)) as string[] | null) ?? []).filter((x) => x !== this.rec.id);
    this.storage.set(INDEX_KEY, JSON.stringify(ids));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- the view

  view(): CrewView {
    if (this.snapshot) return this.snapshot;
    const rec = this.rec;
    const now = this.now();
    const members: MemberView[] = rec.members
      .filter((m) => !m.left)
      .map((m) => {
        const self = m.id === rec.selfId;
        return {
          id: m.id,
          name: m.name,
          color: m.color,
          self,
          owner: m.owner,
          web: !!m.web,
          online: self ? this.connection === "online" : m.lastSeen !== null && now - m.lastSeen < ONLINE_MS,
          lastSeen: m.lastSeen ? iso(m.lastSeen) : null,
          branch: m.presence?.branch ?? null,
          files: m.presence?.files ?? [],
          ahead: m.presence?.ahead ?? 0,
          agents: m.presence?.agents ?? [],
        };
      })
      .sort((a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    this.snapshot = {
      id: rec.id,
      name: rec.name,
      project: rec.project,
      remote: rec.remote,
      membership: rec.membership,
      joinCode: rec.membership === "pending" ? (rec.joinRequest?.code ?? null) : null,
      connection: this.link ? this.connection : "offline",
      error: this.error,
      selfId: rec.selfId,
      members,
      tasks: rec.tasks.filter((t) => !t.deleted).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
      feed: rec.feed,
      requests: rec.requests.map(({ id, name, code, at }) => ({ id, name, code, at })),
      watch: this.watchState ? { ...this.watchState.view } : null,
    };
    return this.snapshot;
  }

  memberName(id: string | null): string {
    return (id && this.rec.members.find((m) => m.id === id)?.name) || "?";
  }

  private changed() {
    this.snapshot = null;
    if (this.timers.emit) return;
    this.timers.emit = setTimeout(() => {
      this.timers.emit = undefined;
      for (const fn of this.listeners) fn();
    }, 30);
  }

  // ---------- actions

  private requireMember() {
    if (this.rec.membership !== "member") throw new CrewWebError("notMember");
  }

  async message(text: string, to: string | null = null): Promise<FeedItem> {
    this.requireMember();
    const item: FeedItem = { id: randomId(9), kind: "message", from: this.rec.selfId, agent: null, to, text: text.trim(), files: [], ts: iso(this.now()) };
    this.rec.feed = mergeFeed(this.rec.feed, [item]);
    this.save();
    await this.sendRoom({ t: "feed", item });
    return item;
  }

  async addTask(t: { title: string; detail?: string; assignee?: string | null }): Promise<TaskEntry> {
    this.requireMember();
    const at = iso(this.now());
    const task: TaskEntry = {
      id: randomId(6),
      title: t.title.trim(),
      detail: t.detail?.trim() ?? "",
      status: "open",
      createdBy: this.rec.selfId,
      assignee: t.assignee ?? null,
      owner: null,
      note: null,
      source: "user",
      createdAt: at,
      updatedAt: at,
    };
    await this.putTask(task);
    return task;
  }

  async updateTask(taskId: string, patch: { title?: string; detail?: string; status?: TaskStatus; assignee?: string | null }): Promise<void> {
    this.requireMember();
    const cur = this.rec.tasks.find((x) => x.id === taskId && !x.deleted);
    if (!cur) throw new CrewWebError("gone");
    const next: TaskEntry = { ...cur, updatedAt: this.stamp(cur.updatedAt) };
    if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.detail !== undefined) next.detail = patch.detail.trim();
    if (patch.assignee !== undefined) next.assignee = patch.assignee;
    if (patch.status && patch.status !== cur.status) {
      next.status = patch.status;
      next.owner = patch.status === "open" ? null : { member: this.rec.selfId, agent: null };
    }
    await this.putTask(next);
  }

  async removeTask(taskId: string): Promise<void> {
    this.requireMember();
    const cur = this.rec.tasks.find((x) => x.id === taskId && !x.deleted);
    if (!cur) throw new CrewWebError("gone");
    await this.putTask({ ...cur, deleted: true, updatedAt: this.stamp(cur.updatedAt) });
  }

  private stamp(prev: string): string {
    const now = iso(this.now());
    return now > prev ? now : iso(new Date(prev).getTime() + 1);
  }

  private async putTask(task: TaskEntry) {
    mergeTask(this.rec.tasks, task);
    this.rec.tasks = pruneTasks(this.rec.tasks, this.now());
    this.save();
    await this.sendRoom({ t: "task", task });
  }

  /** Lets someone with an invite in (after comparing the check code) or turns them down. */
  async respond(requestId: string, accept: boolean): Promise<void> {
    this.requireMember();
    const req = this.rec.requests.find((r) => r.id === requestId);
    if (!req) throw new CrewWebError("gone");
    if (!this.rec.keys.invites[req.invite]) throw new CrewWebError("expired");
    if (accept && this.rec.members.filter((x) => !x.left).length >= MAX_MEMBERS) throw new CrewWebError("full");
    this.rec.requests = this.rec.requests.filter((r) => r.id !== requestId);
    if (!accept) {
      await this.sendInvite(req.invite, { t: "join_reject", request: req.id, by: this.rec.selfId });
    } else {
      const at = iso(this.now());
      mergeMember(this.rec, { id: req.member, name: req.name, color: req.color, pub: req.pub, joinedAt: at, owner: false }, null);
      const grant = {
        roomKey: this.rec.keys.rooms[String(this.rec.epoch)]!,
        epoch: this.rec.epoch,
        name: this.rec.name,
        nameAt: this.rec.nameAt,
        createdAt: this.rec.createdAt,
        members: this.rec.members.filter((x) => !x.left).map(cardOf),
      };
      const box = await seal(await sharedKey(this.rec.keys, req.pub, `grant:${req.id}`), JSON.stringify(grant));
      await this.sendInvite(req.invite, { t: "join_accept", request: req.id, by: this.rec.selfId, byPub: this.rec.keys.pub, box });
      const item: FeedItem = { id: randomId(9), kind: "joined", from: req.member, agent: null, to: null, text: req.name, files: [], ts: at };
      this.rec.feed = mergeFeed(this.rec.feed, [item]);
      await this.sendRoom({ t: "feed", item });
    }
    this.save();
  }

  // ---------- live view of a member's session

  /** Asks a member for a live, read-only view of one of its sessions (it may have to agree first). */
  async watch(memberId: string, agentId: string): Promise<void> {
    this.requireMember();
    const member = this.rec.members.find((m) => m.id === memberId && !m.left);
    if (!member) throw new CrewWebError("gone");
    if (member.lastSeen === null || this.now() - member.lastSeen >= ONLINE_MS) throw new CrewWebError("offline");
    this.stopWatch();
    const title = member.presence?.agents.find((a) => a.id === agentId)?.title ?? "Session";
    const w: Watch = {
      view: { id: randomId(12), member: memberId, agentId, title, state: "asking", received: 0, total: null, error: null, events: [] },
      room: null,
      link: null,
      chunks: [],
      liveNext: 1,
      liveWaiting: new Map(),
      timers: {},
    };
    this.watchState = w;
    w.timers.ask = setTimeout(() => {
      if (this.watchState === w && w.view.state === "asking") this.failWatch(w, "noAnswer");
    }, ASK_TIMEOUT_MS);
    this.changed();
    await this.sendRoom({ t: "share_ask", request: w.view.id, to: memberId, agent: agentId, mode: "view", events: WATCH_EVENTS });
  }

  stopWatch() {
    const w = this.watchState;
    if (!w) return;
    this.watchState = null;
    if (w.view.state === "asking" || w.view.state === "transferring" || w.view.state === "live") void this.sendRoom({ t: "share_stop", request: w.view.id, to: w.view.member });
    this.closeWatch(w);
    this.changed();
  }

  private closeWatch(w: Watch) {
    if (w.timers.ask) clearTimeout(w.timers.ask);
    if (w.timers.stall) clearTimeout(w.timers.stall);
    if (w.timers.keep) clearInterval(w.timers.keep);
    w.timers = {};
    w.link?.stop();
    w.link = null;
  }

  /** `error`: a code the UI words (noAnswer, stalled, broken) or the member's own reason. */
  private failWatch(w: Watch, error: string, state: WatchState = "failed") {
    this.closeWatch(w);
    w.view = { ...w.view, state, error };
    this.changed();
  }

  private onShareAnswer(from: string, msg: Extract<RoomMessage, { t: "share_answer" }>) {
    const w = this.watchState;
    if (!w || w.view.id !== msg.request || w.view.member !== from || w.view.state !== "asking") return;
    if (w.timers.ask) clearTimeout(w.timers.ask);
    if (!msg.accept || !msg.room) return this.failWatch(w, msg.reason ?? "declined", "declined");
    const room = msg.room;
    w.room = room;
    w.view = { ...w.view, state: "transferring", title: msg.title ?? w.view.title };
    let queue = Promise.resolve();
    w.link = new RelayLink({
      url: this.rec.relayUrl,
      room,
      after: () => 0,
      fetch: this.o.fetch,
      onEnvelope: (e) => {
        queue = queue.then(() => this.onShareEnvelope(w, room, e)).catch(() => {});
      },
      onGap: () => {},
      onReady: () => {},
      onState: () => {},
    });
    w.link.start();
    this.stall(w);
    this.changed();
  }

  private stall(w: Watch) {
    if (w.timers.stall) clearTimeout(w.timers.stall);
    w.timers.stall = setTimeout(() => {
      if (w.view.state === "transferring") this.failWatch(w, "stalled");
    }, TRANSFER_STALL_MS);
  }

  private async onShareEnvelope(w: Watch, room: string, e: Envelope) {
    if (this.watchState !== w || e.from !== w.view.member || !e.kid.startsWith("room:")) return;
    const key = this.rec.keys.rooms[e.kid.slice(5)];
    const msg = key ? parseShare(safeJson(await open(key, e, `${room}|${e.kid}`))) : null;
    if (!msg || msg.request !== w.view.id) return;
    if (msg.t === "chunk") {
      if (w.view.state !== "transferring") return;
      if (w.chunks.length !== msg.n) w.chunks = Array.from({ length: msg.n }, (_, i) => w.chunks[i] ?? "");
      if (!w.chunks[msg.i]) w.chunks[msg.i] = msg.data;
      const received = w.chunks.filter(Boolean).length;
      w.view = { ...w.view, received, total: msg.n };
      this.stall(w);
      this.changed();
      if (received === msg.n) await this.completeWatch(w);
    } else if (msg.t === "live") {
      w.liveWaiting.set(msg.n, msg.events);
      this.drainLive(w);
    } else if (w.view.state === "transferring") {
      this.failWatch(w, msg.reason ?? "stalled");
    } else if (w.view.state === "live") {
      this.failWatch(w, msg.reason ?? "", "ended");
    }
  }

  private async completeWatch(w: Watch) {
    if (w.timers.stall) clearTimeout(w.timers.stall);
    let events: unknown[];
    try {
      const payload = JSON.parse(await gunzipBase64(w.chunks.join(""))) as { events?: unknown };
      if (!Array.isArray(payload.events)) throw new Error("no events");
      events = payload.events;
    } catch {
      return this.failWatch(w, "broken");
    }
    w.chunks = [];
    if (this.watchState !== w) return;
    w.view = { ...w.view, state: "live", events: events.slice(-WATCH_EVENTS_MAX) };
    w.timers.keep = setInterval(() => void this.sendRoom({ t: "share_keep", request: w.view.id, to: w.view.member }), KEEP_MS);
    this.drainLive(w);
    this.changed();
  }

  private drainLive(w: Watch) {
    if (w.view.state !== "live") return;
    const fresh: unknown[] = [];
    for (let batch = w.liveWaiting.get(w.liveNext); batch; batch = w.liveWaiting.get(w.liveNext)) {
      w.liveWaiting.delete(w.liveNext);
      w.liveNext++;
      fresh.push(...batch);
    }
    if (!fresh.length) return;
    w.view = { ...w.view, events: [...w.view.events, ...fresh].slice(-WATCH_EVENTS_MAX) };
    this.changed();
  }

  // ---------- sending

  private async sendRoom(msg: RoomMessage) {
    if (this.rec.membership !== "member" || !this.link) return;
    const key = this.rec.keys.rooms[String(this.rec.epoch)];
    if (!key) return;
    const kid = `room:${this.rec.epoch}`;
    this.link.post(this.rec.selfId, kid, await seal(key, JSON.stringify(msg), `${this.rec.roomId}|${kid}`));
  }

  private async sendInvite(inviteId: string, msg: InviteMessage) {
    const key = this.rec.keys.invites[inviteId];
    if (!key || !this.link) return;
    const kid = `invite:${inviteId}`;
    this.link.post(this.rec.selfId, kid, await seal(key, JSON.stringify(msg), `${this.rec.roomId}|${kid}`));
  }

  private self(): MemberEntry {
    return this.rec.members.find((m) => m.id === this.rec.selfId)!;
  }

  private async publishPresence() {
    if (this.rec.membership !== "member") return;
    const me = this.self();
    me.lastSeen = this.now();
    // A browser has no checkout and no agents; the presence only says it is there.
    await this.sendRoom({ t: "presence", presence: { at: iso(this.now()), branch: null, files: [], ahead: 0, agents: [] } });
  }

  private stateMessage(): RoomMessage {
    const now = this.now();
    return {
      t: "state",
      name: this.rec.name,
      nameAt: this.rec.nameAt,
      members: this.rec.members.filter((x) => !x.left).map(cardOf),
      removed: this.rec.removed.slice(-64),
      tasks: this.rec.tasks.slice(-500),
      feed: this.rec.feed.slice(-200),
      invites: this.rec.invites
        .filter((i) => this.rec.keys.invites[i.id] && new Date(i.expiresAt).getTime() > now)
        .slice(-32)
        .map((i) => ({ ...i, key: this.rec.keys.invites[i.id]! })),
    };
  }

  private async ready() {
    if (this.rec.membership === "member") {
      await this.sendRoom({ t: "hello", member: cardOf(this.self()) });
      await this.publishPresence();
    } else if (this.rec.membership === "pending" && this.rec.joinRequest) {
      const r = this.rec.joinRequest;
      const me = this.self();
      await this.sendInvite(r.invite, { t: "join_request", request: r.id, member: me.id, name: me.name, color: me.color, pub: this.rec.keys.pub });
    }
  }

  // ---------- receiving

  private async receive(e: Envelope) {
    if (e.seq > this.rec.lastSeq) this.rec.lastSeq = e.seq;
    this.save();
    if (e.from === this.rec.selfId) return;
    if (e.kid.startsWith("room:")) {
      const key = this.rec.keys.rooms[e.kid.slice(5)];
      if (!key) return;
      const msg = parseRoom(safeJson(await open(key, e, `${this.rec.roomId}|${e.kid}`)));
      if (!msg) return;
      if (Number(e.kid.slice(5)) < this.rec.epoch && this.rec.removed.includes(e.from)) return;
      await this.onRoom(e, msg);
    } else if (e.kid.startsWith("invite:")) {
      const id = e.kid.slice(7);
      const key = this.rec.keys.invites[id];
      if (!key) return;
      const msg = parseInviteMessage(safeJson(await open(key, e, `${this.rec.roomId}|${e.kid}`)));
      if (msg) await this.onInvite(id, e, msg);
    }
  }

  private seen(from: string, ts: number) {
    const x = this.rec.members.find((m) => m.id === from);
    if (x) x.lastSeen = Math.max(x.lastSeen ?? 0, Math.min(ts, this.now()));
  }

  private applyRemoval(memberId: string) {
    if (!this.rec.removed.includes(memberId)) this.rec.removed.push(memberId);
    const x = this.rec.members.find((y) => y.id === memberId);
    if (x) x.left = true;
    this.rec.requests = this.rec.requests.filter((r) => r.member !== memberId);
  }

  private takeInvite(inv: { id: string; key: string; expiresAt: string; by: string }) {
    if (new Date(inv.expiresAt).getTime() < this.now() || this.rec.keys.invites[inv.id]) return;
    this.rec.keys.invites[inv.id] = inv.key;
    this.rec.invites = [...this.rec.invites.filter((i) => i.id !== inv.id), { id: inv.id, expiresAt: inv.expiresAt, by: inv.by }];
  }

  private async onRoom(e: Envelope, msg: RoomMessage) {
    const rec = this.rec;
    if (rec.membership !== "member") return;
    if (rec.removed.includes(e.from) && msg.t !== "rekey") return;
    this.seen(e.from, e.ts);
    switch (msg.t) {
      case "hello":
        if (msg.member.id !== e.from) return;
        mergeMember(rec, msg.member, Math.min(e.ts, this.now()));
        if (this.timers.state) clearTimeout(this.timers.state);
        this.timers.state = setTimeout(() => {
          this.timers.state = undefined;
          void this.sendRoom(this.stateMessage()).then(() => this.publishPresence());
        }, 300 + Math.floor(Math.random() * 700));
        break;
      case "state":
        if (rec.members.find((x) => x.id === e.from)?.owner) for (const id of msg.removed) if (id !== rec.selfId) this.applyRemoval(id);
        for (const card of msg.members) if (card.id !== rec.selfId) mergeMember(rec, card, card.id === e.from ? Math.min(e.ts, this.now()) : null);
        if (msg.nameAt > rec.nameAt) {
          rec.name = msg.name;
          rec.nameAt = msg.nameAt;
        }
        for (const t of msg.tasks) mergeTask(rec.tasks, t);
        rec.feed = mergeFeed(rec.feed, msg.feed);
        for (const inv of msg.invites) this.takeInvite(inv);
        rec.tasks = pruneTasks(rec.tasks, this.now());
        break;
      case "presence": {
        const x = rec.members.find((m) => m.id === e.from);
        if (x && (!x.presence || msg.presence.at > x.presence.at)) x.presence = msg.presence;
        break;
      }
      case "task":
        mergeTask(rec.tasks, msg.task);
        rec.tasks = pruneTasks(rec.tasks, this.now());
        break;
      case "feed":
        rec.feed = mergeFeed(rec.feed, [msg.item]);
        break;
      case "rename":
        if (msg.at > rec.nameAt) {
          rec.name = msg.name;
          rec.nameAt = msg.at;
        }
        break;
      case "invite":
        this.takeInvite(msg.invite);
        break;
      case "leave": {
        if (msg.member !== e.from) break;
        const x = rec.members.find((m) => m.id === e.from);
        if (x) x.left = true;
        break;
      }
      case "rekey": {
        const from = rec.members.find((x) => x.id === e.from);
        if (!from?.owner || msg.epoch <= rec.epoch) break;
        if (msg.removed === rec.selfId) {
          rec.membership = "removed";
          this.stop();
          break;
        }
        const box = msg.keys[rec.selfId];
        const key = box ? await open(await sharedKey(rec.keys, from.pub, `rekey:${msg.epoch}`), box) : null;
        if (!key) break;
        rec.keys.rooms = { [String(rec.epoch)]: rec.keys.rooms[String(rec.epoch)]!, [String(msg.epoch)]: key };
        rec.epoch = msg.epoch;
        this.applyRemoval(msg.removed);
        break;
      }
      case "share_answer":
        if (msg.to === rec.selfId) this.onShareAnswer(e.from, msg);
        break;
      case "share_ask":
        // A browser has no sessions to show.
        if (msg.to === rec.selfId) await this.sendRoom({ t: "share_answer", request: msg.request, to: e.from, accept: false, room: null, title: null, reason: null });
        break;
      default:
        break;
    }
    this.save();
  }

  private async onInvite(inviteId: string, e: Envelope, msg: InviteMessage) {
    const rec = this.rec;
    if (msg.t === "join_request") {
      if (rec.membership !== "member" || msg.member !== e.from) return;
      const inv = rec.invites.find((i) => i.id === inviteId);
      if (!inv || new Date(inv.expiresAt).getTime() < this.now()) return;
      if (rec.removed.includes(msg.member) || rec.members.some((x) => x.id === msg.member && !x.left) || rec.requests.some((r) => r.id === msg.request)) return;
      rec.requests.push({ id: msg.request, name: msg.name, code: await fingerprint(msg.pub), at: iso(Math.min(e.ts, this.now())), pub: msg.pub, member: msg.member, invite: inviteId, color: msg.color });
    } else {
      rec.requests = rec.requests.filter((r) => r.id !== msg.request);
      if (rec.membership === "pending" && rec.joinRequest?.id === msg.request) {
        if (msg.t === "join_reject") {
          rec.membership = "rejected";
          this.save();
          this.stop();
          return;
        }
        const grant = parseGrant(safeJson(await open(await sharedKey(rec.keys, msg.byPub, `grant:${msg.request}`), msg.box)));
        if (!grant) return;
        rec.keys.rooms = { [String(grant.epoch)]: grant.roomKey };
        rec.epoch = grant.epoch;
        rec.name = grant.name;
        rec.nameAt = grant.nameAt;
        rec.createdAt = grant.createdAt;
        rec.membership = "member";
        rec.joinRequest = null;
        for (const card of grant.members) if (card.id !== rec.selfId) mergeMember(rec, card, card.id === msg.by ? Math.min(e.ts, this.now()) : null);
        this.saveNow();
        await this.sendRoom({ t: "hello", member: cardOf(this.self()) });
        await this.publishPresence();
      }
    }
    this.save();
  }

  // ---------- persistence

  private save() {
    this.changed();
    if (this.timers.save) return;
    this.timers.save = setTimeout(() => {
      this.timers.save = undefined;
      this.saveNow();
    }, 400);
  }

  private saveNow() {
    if (this.timers.save) clearTimeout(this.timers.save);
    this.timers.save = undefined;
    try {
      this.storage.set(STORE_PREFIX + this.rec.id, JSON.stringify(this.rec));
    } catch {
      // Storage full or blocked (private mode): the crew keeps working until the page closes.
    }
    this.changed();
  }
}
