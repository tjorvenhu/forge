import { z } from "zod";
import { SessionStatus, type EffortLevel, type SessionEvent } from "./models.js";

/**
 * Agent teams, built by FORGE: a team is a session whose lead (a strong model) plans the work, hands
 * it to subagents with fixed roles and the model that fits the role, runs independent packages in
 * parallel and reviews the result. Everything FORGE shows of a team comes from the session's events.
 */

/** Roles the lead can staff; each is a subagent type (TEAM_AGENT_PREFIX + role) of the lead's session. */
export const TEAM_ROLES = ["scout", "developer", "specialist", "tester", "reviewer"] as const;
export const TeamRole = z.enum(TEAM_ROLES);
export type TeamRole = z.infer<typeof TeamRole>;

/** subagent type of a role in Claude Code ("team-developer"); keeps clear of the user's own agents */
export const TEAM_AGENT_PREFIX = "team-";

export type TeamModelFamily = "haiku" | "sonnet" | "opus" | "fable";

export interface TeamRoleSpec {
  /** model alias Claude Code resolves to the newest of the family */
  model: TeamModelFamily;
  effort: EffortLevel | null;
  /** may not edit files */
  readOnly: boolean;
}

/**
 * Who does what on which model. The lead is the brain (plan, split, judge, integrate); the expensive
 * models only where judgment decides the outcome (hard problems, the final review), the bulk of the
 * work on Sonnet and the reading on Haiku, which costs a fraction.
 */
export const TEAM_ROLE_SPECS: Record<TeamRole, TeamRoleSpec> = {
  scout: { model: "haiku", effort: "low", readOnly: true },
  developer: { model: "sonnet", effort: null, readOnly: false },
  specialist: { model: "opus", effort: "high", readOnly: false },
  tester: { model: "sonnet", effort: "medium", readOnly: false },
  reviewer: { model: "opus", effort: "high", readOnly: true },
};

/** Models the lead can run on; the first is the default. */
export const TEAM_LEAD_MODELS = ["opus", "fable", "sonnet"] as const;
export const TeamLeadModel = z.enum(TEAM_LEAD_MODELS);
export type TeamLeadModel = z.infer<typeof TeamLeadModel>;
export const TEAM_LEAD_EFFORT: EffortLevel = "high";

/** Members of one team at work at the same time, at most (the lead is told so). */
export const TEAM_MAX_PARALLEL = 5;

/** the role of a subagent type, also for Claude Code's own agents the lead may use */
export function teamRoleOf(agentType: string | null | undefined): TeamRole | null {
  if (!agentType) return null;
  if (agentType.startsWith(TEAM_AGENT_PREFIX)) {
    const r = agentType.slice(TEAM_AGENT_PREFIX.length);
    return (TEAM_ROLES as readonly string[]).includes(r) ? (r as TeamRole) : null;
  }
  return agentType === "Explore" ? "scout" : null;
}

/** "claude-sonnet-5-5", "sonnet", "opus[1m]" → "sonnet" / "opus"; null when unknown */
export function modelFamily(model: string | null | undefined): TeamModelFamily | null {
  const m = model?.toLowerCase() ?? "";
  for (const f of ["fable", "opus", "sonnet", "haiku"] as const) if (m.includes(f)) return f;
  return null;
}

export const TeamMemberState = z.enum(["working", "done", "failed", "stopped"]);
export type TeamMemberState = z.infer<typeof TeamMemberState>;

/** A subagent the lead started: one package of work. */
export const TeamMember = z.object({
  /** the Agent call that started it; its own events carry it as parentToolUseId */
  id: z.string(),
  /** null: an agent outside the team roles (general-purpose, the user's own) */
  role: TeamRole.nullable(),
  agentType: z.string().nullable(),
  /** what the lead calls the package ("Login-Formular bauen") */
  title: z.string(),
  /** the start of the lead's instructions */
  prompt: z.string(),
  /** model alias or id; null: the lead's model */
  model: z.string().nullable(),
  background: z.boolean(),
  state: TeamMemberState,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** its latest tool call, e.g. "Edit · src/app.ts" */
  activity: z.string().nullable(),
  toolUses: z.number().int(),
  /** files it edited or wrote, relative where possible */
  files: z.array(z.string()),
  /** the start of its report to the lead */
  result: z.string().nullable(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamTask = z.object({
  id: z.string(),
  subject: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  /** the form shown while it runs ("Baut das Formular") */
  activeForm: z.string().nullable(),
});
export type TeamTask = z.infer<typeof TeamTask>;

export const AgentTeam = z.object({
  /** the lead's session */
  sessionId: z.string(),
  projectId: z.string(),
  title: z.string().nullable(),
  leadModel: z.string().nullable(),
  status: SessionStatus,
  live: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  members: z.array(TeamMember),
  /** the lead's plan (its latest todo list) */
  tasks: z.array(TeamTask),
});
export type AgentTeam = z.infer<typeof AgentTeam>;

/** event types buildTeam reads; enough to load just these from a long session */
export const TEAM_EVENT_TYPES = ["tool.use", "tool.result", "background.task"] as const;

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PROMPT_CHARS = 600;
const RESULT_CHARS = 1500;
const MAX_FILES = 30;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function rel(p: string, cwd: string | null): string {
  const norm = p.replace(/\\/g, "/");
  const base = cwd?.replace(/\\/g, "/").replace(/\/$/, "");
  return base && norm.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? norm.slice(base.length + 1) : norm;
}

function activityOf(name: string, input: Record<string, unknown>, cwd: string | null): string {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const detail = file ? rel(file, cwd) : (str(input.command) ?? str(input.pattern) ?? str(input.query) ?? str(input.url) ?? str(input.description));
  const short = name.startsWith("mcp__") ? (name.split("__").pop() ?? name) : name;
  return detail ? `${short} · ${clip(detail.split("\n")[0] ?? "", 80)}` : short;
}

interface Draft {
  member: TeamMember;
  result: { isError: boolean; text: string; ts: string } | null;
  bg: { state: "started" | "completed" | "failed" | "stopped"; summary: string | null; ts: string } | null;
}

/**
 * The team of a session from its events (tool.use, tool.result, background.task, oldest first).
 * `live`: the lead's process runs; members still at work in an ended session count as stopped.
 */
export function buildTeam(events: readonly SessionEvent[], opts: { live: boolean; cwd?: string | null }): { members: TeamMember[]; tasks: TeamTask[] } {
  const cwd = opts.cwd ?? null;
  const drafts = new Map<string, Draft>();
  let tasks: TeamTask[] = [];
  /** TaskCreate calls waiting for their result (which carries the id) */
  const created = new Map<string, TeamTask>();
  for (const ev of events) {
    const b = ev.body;
    if (b.type === "tool.use") {
      if (b.parentToolUseId) {
        const d = drafts.get(b.parentToolUseId);
        if (!d) continue;
        d.member.toolUses++;
        d.member.activity = activityOf(b.name, b.input, cwd);
        const file = FILE_TOOLS.has(b.name) ? (str(b.input.file_path) ?? str(b.input.notebook_path)) : null;
        if (file) {
          const f = rel(file, cwd);
          if (!d.member.files.includes(f) && d.member.files.length < MAX_FILES) d.member.files.push(f);
        }
        continue;
      }
      if (AGENT_TOOLS.has(b.name)) {
        const agentType = str(b.input.subagent_type);
        const role = teamRoleOf(agentType);
        const prompt = str(b.input.prompt) ?? "";
        drafts.set(b.toolUseId, {
          member: {
            id: b.toolUseId,
            role,
            agentType,
            title: str(b.input.description) ?? clip(prompt.split("\n")[0] ?? "", 60),
            prompt: clip(prompt, PROMPT_CHARS),
            model: str(b.input.model) ?? (role ? TEAM_ROLE_SPECS[role].model : null),
            background: b.input.run_in_background === true,
            state: "working",
            startedAt: ev.ts,
            endedAt: null,
            activity: null,
            toolUses: 0,
            files: [],
            result: null,
          },
          result: null,
          bg: null,
        });
      } else if (b.name === "TodoWrite" && Array.isArray(b.input.todos)) {
        tasks = (b.input.todos as unknown[])
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map((t, i) => ({
            id: String(i + 1),
            subject: str(t.content) ?? "",
            status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
            activeForm: str(t.activeForm),
          }));
      } else if (b.name === "TaskCreate") {
        const subject = str(b.input.subject) ?? str(b.input.description);
        if (subject) created.set(b.toolUseId, { id: "", subject, status: "pending", activeForm: str(b.input.activeForm) });
      } else if (b.name === "TaskUpdate") {
        const t = tasks.find((x) => x.id === String(b.input.taskId ?? ""));
        if (t) {
          const s = b.input.status;
          if (s === "deleted") tasks = tasks.filter((x) => x !== t);
          else if (s === "completed" || s === "in_progress" || s === "pending") t.status = s;
          t.subject = str(b.input.subject) ?? t.subject;
          t.activeForm = str(b.input.activeForm) ?? t.activeForm;
        }
      }
    } else if (b.type === "tool.result") {
      const d = drafts.get(b.toolUseId);
      if (d) {
        d.result = { isError: b.isError, text: b.content.text, ts: ev.ts };
        continue;
      }
      const task = created.get(b.toolUseId);
      if (task) {
        created.delete(b.toolUseId);
        if (!b.isError) tasks.push({ ...task, id: /#?(\d+)/.exec(b.content.text)?.[1] ?? String(tasks.length + 1) });
      }
    } else if (b.type === "background.task" && b.toolUseId) {
      const d = drafts.get(b.toolUseId);
      if (d) d.bg = { state: b.state, summary: b.summary, ts: ev.ts };
    }
  }

  const members = [...drafts.values()].map(({ member: m, result, bg }) => {
    // A background agent's tool result only says it was launched; its end comes as background.task.
    if (bg || m.background) {
      m.background = true;
      if (bg && bg.state !== "started") {
        m.state = bg.state === "completed" ? "done" : bg.state;
        m.endedAt = bg.ts;
        m.result = bg.summary ? clip(bg.summary, RESULT_CHARS) : null;
      }
    } else if (result) {
      m.state = result.isError ? "failed" : "done";
      m.endedAt = result.ts;
      m.result = clip(result.text, RESULT_CHARS);
    }
    if (m.state === "working" && !opts.live) m.state = "stopped";
    return m;
  });
  return { members, tasks };
}
