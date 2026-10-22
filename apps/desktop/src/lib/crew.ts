import type { QueryClient } from "@tanstack/react-query";
import type { Crew, CrewMember, ServerEventPayload } from "@forge/protocol";
import { useUi, type CrewRequest } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { call, keys } from "./queries";
import { errorMessage } from "./rpc";
import { desktopNotify } from "./native";
import { t } from "@/i18n";

/** Initials for a member's avatar: first letters of the first two words. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

export function memberName(crew: Crew, id: string | null | undefined): string {
  return crew.members.find((m) => m.id === id)?.name ?? "?";
}

/** Members that are not this installation, online ones first. */
export function others(crew: Crew): CrewMember[] {
  return crew.members.filter((m) => !m.self).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** Refreshes the crews of the project after a change (the event follows, this is faster). */
export function crewChanged(qc: QueryClient, crew: Pick<Crew, "projectId">) {
  void qc.invalidateQueries({ queryKey: keys.crews(crew.projectId) });
  void qc.invalidateQueries({ queryKey: ["crews"] });
}

/** Opens the project with its Crew tab, optionally with a dialog open. */
export function openCrew(projectId: string, request: CrewRequest = null) {
  const ui = useUi.getState();
  if (ui.view !== "workspace" || ui.activeProjectId !== projectId) ui.openProject(projectId);
  ui.openCrew(request);
}

/** Takes over what the others pushed. */
export async function pullCrew(qc: QueryClient, crew: Pick<Crew, "id" | "projectId">) {
  try {
    const r = await call("crew.pull", { crewId: crew.id });
    toast.success(t.crew.pulled, r.output);
    crewChanged(qc, crew);
    void qc.invalidateQueries({ queryKey: keys.git(crew.projectId) });
    void qc.invalidateQueries({ queryKey: keys.project(crew.projectId) });
  } catch (e) {
    toast.error(t.crew.notPulled, errorMessage(e));
  }
}

/** A new session works on the task; its chat opens. */
export async function startCrewTask(qc: QueryClient, crew: Pick<Crew, "id" | "projectId">, taskId: string, team = false) {
  try {
    const r = await call("crew.taskStart", { crewId: crew.id, taskId, ...(team ? { team: true } : {}) });
    toast.success(team ? t.crew.startedTeam : t.crew.started);
    if (team) void qc.invalidateQueries({ queryKey: ["agentTeams"] });
    crewChanged(qc, crew);
    void qc.invalidateQueries({ queryKey: keys.sessions(crew.projectId) });
    useUi.getState().openProject(crew.projectId, r.sessionId);
  } catch (e) {
    toast.error(t.crew.notStarted, errorMessage(e));
  }
}

export async function respondCrew(qc: QueryClient, crew: Pick<Crew, "id" | "projectId">, request: { id: string; name: string }, accept: boolean) {
  try {
    await call("crew.respond", { crewId: crew.id, requestId: request.id, accept });
    toast.success(accept ? t.crew.accepted(request.name) : t.crew.declined(request.name));
    crewChanged(qc, crew);
  } catch (e) {
    toast.error(t.crew.notAnswered, errorMessage(e));
  }
}

/**
 * Something in a crew the user should see now: a toast with the matching action in the main window,
 * and a Windows notification for what needs them (requests, tasks, messages) unless switched off.
 */
export function crewNotice(qc: QueryClient, n: ServerEventPayload<"crew.notice">) {
  const crew = { id: n.crewId, projectId: n.projectId };
  const view = { label: t.crew.view, onClick: () => openCrew(n.projectId) };
  const action =
    n.kind === "task" && n.ref
      ? { label: t.crew.startNow, onClick: () => void startCrewTask(qc, crew, n.ref!) }
      : n.kind === "push"
        ? { label: t.crew.pull, onClick: () => void pullCrew(qc, crew) }
        : n.kind === "removed" || n.kind === "rejected"
          ? undefined
          : view;
  const tone = n.kind === "rejected" || n.kind === "removed" ? "warning" : n.kind === "joined" || n.kind === "pulled" ? "success" : "info";
  toast.notify({ tone, title: n.title, body: n.text, action, duration: n.kind === "request" || n.kind === "task" ? 15_000 : 6_000 });
  crewChanged(qc, crew);
  if (n.kind === "request" || n.kind === "task" || n.kind === "message") {
    if (qc.getQueryData<{ desktopNotifications?: boolean }>(keys.settings)?.desktopNotifications === false) return;
    void desktopNotify(n.title, n.text);
  }
}
