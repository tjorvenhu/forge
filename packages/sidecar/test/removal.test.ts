import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
import { githubRepoFromRemote, type GitHubService } from "../src/github/github.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { folderDeleteBlocker, removalInfo, removeProject, type RemovalDeps } from "../src/projects/removal.js";
import type { SessionService } from "../src/sessions/session-service.js";
import { WorktreeService } from "../src/automation/worktrees.js";
import { git, initRepo, tempDir } from "./helpers.js";

describe("githubRepoFromRemote", () => {
  it("reads owner/repo from github.com remotes only", () => {
    expect(githubRepoFromRemote("https://github.com/vanturis/forge.git")).toBe("vanturis/forge");
    expect(githubRepoFromRemote("https://user@github.com/vanturis/forge")).toBe("vanturis/forge");
    expect(githubRepoFromRemote("git@github.com:vanturis/my.repo.git")).toBe("vanturis/my.repo");
    expect(githubRepoFromRemote("https://gitlab.com/vanturis/forge.git")).toBeNull();
    expect(githubRepoFromRemote("https://github.com/vanturis")).toBeNull();
    expect(githubRepoFromRemote(null)).toBeNull();
  });
});

describe("folderDeleteBlocker", () => {
  const home = path.join(os.tmpdir(), "forge-home-test");
  it("protects drives, home, its known folders, FORGE data and other projects", () => {
    expect(folderDeleteBlocker(path.parse(home).root, [], [], home)).toMatch(/Laufwerk/);
    expect(folderDeleteBlocker(home, [], [], home)).toMatch(/Benutzerverzeichnis/);
    expect(folderDeleteBlocker(path.dirname(home), [], [], home)).toMatch(/Benutzerverzeichnis/);
    expect(folderDeleteBlocker(path.join(home, "Documents"), [], [], home)).toMatch(/Documents/);
    expect(folderDeleteBlocker(path.join(home, "code"), [], [path.join(home, "code", "forge-data")], home)).toMatch(/FORGE/);
    expect(folderDeleteBlocker(path.join(home, "code"), [path.join(home, "code", "app")], [], home)).toMatch(/weiteres Projekt/);
    expect(folderDeleteBlocker(path.join(home, "code", "app"), [path.join(home, "code", "other")], [], home)).toBeNull();
  });
});

describe("removeProject", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let deps: RemovalDeps;
  let deleted: string[];
  let closed: string[][];

  beforeEach(() => {
    t = tempDir("forge-rm-");
    mkdirSync(t.dir, { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    const engine = new GitEngine();
    const projects = new ProjectManager(db, engine, () => "balanced");
    deleted = [];
    closed = [];
    const github = {
      scopes: async () => ["repo", "delete_repo"],
      deleteRepo: async (name: string) => {
        deleted.push(name);
      },
    } as unknown as GitHubService;
    const sessions = {
      closeProject: async (ids: string[]) => {
        closed.push(ids);
      },
    } as unknown as SessionService;
    deps = { projects, git: engine, github, sessions, worktrees: new WorktreeService(engine, projects), dataDir: path.join(t.dir, "data") };
  });
  afterEach(() => {
    db.close();
    t.cleanup();
  });

  async function repoWithCommit(name: string, remote?: string) {
    const dir = path.join(t.dir, name);
    mkdirSync(dir, { recursive: true });
    await initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-m", "init");
    if (remote) await git(dir, "remote", "add", "origin", remote);
    return dir;
  }

  it("only removes the entry by default", async () => {
    const dir = await repoWithCommit("keep", "https://github.com/me/keep.git");
    const p = await deps.projects.import(dir);
    expect(await removeProject(p.id, { deleteFolder: false, deleteGitHubRepo: false }, deps)).toEqual({ removed: true, folderDeleted: false, githubDeleted: false });
    expect(existsSync(dir)).toBe(true);
    expect(deleted).toEqual([]);
    expect(deps.projects.all()).toEqual([]);
  });

  it("deletes the GitHub repository and the folder including read-only git objects", async () => {
    const dir = await repoWithCommit("gone", "git@github.com:me/gone.git");
    const p = await deps.projects.import(dir);
    const info = await removalInfo(p.id, deps);
    expect(info).toMatchObject({ githubRepo: "me/gone", githubCanDelete: true, folderBlocker: null, folderExists: true });
    const r = await removeProject(p.id, { deleteFolder: true, deleteGitHubRepo: true }, deps);
    expect(r).toEqual({ removed: true, folderDeleted: true, githubDeleted: true });
    expect(deleted).toEqual(["me/gone"]);
    expect(closed[0]).toEqual([p.id]);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses to delete a folder that contains another project", async () => {
    const outer = await repoWithCommit("outer");
    const inner = await repoWithCommit(path.join("outer", "inner"));
    const p = await deps.projects.import(outer);
    await deps.projects.import(inner);
    await expect(removeProject(p.id, { deleteFolder: true, deleteGitHubRepo: false }, deps)).rejects.toThrow(/weiteres Projekt/);
    expect(existsSync(outer)).toBe(true);
    expect(deps.projects.all()).toHaveLength(2);
  });
});
