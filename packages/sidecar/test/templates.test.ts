import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeError } from "@forge/protocol";
import { Db } from "../src/persistence/db.js";
import { TemplateService } from "../src/templates/templates.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let db: Db;
let svc: TemplateService;
let events: Array<string | null>;

function addProject(id: string, parentId: string | null = null) {
  db.insertProject(
    {
      id,
      name: id,
      path: `C:\\${id}`,
      favorite: false,
      tags: [],
      technologies: [],
      profile: "balanced",
      defaultModel: null,
      defaultEffort: null,
      createdAt: "2026-10-01T00:00:00Z",
      lastOpenedAt: null,
      testCommand: null,
      devCommand: null,
      parentId,
      gitEnabled: true,
      group: null,
    },
    `c:\\${id}`,
  );
}

beforeEach(() => {
  t = tempDir();
  mkdirSync(t.dir, { recursive: true });
  db = new Db(path.join(t.dir, "forge.db"));
  events = [];
  svc = new TemplateService({
    db,
    rootOf: (id) => {
      const p = db.getProject(id);
      if (!p) throw new ForgeError("NOT_FOUND", "Projekt nicht gefunden.");
      return p.parentId ?? id;
    },
    emit: (projectId) => events.push(projectId),
  });
  addProject("shop");
  addProject("blog");
});
afterEach(() => {
  db.close();
  t.cleanup();
});

const save = (name: string, projectId: string | null = null, text = `${name} für {datei}`) => svc.save({ id: null, projectId, name, description: null, text });

describe("prompt templates", () => {
  it("lists the global ones in every project, a project's own only there", () => {
    const review = save("Review vor Release");
    const tests = save("Tests schreiben", "shop");
    save("Artikel prüfen", "blog");
    expect(svc.list().map((x) => x.name)).toEqual(["Review vor Release"]);
    expect(svc.list("shop").map((x) => x.name)).toEqual(["Review vor Release", "Tests schreiben"]);
    expect(svc.list(undefined, true)).toHaveLength(3);
    expect([review.sortOrder, tests.sortOrder]).toEqual([0, 0]);
    expect(events).toEqual([null, "shop", "blog"]);
  });

  it("keeps the templates of an agent's worktree with its project", () => {
    addProject("shop-agent", "shop");
    const x = save("Nur im Shop", "shop-agent");
    expect(x.projectId).toBe("shop");
    expect(svc.list("shop-agent").map((y) => y.name)).toEqual(["Nur im Shop"]);
  });

  it("edits, moves to another list at its end and deletes", () => {
    const a = save("A");
    save("B", "shop");
    const moved = svc.save({ id: a.id, projectId: "shop", name: " A2 ", description: "  ", text: "neu" });
    expect(moved).toMatchObject({ name: "A2", description: null, text: "neu", projectId: "shop", sortOrder: 1, createdAt: a.createdAt });
    expect(events.slice(-2)).toEqual([null, "shop"]);
    expect(svc.delete(a.id)).toBe(true);
    expect(svc.delete(a.id)).toBe(false);
    expect(() => svc.get(a.id)).toThrow(/gibt es nicht mehr/);
  });

  it("reorders within one list and refuses to mix lists", () => {
    const [a, b, c] = ["A", "B", "C"].map((n) => save(n));
    const shop = save("S", "shop");
    expect(svc.reorder([c!.id, a!.id]).map((x) => x.name)).toEqual(["C", "B", "A"]);
    expect(svc.reorder([b!.id, c!.id, a!.id]).map((x) => x.name)).toEqual(["B", "C", "A"]);
    expect(() => svc.reorder([a!.id, shop.id])).toThrow(/nicht untereinander/);
  });

  it("goes with its project when the project is removed", () => {
    save("S", "shop");
    db.deleteProject("shop");
    expect(svc.list(undefined, true)).toEqual([]);
  });
});
