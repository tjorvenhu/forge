import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
import { git, initRepo, tempDir } from "./helpers.js";

let t: { dir: string; cleanup: () => void };
let repo: string;
const engine = new GitEngine();

beforeEach(async () => {
  t = tempDir();
  repo = path.join(t.dir, "repo");
  mkdirSync(repo, { recursive: true });
  await initRepo(repo);
  await git(repo, "checkout", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "1\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => t.cleanup());

const branchNames = async () => (await engine.branches(repo)).map((b) => b.name);

// Several real git processes per case; on Windows under a full test run that exceeds the 5 s default.
describe("deleteBranch", { timeout: 30_000 }, () => {
  it("deletes a merged branch", async () => {
    await git(repo, "branch", "fertig");
    await engine.deleteBranch(repo, "fertig", false);
    expect(await branchNames()).toEqual(["main"]);
  });

  it("asks before dropping unmerged commits and deletes them when forced", async () => {
    await git(repo, "checkout", "-q", "-b", "agent/x");
    writeFileSync(path.join(repo, "b.txt"), "neu\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "nur hier");
    await git(repo, "checkout", "-q", "main");

    await expect(engine.deleteBranch(repo, "agent/x", false)).rejects.toMatchObject({ code: "CONFLICT", details: { unmerged: true } });
    expect(await branchNames()).toContain("agent/x");
    await engine.deleteBranch(repo, "agent/x", true);
    expect(await branchNames()).toEqual(["main"]);
  });

  it("keeps the current branch, the default branch and branches checked out in a worktree", async () => {
    await git(repo, "checkout", "-q", "-b", "feature");
    await expect(engine.deleteBranch(repo, "feature", true)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(engine.deleteBranch(repo, "main", true)).rejects.toMatchObject({ code: "POLICY_DENIED" });

    await git(repo, "checkout", "-q", "main");
    await git(repo, "worktree", "add", "-q", path.join(t.dir, "wt"), "feature");
    await expect(engine.deleteBranch(repo, "feature", true)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects names that could be read as options", async () => {
    await expect(engine.deleteBranch(repo, "--all", true)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("branches only on origin", { timeout: 30_000 }, () => {
  it("lists them and switching creates the tracking branch", async () => {
    const origin = path.join(t.dir, "origin.git");
    await git(t.dir, "init", "-q", "--bare", origin);
    await git(repo, "remote", "add", "origin", origin);
    await git(repo, "push", "-q", "origin", "main", "main:dev");
    await git(repo, "fetch", "-q", "origin");

    expect(await engine.branches(repo)).toEqual([
      { name: "main", current: true, upstream: null },
      { name: "dev", current: false, upstream: "origin/dev", remote: true },
    ]);

    await engine.checkout(repo, "dev", false);
    expect(await engine.branches(repo)).toEqual([
      { name: "dev", current: true, upstream: "origin/dev" },
      { name: "main", current: false, upstream: null },
    ]);
  });
});
