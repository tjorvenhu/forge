import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@forge/protocol";
import { GitEngine } from "../src/git/git.js";
import { PushAll } from "../src/git/push-all.js";
import { git, initRepo, tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let repo: string;
let remote: string;

function project(id: string, dir: string, extra: Partial<Project> = {}): Project {
  return {
    id, name: id, path: dir, favorite: false, group: null, tags: [], technologies: [], profile: "balanced",
    defaultModel: null, defaultEffort: null, createdAt: "", lastOpenedAt: null, testCommand: null, devCommand: null,
    parentId: null, gitEnabled: true, agentsEnabled: true, exists: true, ...extra,
  };
}

function service(projects: Project[]) {
  const notified: string[] = [];
  const s = new PushAll({
    git: new GitEngine(),
    projects: () => projects,
    suggestCommitMessage: async () => ({ message: "Stand sichern" }),
    notifyProject: (id) => notified.push(id),
  });
  return { s, notified };
}

beforeEach(async () => {
  t = tempDir();
  remote = path.join(t.dir, "remote.git");
  repo = path.join(t.dir, "repo");
  mkdirSync(remote, { recursive: true });
  await git(remote, "init", "-q", "--bare", "-b", "main");
  mkdirSync(repo);
  await initRepo(repo);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  await git(repo, "add", "a.txt");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-q", "-u", "origin", "main");
}, 30_000);
afterEach(() => t.cleanup());

describe("push all on close", { timeout: 30_000 }, () => {
  it("lists changed files and unpushed commits, leaves out clean projects, worktrees and projects without remote", async () => {
    const local = path.join(t.dir, "local");
    mkdirSync(local);
    await initRepo(local);
    writeFileSync(path.join(local, "x.txt"), "x\n");
    const { s } = service([project("p", repo), project("wt", repo, { parentId: "p" }), project("local", local)]);
    expect(await s.unpushed()).toEqual([]);

    writeFileSync(path.join(repo, "b.txt"), "b\n");
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    await git(repo, "checkout", "-q", "-b", "feature");
    expect(await s.unpushed()).toEqual([{ projectId: "p", name: "p", branch: "feature", changed: 1, ahead: 0 }]);

    await git(repo, "add", "b.txt");
    await git(repo, "commit", "-q", "-m", "b");
    // No upstream yet: counts the commits that are on no branch of origin.
    expect(await s.unpushed()).toEqual([{ projectId: "p", name: "p", branch: "feature", changed: 0, ahead: 1 }]);
  });

  it("commits open changes without secrets and pushes the branch", async () => {
    writeFileSync(path.join(repo, "b.txt"), "b\n");
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    const { s, notified } = service([project("p", repo)]);

    // main needs the confirmation; the commit stays local until then.
    expect(await s.pushAll(["p"], false)).toEqual([
      { projectId: "p", name: "p", committed: "Stand sichern", pushed: false, error: expect.stringContaining("main") },
    ]);
    const [r] = await s.pushAll(["p"], true);
    expect(r).toEqual({ projectId: "p", name: "p", committed: null, pushed: true, error: null });
    expect(notified).toContain("p");
    expect((await git(remote, "log", "--format=%s", "main")).trim().split(/\r?\n/)[0]).toBe("Stand sichern");
    expect(await git(repo, "status", "--porcelain")).toContain(".env");
    expect(await s.unpushed()).toEqual([]);
  });
});
