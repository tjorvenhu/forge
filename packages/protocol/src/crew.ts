import { z } from "zod";

/**
 * Crew: several FORGE installations work live on the same project, each on its own computer and
 * checkout (no worktrees). They meet in a room on a relay; everything in it is end-to-end encrypted
 * with the crew's key, the relay only forwards and briefly keeps sealed messages. Every member keeps
 * its own copy of the shared state (members, what their agents do, tasks, feed).
 */

/**
 * Relay of Vanturis: part of the website (services/stats, routes under /crew). A crew can use any
 * other one that speaks the same paths (<url>/v1/rooms/<room>[/stream]).
 */
export const CREW_RELAY_URL = "https://forge.vanturis.de/crew";
/**
 * The crew in the browser (services/stats, page /crew): an invite as a link to it lets someone join
 * from a phone without FORGE. The code after # never reaches the server.
 */
export const CREW_WEB_URL = "https://forge.vanturis.de/crew";
export const crewWebLink = (code: string) => `${CREW_WEB_URL}#${code}`;
/** Pictures of members come from GitHub only: a member must not make the others load any address. */
export const CREW_AVATAR_PREFIX = "https://avatars.githubusercontent.com/";
export const isCrewAvatar = (url: unknown): url is string => typeof url === "string" && url.length <= 300 && url.startsWith(CREW_AVATAR_PREFIX);
/** Prefix of an invite code; the rest is base64url. */
export const CREW_INVITE_PREFIX = "forge-crew1.";
/** Members of one crew at most: everyone answers a newcomer with the whole state. */
export const CREW_MAX_MEMBERS = 8;
export const CREW_NAME_MAX = 60;
export const CREW_TASK_TITLE_MAX = 200;
export const CREW_TASK_DETAIL_MAX = 4000;
export const CREW_MESSAGE_MAX = 2000;
/** a member counts as online when it was heard from within this time (presence every 30 s) */
export const CREW_ONLINE_MS = 90_000;

export const CrewAgentStatus = z.enum(["working", "waiting", "idle"]);
export type CrewAgentStatus = z.infer<typeof CrewAgentStatus>;

/** A FORGE session of a member in the crew's project (or one of its agent worktrees). */
export const CrewAgent = z.object({
  /** session id on the member's computer; only an opaque key elsewhere */
  id: z.string(),
  title: z.string(),
  status: CrewAgentStatus,
  /** the request it works on (excerpt of the latest prompt) */
  task: z.string().nullable(),
  /** files it changed in its current or last turn, relative to the project */
  files: z.array(z.string()),
  /** excerpt of its last answer */
  lastResult: z.string().nullable(),
  /** branch of a parallel agent; null in the main checkout */
  branch: z.string().nullable(),
  updatedAt: z.string(),
});
export type CrewAgent = z.infer<typeof CrewAgent>;

export const CrewMember = z.object({
  id: z.string(),
  name: z.string(),
  /** hex color the member picked (or got) */
  color: z.string(),
  /** this installation */
  self: z.boolean(),
  /** created the crew; may remove members */
  owner: z.boolean(),
  /** in the browser on the website (forge.vanturis.de/crew), not a FORGE installation: no project, no agents */
  web: z.boolean().optional(),
  /** GitHub picture of the member (CREW_AVATAR_PREFIX); missing: initials */
  avatar: z.string().nullable().optional(),
  online: z.boolean(),
  lastSeen: z.string().nullable(),
  /** checked-out branch of the member's project */
  branch: z.string().nullable(),
  /** files changed and not pushed yet (working tree and own commits not on origin), relative to the project */
  files: z.array(z.string()),
  /** own commits not on origin */
  ahead: z.number().int(),
  agents: z.array(CrewAgent),
});
export type CrewMember = z.infer<typeof CrewMember>;

export const CrewTaskStatus = z.enum(["open", "in_progress", "done"]);
export type CrewTaskStatus = z.infer<typeof CrewTaskStatus>;

export const CrewTask = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  status: CrewTaskStatus,
  /** member who created it */
  createdBy: z.string(),
  /** member who should do it; null: whoever takes it */
  assignee: z.string().nullable(),
  /** who works on it or finished it: member and the title of its agent session (null: by hand) */
  owner: z.object({ member: z.string(), agent: z.string().nullable() }).nullable(),
  /** progress or result in a few words */
  note: z.string().nullable(),
  /** user: added in FORGE or on the phone; agent: added by a Claude session */
  source: z.enum(["user", "agent"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CrewTask = z.infer<typeof CrewTask>;

export const CrewFeedKind = z.enum(["message", "turn", "push", "pulled", "joined", "left", "task"]);
export type CrewFeedKind = z.infer<typeof CrewFeedKind>;

/** What happened in the crew, newest last. */
export const CrewFeedItem = z.object({
  id: z.string(),
  kind: CrewFeedKind,
  /** member it came from */
  from: z.string(),
  /** title of the agent session it came from; null: the person */
  agent: z.string().nullable(),
  /** a message to one member; null: to everyone */
  to: z.string().nullable(),
  text: z.string(),
  /** files of a finished turn or a push */
  files: z.array(z.string()),
  ts: z.string(),
});
export type CrewFeedItem = z.infer<typeof CrewFeedItem>;

/** Someone with an invite asks to join; a member lets them in or not. */
export const CrewJoinRequest = z.object({
  id: z.string(),
  name: z.string(),
  /** short fingerprint of the newcomer's key; the newcomer sees the same one */
  code: z.string(),
  at: z.string(),
});
export type CrewJoinRequest = z.infer<typeof CrewJoinRequest>;

/** member: in the crew; pending: asked to join, waiting for a member to let us in; rejected: was turned down */
export const CrewMembership = z.enum(["member", "pending", "rejected"]);
export type CrewMembership = z.infer<typeof CrewMembership>;

/** What a member does with tasks other members give it: start an agent on its own, ask first, or only list them. */
export const CrewAcceptTasks = z.enum(["auto", "ask", "off"]);
export type CrewAcceptTasks = z.infer<typeof CrewAcceptTasks>;

/**
 * Sessions of other members: view (a live, read-only copy of the chat) or takeover (a copy of the
 * chat with Claude's conversation and the member's files in a worktree here, to go on from there).
 */
export const CrewShareMode = z.enum(["view", "takeover"]);
export type CrewShareMode = z.infer<typeof CrewShareMode>;

/** What a member does when someone wants to see or take over one of its sessions. */
export const CrewShareAgents = z.enum(["ask", "auto", "off"]);
export type CrewShareAgents = z.infer<typeof CrewShareAgents>;

/** Someone wants to see or take over one of our sessions and waits for our answer. */
export const CrewShareRequest = z.object({
  id: z.string(),
  /** member asking */
  from: z.string(),
  agentId: z.string(),
  agentTitle: z.string(),
  mode: CrewShareMode,
  at: z.string(),
});
export type CrewShareRequest = z.infer<typeof CrewShareRequest>;

export const CrewShareState = z.enum(["asking", "transferring", "importing", "live", "done", "declined", "failed", "ended"]);
export type CrewShareState = z.infer<typeof CrewShareState>;

/** A session of another member we asked for, and how far it got. */
export const CrewShare = z.object({
  id: z.string(),
  /** member whose session it is */
  member: z.string(),
  agentId: z.string(),
  agentTitle: z.string(),
  mode: CrewShareMode,
  state: CrewShareState,
  /** chunks received and expected while it transfers */
  received: z.number().int(),
  total: z.number().int().nullable(),
  /** the session here, once it is imported */
  sessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  error: z.string().nullable(),
  at: z.string(),
});
export type CrewShare = z.infer<typeof CrewShare>;

/** Size limits of a share: chunks on the relay and the whole (compressed) copy. */
export const CREW_SHARE_CHUNK_CHARS = 180_000;
export const CREW_SHARE_MAX_BYTES = 40 * 1024 * 1024;

export const Crew = z.object({
  id: z.string(),
  name: z.string(),
  /** FORGE project of this installation the crew works on */
  projectId: z.string(),
  projectName: z.string(),
  relayUrl: z.string(),
  membership: CrewMembership,
  /** the fingerprint the members see with our join request (pending only) */
  joinCode: z.string().nullable(),
  connection: z.enum(["connecting", "online", "offline"]),
  /** last connection problem, for the user */
  error: z.string().nullable(),
  /** this member's id */
  selfId: z.string(),
  members: z.array(CrewMember),
  tasks: z.array(CrewTask),
  feed: z.array(CrewFeedItem),
  requests: z.array(CrewJoinRequest),
  acceptTasks: CrewAcceptTasks,
  /** pushed commits of others are taken over on their own while no session of the project works */
  autoPull: z.boolean(),
  /** others want to see or take over one of our sessions: ask each time, allow, or refuse */
  shareAgents: CrewShareAgents,
  /** waiting for our answer */
  shareRequests: z.array(CrewShareRequest),
  /** sessions of others we asked for (this run of FORGE) */
  shares: z.array(CrewShare),
  /** commits on origin the project does not have yet (after the last push of a member) */
  behind: z.number().int(),
  /** our open invite: anyone with it can ask to join until it expires or a new one is made */
  invite: z.object({ code: z.string(), expiresAt: z.string() }).nullable(),
  createdAt: z.string(),
});
export type Crew = z.infer<typeof Crew>;

/** What an invite code says before joining. */
export const CrewInviteInfo = z.object({
  crewName: z.string(),
  projectName: z.string(),
  /** host/owner/repo of the project's origin; null without remote */
  remote: z.string().nullable(),
  /** clone URL of the origin (without credentials), to clone the project when it is missing here */
  cloneUrl: z.string().nullable(),
  from: z.string(),
  relayUrl: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
  /** projects here with the same origin; the first fits best */
  projectIds: z.array(z.string()),
  /** already in this crew */
  joined: z.boolean(),
});
export type CrewInviteInfo = z.infer<typeof CrewInviteInfo>;

/** This installation's face in every crew. */
export const CrewProfile = z.object({
  name: z.string(),
  color: z.string(),
  /** null: CREW_RELAY_URL */
  relayUrl: z.string().nullable(),
});
export type CrewProfile = z.infer<typeof CrewProfile>;

/** Colors to pick from; readable on the dark and the light theme. */
export const CREW_COLORS = ["#3e8cf0", "#30a46c", "#8e4ec6", "#ef7d32", "#d6409f", "#0fa3b8", "#d6a10b", "#e5484d"] as const;
export const CrewColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
