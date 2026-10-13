import { existsSync } from "node:fs";
import { ForgeError, type AgentFinishResult, type AgentReview, type Project } from "@forge/protocol";
import type { GitEngine } from "../git/git.js";
import type { Db, SessionRecord } from "../persistence/db.js";
import { lastAnswer } from "../phone/session-info.js";
import { removeWorktree, type RemovalDeps } from "../projects/removal.js";
import { pathKey } from "../util/paths.js";

const BUSY = new Set(["starting", "running", "waiting_approval", "stopping"]);
const MAX_COMMITS = 20;

export interface AgentFinishDeps extends Pick<RemovalDeps, "projects" | "sessions" | "worktrees" | "devServers"> {
  db: Db;
  git: GitEngine;
  notifyProject(projectId: string): void;
}

interface Located {
  worktree: Project;
  root: Project | null;
  branch: string | null;
  /** working tree the work goes back to */
  dir: string | null;
  targetBranch: string | null;
  /** branch the agent started from, if FORGE recorded it */
  originBranch: string | null;
  session: SessionRecord | null;
}

/**
 * The end of a parallel agent: its branch goes into the branch it started from (rebase onto it, then
 * fast-forward, so the history stays linear) or is thrown away. Either way worktree, session and
 * branch are gone afterwards, so finished agents do not pile up.
 */
export class AgentFinisher {
  constructor(private readonly d: AgentFinishDeps) {}

  private async locate(projectId: string): Promise<Located> {
    const worktree = this.d.projects.get(projectId);
    if (!worktree.parentId) throw new ForgeError("VALIDATION", "Das ist kein Agent-Worktree.");
    const root = this.d.projects.all().find((p) => p.id === worktree.parentId) ?? null;
    const branch = existsSync(worktree.path) ? await this.d.worktrees.branchOf(worktree.path) : null;
    const origin = branch ? await this.d.worktrees.origin(worktree, branch) : { dir: null, branch: null };
    // The starting worktree may be gone by now; then the work goes to the main project.
    const recorded = origin.dir && existsSync(origin.dir) && pathKey(origin.dir) !== pathKey(worktree.path) ? origin.dir : null;
    const dir = recorded ?? (root?.exists ? root.path : null);
    const targetBranch = dir ? await this.d.git.currentBranch(dir).catch(() => null) : null;
    const session = this.d.db.listSessions(worktree.id)[0] ?? null;
    return { worktree, root, branch, dir, targetBranch, originBranch: origin.branch, session };
  }

  private async count(cwd: string, range: string): Promise<number> {
    const r = await this.d.git.exec(cwd, ["rev-list", "--count", range]);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  async review(projectId: string): Promise<AgentReview> {
    const l = await this.locate(projectId);
    const { worktree, branch, targetBranch } = l;
    const busy = BUSY.has(l.session?.status ?? "");
    let commits: AgentReview["commits"] = [];
    let ahead = 0;
    let behind = 0;
    let filesChanged = 0;
    let uncommitted = 0;
    if (branch && targetBranch && existsSync(worktree.path)) {
      const target = `refs/heads/${targetBranch}`;
      const own = `refs/heads/${branch}`;
      const log = await this.d.git.exec(worktree.path, ["log", `-${MAX_COMMITS}`, "--format=%h%x09%s", `${target}..${own}`]);
      commits = log.stdout
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
        });
      ahead = await this.count(worktree.path, `${target}..${own}`);
      behind = await this.count(worktree.path, `${own}..${target}`);
      const diff = await this.d.git.exec(worktree.path, ["diff", "--name-only", `${target}...${own}`]);
      filesChanged = diff.stdout.split("\n").filter((f) => f.trim()).length;
      uncommitted = (await this.d.git.status(worktree.path)).files.length;
    }
    return {
      projectId: worktree.id,
      rootId: l.root?.id ?? worktree.parentId!,
      rootName: l.root?.name ?? worktree.name,
      branch,
      targetBranch,
      targetPath: l.dir ?? "",
      sessionId: l.session?.id ?? null,
      sessionTitle: l.session?.title ?? null,
      sessionStatus: l.session?.status ?? null,
      summary: l.session ? lastAnswer(this.d.db, l.session.id) : "",
      busy,
      commits,
      ahead,
      behind,
      filesChanged,
      uncommitted,
      mergeBlocker: this.blocker(l, busy, ahead + uncommitted),
    };
  }

  private blocker(l: Located, busy: boolean, work: number): string | null {
    if (!existsSync(l.worktree.path)) return "Der Ordner des Agenten fehlt.";
    if (!l.dir) return "Das Projekt, in das die Arbeit zurückgehen soll, ist nicht mehr da.";
    if (!l.branch) return "Im Worktree des Agenten ist kein Branch ausgecheckt.";
    if (!l.targetBranch) return "Im Projekt ist kein Branch ausgecheckt.";
    if (busy) return "Der Agent arbeitet noch.";
    if (l.originBranch && l.targetBranch !== l.originBranch) {
      return `Der Agent ist von ${l.originBranch} abgezweigt, im Projekt ist jetzt ${l.targetBranch} ausgecheckt. Wechsle dort zurück auf ${l.originBranch}.`;
    }
    if (!work) return "Der Agent hat nichts geändert.";
    return null;
  }

  async finish(projectId: string, action: "merge" | "discard"): Promise<AgentFinishResult> {
    return action === "merge" ? this.merge(projectId) : this.discard(projectId);
  }

  private async discard(projectId: string): Promise<AgentFinishResult> {
    const l = await this.locate(projectId);
    // No branch to find (folder half gone, branch already deleted): only session, folder and entry go.
    const r = await removeWorktree(projectId, true, this.d, { deleteBranch: !!l.branch });
    this.changed(l);
    return {
      action: "discard",
      outcome: "discarded",
      branch: l.branch,
      targetBranch: l.targetBranch,
      commits: 0,
      files: [],
      sessionId: null,
      branchError: r.branchError,
      message: r.branchError ? `Agent verworfen, aber der Branch blieb: ${r.branchError}` : `Agent verworfen${l.branch ? `, Branch ${l.branch} gelöscht` : ""}.`,
    };
  }

  private async merge(projectId: string): Promise<AgentFinishResult> {
    const review = await this.review(projectId);
    if (review.mergeBlocker) throw new ForgeError("CONFLICT", review.mergeBlocker);
    const l = await this.locate(projectId);
    const wt = l.worktree.path;
    const branch = l.branch!;
    const targetBranch = l.targetBranch!;
    const dir = l.dir!;
    const git = this.d.git;

    if (review.uncommitted) {
      const files = (await git.status(wt)).files.map((f) => f.path);
      await git.commit(wt, `Restliche Änderungen von ${branch}`, files, false);
    }

    if (review.behind) {
      const r = await git.exec(wt, ["rebase", `refs/heads/${targetBranch}`], undefined, 180_000);
      if (r.code !== 0) {
        const files = (await git.exec(wt, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((f) => f.trim()).filter(Boolean);
        await git.exec(wt, ["rebase", "--abort"]);
        const sessionId = await this.handBack(l, conflictPrompt(branch, targetBranch, review.behind, files));
        this.changed(l);
        return {
          action: "merge",
          outcome: "conflict",
          branch,
          targetBranch,
          commits: 0,
          files,
          sessionId,
          branchError: null,
          message: `${targetBranch} hat sich seit dem Start des Agenten geändert, die Änderungen kollidieren${files.length ? ` in ${files.join(", ")}` : ""}. Der Agent löst die Konflikte jetzt, danach kannst du erneut zusammenführen.`,
        };
      }
    }

    const commits = await this.count(dir, `refs/heads/${targetBranch}..refs/heads/${branch}`);
    const ff = await git.exec(dir, ["merge", "--ff-only", `refs/heads/${branch}`], undefined, 120_000);
    if (ff.code !== 0) {
      const msg = (ff.stderr || ff.stdout).trim();
      if (/would be overwritten|overwritten by merge/i.test(msg)) {
        throw new ForgeError("CONFLICT", `Im Projekt gibt es nicht committete Änderungen an Dateien, die auch der Agent geändert hat. Committe oder verwirf sie dort zuerst. (${msg})`);
      }
      throw new ForgeError("GIT_FAILED", msg || `${branch} ließ sich nicht in ${targetBranch} übernehmen.`);
    }
    const taken = `${commits === 1 ? "1 Commit" : `${commits} Commits`} von ${branch} in ${targetBranch} übernommen`;
    let removed: { branchError: string | null };
    try {
      removed = await removeWorktree(projectId, false, this.d, { deleteBranch: true });
    } catch (e) {
      // The work is in: a folder that would not go is no failed merge. The branch is merged, so it
      // can go; the folder's remains are cleaned up by the next auto-merge round or "Verwerfen".
      await git.exec(dir, ["branch", "-d", branch]).catch(() => null);
      this.changed(l);
      const why = e instanceof Error ? e.message : String(e);
      return { action: "merge", outcome: "merged", branch, targetBranch, commits, files: [], sessionId: null, branchError: null, message: `${taken}. Der Worktree-Ordner ließ sich aber nicht löschen: ${why}` };
    }
    this.changed(l);
    return {
      action: "merge",
      outcome: "merged",
      branch,
      targetBranch,
      commits,
      files: [],
      sessionId: null,
      branchError: removed.branchError,
      message: `${taken}, Worktree und Branch gelöscht.${removed.branchError ? ` Der Branch blieb aber: ${removed.branchError}` : ""}`,
    };
  }

  /** The agent knows its own changes best; without a session one starts in the worktree. */
  private async handBack(l: Located, prompt: string): Promise<string> {
    if (l.session) return (await this.d.sessions.send(l.session.id, prompt)).id;
    return (await this.d.sessions.start({ projectId: l.worktree.id, prompt })).id;
  }

  private changed(l: Located) {
    const ids = new Set([l.worktree.id]);
    if (l.root) ids.add(l.root.id);
    const target = l.dir && this.d.projects.all().find((p) => pathKey(p.path) === pathKey(l.dir!));
    if (target) ids.add(target.id);
    for (const id of ids) this.d.notifyProject(id);
  }
}

export function conflictPrompt(branch: string, targetBranch: string, behind: number, files: string[]): string {
  return [
    `Ich wollte deinen Branch ${branch} in ${targetBranch} übernehmen. Auf ${targetBranch} gibt es seit deinem Start ${behind} neue Commits. Der Rebase hatte Konflikte in:`,
    files.length ? files.map((f) => `- ${f}`).join("\n") : "- (git hat keine Dateien genannt)",
    "",
    "Der Rebase ist abgebrochen, dein Branch ist im Stand von vorher.",
    "",
    "Bitte:",
    `1. Committe zuerst alles Offene, dann \`git rebase ${targetBranch}\`.`,
    "2. Löse die Konflikte so, dass deine Änderungen und die neuen Commits erhalten bleiben. Wenn nicht klar ist, welche Seite gelten soll: frag mich mit AskUserQuestion und rate nicht.",
    "3. Prüf danach, ob das Projekt noch baut und die Tests laufen, sofern es dafür einen Befehl gibt.",
    "4. Nicht pushen. Fass am Ende kurz zusammen, wie du jeden Konflikt aufgelöst hast. Danach übernimmt FORGE deinen Branch.",
  ].join("\n");
}
