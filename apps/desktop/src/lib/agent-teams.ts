import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { Code2, Compass, FlaskConical, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { modelFamily, type AgentTeam, type Project, type TeamLeadModel, type TeamMember, type TeamModelFamily, type TeamRole } from "@forge/protocol";
import { useUi } from "@/stores/ui";
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

/** The start dialog, opened from the Agents tab, the palette or the search. */
export const useTeamDialog = create<{ projectId: string | null; open: (projectId: string) => void; close: () => void }>((set) => ({
  projectId: null,
  open: (projectId) => set({ projectId }),
  close: () => set({ projectId: null }),
}));

/** Opens the Agents tab of the project with the start dialog. */
export function openTeamStart(projectId: string) {
  const ui = useUi.getState();
  if (ui.activeProjectId !== projectId || ui.view !== "workspace") ui.openProject(projectId);
  useUi.getState().setWorkspaceTab("agents");
  useTeamDialog.getState().open(projectId);
}

/** Starts a team and opens the lead's chat; null when it failed (the toast is shown). */
export async function startTeam(qc: QueryClient, projectId: string, prompt: string, leadModel: TeamLeadModel) {
  try {
    const s = await call("teams.start", { projectId, prompt, leadModel });
    qc.setQueryData(keys.session(s.id), s);
    void qc.invalidateQueries({ queryKey: keys.sessions(projectId) });
    void qc.invalidateQueries({ queryKey: ["agentTeams"] });
    useUi.getState().openProject(projectId, s.id);
    toast.success(t.workspace.teams.startedToast, t.workspace.teams.startedDetail);
    return s;
  } catch (e) {
    toast.error(t.workspace.teams.notStarted, errorMessage(e));
    return null;
  }
}

export async function stopTeam(qc: QueryClient, team: AgentTeam): Promise<boolean> {
  try {
    const r = await call("teams.stop", { sessionId: team.sessionId });
    toast.success(t.workspace.teams.stopped(r.stopped));
    void qc.invalidateQueries({ queryKey: ["agentTeams"] });
    void qc.invalidateQueries({ queryKey: keys.agentTeam(team.sessionId) });
    return true;
  } catch (e) {
    toast.error(t.workspace.teams.notStopped, errorMessage(e));
    return false;
  }
}

export function openTeam(team: Pick<AgentTeam, "projectId" | "sessionId">) {
  useUi.getState().openProject(team.projectId, team.sessionId);
}

/** A member's own history (and its composer) over the lead's chat. */
export function openMember(sessionId: string, m: TeamMember, compose = false) {
  useUi.getState().openTask({ kind: "agent", sessionId, toolUseId: m.id, title: m.title, ...(compose ? { compose: true } : {}) });
}

/** the lead is doing something right now: thinking, or waiting for members it started */
export function teamBusy(team: Pick<AgentTeam, "live" | "status" | "members">): boolean {
  return team.live && (team.status === "running" || team.status === "starting" || team.status === "waiting_approval" || team.members.some((m) => m.state === "working"));
}

export type LeadState = keyof typeof t.workspace.teams.leadState;

export function leadState(team: Pick<AgentTeam, "live" | "status" | "members">): LeadState {
  if (!team.live || team.status === "stopped" || team.status === "error" || team.status === "interrupted") return "stopped";
  if (team.status === "waiting_approval") return "approval";
  if (team.status === "running" || team.status === "starting") return "planning";
  return team.members.some((m) => m.state === "working") ? "waiting" : "idle";
}

export interface RoleMeta {
  icon: LucideIcon;
  /** readable on the dark and the light theme */
  color: string;
}

export const ROLE_META: Record<TeamRole | "other", RoleMeta> = {
  scout: { icon: Compass, color: "#0fa3b8" },
  developer: { icon: Code2, color: "#3e8cf0" },
  specialist: { icon: Sparkles, color: "#8e4ec6" },
  tester: { icon: FlaskConical, color: "#30a46c" },
  reviewer: { icon: ShieldCheck, color: "#e5734a" },
  other: { icon: Code2, color: "#8b8d98" },
};

/** Model families with their display name and a color, cheapest first. */
export const MODEL_META: Record<TeamModelFamily, { label: string; color: string; tier: number }> = {
  haiku: { label: "Haiku", color: "#0fa3b8", tier: 1 },
  sonnet: { label: "Sonnet", color: "#3e8cf0", tier: 2 },
  opus: { label: "Opus", color: "#8e4ec6", tier: 3 },
  fable: { label: "Fable", color: "#d6a10b", tier: 4 },
};

export function modelMeta(model: string | null | undefined) {
  const f = modelFamily(model);
  return f ? { family: f, ...MODEL_META[f] } : null;
}

/** "3 min", "1 h 5 min" */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
