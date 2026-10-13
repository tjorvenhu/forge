import { existsSync } from "node:fs";
import path from "node:path";
import type { Project, ServerEvent, SessionEventBody } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { AgentFinisher } from "./agent-finish.js";

/** Tag of the main project: finished agents go back without asking. */
export const AUTO_MERGE_TAG = "auto-merge";
/** Conflict hand-backs per agent before FORGE leaves the decision to the user. */
export const MAX_CONFLICT_ROUNDS = 3;

export interface AgentAutoMergeDeps {
  db: Db;
  projects: ProjectManager;
  finisher: Pick<AgentFinisher, "review" | "finish">;
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  /** session that started the agent with start_agent */
  parentOf(sessionId: string): string | null;
  /** background tasks of the session still running; their results start a new turn */
  hasBackground(sessionId: string): boolean;
}

type Outcome = "merged" | "conflict" | "skipped";

/** Whether finished agents of this project are merged automatically. The main project decides: worktrees only copied its tags when they started. */
export function autoMergeOn(projects: ProjectManager, project: Project): boolean {
  const root = project.parentId ? projects.all().find((p) => p.id === project.parentId) : project;
  return !!root?.tags.includes(AUTO_MERGE_TAG);
}

/**
 * The end of a successful agent turn in a project with auto-merge: the same merge as the dialog
 * (rebase, fast-forward, worktree and branch gone). Whatever stops it goes to the user as the dialog.
 */
export class AgentAutoMerge {
  /** worktree project -> conflicts handed back to its agent so far */
  private readonly conflicts = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(private readonly d: AgentAutoMergeDeps) {}

  async turnDone(sessionId: string, testsOk: boolean): Promise<void> {
    const rec = this.d.db.getSession(sessionId);
    const worktree = rec ? this.d.projects.all().find((p) => p.id === rec.projectId) : null;
    if (!worktree?.parentId || !autoMergeOn(this.d.projects, worktree)) return;
    if (this.running.has(worktree.id) || this.d.hasBackground(sessionId)) return;
    this.running.add(worktree.id);
    try {
      await this.run(sessionId, worktree, testsOk);
    } finally {
      this.running.delete(worktree.id);
    }
  }

  private async run(sessionId: string, worktree: Project, testsOk: boolean) {
    // Read before the merge: afterwards the agent's session and worktree are gone.
    const parentId = this.d.parentOf(sessionId);
    if (!existsSync(path.join(worktree.path, ".git"))) {
      // Remains of an agent whose merge went through but whose folder would not go (git already
      // forgot it): there is nothing left to merge, only the folder and the entry to clear away.
      await this.d.finisher.finish(worktree.id, "discard").catch(() => null);
      return;
    }
    const review = await this.d.finisher.review(worktree.id);
    // A new turn started meanwhile; its end tries again.
    if (review.busy) return;
    const skip = (reason: string) => this.report(sessionId, parentId, worktree, review.branch, "skipped", `Nicht automatisch zusammengeführt: ${reason}`);
    if (!testsOk) return skip("Die Tests sind fehlgeschlagen.");
    if (review.mergeBlocker) return skip(review.mergeBlocker);
    const rounds = this.conflicts.get(worktree.id) ?? 0;
    if (rounds >= MAX_CONFLICT_ROUNDS) return skip(`Die Konflikte mit ${review.targetBranch} sind nach ${rounds} Versuchen noch da.`);

    let r;
    try {
      r = await this.d.finisher.finish(worktree.id, "merge");
    } catch (e) {
      return skip(e instanceof Error ? e.message : String(e));
    }
    if (r.outcome === "conflict") {
      this.conflicts.set(worktree.id, rounds + 1);
      return this.report(sessionId, parentId, worktree, r.branch, "conflict", r.message);
    }
    this.conflicts.delete(worktree.id);
    this.report(null, parentId, worktree, r.branch, "merged", `Automatisch zusammengeführt: ${r.message}`);
  }

  /** In the agent's chat (gone after a merge), in the chat of the session that started it, and to the UI. */
  private report(sessionId: string | null, parentId: string | null, worktree: Project, branch: string | null, outcome: Outcome, message: string) {
    const body: SessionEventBody = { type: "automation", action: outcome === "skipped" ? "skip" : "merge", ok: outcome !== "conflict", message, hash: null, files: [] };
    for (const id of new Set([sessionId, parentId])) if (id && this.d.db.getSession(id)) this.d.record(id, body);
    this.d.emit({ event: "agent.autoMerge", payload: { rootId: worktree.parentId!, worktreeId: worktree.id, branch, outcome, message } });
  }
}
