import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeError } from "@forge/protocol";
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

describe("project groups", () => {
  it("starts without group, joins an existing group in its spelling and leaves it with null", async () => {
    const a = await project("a");
    const b = await project("b");
    expect(a.group).toBeNull();
    expect(pm.update(a.id, { group: "Kunde A" }).group).toBe("Kunde A");
    expect(pm.update(b.id, { group: "kunde a" }).group).toBe("Kunde A");
    // The only member may change the spelling of its own group.
    expect(pm.update(a.id, { group: "KUNDE A" }).group).toBe("Kunde A");
    expect(pm.update(b.id, { group: null }).group).toBeNull();
    expect(pm.update(a.id, { group: "KUNDE A" }).group).toBe("KUNDE A");
  });

  it("renames a group in all its projects, merges into an existing one and dissolves", async () => {
    const a = await project("a");
    const b = await project("b");
    const c = await project("c");
    pm.update(a.id, { group: "Alt" });
    pm.update(b.id, { group: "Alt" });
    pm.update(c.id, { group: "Neu" });
    expect(pm.renameGroup("alt", "neu")).toBe(2);
    expect([a, b, c].map((p) => pm.get(p.id).group)).toEqual(["Neu", "Neu", "Neu"]);
    expect(pm.renameGroup("Neu", null)).toBe(3);
    expect([a, b, c].map((p) => pm.get(p.id).group)).toEqual([null, null, null]);
    expect(() => pm.renameGroup("Neu", "X")).toThrow(ForgeError);
  });
});
