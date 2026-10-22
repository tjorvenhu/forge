import { z } from "zod";
import {
  CREW_ONLINE_MS,
  CrewAcceptTasks,
  CrewShareAgents,
  CrewFeedItem,
  CrewJoinRequest,
  CrewMembership,
  type Crew,
  type CrewMember,
  type CrewShare,
  type CrewShareRequest,
  type CrewTask,
} from "@forge/protocol";
import { InviteEntry, MemberCard, Presence, TaskEntry } from "./wire.js";

/** Feed items a member keeps; older ones fall off. */
export const FEED_MAX = 200;
/** Finished tasks kept (open and running ones always stay). */
export const DONE_TASKS_MAX = 150;

export const MemberEntry = MemberCard.extend({
  left: z.boolean().default(false),
  /** ms since epoch of the last message from it */
  lastSeen: z.number().nullable().default(null),
  presence: Presence.nullable().default(null),
});
export type MemberEntry = z.infer<typeof MemberEntry>;

/** A join request as members keep it until someone answers. */
export const RequestEntry = CrewJoinRequest.extend({ pub: z.string(), member: z.string(), invite: z.string(), color: z.string() });
export type RequestEntry = z.infer<typeof RequestEntry>;

/** What this installation keeps of a crew (crew/<id>.json); the keys are in the secret store. */
export const CrewRecord = z.object({
  v: z.literal(1),
  id: z.string(),
  name: z.string(),
  nameAt: z.string(),
  projectId: z.string(),
  relayUrl: z.string(),
  roomId: z.string(),
  createdAt: z.string(),
  membership: CrewMembership,
  selfId: z.string(),
  epoch: z.number().int(),
  lastSeq: z.number().int(),
  acceptTasks: CrewAcceptTasks,
  autoPull: z.boolean(),
  /** others want to see or take over our sessions (missing in records of before 2026-10-22: ask) */
  shareAgents: CrewShareAgents.default("ask"),
  members: z.array(MemberEntry),
  removed: z.array(z.string()),
  tasks: z.array(TaskEntry),
  feed: z.array(CrewFeedItem),
  requests: z.array(RequestEntry),
  invites: z.array(InviteEntry.omit({ key: true })),
  /** our own open invite code */
  ownInvite: z.object({ id: z.string(), code: z.string(), expiresAt: z.string() }).nullable(),
  /** while pending: our request and the invite it went to */
  joinRequest: z.object({ id: z.string(), invite: z.string(), code: z.string() }).nullable(),
  /** origin/<branch> as last seen, to notice our own pushes */
  originSeen: z.object({ branch: z.string(), sha: z.string() }).nullable(),
  behind: z.number().int(),
});
export type CrewRecord = z.infer<typeof CrewRecord>;

/** Keys of a crew (one secret per crew). */
export const CrewKeys = z.object({
  pub: z.string(),
  priv: z.string(),
  /** crew key per epoch; the previous one stays for messages still on their way */
  rooms: z.record(z.string(), z.string()),
  /** invite id -> key (ours and the ones other members shared) */
  invites: z.record(z.string(), z.string()),
});
export type CrewKeys = z.infer<typeof CrewKeys>;

const later = (a: string, b: string) => a > b;

/** Takes a task if it is newer than ours; equal times decide by content, so every member ends the same. */
export function mergeTask(tasks: TaskEntry[], incoming: TaskEntry): boolean {
  const i = tasks.findIndex((t) => t.id === incoming.id);
  if (i < 0) {
    tasks.push(incoming);
    return true;
  }
  const cur = tasks[i]!;
  if (later(incoming.updatedAt, cur.updatedAt) || (incoming.updatedAt === cur.updatedAt && JSON.stringify(incoming) > JSON.stringify(cur))) {
    tasks[i] = incoming;
    return true;
  }
  return false;
}

/** Done tasks beyond DONE_TASKS_MAX and tombstones older than two weeks go. */
export function pruneTasks(tasks: TaskEntry[], now: number): TaskEntry[] {
  const cutoff = new Date(now - 14 * 24 * 3600_000).toISOString();
  const kept = tasks.filter((t) => !t.deleted || t.updatedAt > cutoff);
  const done = kept.filter((t) => t.status === "done" && !t.deleted).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const drop = new Set(done.slice(DONE_TASKS_MAX).map((t) => t.id));
  return kept.filter((t) => !drop.has(t.id));
}

export function mergeFeed(feed: CrewFeedItem[], items: CrewFeedItem[]): { feed: CrewFeedItem[]; added: CrewFeedItem[] } {
  const known = new Set(feed.map((f) => f.id));
  const added = items.filter((i) => !known.has(i.id));
  if (!added.length) return { feed, added };
  const all = [...feed, ...added].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return { feed: all.slice(-FEED_MAX), added };
}

/** Adds or updates a member from its card; a removed member stays out. */
export function mergeMember(rec: CrewRecord, card: MemberCard, seen: number | null): boolean {
  if (rec.removed.includes(card.id)) return false;
  const cur = rec.members.find((m) => m.id === card.id);
  if (!cur) {
    rec.members.push({ ...card, left: false, lastSeen: seen, presence: null });
    return true;
  }
  // The owner flag of a known member never changes: nobody can make themselves owner later.
  const changed = cur.name !== card.name || cur.color !== card.color || cur.pub !== card.pub || cur.left;
  cur.name = card.name;
  cur.color = card.color;
  cur.pub = card.pub;
  cur.left = false;
  if (seen !== null) cur.lastSeen = Math.max(cur.lastSeen ?? 0, seen);
  return changed;
}

export function cardOf(m: MemberEntry): MemberCard {
  return { id: m.id, name: m.name, color: m.color, pub: m.pub, joinedAt: m.joinedAt, owner: m.owner };
}

/** The crew as the UI and the tools see it. */
export function crewView(
  rec: CrewRecord,
  o: {
    projectName: string;
    connection: Crew["connection"];
    error: string | null;
    now: number;
    self: Pick<MemberEntry, "presence"> | null;
    shareRequests?: CrewShareRequest[];
    shares?: CrewShare[];
  },
): Crew {
  const members: CrewMember[] = rec.members
    .filter((m) => !m.left)
    .map((m) => {
      const self = m.id === rec.selfId;
      const p = self ? (o.self?.presence ?? m.presence) : m.presence;
      return {
        id: m.id,
        name: m.name,
        color: m.color,
        self,
        owner: m.owner,
        online: self ? o.connection === "online" : m.lastSeen !== null && o.now - m.lastSeen < CREW_ONLINE_MS,
        lastSeen: m.lastSeen ? new Date(m.lastSeen).toISOString() : null,
        branch: p?.branch ?? null,
        files: p?.files ?? [],
        ahead: p?.ahead ?? 0,
        agents: p?.agents ?? [],
      };
    })
    .sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
  const tasks: CrewTask[] = rec.tasks
    .filter((t) => !t.deleted)
    .map(({ deleted: _d, ...t }) => t)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return {
    id: rec.id,
    name: rec.name,
    projectId: rec.projectId,
    projectName: o.projectName,
    relayUrl: rec.relayUrl,
    membership: rec.membership,
    joinCode: rec.membership === "pending" ? (rec.joinRequest?.code ?? null) : null,
    connection: o.connection,
    error: o.error,
    selfId: rec.selfId,
    members,
    tasks,
    feed: rec.feed,
    requests: rec.requests.map(({ id, name, code, at }) => ({ id, name, code, at })),
    acceptTasks: rec.acceptTasks,
    autoPull: rec.autoPull,
    shareAgents: rec.shareAgents,
    shareRequests: o.shareRequests ?? [],
    shares: o.shares ?? [],
    behind: rec.behind,
    invite: rec.ownInvite && rec.ownInvite.expiresAt > new Date(o.now).toISOString() ? { code: rec.ownInvite.code, expiresAt: rec.ownInvite.expiresAt } : null,
    createdAt: rec.createdAt,
  };
}

/** Files two lists have in common (paths with / and without case on Windows). */
export function overlap(a: readonly string[], b: readonly string[]): string[] {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const set = new Set(b.map(norm));
  return [...new Set(a.filter((f) => set.has(norm(f))))];
}
