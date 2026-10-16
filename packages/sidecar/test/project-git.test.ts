import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeError } from "@forge/protocol";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { git, initRepo, tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let db: Db;
let pm: ProjectManager;
const engine = new GitEngine();

beforeEach(() => {
  t = tempDir();
  mkdirSync(t.dir, { recursive: true });
  db = new Db(path.join(t.dir, "..", "forge.db"));
  pm = new ProjectManager(db, engine, () => "balanced");
});
afterEach(() => {
  db.close();
  t.cleanup();
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ForgeError && e.code === code);
}

describe("ProjectManager", () => {
  it("imports a folder, canonicalizes, detects technologies and rejects duplicates", async () => {
    const dir = path.join(t.dir, "web app");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19" }, devDependencies: { typescript: "5" } }));
    const p = await pm.import(dir);
    expect(p.name).toBe("web app");
    expect(p.technologies).toEqual(expect.arrayContaining(["Next.js", "React", "TypeScript"]));
    expect(p.exists).toBe(true);
    await expectCode(pm.import(dir + path.sep), "DUPLICATE_PROJECT");
    await expectCode(pm.import(dir.toUpperCase()), "DUPLICATE_PROJECT");
  });

  it("persists across a new Db instance (app restart)", async () => {
    const dir = path.join(t.dir, "persist");
    mkdirSync(dir);
    const p = await pm.import(dir);
    db.close();
    db = new Db(path.join(t.dir, "..", "forge.db"));
    pm = new ProjectManager(db, engine, () => "balanced");
    expect(pm.get(p.id).path).toBe(p.path);
  });

  it("rejects missing paths and files", async () => {
    await expectCode(pm.import(path.join(t.dir, "nope")), "PATH_INVALID");
    const f = path.join(t.dir, "file.txt");
    writeFileSync(f, "x");
    await expectCode(pm.import(f), "PATH_INVALID");
  });

  it("creates an empty project folder with git, no template files", async () => {
    const p = await pm.create({ name: "Neues Projekt", parentDir: t.dir, gitInit: true });
    expect(existsSync(path.join(p.path, ".git"))).toBe(true);
    expect(existsSync(path.join(p.path, "README.md"))).toBe(false);
    await expectCode(pm.create({ name: "Neues Projekt", parentDir: t.dir, gitInit: false }), "CONFLICT");
    await expectCode(pm.create({ name: "../evil", parentDir: t.dir, gitInit: false }), "VALIDATION");
    await expectCode(pm.create({ name: "CON", parentDir: t.dir, gitInit: false }), "VALIDATION");
  });

  it("sets a project up without git: no repository, no git status, git actions refused", async () => {
    const p = await pm.create({ name: "ohne-git", parentDir: t.dir, gitInit: true, gitEnabled: false });
    expect(p.gitEnabled).toBe(false);
    expect(existsSync(path.join(p.path, ".git"))).toBe(false);
    expect((await pm.withStatus(p)).git).toBeNull();
    expect(() => pm.requireGit(p.id)).toThrow(expect.objectContaining({ code: "GIT_DISABLED" }));

    // A folder that already is a repository always comes in with git.
    const repo = path.join(t.dir, "repo");
    mkdirSync(repo);
    await initRepo(repo);
    expect(await pm.inspectFolder(repo)).toEqual({ hasGit: true });
    expect(await pm.inspectFolder(path.join(t.dir, "fehlt"))).toEqual({ hasGit: false });
    const imported = await pm.import(repo, null, false);
    expect(imported.gitEnabled).toBe(true);
    expect((await pm.withStatus(imported)).git?.isRepo).toBe(true);
  });

  it("drops git-only automation tags while git is off and refuses it for worktrees and projects with agents", async () => {
    const dir = path.join(t.dir, "app");
    mkdirSync(dir);
    const p = await pm.import(dir);
    pm.update(p.id, { tags: ["auto-commit", "auto-push", "auto-merge", "review-required", "auto-test", "kunde"] });
    expect(pm.update(p.id, { gitEnabled: false }).tags).toEqual(["auto-test", "kunde"]);
    expect(pm.update(p.id, { tags: ["auto-commit", "plan-first"] }).tags).toEqual(["plan-first"]);
    expect(pm.update(p.id, { gitEnabled: true }).gitEnabled).toBe(true);

    const wtDir = path.join(t.dir, "app-wt");
    mkdirSync(wtDir);
    const wt = await pm.import(wtDir, p.id);
    expect(() => pm.update(wt.id, { gitEnabled: false })).toThrow(/Agent-Worktree/);
    expect(() => pm.update(p.id, { gitEnabled: false })).toThrow(/Agenten abschließen/);
  });

  it("marks deleted project folders and blocks file access", async () => {
    const dir = path.join(t.dir, "gone");
    mkdirSync(dir);
    const p = await pm.import(dir);
    rmSync(dir, { recursive: true });
    expect(pm.get(p.id).exists).toBe(false);
    expect(() => pm.requireExisting(p.id)).toThrow(/existiert nicht mehr/);
  });

  it("switches to autonomous directly and respects sandbox-only", async () => {
    const dir = path.join(t.dir, "auto");
    mkdirSync(dir);
    const p = await pm.import(dir);
    expect(pm.update(p.id, { profile: "safe" }).profile).toBe("safe");
    expect(pm.update(p.id, { profile: "autonomous" }).profile).toBe("autonomous");
    expect(pm.update(p.id, { tags: ["sandbox-only"] }).profile).toBe("balanced");
    expect(() => pm.update(p.id, { profile: "autonomous" })).toThrow(/sandbox-only/);

    const autoDir = path.join(t.dir, "auto-default");
    mkdirSync(autoDir);
    const autoPm = new ProjectManager(db, engine, () => "autonomous");
    expect((await autoPm.import(autoDir)).profile).toBe("autonomous");
  });

  it("blocks reading files outside the project", async () => {
    const dir = path.join(t.dir, "files");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a.txt"), "hallo");
    const p = await pm.import(dir);
    expect((await pm.readFile(p.id, "a.txt")).content).toBe("hallo");
    await expect(pm.readFile(p.id, "../forge.db")).rejects.toThrow(/außerhalb/);
  });

  it("does not follow links that point outside the project", async () => {
    const dir = path.join(t.dir, "linked");
    const secret = path.join(t.dir, "geheim");
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    mkdirSync(secret);
    writeFileSync(path.join(secret, "id_rsa"), "PRIVATE");
    // A junction needs no extra rights on Windows; elsewhere it is a normal directory symlink.
    symlinkSync(secret, path.join(dir, "docs", "x"), "junction");
    const p = await pm.import(dir);
    await expect(pm.readFile(p.id, "docs/x/id_rsa")).rejects.toThrow(/außerhalb/);
    await expect(pm.listFiles(p.id, "docs/x")).rejects.toThrow(/außerhalb/);
    expect((await pm.listFiles(p.id, "docs")).map((f) => f.path)).toEqual(["docs/x"]);
    await expect(pm.readFile(p.id, "docs/fehlt.txt")).rejects.toThrow(/ENOENT/);
    expect((await pm.allFiles(p.id)).files).toEqual([]);
  });

  it("lists every file in one call, shallow first, without installed folders and subagent worktrees", async () => {
    const dir = path.join(t.dir, "deep");
    let deep = dir;
    // deeper than the 150 folders the old crawl from the UI stopped at
    for (let i = 0; i < 200; i++) mkdirSync(path.join(dir, `d${i}`), { recursive: true });
    for (let i = 0; i < 12; i++) deep = path.join(deep, `n${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "datei.txt"), "x");
    writeFileSync(path.join(dir, "README.md"), "x");
    for (const d of ["node_modules/pkg", ".idea", ".github", ".claude/worktrees/agent-1", ".claude/agents"]) mkdirSync(path.join(dir, d), { recursive: true });
    writeFileSync(path.join(dir, "node_modules/pkg/index.js"), "x");
    writeFileSync(path.join(dir, ".idea/ws.xml"), "x");
    writeFileSync(path.join(dir, ".github/ci.yml"), "x");
    writeFileSync(path.join(dir, ".claude/worktrees/agent-1/README.md"), "x");
    writeFileSync(path.join(dir, ".claude/agents/review.md"), "x");
    const p = await pm.import(dir);
    const { files, truncated } = await pm.allFiles(p.id);
    expect(truncated).toBe(false);
    expect(files[0]).toEqual({ name: "README.md", path: "README.md" });
    expect(files.map((f) => f.path).sort()).toEqual([".claude/agents/review.md", ".github/ci.yml", "README.md", `${Array.from({ length: 12 }, (_, i) => `n${i}`).join("/")}/datei.txt`]);
  });
});

describe("GitEngine against a real repository", () => {
  let repo: string;
  beforeEach(async () => {
    repo = path.join(t.dir, "repo");
    mkdirSync(repo);
    await initRepo(repo);
    writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
  });

  it("reports status and real diffs for modified and untracked files", async () => {
    writeFileSync(path.join(repo, "a.txt"), "one\nzwei\n");
    writeFileSync(path.join(repo, "neu mit leerzeichen.txt"), "hallo\n");
    const st = await engine.status(repo);
    expect(st.summary.branch).toBe("main");
    expect(st.files.map((f) => [f.path, f.kind])).toEqual([
      ["a.txt", "modified"],
      ["neu mit leerzeichen.txt", "untracked"],
    ]);
    const d = await engine.diff(repo, "a.txt", false);
    expect(d.additions).toBe(1);
    expect(d.deletions).toBe(1);
    expect(d.lines.find((l) => l.kind === "add")?.text).toBe("zwei");
    const u = await engine.diff(repo, "neu mit leerzeichen.txt", false);
    expect(u.lines.find((l) => l.kind === "add")?.text).toBe("hallo");
  });

  it("commits exactly the reviewed files and leaves other changes alone", async () => {
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    writeFileSync(path.join(repo, "b.txt"), "new\n");
    writeFileSync(path.join(repo, "c.txt"), "unreviewed\n");
    const r = await engine.commit(repo, "feat: a und b\n\nDetails", ["a.txt", "b.txt"], false);
    expect(r.summary).toBe("feat: a und b");
    expect(r.hash).toMatch(/^[0-9a-f]{40}$/);
    const st = await engine.status(repo);
    expect(st.files.map((f) => f.path)).toEqual(["c.txt"]);
    const log = await engine.log(repo, 10);
    expect(log.map((c) => c.subject)).toEqual(["feat: a und b", "init"]);
  });

  it("commits staged deletions and staged renames (git rm, git mv) together with other changes", async () => {
    writeFileSync(path.join(repo, "b.txt"), "b\n");
    writeFileSync(path.join(repo, "c.txt"), "c\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "b und c");
    await git(repo, "rm", "-q", "b.txt");
    await git(repo, "mv", "c.txt", "d.txt");
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const st = await engine.status(repo);
    const r = await engine.commit(repo, "aufräumen", st.files.map((f) => f.path), false);
    expect(r.summary).toBe("aufräumen");
    expect((await engine.status(repo)).files).toEqual([]);
    expect(await git(repo, "ls-files")).toMatch(/^a\.txt\r?\nd\.txt\s*$/);
  });

  it("stops commits of sensitive files unless explicitly allowed, without scanning contents", async () => {
    writeFileSync(path.join(repo, ".env"), "X=1\n");
    writeFileSync(path.join(repo, "config.ts"), "export const key = process.env.KEY;\n");
    await expectCode(engine.commit(repo, "oops", [".env"], false), "POLICY_DENIED");
    await expect(engine.commit(repo, "config", ["config.ts"], false)).resolves.toMatchObject({ summary: "config" });
    await expect(engine.commit(repo, "bewusst", [".env"], true)).resolves.toMatchObject({ summary: "bewusst" });
  });

  it("rejects unknown paths, traversal and commits during conflicts", async () => {
    await expectCode(engine.commit(repo, "x", ["nichtgeaendert.txt"], false), "VALIDATION");
    await expectCode(engine.commit(repo, "x", ["../outside.txt"], false), "PATH_INVALID");

    await git(repo, "switch", "-c", "other");
    writeFileSync(path.join(repo, "a.txt"), "other\n");
    await git(repo, "commit", "-am", "other");
    await git(repo, "switch", "main");
    writeFileSync(path.join(repo, "a.txt"), "main\n");
    await git(repo, "commit", "-am", "main");
    await engine.exec(repo, ["merge", "other"]);
    const st = await engine.status(repo);
    expect(st.summary.conflicted).toBe(true);
    await expectCode(engine.commit(repo, "x", ["a.txt"], false), "GIT_CONFLICT");
  });

  it("stages, unstages, lists and switches branches", async () => {
    writeFileSync(path.join(repo, "a.txt"), "x\n");
    await engine.stage(repo, ["a.txt"]);
    expect((await engine.status(repo)).files[0]).toMatchObject({ staged: true, unstaged: false });
    await engine.unstage(repo, ["a.txt"]);
    expect((await engine.status(repo)).files[0]).toMatchObject({ staged: false, unstaged: true });
    await engine.checkout(repo, "feature/test", true);
    expect((await engine.branches(repo)).find((b) => b.current)?.name).toBe("feature/test");
    await expectCode(engine.checkout(repo, "-evil", false), "VALIDATION");
    await expectCode(engine.checkout(repo, "bad..name", false), "VALIDATION");
  });

  it("treats file names with glob characters literally", async () => {
    mkdirSync(path.join(repo, "app", "[id]"), { recursive: true });
    mkdirSync(path.join(repo, "app", "i"), { recursive: true });
    writeFileSync(path.join(repo, "app", "[id]", "page.tsx"), "a\n");
    writeFileSync(path.join(repo, "app", "i", "page.tsx"), "b\n");
    writeFileSync(path.join(repo, ".e[n]v"), "harmlos\n");
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    await engine.commit(repo, "feat: slug", ["app/[id]/page.tsx", ".e[n]v"], false);
    const committed = (await git(repo, "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean);
    expect(committed.sort()).toEqual([".e[n]v", "app/[id]/page.tsx"]);
    expect((await engine.status(repo)).files.map((f) => f.path).sort()).toEqual([".env", "app/i/page.tsx"]);

    await engine.stage(repo, ["app/[id]/page.tsx"]);
    writeFileSync(path.join(repo, "app", "[id]", "page.tsx"), "a2\n");
    await engine.stage(repo, ["app/[id]/page.tsx"]);
    expect((await engine.status(repo)).files.find((f) => f.path === "app/i/page.tsx")).toMatchObject({ staged: false });
  });

  it("works on a project that is a subfolder of a repository", async () => {
    const web = path.join(repo, "packages", "web");
    mkdirSync(path.join(web, "src"), { recursive: true });
    writeFileSync(path.join(web, "src", "page.tsx"), "eins\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "web");
    writeFileSync(path.join(web, "src", "page.tsx"), "zwei\n");
    writeFileSync(path.join(web, "neu.ts"), "neu\n");
    writeFileSync(path.join(repo, "a.txt"), "root change\n");

    const st = await engine.status(web);
    expect(st.files.map((f) => [f.path, f.kind])).toEqual([
      ["src/page.tsx", "modified"],
      ["neu.ts", "untracked"],
    ]);
    expect(st.summary.changedCount).toBe(2);
    const d = await engine.diff(web, "src/page.tsx", false);
    expect(d.lines.find((l) => l.kind === "add")?.text).toBe("zwei");
    expect((await engine.diff(web, "neu.ts", false)).lines.find((l) => l.kind === "add")?.text).toBe("neu");

    await engine.stage(web, ["src/page.tsx"]);
    expect((await engine.status(web)).files[0]).toMatchObject({ path: "src/page.tsx", staged: true });
    await engine.unstage(web, ["src/page.tsx"]);
    await engine.commit(web, "feat: web", ["src/page.tsx", "neu.ts"], false);
    const committed = (await git(repo, "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean);
    expect(committed.sort()).toEqual(["packages/web/neu.ts", "packages/web/src/page.tsx"]);
    expect(await engine.status(web)).toMatchObject({ files: [] });
    expect((await engine.status(repo)).files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("supports the first commit in a fresh repository", async () => {
    const fresh = path.join(t.dir, "fresh");
    mkdirSync(fresh);
    await initRepo(fresh);
    writeFileSync(path.join(fresh, "x.txt"), "x\n");
    expect(await engine.log(fresh, 5)).toEqual([]);
    await expect(engine.commit(fresh, "erster commit", ["x.txt"], false)).resolves.toMatchObject({ summary: "erster commit" });
  });
});

describe("push and pull guardrails against a local bare remote", () => {
  it("pushes feature branches, guards main, pulls and reports conflicting divergence", async () => {
    const remote = path.join(t.dir, "remote.git");
    const a = path.join(t.dir, "a");
    const b = path.join(t.dir, "b");
    mkdirSync(a);
    await git(t.dir, "init", "--bare", "-b", "main", remote);
    await initRepo(a);
    writeFileSync(path.join(a, "x.txt"), "1\n");
    await git(a, "add", ".");
    await git(a, "commit", "-m", "init");
    await git(a, "remote", "add", "origin", remote);

    await expect(engine.push(a, false)).rejects.toSatisfy((e: unknown) => e instanceof ForgeError && e.code === "POLICY_DENIED");
    await expect(engine.push(a, true)).resolves.toMatchObject({ branch: "main" });

    await engine.checkout(a, "feature/x", true);
    writeFileSync(path.join(a, "y.txt"), "y\n");
    await engine.commit(a, "feat: y", ["y.txt"], false);
    await expect(engine.push(a, false)).resolves.toMatchObject({ branch: "feature/x" });
    expect(await git(remote, "branch", "--list", "feature/x")).toContain("feature/x");

    await git(t.dir, "clone", remote, b);
    await initRepo(b).catch(() => {});
    await git(b, "config", "user.email", "b@forge.local");
    await git(b, "config", "user.name", "B");
    writeFileSync(path.join(b, "x.txt"), "2\n");
    await git(b, "commit", "-am", "remote change");
    await git(b, "push", "origin", "main");

    await engine.checkout(a, "main", false);
    await expect(engine.pull(a)).resolves.toBeTruthy();
    expect(readFileSync(path.join(a, "x.txt"), "utf8").trim()).toBe("2");

    writeFileSync(path.join(b, "x.txt"), "3\n");
    await git(b, "commit", "-am", "remote again");
    await git(b, "push", "origin", "main");
    writeFileSync(path.join(a, "x.txt"), "local\n");
    await git(a, "commit", "-am", "local change");
    // Both changed the same line: no automatic rebase, the repository stays as it was.
    await expect(engine.pull(a)).rejects.toMatchObject({ code: "GIT_CONFLICT", details: { integration: { files: ["x.txt"] } } });
    await expect(engine.push(a, true)).rejects.toMatchObject({ code: "GIT_CONFLICT" });
    expect(readFileSync(path.join(a, "x.txt"), "utf8").trim()).toBe("local");
    expect(await engine.defaultBranch(a)).toBe("main");
    // About 25 git processes against a real bare remote; on Windows that alone takes several seconds.
  }, 30_000);
});
