import {
  buildTeam,
  ForgeError,
  TEAM_EVENT_TYPES,
  TEAM_LEAD_EFFORT,
  TEAM_LEAD_MODELS,
  TEAM_ROLES,
  teamRoleModel,
  type AgentTeam,
  type Project,
  type ServerEvent,
  type Session,
  type TeamLeadModel,
  type TeamRoleModels,
} from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import type { StartParams } from "../sessions/lifecycle.js";
import { tr } from "../i18n/index.js";

/** teams shown per list, newest first */
export const TEAM_LIST_LIMIT = 20;
/** a working team changes with every tool call of a member; the UI hears of it at most this often */
const UPDATE_THROTTLE_MS = 400;

export interface AgentTeamsDeps {
  db: Db;
  sessions: {
    get(id: string): Session;
    start(params: StartParams): Promise<Session>;
    resume(id: string, prompt: string): Promise<Session>;
    stop(id: string): Promise<Session>;
    stopTask(id: string, taskId: string): Promise<unknown>;
  };
  projects(): Project[];
  emit(e: ServerEvent): void;
  /** agent teams switched on: globally (null) or for a project (its main project decides) */
  enabled(projectId: string | null): boolean;
}

/**
 * FORGE's agent teams: a team is a session whose lead staffs subagents with roles and models
 * (team-agents.ts). This service starts and steers them and builds the team view from the events.
 */
export class AgentTeams {
  private cache = new Map<string, { key: string; team: AgentTeam }>();
  /** session id → is a team; sessions never change that */
  private known = new Map<string, boolean>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly d: AgentTeamsDeps) {}

  list(projectId?: string): AgentTeam[] {
    const ids = projectId ? [projectId, ...this.d.projects().filter((p) => p.parentId === projectId).map((p) => p.id)] : null;
    return this.d.db.listTeamSessions(ids, TEAM_LIST_LIMIT).flatMap((rec) => {
      try {
        return [this.get(rec.id)];
      } catch {
        return [];
      }
    });
  }

  get(sessionId: string): AgentTeam {
    const rec = this.d.db.getSession(sessionId);
    if (!rec?.team) throw new ForgeError("NOT_FOUND", tr().core.teams.notATeam);
    const s = this.d.sessions.get(sessionId);
    // Tokens of members at work come with the session (task_progress), not as events.
    const liveTokens = new Map<string, number>();
    for (const t of [...s.subagents, ...s.background]) if (t.toolUseId && typeof t.tokens === "number") liveTokens.set(t.toolUseId, t.tokens);
    const key = `${this.d.db.lastEventSeq(sessionId)}:${s.live}:${s.status}:${s.updatedAt}:${[...liveTokens.values()].join(",")}`;
    const hit = this.cache.get(sessionId);
    if (hit?.key === key) return hit.team;
    const { members, tasks, models } = buildTeam(this.d.db.listEventsOfTypes(sessionId, TEAM_EVENT_TYPES), { live: s.live, cwd: s.cwd, roleModels: s.teamModels, liveTokens });
    const team: AgentTeam = {
      sessionId,
      projectId: s.projectId,
      title: s.title,
      leadModel: s.model,
      status: s.status,
      live: s.live,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      members,
      tasks,
      roleModels: Object.fromEntries(TEAM_ROLES.map((r) => [r, teamRoleModel(r, s.teamModels)])) as AgentTeam["roleModels"],
      models,
    };
    this.cache.set(sessionId, { key, team });
    return team;
  }

  /** roleModels: models of the roles for this team; without it the defaults from the settings */
  async start(projectId: string, prompt: string, leadModel?: TeamLeadModel, roleModels?: TeamRoleModels): Promise<Session> {
    if (!this.d.enabled(null)) throw new ForgeError("TEAMS_DISABLED", tr().core.teams.disabled);
    if (!this.d.enabled(projectId)) {
      const p = this.d.projects().find((x) => x.id === projectId);
      throw new ForgeError("TEAMS_DISABLED", tr().core.teams.disabledInProject(p?.name ?? projectId));
    }
    const teamModels = roleModels ?? this.d.db.getSettings().teamRoleModels ?? {};
    return this.d.sessions.start({ projectId, prompt, model: leadModel ?? TEAM_LEAD_MODELS[0], effort: TEAM_LEAD_EFFORT, team: true, teamModels });
  }

  /** to the lead; it passes the message on to the members concerned */
  message(sessionId: string, text: string): Promise<Session> {
    this.get(sessionId);
    return this.d.sessions.resume(sessionId, text);
  }

  /** stops every member still at work and the lead's turn; returns how many members were stopped */
  async stop(sessionId: string): Promise<{ stopped: number }> {
    this.get(sessionId);
    const s = this.d.sessions.get(sessionId);
    if (!s.live) return { stopped: 0 };
    let stopped = 0;
    for (const task of s.background) {
      // members only; commands the lead runs in the background (a dev server) are not the team
      if (!task.taskType.includes("agent")) continue;
      try {
        await this.d.sessions.stopTask(sessionId, task.taskId);
        stopped++;
      } catch {
        /* ended meanwhile */
      }
    }
    if (s.status === "running" || s.status === "waiting_approval") await this.d.sessions.stop(sessionId);
    return { stopped };
  }

  onServerEvent(e: ServerEvent) {
    if (e.event === "session.event") {
      const t = e.payload.body.type;
      if ((TEAM_EVENT_TYPES as readonly string[]).includes(t) || t === "status") this.changed(e.payload.sessionId);
    } else if (e.event === "session.updated") {
      this.changed(e.payload.id);
    }
  }

  private changed(sessionId: string) {
    let team = this.known.get(sessionId);
    if (team === undefined) {
      const rec = this.d.db.getSession(sessionId);
      if (!rec) return;
      team = rec.team === true;
      this.known.set(sessionId, team);
    }
    if (!team || this.timers.has(sessionId)) return;
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        const rec = this.d.db.getSession(sessionId);
        if (!rec) {
          this.cache.delete(sessionId);
          this.known.delete(sessionId);
          return;
        }
        this.d.emit({ event: "teams.updated", payload: { sessionId, projectId: rec.projectId } });
      }, UPDATE_THROTTLE_MS),
    );
  }

  shutdown() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
