import type { ResultOf, Session } from "@forge/protocol";
import { splitActive } from "@/stores/ui";

export type TabSession = ResultOf<"sessions.listLive">[number];

export interface TabGroup {
  projectId: string;
  projectName: string;
  tabs: TabSession[];
}

export type TabProject = { id: string; name: string; parentId?: string | null };

/** The project a project's sessions are listed under: an agent's worktree belongs to its main project. */
export function groupOf(projectId: string, projects: readonly TabProject[] | undefined): TabProject | null {
  const p = projects?.find((x) => x.id === projectId);
  const root = p?.parentId ? projects?.find((x) => x.id === p.parentId) : null;
  return root ?? p ?? null;
}

/**
 * Session tabs grouped per project. The order only changes when tabs come or go, never with a
 * status change: groups by their oldest session, sessions oldest first. The open session without a
 * running process goes last in its group, so it can disappear again without moving other tabs.
 * Sessions of an agent's worktree go into the group of its main project (`projects` tells which).
 */
export function groupTabs(live: TabSession[], open: TabSession | null = null, projects?: readonly TabProject[]): TabGroup[] {
  const groups = new Map<string, TabGroup>();
  const add = (s: TabSession) => {
    const root = groupOf(s.projectId, projects);
    const id = root?.id ?? s.projectId;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { projectId: id, projectName: root?.name ?? s.projectName, tabs: [] }));
    g.tabs.push(s);
  };
  [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach(add);
  if (open && !live.some((s) => s.id === open.id)) add(open);
  return [...groups.values()];
}

export function flatTabs(groups: TabGroup[]): TabSession[] {
  return groups.flatMap((g) => g.tabs);
}

/** The FORGE session shown in the workspace chat. Outside the workspace no session is open. */
export function openSessionId(ui: { view: string; activeProjectId: string | null; activeSession: Record<string, string | null> }): string | null {
  if (ui.view !== "workspace" || !ui.activeProjectId) return null;
  return splitActive(ui.activeSession[ui.activeProjectId]).sessionId;
}

/** The open session as a tab, also without a running process. Needs its project for the group label. */
export function openSessionTab(session: Session | null | undefined, projects: { id: string; name: string }[] | undefined): TabSession | null {
  const project = session && projects?.find((p) => p.id === session.projectId);
  return session && project ? { ...session, projectName: project.name } : null;
}
