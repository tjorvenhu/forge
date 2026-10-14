import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { GitEngine } from "../git/git.js";

/** Folder of a worktree Claude Code made for a subagent (Agent tool with isolation "worktree"). */
const SUBAGENT_DIR = /[\\/]\.claude[\\/]worktrees[\\/]agent-[0-9a-f]+$/i;
const SUBAGENT_BRANCH = /^refs\/heads\/(worktree-agent-[0-9a-f]+)$/;

interface Entry {
  path: string;
  branch: string | null;
  locked: boolean;
}

export function parseWorktreeList(out: string): Entry[] {
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null, locked: false };
      entries.push(cur);
    } else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7);
    else if (cur && (line === "locked" || line.startsWith("locked "))) cur.locked = true;
  }
  return entries;
}

/**
 * Whether `.claude/worktrees` exists in `dir` or above it up to the repository root (a project may
 * be a subfolder). Without it there is nothing to tidy and no git process is started.
 */
function hasSubagentFolder(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".claude", "worktrees"))) return true;
    if (existsSync(path.join(d, ".git")) || path.dirname(d) === d) return false;
  }
}

/**
 * Removes worktrees of finished Claude Code subagents whose work is already in `dir`'s branch.
 * Claude Code keeps such a worktree when the subagent changed files and only sweeps it after its
 * retention period, and only once pushed; merged into the project they just pile up. A running
 * subagent's worktree is locked by Claude Code and stays, as does one with uncommitted changes or
 * commits the branch of `dir` does not have.
 */
export async function pruneSubagentWorktrees(git: GitEngine, dir: string): Promise<string[]> {
  if (!hasSubagentFolder(dir)) return [];
  const list = await git.exec(dir, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return [];
  const removed: string[] = [];
  for (const wt of parseWorktreeList(list.stdout)) {
    const branch = wt.branch ? SUBAGENT_BRANCH.exec(wt.branch)?.[1] : null;
    if (!branch || wt.locked || !SUBAGENT_DIR.test(wt.path) || !existsSync(wt.path)) continue;
    const dirty = await git.exec(wt.path, ["status", "--porcelain"]);
    if (dirty.code !== 0 || dirty.stdout.trim()) continue;
    if ((await git.exec(dir, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, "HEAD"])).code !== 0) continue;
    const r = await git.exec(dir, ["worktree", "remove", wt.path], undefined, 60_000);
    // On Windows git leaves pnpm's node_modules (junctions) behind, or stops at paths beyond 260
    // characters; everything in there is merged, so Node deletes the rest.
    if (existsSync(wt.path)) await rm(wt.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined);
    if (r.code !== 0) await git.exec(dir, ["worktree", "prune"]);
    if (existsSync(wt.path)) continue;
    await git.exec(dir, ["branch", "-d", "--", branch]);
    removed.push(branch);
  }
  return removed;
}
