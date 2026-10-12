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
