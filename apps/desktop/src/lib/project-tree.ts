import type { ProjectWithStatus } from "@forge/protocol";

/**
 * Worktrees of parallel agents are projects of their own in the database (with `parentId`), but for
 * the user they belong to their project: lists show the projects and the agents inside them. A
 * worktree whose project is gone stands on its own, so nothing disappears.
 */
export function splitProjects(list: readonly ProjectWithStatus[]): { roots: ProjectWithStatus[]; agentsOf: Map<string, ProjectWithStatus[]> } {
  const ids = new Set(list.map((p) => p.id));
  const roots: ProjectWithStatus[] = [];
  const agentsOf = new Map<string, ProjectWithStatus[]>();
  for (const p of list) {
    if (p.parentId && ids.has(p.parentId)) {
      const agents = agentsOf.get(p.parentId) ?? [];
      agents.push(p);
      agentsOf.set(p.parentId, agents);
    } else roots.push(p);
  }
  // Newest work first inside a project.
  for (const agents of agentsOf.values()) agents.sort((a, b) => (b.lastSession?.updatedAt ?? b.createdAt).localeCompare(a.lastSession?.updatedAt ?? a.createdAt));
  return { roots, agentsOf };
}

/** Groups compare without regard to case (the sidecar keeps one spelling); "" stands for "without group". */
export function groupKey(group: string | null): string {
  return group?.toLowerCase() ?? "";
}

/** Names of the groups in use, sorted. */
export function groupNames(list: readonly ProjectWithStatus[]): string[] {
  const names = new Map<string, string>();
  for (const p of list) if (p.group && !names.has(groupKey(p.group))) names.set(groupKey(p.group), p.group);
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

export interface ProjectGroupSection {
  key: string;
  /** null: the projects without group */
  name: string | null;
  projects: ProjectWithStatus[];
}

/** Projects by group, groups sorted by name and the ones without group last; the order inside stays. */
export function groupProjects(list: readonly ProjectWithStatus[]): ProjectGroupSection[] {
  const sections = new Map<string, ProjectGroupSection>();
  for (const name of groupNames(list)) sections.set(groupKey(name), { key: groupKey(name), name, projects: [] });
  const without: ProjectGroupSection = { key: "", name: null, projects: [] };
  for (const p of list) (p.group ? sections.get(groupKey(p.group))! : without).projects.push(p);
  return [...sections.values(), ...(without.projects.length ? [without] : [])];
}

/**
 * Adds the empty groups (made with "Gruppe erstellen", not yet holding a project) to the sections, in
 * name order among the others; names already in use are left out.
 */
export function withEmptyGroups(sections: readonly ProjectGroupSection[], empty: readonly string[]): ProjectGroupSection[] {
  const named = sections.filter((s) => s.name !== null);
  const keys = new Set(named.map((s) => s.key));
  for (const name of empty) {
    if (keys.has(groupKey(name))) continue;
    keys.add(groupKey(name));
    named.push({ key: groupKey(name), name, projects: [] });
  }
  named.sort((a, b) => a.name!.localeCompare(b.name!));
  return [...named, ...sections.filter((s) => s.name === null)];
}

const BUSY = new Set(["starting", "running", "waiting_approval", "stopping"]);

/** Whether the agent's last session is at work right now (or waits for an approval). */
export function agentBusy(p: ProjectWithStatus): boolean {
  return !!p.lastSession && BUSY.has(p.lastSession.status);
}

/** Branch of an agent without the "agent/" prefix FORGE gives it. */
export function agentLabel(p: ProjectWithStatus): string {
  const branch = p.git?.branch ?? p.name;
  return branch.replace(/^agent\//, "");
}
