import { z } from "zod";
import { CrewAgent, CrewFeedItem, CrewShareMode, CrewTask, CREW_INVITE_PREFIX } from "@forge/protocol";

/** What one member tells the others about itself; the newest (by `at`) wins. */
export const Presence = z.object({
  at: z.string(),
  branch: z.string().max(250).nullable(),
  files: z.array(z.string().max(1000)).max(400),
  ahead: z.number().int(),
  agents: z.array(CrewAgent).max(24),
});
export type Presence = z.infer<typeof Presence>;

export const MemberCard = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(60),
  color: z.string().max(20),
  /** X25519 public key (base64url) */
  pub: z.string().min(20).max(100),
  joinedAt: z.string(),
  owner: z.boolean(),
});
export type MemberCard = z.infer<typeof MemberCard>;

/** A task as members keep it: deleted ones stay as a tombstone, so an old copy cannot bring them back. */
export const TaskEntry = CrewTask.extend({ deleted: z.boolean().optional() });
export type TaskEntry = z.infer<typeof TaskEntry>;

export const InviteEntry = z.object({ id: z.string().max(64), key: z.string().max(100), expiresAt: z.string(), by: z.string().max(64) });
export type InviteEntry = z.infer<typeof InviteEntry>;

/** Messages in the room, sealed with the crew key. */
export const RoomMessage = z.discriminatedUnion("t", [
  /** a member came (back) online; the others answer with `state` */
  z.object({ t: z.literal("hello"), member: MemberCard }),
  /** everything a member knows, for members that missed something */
  z.object({
    t: z.literal("state"),
    name: z.string(),
    nameAt: z.string(),
    members: z.array(MemberCard).max(32),
    removed: z.array(z.string()).max(64),
    tasks: z.array(TaskEntry).max(500),
    feed: z.array(CrewFeedItem).max(200),
    invites: z.array(InviteEntry).max(32),
  }),
  z.object({ t: z.literal("presence"), presence: Presence }),
  z.object({ t: z.literal("task"), task: TaskEntry }),
  z.object({ t: z.literal("feed"), item: CrewFeedItem }),
  z.object({ t: z.literal("rename"), name: z.string().min(1).max(60), at: z.string() }),
  /** a new invite: any member can then let its holder in */
  z.object({ t: z.literal("invite"), invite: InviteEntry }),
  z.object({ t: z.literal("leave"), member: z.string() }),
  /** the owner removed a member: new crew key, sealed for each remaining member */
  z.object({ t: z.literal("rekey"), epoch: z.number().int().min(1), removed: z.string(), keys: z.record(z.string(), z.object({ iv: z.string(), tag: z.string(), data: z.string() })) }),
  /** a member asks `to` for one of its sessions (crew/share.ts) */
  z.object({ t: z.literal("share_ask"), request: z.string().max(64), to: z.string().max(64), agent: z.string().max(100), mode: CrewShareMode }),
  /** the answer; accepted: the copy follows in its own room on the relay */
  z.object({
    t: z.literal("share_answer"),
    request: z.string().max(64),
    to: z.string().max(64),
    accept: z.boolean(),
    room: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).nullable(),
    title: z.string().max(200).nullable(),
    /** why not, for the asker */
    reason: z.string().max(500).nullable(),
  }),
  /** the asker no longer watches (live view) or gave up */
  z.object({ t: z.literal("share_stop"), request: z.string().max(64), to: z.string().max(64) }),
  /** the asker still watches; without it the live view ends */
  z.object({ t: z.literal("share_keep"), request: z.string().max(64), to: z.string().max(64) }),
]);
export type RoomMessage = z.infer<typeof RoomMessage>;

/** Messages in a share's own room on the relay, sealed with the crew key. */
export const ShareMessage = z.discriminatedUnion("t", [
  /** a piece of the gzipped copy (base64) */
  z.object({ t: z.literal("chunk"), request: z.string().max(64), i: z.number().int().min(0), n: z.number().int().min(1).max(1000), data: z.string() }),
  /** new events of a session under live view, in order (`n` counts batches) */
  z.object({ t: z.literal("live"), request: z.string().max(64), n: z.number().int().min(1), events: z.array(z.unknown()).max(500) }),
  /** the sharer stopped (session gone, live view over, too large, an error) */
  z.object({ t: z.literal("end"), request: z.string().max(64), reason: z.string().max(500).nullable() }),
]);
export type ShareMessage = z.infer<typeof ShareMessage>;

/** What the crew key travels in to a newcomer. */
export const JoinGrant = z.object({
  roomKey: z.string(),
  epoch: z.number().int().min(1),
  name: z.string(),
  nameAt: z.string(),
  createdAt: z.string(),
  members: z.array(MemberCard).max(32),
});
export type JoinGrant = z.infer<typeof JoinGrant>;

/** Messages on an invite's key: only the request to join and the answer. */
export const InviteMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("join_request"), request: z.string().max(64), member: z.string().max(64), name: z.string().min(1).max(60), color: z.string().max(20), pub: z.string().min(20).max(100) }),
  /** `box`: the JoinGrant, sealed with the key of the newcomer's and the acceptor's X25519 keys */
  z.object({ t: z.literal("join_accept"), request: z.string().max(64), by: z.string().max(64), byPub: z.string().max(100), box: z.object({ iv: z.string(), tag: z.string(), data: z.string() }) }),
  z.object({ t: z.literal("join_reject"), request: z.string().max(64), by: z.string().max(64) }),
]);
export type InviteMessage = z.infer<typeof InviteMessage>;

/** What an invite code carries (base64url JSON after CREW_INVITE_PREFIX). */
export const InvitePayload = z.object({
  v: z.literal(1),
  /** relay */
  u: z.string().url().max(500),
  /** room */
  r: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  /** invite id and key */
  i: z.string().max(64),
  k: z.string().max(100),
  /** expiry, unix seconds */
  x: z.number().int(),
  /** crew, project, origin (host/owner/repo), clone URL, inviter */
  n: z.string().max(60),
  p: z.string().max(200),
  o: z.string().max(500).nullable(),
  c: z.string().max(2048).nullable(),
  f: z.string().max(60),
});
export type InvitePayload = z.infer<typeof InvitePayload>;

export function encodeInvite(p: InvitePayload): string {
  return CREW_INVITE_PREFIX + Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

export function decodeInvite(code: string): InvitePayload | null {
  const c = code.trim().replace(/\s+/g, "");
  const at = c.indexOf(CREW_INVITE_PREFIX);
  if (at < 0) return null;
  try {
    const parsed = InvitePayload.safeParse(JSON.parse(Buffer.from(c.slice(at + CREW_INVITE_PREFIX.length), "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
