import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let db: Db;
let pm: ProjectManager;

beforeEach(() => {
  t = tempDir();
  mkdirSync(t.dir, { recursive: true });
  db = new Db(path.join(t.dir, "..", "forge.db"));
  pm = new ProjectManager(db, new GitEngine(), () => "balanced");
});
afterEach(() => {
  db.close();
  t.cleanup();
});

async function project(name: string) {
  const dir = path.join(t.dir, name);
  mkdirSync(dir);
  return pm.import(dir, null, false);
}

const file = (dir: string) => path.join(dir, ".forge", "project.json");

describe(".forge/project.json", () => {
  it("writes changed commands into the repository and keeps other keys", async () => {
    const p = await project("a");
    expect(p.projectFile).toBe(false);
    mkdirSync(path.join(p.path, ".forge"));
    writeFileSync(file(p.path), JSON.stringify({ other: 1 }));
    const next = pm.update(p.id, { devCommand: "pnpm dev", name: "A" });
    expect(next.devCommand).toBe("pnpm dev");
    expect(next.projectFile).toBe(true);
    expect(JSON.parse(readFileSync(file(p.path), "utf8"))).toEqual({ other: 1, devCommand: "pnpm dev" });
  });

  it("lets the file win over the local value and leaves the file alone when nothing changes", async () => {
    const p = await project("b");
    db.updateProject(p.id, { testCommand: "npm test" });
    mkdirSync(path.join(p.path, ".forge"));
    writeFileSync(file(p.path), JSON.stringify({ testCommand: "pnpm test", devCommand: null }));
    const shared = pm.get(p.id);
    expect(shared.testCommand).toBe("pnpm test");
    expect(shared.devCommand).toBeNull();
    pm.update(p.id, { testCommand: "pnpm test" });
    expect(readFileSync(file(p.path), "utf8")).toBe(JSON.stringify({ testCommand: "pnpm test", devCommand: null }));
  });

  it("refuses to overwrite a broken file and keeps the local value in effect", async () => {
    const p = await project("c");
    db.updateProject(p.id, { testCommand: "npm test" });
    mkdirSync(path.join(p.path, ".forge"));
    writeFileSync(file(p.path), "{ broken");
    expect(pm.get(p.id).testCommand).toBe("npm test");
    expect(() => pm.update(p.id, { testCommand: "pnpm test" })).toThrow(/JSON/);
  });

  it("does not write the file for agent worktrees", async () => {
    const parent = await project("d");
    const dir = path.join(t.dir, "d-agent");
    mkdirSync(dir);
    const child = await pm.import(dir, parent.id, false);
    pm.update(child.id, { testCommand: "pnpm test" });
    expect(pm.get(child.id).testCommand).toBe("pnpm test");
    expect(() => readFileSync(file(dir))).toThrow();
  });
});
