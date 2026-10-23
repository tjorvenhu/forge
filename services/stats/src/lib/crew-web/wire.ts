import type { Sealed } from "./crypto";

/**
 * What crew members say to each other, as FORGE's sidecar defines it (packages/sidecar/src/crew/wire.ts
 * and packages/protocol/src/crew.ts). The website is not part of the FORGE workspace, so the shapes live
 * here once more; the checks below only keep broken or foreign messages out, members trust each other.
 */

export const INVITE_PREFIX = "forge-crew1.";
export const ONLINE_MS = 90_000;
export const MESSAGE_MAX = 2000;
export const TASK_TITLE_MAX = 200;
export const TASK_DETAIL_MAX = 4000;
export const MAX_MEMBERS = 8;

export interface Envelope extends Sealed {
  seq: number;
  ts: number;
  from: string;
  kid: string;
}

export type AgentStatus = "working" | "waiting" | "idle";

export interface CrewAgent {
  id: string;
  title: string;
  status: AgentStatus;
  task: string | null;
  files: string[];
  lastResult: string | null;
  branch: string | null;
  updatedAt: string;
  team?: { working: number } | null;
}

export interface Presence {
  at: string;
  branch: string | null;
  files: string[];
  ahead: number;
  agents: CrewAgent[];
}

export interface MemberCard {
  id: string;
  name: string;
  color: string;
  pub: string;
  joinedAt: string;
  owner: boolean;
  /** a member in the browser (this website), not a FORGE installation */
  web?: boolean;
}

export type TaskStatus = "open" | "in_progress" | "done";

export interface TaskEntry {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  createdBy: string;
  assignee: string | null;
  owner: { member: string; agent: string | null } | null;
  note: string | null;
  source: "user" | "agent";
  createdAt: string;
  updatedAt: string;
  deleted?: boolean;
}

export type FeedKind = "message" | "turn" | "push" | "pulled" | "joined" | "left" | "task";

export interface FeedItem {
  id: string;
  kind: FeedKind;
  from: string;
  agent: string | null;
  to: string | null;
  text: string;
  files: string[];
  ts: string;
}

export interface InviteEntry {
  id: string;
  key: string;
  expiresAt: string;
  by: string;
}

export type RoomMessage =
  | { t: "hello"; member: MemberCard }
  | { t: "state"; name: string; nameAt: string; members: MemberCard[]; removed: string[]; tasks: TaskEntry[]; feed: FeedItem[]; invites: InviteEntry[] }
  | { t: "presence"; presence: Presence }
  | { t: "task"; task: TaskEntry }
  | { t: "feed"; item: FeedItem }
  | { t: "rename"; name: string; at: string }
  | { t: "invite"; invite: InviteEntry }
  | { t: "leave"; member: string }
  | { t: "rekey"; epoch: number; removed: string; keys: Record<string, Sealed> }
  /** `events`: only the newest this many (a phone does not need the whole session); older FORGE versions send all */
  | { t: "share_ask"; request: string; to: string; agent: string; mode: "view" | "takeover"; events?: number }
  | { t: "share_answer"; request: string; to: string; accept: boolean; room: string | null; title: string | null; reason: string | null }
  | { t: "share_stop"; request: string; to: string }
  | { t: "share_keep"; request: string; to: string };

export type ShareMessage =
  | { t: "chunk"; request: string; i: number; n: number; data: string }
  | { t: "live"; request: string; n: number; events: unknown[] }
  | { t: "end"; request: string; reason: string | null };

export interface JoinGrant {
  roomKey: string;
  epoch: number;
  name: string;
  nameAt: string;
  createdAt: string;
  members: MemberCard[];
}

export type InviteMessage =
  | { t: "join_request"; request: string; member: string; name: string; color: string; pub: string }
  | { t: "join_accept"; request: string; by: string; byPub: string; box: Sealed }
  | { t: "join_reject"; request: string; by: string };

export interface InvitePayload {
  v: 1;
  /** relay */
  u: string;
  r: string;
  i: string;
  k: string;
  /** expiry, unix seconds */
  x: number;
  n: string;
  p: string;
  o: string | null;
  c: string | null;
  f: string;
}

// ---------- checks

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 100_000): v is string => typeof v === "string" && v.length <= max;
const strOrNull = (v: unknown, max = 100_000) => v === null || str(v, max);
const strs = (v: unknown, max = 1000): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string");
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;

export const isSealed = (v: unknown): v is Sealed => isObj(v) && str(v.iv) && str(v.tag) && str(v.data);

export function isCard(v: unknown): v is MemberCard {
  return isObj(v) && str(v.id, 64) && !!v.id && str(v.name, 60) && !!v.name && str(v.color, 20) && str(v.pub, 100) && str(v.joinedAt) && typeof v.owner === "boolean" && (v.web === undefined || typeof v.web === "boolean");
}

function isAgent(v: unknown): v is CrewAgent {
  return (
    isObj(v) && str(v.id) && str(v.title) && (v.status === "working" || v.status === "waiting" || v.status === "idle") && strOrNull(v.task) && strs(v.files) &&
    strOrNull(v.lastResult) && strOrNull(v.branch) && str(v.updatedAt) && (v.team === undefined || v.team === null || (isObj(v.team) && int(v.team.working)))
  );
}

function isPresence(v: unknown): v is Presence {
  return isObj(v) && str(v.at) && strOrNull(v.branch, 250) && strs(v.files, 400) && int(v.ahead) && Array.isArray(v.agents) && v.agents.length <= 24 && v.agents.every(isAgent);
}

export function isTask(v: unknown): v is TaskEntry {
  return (
    isObj(v) && str(v.id) && str(v.title) && str(v.detail) && (v.status === "open" || v.status === "in_progress" || v.status === "done") && str(v.createdBy) &&
    strOrNull(v.assignee) && (v.owner === null || (isObj(v.owner) && str(v.owner.member) && strOrNull(v.owner.agent))) && strOrNull(v.note) &&
    (v.source === "user" || v.source === "agent") && str(v.createdAt) && str(v.updatedAt) && (v.deleted === undefined || typeof v.deleted === "boolean")
  );
}

const FEED_KINDS = new Set(["message", "turn", "push", "pulled", "joined", "left", "task"]);

export function isFeed(v: unknown): v is FeedItem {
  return isObj(v) && str(v.id) && FEED_KINDS.has(v.kind as string) && str(v.from) && strOrNull(v.agent) && strOrNull(v.to) && str(v.text) && strs(v.files) && str(v.ts);
}

const isInvite = (v: unknown): v is InviteEntry => isObj(v) && str(v.id, 64) && str(v.key, 100) && str(v.expiresAt) && str(v.by, 64);

/** A room message we understand, or null. */
export function parseRoom(v: unknown): RoomMessage | null {
  if (!isObj(v)) return null;
  switch (v.t) {
    case "hello":
      return isCard(v.member) ? (v as RoomMessage) : null;
    case "state":
      return str(v.name) && str(v.nameAt) && Array.isArray(v.members) && v.members.every(isCard) && strs(v.removed) && Array.isArray(v.tasks) && v.tasks.every(isTask) &&
        Array.isArray(v.feed) && v.feed.every(isFeed) && Array.isArray(v.invites) && v.invites.every(isInvite)
        ? (v as RoomMessage)
        : null;
    case "presence":
      return isPresence(v.presence) ? (v as RoomMessage) : null;
    case "task":
      return isTask(v.task) ? (v as RoomMessage) : null;
    case "feed":
      return isFeed(v.item) ? (v as RoomMessage) : null;
    case "rename":
      return str(v.name, 60) && !!v.name && str(v.at) ? (v as RoomMessage) : null;
    case "invite":
      return isInvite(v.invite) ? (v as RoomMessage) : null;
    case "leave":
      return str(v.member) ? (v as RoomMessage) : null;
    case "rekey":
      return int(v.epoch) && v.epoch >= 1 && str(v.removed) && isObj(v.keys) && Object.values(v.keys).every(isSealed) ? (v as RoomMessage) : null;
    case "share_ask":
      return str(v.request, 64) && str(v.to, 64) && str(v.agent, 100) && (v.mode === "view" || v.mode === "takeover") ? (v as RoomMessage) : null;
    case "share_answer":
      return str(v.request, 64) && str(v.to, 64) && typeof v.accept === "boolean" && (v.room === null || (str(v.room) && ROOM_ID.test(v.room))) && strOrNull(v.title) && strOrNull(v.reason)
        ? (v as RoomMessage)
        : null;
    case "share_stop":
    case "share_keep":
      return str(v.request, 64) && str(v.to, 64) ? (v as RoomMessage) : null;
    default:
      return null;
  }
}

export function parseInviteMessage(v: unknown): InviteMessage | null {
  if (!isObj(v)) return null;
  if (v.t === "join_request") return str(v.request, 64) && str(v.member, 64) && str(v.name, 60) && !!v.name && str(v.color, 20) && str(v.pub, 100) && v.pub.length >= 20 ? (v as InviteMessage) : null;
  if (v.t === "join_accept") return str(v.request, 64) && str(v.by, 64) && str(v.byPub, 100) && isSealed(v.box) ? (v as InviteMessage) : null;
  if (v.t === "join_reject") return str(v.request, 64) && str(v.by, 64) ? (v as InviteMessage) : null;
  return null;
}

export function parseGrant(v: unknown): JoinGrant | null {
  return isObj(v) && str(v.roomKey) && int(v.epoch) && v.epoch >= 1 && str(v.name) && str(v.nameAt) && str(v.createdAt) && Array.isArray(v.members) && v.members.every(isCard)
    ? (v as unknown as JoinGrant)
    : null;
}

export function parseShare(v: unknown): ShareMessage | null {
  if (!isObj(v) || !str(v.request, 64)) return null;
  // A chunk holds up to CREW_SHARE_CHUNK_CHARS (180,000) characters of the gzipped copy.
  if (v.t === "chunk") return int(v.i) && int(v.n) && v.n >= 1 && v.i >= 0 && v.i < v.n && str(v.data, 200_000) ? (v as ShareMessage) : null;
  if (v.t === "live") return int(v.n) && v.n >= 1 && Array.isArray(v.events) ? (v as ShareMessage) : null;
  if (v.t === "end") return strOrNull(v.reason) ? (v as ShareMessage) : null;
  return null;
}

export function safeJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The invite in a code or a link to this page (…/crew#forge-crew1.…); null when it is none. */
export function decodeInvite(code: string): InvitePayload | null {
  const c = code.trim().replace(/\s+/g, "");
  const at = c.indexOf(INVITE_PREFIX);
  if (at < 0) return null;
  try {
    const raw = c.slice(at + INVITE_PREFIX.length).replace(/[^A-Za-z0-9_-].*$/, "");
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as Obj;
    const ok =
      p.v === 1 && str(p.u, 500) && /^https?:\/\//.test(p.u) && str(p.r) && ROOM_ID.test(p.r) && str(p.i, 64) && str(p.k, 100) && int(p.x) && str(p.n, 60) && str(p.p, 200) &&
      strOrNull(p.o, 500) && strOrNull(p.c, 2048) && str(p.f, 60);
    return ok ? (p as unknown as InvitePayload) : null;
  } catch {
    return null;
  }
}
