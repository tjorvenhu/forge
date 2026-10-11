import type { ResultOf, Session } from "@forge/protocol";
import { splitActive } from "@/stores/ui";

export type TabSession = ResultOf<"sessions.listLive">[number];

export interface TabGroup {
  projectId: string;
  projectName: string;
  tabs: TabSession[];
}

/**
 * Session tabs grouped per project. The order only changes when tabs come or go, never with a
 * status change: groups by their oldest session, sessions oldest first. The open session without a
 * running process goes last in its group, so it can disappear again without moving other tabs.
 */
export function groupTabs(live: TabSession[], open: TabSession | null = null): TabGroup[] {
  const groups = new Map<string, TabGroup>();
  const add = (s: TabSession) => {
    let g = groups.get(s.projectId);
    if (!g) groups.set(s.projectId, (g = { projectId: s.projectId, projectName: s.projectName, tabs: [] }));
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
