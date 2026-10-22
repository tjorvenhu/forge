import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { Crew, CrewMember, CrewShareMode, CrewShareRequest, ServerEventPayload } from "@forge/protocol";
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
    n.kind === "shared" && n.ref
      ? { label: t.crew.openSession, onClick: () => openSharedSession(qc, n.ref!) }
      : n.kind === "task" && n.ref
      ? { label: t.crew.startNow, onClick: () => void startCrewTask(qc, crew, n.ref!) }
      : n.kind === "push"
        ? { label: t.crew.pull, onClick: () => void pullCrew(qc, crew) }
        : n.kind === "removed" || n.kind === "rejected"
          ? undefined
          : view;
  const tone = n.kind === "rejected" || n.kind === "removed" ? "warning" : n.kind === "joined" || n.kind === "pulled" || n.kind === "shared" ? "success" : "info";
  toast.notify({ tone, title: n.title, body: n.text, action, duration: n.kind === "request" || n.kind === "task" || n.kind === "share" ? 15_000 : 6_000 });
  // What we asked for is here: it opens right away.
  if (n.kind === "shared" && n.ref) openSharedSession(qc, n.ref);
  crewChanged(qc, crew);
  if (n.kind === "request" || n.kind === "task" || n.kind === "message" || n.kind === "share") {
    if (qc.getQueryData<{ desktopNotifications?: boolean }>(keys.settings)?.desktopNotifications === false) return;
    void desktopNotify(n.title, n.text);
  }
}

// ---------- read state of the crew chat (tab and bubble)

const READ_KEY = "forge.crew.read";

function loadRead(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** Per crew: the time of the newest message the user has seen (tab or bubble open). */
export const useCrewRead = create<{ read: Record<string, string>; markRead: (crewId: string, ts: string) => void }>((set, get) => ({
  read: loadRead(),
  markRead: (crewId, ts) => {
    if ((get().read[crewId] ?? "") >= ts) return;
    const read = { ...get().read, [crewId]: ts };
    set({ read });
    try {
      localStorage.setItem(READ_KEY, JSON.stringify(read));
    } catch {
      /* private mode */
    }
  },
}));

/** Messages of others to everyone or to us that came after the user last looked. */
export function unreadMessages(crew: Crew, readTs: string | undefined): number {
  return crew.feed.filter((f) => f.kind === "message" && f.from !== crew.selfId && (!f.to || f.to === crew.selfId) && f.ts > (readTs ?? "")).length;
}

// ---------- sessions of other members

/** Asks a member for one of its sessions; the copy opens on its own once it is here. */
export async function askShare(qc: QueryClient, crew: Pick<Crew, "id" | "projectId" | "members">, memberId: string, agentId: string, mode: CrewShareMode) {
  try {
    await call("crew.shareAsk", { crewId: crew.id, memberId, agentId, mode });
    toast.info(t.crew.shareAsked(memberName(crew as Crew, memberId)), mode === "view" ? t.crew.viewSessionHint : t.crew.takeoverSessionHint);
    crewChanged(qc, crew);
  } catch (e) {
    toast.error(t.crew.notAsked, errorMessage(e));
  }
}

export async function respondShare(qc: QueryClient, crew: Pick<Crew, "id" | "projectId">, request: CrewShareRequest, name: string, accept: boolean, always = false) {
  try {
    await call("crew.shareRespond", { crewId: crew.id, requestId: request.id, accept, ...(always ? { always: true } : {}) });
    toast.success(accept ? t.crew.shareAllowed(name) : t.crew.shareDenied(name));
    crewChanged(qc, crew);
  } catch (e) {
    toast.error(t.crew.notAnswered, errorMessage(e));
  }
}

export async function stopShare(qc: QueryClient, crew: Pick<Crew, "id" | "projectId">, requestId: string) {
  try {
    await call("crew.shareStop", { crewId: crew.id, requestId });
    crewChanged(qc, crew);
  } catch (e) {
    toast.error(t.crew.notSaved, errorMessage(e));
  }
}

/** Opens a copy of another member's session. */
export function openShared(projectId: string, sessionId: string) {
  useUi.getState().openProject(projectId, sessionId);
}

/** The copy's project comes with the session (a takeover lives in a new worktree). */
function openSharedSession(qc: QueryClient, sessionId: string) {
  void call("sessions.get", { sessionId })
    .then((s) => {
      qc.setQueryData(keys.session(s.id), s);
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.sessions(s.projectId) });
      openShared(s.projectId, s.id);
    })
    .catch(() => {});
}
