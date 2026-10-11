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

  it("protects Claude data, credentials, dot folders, program and system folders", () => {
    const env = { CLAUDE_CONFIG_DIR: path.join(home, "claude-config"), OneDrive: path.join(home, "OneDrive - Firma") };
    const blocked = [
      path.join(home, ".claude"),
      path.join(home, ".ssh"),
      path.join(home, ".config"),
      path.join(home, ".config", "gh"),
      path.join(home, ".aws", "sso"),
      path.join(home, "AppData"),
      path.join(home, "OneDrive - Firma"),
      path.join(home, "OneDrive - Firma", "Documents"),
      path.join(home, "claude-config"),
      path.join(home, "claude-config", "skills"),
    ];
    for (const dir of blocked) expect(folderDeleteBlocker(dir, [], [], home, env), dir).not.toBeNull();
    expect(folderDeleteBlocker(path.join(home, ".forge-worktrees", "app", "feature"), [], [], home, env)).toBeNull();
    expect(folderDeleteBlocker(path.join(home, "OneDrive - Firma", "Projekte", "app"), [], [], home, env)).toBeNull();

    const sys = { ...env, ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", LOCALAPPDATA: path.join(home, "AppData", "Local") };
    expect(folderDeleteBlocker("C:\\Program Files", [], [], home, sys)).not.toBeNull();
    expect(folderDeleteBlocker("C:\\Program Files\\nodejs", [], [], home, sys)).not.toBeNull();
    expect(folderDeleteBlocker("C:\\Windows\\System32", [], [], home, sys)).not.toBeNull();
    expect(folderDeleteBlocker(path.join(home, "AppData", "Local", "Programs", "app"), [], [], home, sys)).not.toBeNull();
  });
});

describe("removeProject", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let deps: RemovalDeps;
  let deleted: string[];
  let closed: string[][];
  let forgotten: string[];

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
    forgotten = [];
    const devServers = {
      forget: async (id: string) => {
        forgotten.push(id);
      },
    };
    deps = { projects, git: engine, github, sessions, worktrees: new WorktreeService(engine, projects), devServers, dataDir: path.join(t.dir, "data") };
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
    expect(forgotten).toEqual([]);
  });

  it("stops the dev servers of the project and of its worktrees before deleting them", async () => {
    const dir = await repoWithCommit("withwt");
    const p = await deps.projects.import(dir);
    const wt = await deps.worktrees.create(p, "feature/a");
    await removeProject(p.id, { deleteFolder: true, deleteGitHubRepo: false }, deps);
    expect(forgotten.sort()).toEqual([p.id, wt.id].sort());
    expect(closed[0]!.sort()).toEqual([p.id, wt.id].sort());
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(deps.projects.all()).toEqual([]);
  });

  it("keeps worktrees as standalone projects when only the parent entry is removed", async () => {
    const dir = await repoWithCommit("parent");
    const p = await deps.projects.import(dir);
    const wt = await deps.worktrees.create(p, "feature/b");
    await removeProject(p.id, { deleteFolder: false, deleteGitHubRepo: false }, deps);
    expect(forgotten).toEqual([p.id]);
    const left = deps.projects.get(wt.id);
    expect(left.parentId).toBeNull();
    expect((await removalInfo(wt.id, deps)).isWorktree).toBe(false);

    // Deleting the former worktree later goes through git, so the repository forgets it too.
    await removeProject(wt.id, { deleteFolder: true, deleteGitHubRepo: false }, deps);
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(await git(dir, "worktree", "list")).not.toContain("feature/b");
    expect(await git(dir, "branch", "--list", "feature/b")).toContain("feature/b");
  });

  it("removes a worktree whose parent entry vanished", async () => {
    const dir = await repoWithCommit("legacy");
    const p = await deps.projects.import(dir);
    const wt = await deps.worktrees.create(p, "feature/c");
    db.deleteProject(p.id);
    await removeProject(wt.id, { deleteFolder: true, deleteGitHubRepo: false }, deps);
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(dir, "worktree", "list")).not.toContain("feature/c");
  });
});
