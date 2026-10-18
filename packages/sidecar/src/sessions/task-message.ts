import type { BackgroundTask, SessionEvent, SubagentProgress, TaskMessageRef } from "@forge/protocol";
import { tr } from "../i18n/index.js";

/** Events that tell which background tasks a session had; read when a message goes to one. */
export const TASK_EVENT_TYPES = ["tool.use", "tool.result", "background.task"] as const;

/** A task a message is written to, with what Claude needs to know about it. */
export interface TaskTarget {
  ref: TaskMessageRef;
  running: boolean;
  /** the command of a background shell task */
  command: string | null;
}

export interface TaskQuery {
  taskId?: string;
  toolUseId?: string;
}

/** The agentId in the answer to an Agent call; SendMessage addresses the subagent with it. */
const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9_-]+)/;
/** Task id in the answer to a command started in the background ("... with ID: b2kzcbhw6"). */
const BACKGROUND_ID_RE = /in background with ID:\s*([A-Za-z0-9_-]+)/;
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const MAX_COMMAND = 500;

/**
 * Finds a task of the session by its id or the call that started it: running ones from the live
 * process, ended ones from the stored events.
 */
export function findTask(events: readonly SessionEvent[], live: { background: ReadonlyMap<string, BackgroundTask>; subagents: ReadonlyMap<string, SubagentProgress> } | null, q: TaskQuery): TaskTarget | null {
  const matches = (t: { taskId: string; toolUseId: string | null }) => (!!q.taskId && t.taskId === q.taskId) || (!!q.toolUseId && t.toolUseId === q.toolUseId);
  const bg = live ? [...live.background.values()].find(matches) : undefined;
  const sub = !bg && live ? [...live.subagents.values()].find(matches) : undefined;

  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** toolUseId -> task id named in the call's answer */
  const answered = new Map<string, string>();
  /** task id -> the first background.task event with a description and the call that started it */
  const known = new Map<string, { description: string; toolUseId: string | null }>();
  for (const e of events) {
    const b = e.body;
    if (b.type === "tool.use") uses.set(b.toolUseId, { name: b.name, input: b.input });
    else if (b.type === "tool.result" && !b.isError) {
      const name = uses.get(b.toolUseId)?.name;
      const id = (name && AGENT_TOOLS.has(name) ? AGENT_ID_RE : BACKGROUND_ID_RE).exec(b.content.text)?.[1];
      if (id) answered.set(b.toolUseId, id);
    } else if (b.type === "background.task") {
      const prev = known.get(b.taskId);
      if (!prev) known.set(b.taskId, { description: b.description, toolUseId: b.toolUseId ?? null });
      else if (!prev.toolUseId && b.toolUseId) prev.toolUseId = b.toolUseId;
    }
  }

  const liveTask = bg ?? sub;
  let taskId = q.taskId ?? liveTask?.taskId ?? (q.toolUseId ? answered.get(q.toolUseId) : undefined);
  if (!taskId && q.toolUseId) taskId = [...known].find(([, k]) => k.toolUseId === q.toolUseId)?.[0];
  if (!taskId) return null;
  let toolUseId = liveTask?.toolUseId ?? known.get(taskId)?.toolUseId ?? q.toolUseId ?? null;
  if (!toolUseId) toolUseId = [...answered].find(([, id]) => id === taskId)?.[0] ?? null;
  // A known task id that nothing in the session mentions is not a task of it.
  if (!liveTask && !known.has(taskId) && !(toolUseId && answered.get(toolUseId) === taskId)) return null;

  const use = toolUseId ? uses.get(toolUseId) : undefined;
  const isAgent = sub !== undefined || bg?.taskType === "local_agent" || (!!use && AGENT_TOOLS.has(use.name));
  const inputDescription = typeof use?.input.description === "string" && use.input.description ? use.input.description : null;
  const description = liveTask?.description ?? known.get(taskId)?.description ?? inputDescription ?? (isAgent ? tr().core.sessions.subagent : tr().core.sessions.backgroundTask);
  const command = !isAgent && typeof use?.input.command === "string" ? use.input.command : null;
  return { ref: { taskId, toolUseId, kind: isAgent ? "agent" : "shell", description }, running: !!liveTask, command };
}

/**
 * What Claude reads before the user's text. Claude Code cannot hand a message to a task itself
 * (`send_task_message` is not supported); a subagent gets it through SendMessage, a command reads
 * no input at all, so Claude acts on it.
 */
export function taskNote(t: TaskTarget): string {
  const { taskId, description } = t.ref;
  if (t.ref.kind === "agent") {
    return tr().core.sessions.agentNote(description, taskId, t.running);
  }
  const command = t.command ? tr().core.sessions.taskCommand(t.command.length > MAX_COMMAND ? `${t.command.slice(0, MAX_COMMAND)} …` : t.command) : "";
  return tr().core.sessions.shellNote(description, taskId, command, t.running);
}
