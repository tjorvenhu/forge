import type { QueryClient } from "@tanstack/react-query";
import type { AgentTeam, AgentTeamMessage, Project } from "@forge/protocol";
import { useUi } from "@/stores/ui";
import { useTerminals } from "@/stores/terminals";
import { toast } from "@/stores/toast";
import { call, keys, useProjects, useSettings } from "./queries";
import { errorMessage } from "./rpc";
import { t } from "@/i18n";

/**
 * Agent teams are off until switched on in the settings (they cost a lot of the subscription); a main
 * project can then switch them off for itself, its worktrees follow it.
 */
export function useTeamsAllowed(project: Pick<Project, "id" | "parentId" | "teamsEnabled"> | null) {
  const settings = useSettings();
  const projects = useProjects();
  const root = project?.parentId ? (projects.data ?? []).find((p) => p.id === project.parentId) : project;
  const global = settings.data?.agentTeams === true;
  const inProject = root?.teamsEnabled !== false;
  return { global, project: inProject, allowed: global && inProject, rootId: root?.id ?? project?.id ?? null };
}

/** Saves the project switch; false when it failed (the toast is shown). */
export async function setProjectTeams(qc: QueryClient, p: { id: string; name: string }, enabled: boolean): Promise<boolean> {
  const m = t.projects.teams;
  try {
    await call("projects.update", { projectId: p.id, teamsEnabled: enabled });
    await qc.invalidateQueries({ queryKey: keys.project(p.id) });
    void qc.invalidateQueries({ queryKey: keys.projects });
    toast.success(enabled ? m.turnedOn : m.turnedOff, p.name);
    return true;
  } catch (e) {
    toast.error(t.projects.agents.notSaved, errorMessage(e));
    return false;
  }
}

/**
 * Opens the project with a terminal tab running Claude as an agent team lead. Agent teams form only
 * in an interactive session, never in the Agent SDK behind FORGE's chat.
 */
export function startTeamTerminal(projectId: string, prompt?: string | null) {
  const ui = useUi.getState();
  if (ui.activeProjectId !== projectId) ui.openProject(projectId);
  ui.openTerminal(projectId, "claude", undefined, { team: true, prompt: prompt?.trim() || null });
}

/** Shows the newest team terminal of the project in the bottom panel; false when there is none (any more). */
export function showTeamTerminal(projectId: string): boolean {
  const tabs = (useTerminals.getState().tabs[projectId] ?? []).filter((t) => t.team);
  const tab = tabs.at(-1);
  if (!tab) return false;
  const ui = useUi.getState();
  if (ui.activeProjectId !== projectId) ui.openProject(projectId);
  useTerminals.getState().setActive(projectId, tab.key);
  ui.toggleBottomPanel(true);
  return true;
}

/** Claude Code's teammate colors; readable on the dark and the light theme. */
const COLORS: Record<string, string> = {
  red: "#e5484d",
  blue: "#3e8cf0",
  green: "#30a46c",
  yellow: "#d6a10b",
  purple: "#8e4ec6",
  orange: "#ef7d32",
  pink: "#d6409f",
  cyan: "#0fa3b8",
};
const FALLBACK = ["#3e8cf0", "#30a46c", "#8e4ec6", "#ef7d32", "#d6409f", "#0fa3b8", "#d6a10b", "#e5484d"];

/** Color of a member: the one Claude Code gave it, the accent for the lead and the user, else one from its name. */
export function memberColor(team: AgentTeam, name: string): string {
  const m = team.members.find((x) => x.name === name);
  if (m?.lead || name === "user") return "var(--color-accent)";
  const named = m?.color ? COLORS[m.color.toLowerCase()] : undefined;
  if (named) return named;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length]!;
}

/** Pairs of members that wrote to each other, with how often and when last; for the team graph. */
export function teamLinks(messages: AgentTeamMessage[]): Array<{ a: string; b: string; count: number; last: string }> {
  const links = new Map<string, { a: string; b: string; count: number; last: string }>();
  for (const m of messages) {
    if (m.to === "user" || m.from === m.to) continue;
    const [a, b] = [m.from, m.to].sort() as [string, string];
    const key = `${a}\u0000${b}`;
    const cur = links.get(key);
    if (cur) {
      cur.count++;
      if (m.ts > cur.last) cur.last = m.ts;
    } else links.set(key, { a, b, count: 1, last: m.ts });
  }
  return [...links.values()];
}

/** The task a member is working on: its task in progress, else its first open one. */
export function currentTask(team: AgentTeam, name: string) {
  return team.tasks.find((x) => x.owner === name && x.status === "in_progress") ?? team.tasks.find((x) => x.owner === name && x.status === "pending") ?? null;
}
