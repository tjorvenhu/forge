import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { KNOWLEDGE_DIR, KnowledgeStore } from "../src/knowledge/knowledge.js";
import { tempDir } from "./helpers.js";

describe("KnowledgeStore files", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projectId: string;
  let store: KnowledgeStore;
  let dir: string;

  beforeEach(async () => {
    t = tempDir();
    mkdirSync(path.join(t.dir, "web"), { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    const projects = new ProjectManager(db, new GitEngine(), () => "balanced");
    projectId = (await projects.import(path.join(t.dir, "web"))).id;
    store = new KnowledgeStore(projects, () => {});
    dir = path.join(t.dir, "web", KNOWLEDGE_DIR);
  });

  afterEach(() => {
    db.close();
    t.cleanup();
  });

  it("gives entries saved at the same moment with the same title their own files", async () => {
    const saved = await Promise.all(Array.from({ length: 6 }, (_, k) => store.save(projectId, { id: null, title: "Deploy auf Coolify", summary: "", tags: [], content: `Fassung ${k}` })));
    const ids = saved.map((e) => e.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids).toContain("deploy-auf-coolify");
    for (const e of saved) expect(readFileSync(path.join(dir, `${e.id}.md`), "utf8")).toContain(e.content);

    await Promise.all(saved.map((e) => store.save(projectId, { id: e.id, title: e.title, summary: "neu", tags: [], content: `${e.content} geändert` })));
    expect(readdirSync(dir).filter((n) => !n.endsWith(".md"))).toEqual([]);
    expect(store.list(projectId).every((e) => e.summary === "neu")).toBe(true);
  });

  it("reads, updates and deletes hand-made files whose names are no valid id", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "Deploy.md"), "# Deploy\n\nAuf Coolify.\n");
    writeFileSync(path.join(dir, "db_setup.md"), "---\ntitle: Datenbank einrichten\n---\nErst migrieren.\n");
    writeFileSync(path.join(dir, "notizen.txt"), "kein Eintrag");

    expect(store.list(projectId).map((e) => e.id).sort()).toEqual(["db-setup", "deploy"]);
    expect((await store.read(projectId, "db-setup")).title).toBe("Datenbank einrichten");
    expect(store.search(projectId, "coolify")[0]?.id).toBe("deploy");

    await store.save(projectId, { id: "db-setup", title: "Datenbank einrichten", summary: "Neu", tags: [], content: "Erst migrieren, dann seeden." });
    expect(readFileSync(path.join(dir, "db_setup.md"), "utf8")).toContain("dann seeden");
    expect(existsSync(path.join(dir, "db-setup.md"))).toBe(false);

    const second = await store.save(projectId, { id: null, title: "Deploy", summary: "", tags: [], content: "x" });
    expect(second.id).toBe("deploy-2");
    expect(readFileSync(path.join(dir, "Deploy.md"), "utf8")).toContain("Auf Coolify.");

    expect(await store.delete(projectId, "db-setup")).toBe(true);
    expect(existsSync(path.join(dir, "db_setup.md"))).toBe(false);
    await expect(store.read(projectId, "db-setup")).rejects.toThrow(/Kein Eintrag/);
    await expect(store.read(projectId, "../db_setup")).rejects.toThrow(/Ungültige Kennung/);
    await expect(store.save(projectId, { id: "..\\x", title: "x", summary: "", tags: [], content: "" })).rejects.toThrow(/Ungültige Kennung/);
  });
});
