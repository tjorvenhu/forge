import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
import { parseWorktreeList, pruneSubagentWorktrees } from "../src/automation/subagent-worktrees.js";
import { git, initRepo, tempDir } from "./helpers.js";

describe("subagent worktrees", () => {
  let t: ReturnType<typeof tempDir>;
  let repo: string;
  const engine = new GitEngine();

  beforeEach(async () => {
    t = tempDir("forge-sub-");
    repo = path.join(t.dir, "app");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    writeFileSync(path.join(repo, "README.md"), "# app\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
  });
  afterEach(() => t.cleanup());

  /** A subagent worktree with one commit; `merge` puts that commit into main. */
  async function subagent(name: string, opts: { merge?: boolean; lock?: boolean } = {}) {
    const dir = path.join(repo, ".claude", "worktrees", name);
    const branch = `worktree-${name}`;
    await git(repo, "worktree", "add", ...(opts.lock ? ["--lock"] : []), "-b", branch, dir);
    writeFileSync(path.join(dir, `${name}.txt`), "x\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", name);
    if (opts.merge) await git(repo, "merge", "--no-edit", branch);
    return { dir, branch };
  }

  it("parses git worktree list --porcelain", () => {
    const out = "worktree C:/r\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/r/.claude/worktrees/agent-a1\nHEAD 2\nbranch refs/heads/worktree-agent-a1\nlocked claude agent\n\n";
    expect(parseWorktreeList(out)).toEqual([
      { path: "C:/r", branch: "refs/heads/main", locked: false },
      { path: "C:/r/.claude/worktrees/agent-a1", branch: "refs/heads/worktree-agent-a1", locked: true },
    ]);
  });

  it("removes merged, clean and unlocked subagent worktrees with their branch, and keeps the rest", async () => {
    const merged = await subagent("agent-a1", { merge: true });
    const open = await subagent("agent-b2");
    const locked = await subagent("agent-c3", { merge: true, lock: true });
    const dirty = await subagent("agent-d4", { merge: true });
    writeFileSync(path.join(dirty.dir, "offen.txt"), "nicht committet\n");

    expect(await pruneSubagentWorktrees(engine, repo)).toEqual([merged.branch]);
    expect(existsSync(merged.dir)).toBe(false);
    expect(await git(repo, "branch", "--list", merged.branch)).toBe("");
    for (const kept of [open, locked, dirty]) {
      expect(existsSync(kept.dir)).toBe(true);
      expect(await git(repo, "branch", "--list", kept.branch)).toContain(kept.branch);
    }
  }, 30_000);
});
