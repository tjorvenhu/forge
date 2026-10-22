import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_TEAM_ALL, AGENT_TEAM_LEAD, type AgentTeam, type AgentTeamMember, type AgentTeamMessage, type AgentTeamTask, type Project, type ServerEvent } from "@forge/protocol";
import { tr } from "../i18n/index.js";

/**
 * Claude Code empties an inbox within a second or two of reading it; a slower look misses messages.
 * Polled on purpose: on Windows a recursive fs.watch holds the folders open, so the lock folders and
 * the team folder Claude Code deletes stay "delete pending" and its next lock attempt fails.
 */
export const TEAM_POLL_MS = 500;
/** messages kept per team (FORGE's own record; Claude Code keeps none) */
export const TEAM_MESSAGE_LIMIT = 300;
/** ended teams shown until FORGE restarts, newest first */
export const ENDED_TEAM_LIMIT = 20;
/** proper-lockfile, which Claude Code uses for inboxes, calls a lock older than this stale */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

export interface AgentTeamsDeps {
  /** Claude Code's folder (~/.claude or CLAUDE_CONFIG_DIR) */
  claudeDir: string;
  projects(): Project[];
  emit(e: ServerEvent): void;
  now?: () => number;
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

interface RawMember {
  agentId?: unknown;
  name?: unknown;
  agentType?: unknown;
  color?: unknown;
  model?: unknown;
  prompt?: unknown;
  joinedAt?: unknown;
  cwd?: unknown;
}

interface RawMessage {
  from?: unknown;
  text?: unknown;
  summary?: unknown;
  timestamp?: unknown;
  msg_id?: unknown;
}

interface TeamState {
  name: string;
  leadSessionId: string;
  cwd: string;
  createdAt: string;
  endedAt: string | null;
  members: RawMember[];
  tasks: AgentTeamTask[];
  messages: AgentTeamMessage[];
  seen: Set<string>;
  /** member -> working or idle, from the messages seen */
  state: Map<string, "working" | "idle">;
  lastResult: Map<string, string>;
  /** file -> mtime and size of the last read, so unchanged files are not parsed again */
  stamps: Map<string, string>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const iso = (v: unknown, fallback: string): string => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function stamp(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * rmdir, as proper-lockfile does: the lock is an empty folder. (rmSync would do on FORGE's Node too,
 * but Node 24.11 on Windows silently deletes nothing under a path with umlauts, e.g. C:\Users\Jürgen.)
 */
function unlock(lock: string) {
  try {
    fs.rmdirSync(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

const samePath = (a: string, b: string) => (process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The project a folder belongs to: the deepest project folder that is it or contains it. */
export function projectForCwd(projects: Project[], cwd: string): Project | null {
  const dir = path.resolve(cwd);
  let best: Project | null = null;
  for (const p of projects) {
    const root = path.resolve(p.path);
    const inside = samePath(dir, root) || (dir.length > root.length && samePath(dir.slice(0, root.length + 1), root + path.sep));
    if (inside && (!best || root.length > path.resolve(best.path).length)) best = p;
  }
  return best;
}

/** One inbox entry as FORGE shows it; protocol messages carry JSON in `text`. */
export function parseTeamMessage(raw: RawMessage, to: string, fallbackTs: string): AgentTeamMessage | null {
  const text = typeof raw.text === "string" ? raw.text : null;
  const from = str(raw.from);
  if (text === null || !from) return null;
  const id = str(raw.msg_id) ?? `${from}>${to}@${String(raw.timestamp)}:${text.slice(0, 40)}`;
  const ts = iso(raw.timestamp, fallbackTs);
  const summary = str(raw.summary);
  let kind: AgentTeamMessage["kind"] = "message";
  let shown = text;
  if (text.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const type = typeof j.type === "string" ? j.type : "";
      if (type === "idle_notification") {
        kind = "idle";
        shown = str(j.result) ?? str(j.summary) ?? "";
      } else if (type === "task_assignment") {
        kind = "task";
        shown = [`#${String(j.taskId ?? "?")} ${str(j.subject) ?? ""}`.trim(), str(j.description)].filter(Boolean).join("\n");
      } else if (type.startsWith("shutdown")) {
        kind = "shutdown";
        shown = str(j.reason) ?? str(j.content) ?? str(j.message) ?? type;
      } else if (type.startsWith("plan")) {
        kind = "plan";
        shown = str(j.plan) ?? str(j.feedback) ?? str(j.content) ?? type;
      } else if (type) {
        kind = "other";
        shown = str(j.content) ?? str(j.message) ?? type;
      }
    } catch {
      // Plain text that starts with a brace.
    }
  }
  return { id, from, to, kind, text: shown, summary, ts };
}

function parseTask(raw: unknown): Omit<AgentTeamTask, "blocked"> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.id === undefined ? null : String(r.id);
  if (!id) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const status = r.status === "in_progress" || r.status === "completed" ? r.status : "pending";
  return { id, subject: str(r.subject) ?? "", description: typeof r.description === "string" ? r.description : "", owner: str(r.owner), status, blocks: list(r.blocks), blockedBy: list(r.blockedBy) };
}

/**
 * Watches Claude Code's agent teams: the team config, the shared task list and the inboxes. Inboxes
 * are emptied once read, so FORGE keeps the messages it saw. Writing to an inbox takes the same lock
 * as Claude Code, so FORGE (and the phone) can message the lead and its teammates.
 */
export class AgentTeams {
  private readonly teams = new Map<string, TeamState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: AgentTeamsDeps) {
    this.now = d.now ?? Date.now;
  }

  private get teamsDir() {
    return path.join(this.d.claudeDir, "teams");
  }

  private get tasksDir() {
    return path.join(this.d.claudeDir, "tasks");
  }

  start() {
    this.stop();
    this.scan();
    this.timer = setInterval(() => this.scan(), TEAM_POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads what changed; announces each team that changed. Synchronous: the files are small. */
  scan(): void {
    const nowIso = new Date(this.now()).toISOString();
    const live = new Set<string>();
    for (const e of listDir(this.teamsDir)) {
      if (!e.isDirectory()) continue;
      const cfgFile = path.join(this.teamsDir, e.name, "config.json");
      const cfg = readJson(cfgFile) as Record<string, unknown> | undefined;
      if (!cfg || typeof cfg !== "object") continue;
      live.add(e.name);
      let t = this.teams.get(e.name);
      let changed = false;
      if (!t) {
        const members = Array.isArray(cfg.members) ? (cfg.members as RawMember[]) : [];
        const lead = members.find((m) => m.name === AGENT_TEAM_LEAD) ?? members[0];
        t = {
          name: e.name,
          leadSessionId: str(cfg.leadSessionId) ?? "",
          cwd: str(lead?.cwd) ?? "",
          createdAt: iso(cfg.createdAt, nowIso),
          endedAt: null,
          members: [],
          tasks: [],
          messages: [],
          seen: new Set(),
          state: new Map(),
          lastResult: new Map(),
          stamps: new Map(),
        };
        this.teams.set(e.name, t);
        changed = true;
      } else if (t.endedAt) {
        // A resumed lead brings its team back under the same name.
        t.endedAt = null;
        changed = true;
      }
      if (this.fresh(t, cfgFile)) {
        t.members = Array.isArray(cfg.members) ? (cfg.members as RawMember[]) : [];
        changed = true;
      }
      if (this.readInboxes(t, nowIso)) changed = true;
      if (this.readTasks(t)) changed = true;
      if (changed) this.announce(t);
    }
    for (const t of this.teams.values()) {
      if (live.has(t.name) || t.endedAt) continue;
      // Claude Code removed the team's folder: the lead's session ended. The tasks stay on disk.
      this.readTasks(t);
      t.endedAt = nowIso;
      for (const [name, s] of t.state) if (s === "working") t.state.set(name, "idle");
      this.announce(t);
    }
    this.trimEnded();
  }

  private fresh(t: TeamState, file: string): boolean {
    const s = stamp(file);
    if (s === null || t.stamps.get(file) === s) return false;
    t.stamps.set(file, s);
    return true;
  }

  private readInboxes(t: TeamState, nowIso: string): boolean {
    const dir = path.join(this.teamsDir, t.name, "inboxes");
    let changed = false;
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const file = path.join(dir, f.name);
      if (!this.fresh(t, file)) continue;
      const list = readJson(file);
      if (!Array.isArray(list)) continue;
      const to = f.name.slice(0, -".json".length);
      for (const raw of list as RawMessage[]) {
        const m = parseTeamMessage(raw, to, nowIso);
        if (!m || t.seen.has(m.id)) continue;
        t.seen.add(m.id);
        t.messages.push(m);
        if (m.kind === "idle") {
          t.state.set(m.from, "idle");
          if (m.text) t.lastResult.set(m.from, m.text);
        } else if (to !== AGENT_TEAM_LEAD) {
          t.state.set(to, "working");
        }
        changed = true;
      }
    }
    if (t.messages.length > TEAM_MESSAGE_LIMIT) t.messages.splice(0, t.messages.length - TEAM_MESSAGE_LIMIT);
    return changed;
  }

  private readTasks(t: TeamState): boolean {
    const dir = path.join(this.tasksDir, t.name);
    const files = listDir(dir).filter((f) => f.isFile() && /^[^.].*\.json$/.test(f.name));
    let changed = files.length !== t.tasks.length;
    for (const f of files) if (this.fresh(t, path.join(dir, f.name))) changed = true;
    if (!changed) return false;
    const tasks = files.map((f) => parseTask(readJson(path.join(dir, f.name)))).filter((x): x is Omit<AgentTeamTask, "blocked"> => !!x);
    const done = new Set(tasks.filter((x) => x.status === "completed").map((x) => x.id));
    t.tasks = tasks
      .map((x) => ({ ...x, blocked: x.status !== "completed" && x.blockedBy.some((b) => !done.has(b)) }))
      .sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
    return true;
  }

  private trimEnded() {
    const ended = [...this.teams.values()].filter((t) => t.endedAt).sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    for (const t of ended.slice(ENDED_TEAM_LIMIT)) this.teams.delete(t.name);
  }

  private announce(t: TeamState) {
    this.d.emit({ event: "teams.updated", payload: { team: t.name, projectId: this.view(t).projectId } });
  }

  private view(t: TeamState): AgentTeam {
    const project = t.cwd ? projectForCwd(this.d.projects(), t.cwd) : null;
    const working = new Set(t.tasks.filter((x) => x.status === "in_progress" && x.owner).map((x) => x.owner!));
    const members: AgentTeamMember[] = t.members
      .filter((m) => str(m.name))
      .map((m) => {
        const name = String(m.name);
        const lead = name === AGENT_TEAM_LEAD || m.agentType === AGENT_TEAM_LEAD;
        const seen = t.state.get(name);
        const state = lead ? "unknown" : t.endedAt ? (seen ? "idle" : "unknown") : working.has(name) ? "working" : (seen ?? "working");
        return {
          name,
          agentId: str(m.agentId) ?? `${name}@${t.name}`,
          lead,
          agentType: str(m.agentType),
          color: str(m.color),
          model: str(m.model),
          prompt: str(m.prompt),
          joinedAt: iso(m.joinedAt, t.createdAt),
          state,
          lastResult: t.lastResult.get(name) ?? null,
        };
      });
    return {
      name: t.name,
      leadSessionId: t.leadSessionId,
      projectId: project?.id ?? null,
      cwd: t.cwd,
      active: !t.endedAt,
      createdAt: t.createdAt,
      endedAt: t.endedAt,
      members,
      tasks: t.tasks,
      messages: t.messages,
    };
  }

  /** Running teams first, then ended ones; newest first. projectId: that project and its worktrees. */
  list(projectId?: string): AgentTeam[] {
    const all = [...this.teams.values()].map((t) => this.view(t));
    const scope = projectId ? this.scope(projectId) : null;
    return all
      .filter((t) => !scope || (t.projectId !== null && scope.has(t.projectId)))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt.localeCompare(a.createdAt));
  }

  private scope(projectId: string): Set<string> {
    const all = this.d.projects();
    const root = all.find((p) => p.id === projectId)?.parentId ?? projectId;
    return new Set([root, ...all.filter((p) => p.parentId === root).map((p) => p.id)]);
  }

  /** Asks the main window to open a terminal tab with a team lead in the project (from the phone or the palette). */
  requestStart(projectId: string, prompt?: string | null): { ok: boolean } {
    const m = tr().core.teams;
    const p = this.d.projects().find((x) => x.id === projectId);
    if (!p) throw new Error(m.projectMissing);
    if (!fs.existsSync(p.path)) throw new Error(m.folderMissing);
    this.d.emit({ event: "team.start", payload: { projectId, prompt: prompt?.trim() || null } });
    return { ok: true };
  }

  /**
   * A message from the user into a running team. "all" goes to every teammate (not the lead). Claude
   * Code tells the recipient it came from another session, not from the user at the keyboard.
   */
  async send(teamName: string, to: string, text: string): Promise<string[]> {
    const m = tr().core.teams;
    this.scan();
    const t = this.teams.get(teamName) ?? [...this.teams.values()].find((x) => x.name.endsWith(teamName) || x.leadSessionId.startsWith(teamName));
    if (!t) throw new Error(m.teamNotFound(teamName, [...this.teams.keys()].join(", ")));
    if (t.endedAt) throw new Error(m.teamEnded(t.name));
    const names = t.members.map((x) => str(x.name)).filter((x): x is string => !!x);
    const wanted = to.trim().toLowerCase();
    const lead = wanted === "lead" || wanted === AGENT_TEAM_LEAD;
    const recipients =
      wanted === AGENT_TEAM_ALL ? names.filter((n) => n !== AGENT_TEAM_LEAD) : names.filter((n) => n.toLowerCase() === wanted || (lead && n === AGENT_TEAM_LEAD));
    if (!recipients.length) throw new Error(wanted === AGENT_TEAM_ALL ? m.noTeammates : m.memberNotFound(to, names.join(", ")));
    for (const name of recipients) await this.deliver(t.name, name, text.trim());
    this.scan();
    return recipients;
  }

  private async deliver(team: string, to: string, text: string) {
    const dir = path.join(this.teamsDir, team, "inboxes");
    const file = path.join(dir, `${to}.json`);
    fs.mkdirSync(dir, { recursive: true });
    const lock = `${file}.lock`;
    await this.acquire(lock);
    try {
      const cur = readJson(file);
      const list = Array.isArray(cur) ? cur : [];
      list.push({
        from: "user",
        text,
        summary: tr().core.teams.fromForge,
        timestamp: new Date(this.now()).toISOString(),
        msgV: 1,
        msg_id: randomUUID(),
        type: "message",
        read: false,
      });
      const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, file);
    } finally {
      unlock(lock);
    }
  }

  /** proper-lockfile's lock: a folder made with mkdir; a stale one (its holder died) is taken over. */
  private async acquire(lock: string) {
    const until = this.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const age = (() => {
        try {
          return Date.now() - fs.statSync(lock).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (age > LOCK_STALE_MS) {
        unlock(lock);
        continue;
      }
      if (this.now() > until) throw new Error(tr().core.teams.inboxBusy);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
