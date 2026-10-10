import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
    if (process.platform === "win32") await expectCode(pm.import(dir.toUpperCase()), "DUPLICATE_PROJECT");
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

  it("creates a project with template files and git", async () => {
    const p = await pm.create({ name: "Neues Projekt", parentDir: t.dir, gitInit: true, readme: true, gitignore: true, claudeMd: true, template: "node-ts" });
    for (const f of ["README.md", ".gitignore", "CLAUDE.md", "package.json", "src/index.ts", ".git"]) {
      expect(existsSync(path.join(p.path, f)), f).toBe(true);
    }
    expect(p.technologies).toContain("TypeScript");
    await expectCode(pm.create({ name: "Neues Projekt", parentDir: t.dir, gitInit: false, readme: false, gitignore: false, claudeMd: false, template: "empty" }), "CONFLICT");
    await expectCode(pm.create({ name: "../evil", parentDir: t.dir, gitInit: false, readme: false, gitignore: false, claudeMd: false, template: "empty" }), "VALIDATION");
    await expectCode(pm.create({ name: "CON", parentDir: t.dir, gitInit: false, readme: false, gitignore: false, claudeMd: false, template: "empty" }), "VALIDATION");
  });

  it("marks deleted project folders and blocks file access", async () => {
    const dir = path.join(t.dir, "gone");
    mkdirSync(dir);
    const p = await pm.import(dir);
    rmSync(dir, { recursive: true });
    expect(pm.get(p.id).exists).toBe(false);
    expect(() => pm.requireExisting(p.id)).toThrow(/existiert nicht mehr/);
  });

  it("guards autonomous behind global unlock and typed confirmation", async () => {
    const dir = path.join(t.dir, "auto");
    mkdirSync(dir);
    const p = await pm.import(dir);
    expect(() => pm.update(p.id, { profile: "autonomous" })).toThrow(/bestätigt/);
    expect(() => pm.confirmAutonomous(p.id, "auto", false)).toThrow(/global gesperrt/);
    expect(() => pm.confirmAutonomous(p.id, "falsch", true)).toThrow(/stimmt nicht/);
    expect(pm.confirmAutonomous(p.id, "auto", true).profile).toBe("autonomous");
    const back = pm.update(p.id, { profile: "safe" });
    expect(back.autonomousConfirmed).toBe(false);
  });

  it("blocks reading files outside the project", async () => {
    const dir = path.join(t.dir, "files");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a.txt"), "hallo");
    const p = await pm.import(dir);
    expect((await pm.readFile(p.id, "a.txt")).content).toBe("hallo");
    await expect(pm.readFile(p.id, "../forge.db")).rejects.toThrow(/außerhalb/);
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

  it("stops commits of secrets unless explicitly allowed", async () => {
    writeFileSync(path.join(repo, ".env"), "X=1\n");
    writeFileSync(path.join(repo, "config.ts"), 'export const key = "ghp_abcdefghijklmnopqrstuvwxyz0123";\n');
    await expectCode(engine.commit(repo, "oops", [".env"], false), "POLICY_DENIED");
    await expectCode(engine.commit(repo, "oops", ["config.ts"], false), "POLICY_DENIED");
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

  it("supports the first commit in a fresh repository", async () => {
    const fresh = path.join(t.dir, "fresh");
    mkdirSync(fresh);
    await initRepo(fresh);
    writeFileSync(path.join(fresh, "x.txt"), "x\n");
    expect(await engine.log(fresh, 5)).toEqual([]);
    await expect(engine.commit(fresh, "erster commit", ["x.txt"], false)).resolves.toMatchObject({ summary: "erster commit" });
  });
});
