import type { Project, ServerEvent, SessionEventBody } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import type { Db } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { AgentFinisher } from "./agent-finish.js";

/** Tag of the main project: finished agents go back without asking. */
export const AUTO_MERGE_TAG = "auto-merge";
/** Conflict hand-backs per agent before FORGE leaves the decision to the user. */
export const MAX_CONFLICT_ROUNDS = 3;
/** Agents waiting for the project are tried again this often, besides at the end of every turn. */
export const WAITING_RETRY_MS = 30_000;

export interface AgentAutoMergeDeps {
  db: Db;
  projects: ProjectManager;
  finisher: Pick<AgentFinisher, "review" | "finish" | "isRemains" | "clearRemains">;
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  /** session that started the agent with start_agent */
  parentOf(sessionId: string): string | null;
  /** background tasks of the session still running; their results start a new turn */
  hasBackground(sessionId: string): boolean;
}

type Outcome = "merged" | "conflict" | "skipped" | "waiting";

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
  /** worktree project -> agent session: finished agents whose work the project cannot take yet */
  private readonly waiting = new Map<string, string>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: AgentAutoMergeDeps) {}

  async turnDone(sessionId: string, testsOk: boolean): Promise<void> {
    // Beside the rest: deleting a big leftover folder must not hold up this agent's own merge.
    const remains = this.clearRemains().catch(() => null);
    try {
      await this.afterTurn(sessionId, testsOk);
    } finally {
      await remains;
    }
  }

  private async afterTurn(sessionId: string, testsOk: boolean) {
    const rec = this.d.db.getSession(sessionId);
    const project = rec ? this.d.projects.all().find((p) => p.id === rec.projectId) : null;
    // Any turn that ends (its auto-commit done) may have made room for a waiting agent.
    await this.retryWaiting(sessionId);
    if (!project?.parentId || !autoMergeOn(this.d.projects, project)) return;
    if (this.d.hasBackground(sessionId)) {
      // Its background tasks start another turn when they end; until then it waits, and says so once.
      // Before, such an agent was never merged when the task was a server that keeps running.
      if (!this.waiting.has(project.id)) {
        this.report(sessionId, this.d.parentOf(sessionId), project, null, "waiting", tr().core.automation.waitingBackground);
      }
      this.waiting.set(project.id, sessionId);
      this.syncTimer();
      return;
    }
    await this.attempt(sessionId, project, testsOk);
  }

  /** Agents of this list are still waiting for the project; for the UI and tests. */
  waitingAgents(): string[] {
    return [...this.waiting.keys()];
  }

  private async attempt(sessionId: string, worktree: Project, testsOk: boolean) {
    if (this.running.has(worktree.id)) return;
    this.running.add(worktree.id);
    try {
      await this.run(sessionId, worktree, testsOk);
    } finally {
      this.running.delete(worktree.id);
    }
  }

  /** Tries the waiting agents again; `except`: the session whose own turn is handled right after. */
  async retryWaiting(except: string | null = null): Promise<void> {
    for (const [worktreeId, sessionId] of [...this.waiting]) {
      const worktree = this.d.projects.all().find((p) => p.id === worktreeId);
      // Merged or thrown away by hand meanwhile, or auto-merge switched off.
      if (!worktree || !autoMergeOn(this.d.projects, worktree)) {
        this.waiting.delete(worktreeId);
        continue;
      }
      if (sessionId === except || this.d.hasBackground(sessionId)) continue;
      await this.attempt(sessionId, worktree, true);
    }
    this.syncTimer();
  }

  /**
   * Agents whose merge went through but whose folder would not go (Windows locks, git killed half
   * way through a big node_modules): only folder, entry and branch are left, in every project. Tried
   * at startup and after every turn; a folder still locked stays for the next time.
   */
  async clearRemains(): Promise<void> {
    for (const p of this.d.projects.all()) {
      if (!p.parentId || this.running.has(p.id) || !this.d.finisher.isRemains(p)) continue;
      this.running.add(p.id);
      try {
        await this.d.finisher.clearRemains(p.id);
        this.waiting.delete(p.id);
      } catch {
        // Still held open by some program; the next round tries again.
      } finally {
        this.running.delete(p.id);
      }
    }
    this.syncTimer();
  }

  private syncTimer() {
    if (this.waiting.size && !this.retryTimer) {
      this.retryTimer = setInterval(() => void this.retryWaiting().catch(() => null), WAITING_RETRY_MS);
      this.retryTimer.unref?.();
    } else if (!this.waiting.size && this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  dispose() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  private async run(sessionId: string, worktree: Project, testsOk: boolean) {
    // Read before the merge: afterwards the agent's session and worktree are gone.
    const parentId = this.d.parentOf(sessionId);
    const sessionIds = this.d.db.listSessions(worktree.id).map((s) => s.id);
    if (this.d.finisher.isRemains(worktree)) {
      // Remains of an agent whose merge went through but whose folder would not go: there is
      // nothing left to merge, only folder, entry and the merged branch to clear away.
      await this.d.finisher.clearRemains(worktree.id).catch(() => null);
      return;
    }
    const review = await this.d.finisher.review(worktree.id);
    // A new turn started meanwhile; its end tries again.
    if (review.busy) return;
    const skip = (reason: string) => {
      this.settle(worktree.id);
      const message = tr().core.automation.notAutoMerged(reason);
      this.logSkipped(sessionId, parentId, worktree, review.branch, message);
      this.report(sessionId, parentId, worktree, review.branch, "skipped", message);
    };
    if (!testsOk) return skip(tr().core.automation.testsFailed);
    if (review.mergeBlocker) return skip(review.mergeBlocker);
    const rounds = this.conflicts.get(worktree.id) ?? 0;
    if (rounds >= MAX_CONFLICT_ROUNDS) return skip(tr().core.automation.conflictsRemain(review.targetBranch ?? "", rounds));

    let r;
    try {
      r = await this.d.finisher.finish(worktree.id, "merge");
    } catch (e) {
      return skip(e instanceof Error ? e.message : String(e));
    }
    if (r.outcome === "waiting") {
      // Said once; the retries stay quiet until it goes through.
      const told = this.waiting.has(worktree.id);
      this.waiting.set(worktree.id, sessionId);
      this.syncTimer();
      if (!told) {
        const prefix = tr().core.automation.notMergedYet("");
        const why = r.message.startsWith(prefix) ? r.message.slice(prefix.length) : r.message;
        this.report(sessionId, parentId, worktree, r.branch, "waiting", tr().core.automation.waitingMerge(why));
      }
      return;
    }
    this.settle(worktree.id);
    if (r.outcome === "conflict") {
      this.conflicts.set(worktree.id, rounds + 1);
      return this.report(sessionId, parentId, worktree, r.branch, "conflict", r.message);
    }
    this.conflicts.delete(worktree.id);
    this.report(null, parentId, worktree, r.branch, "merged", tr().core.automation.autoMerged(r.message), sessionIds);
  }

  private settle(worktreeId: string) {
    this.waiting.delete(worktreeId);
    this.syncTimer();
  }

  /** For the daily report; merged, waiting and conflict the finisher notes itself. */
  private logSkipped(sessionId: string, parentId: string | null, worktree: Project, branch: string | null, message: string) {
    try {
      this.d.db.logAgent({
        worktreeId: worktree.id,
        rootId: worktree.parentId!,
        rootName: this.d.projects.all().find((p) => p.id === worktree.parentId)?.name ?? worktree.name,
        branch,
        title: this.d.db.getSession(sessionId)?.title ?? null,
        sessionId,
        parentSessionId: parentId,
        startedAt: worktree.createdAt,
        outcome: "skipped",
        message,
        commits: [],
      });
    } catch {
      // Only the daily report misses it.
    }
  }

  /** In the agent's chat (gone after a merge), in the chat of the session that started it, and to the UI. */
  private report(sessionId: string | null, parentId: string | null, worktree: Project, branch: string | null, outcome: Outcome, message: string, sessionIds: string[] = []) {
    const action = outcome === "skipped" ? "skip" : outcome === "waiting" ? "wait" : "merge";
    const body: SessionEventBody = { type: "automation", action, ok: outcome !== "conflict", message, hash: null, files: [] };
    for (const id of new Set([sessionId, parentId])) if (id && this.d.db.getSession(id)) this.d.record(id, body);
    this.d.emit({ event: "agent.autoMerge", payload: { rootId: worktree.parentId!, worktreeId: worktree.id, branch, outcome, message, sessionIds } });
  }
}
