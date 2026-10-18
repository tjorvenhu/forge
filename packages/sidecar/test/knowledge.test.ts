import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { buildFixPrompt, buildMergePlanPrompt, buildMergePrompt, KNOWLEDGE_DIR, KnowledgeStore, MERGE_PLAN_SCHEMA, MERGE_SCHEMA } from "../src/knowledge/knowledge.js";
import { setLanguage } from "../src/i18n/index.js";
import { projectTools } from "../src/sessions/forge-tools.js";
import { ClaudeAssist, MERGE_MODEL } from "../src/sessions/claude-assist.js";
import type { ClaudeRuntime } from "../src/claude/runtime.js";
import type { DevEnvironment } from "../src/devtools/environment.js";
import { tempDir } from "./helpers.js";

describe("KnowledgeStore files", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projectId: string;
  let store: KnowledgeStore;
  let projects: ProjectManager;
  let dir: string;

  beforeEach(async () => {
    t = tempDir();
    mkdirSync(path.join(t.dir, "web"), { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, new GitEngine(), () => "balanced");
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

  it("drops summaries from the index before it drops entries", async () => {
    const long = "Ein Satz, der erklärt, worum es in diesem Eintrag geht und wann man ihn braucht, mit ein paar Begriffen mehr.".repeat(2);
    for (let k = 0; k < 40; k++) await store.save(projectId, { id: null, title: `Thema ${k} mit Begriffen`, summary: long, tags: ["ui", `t${k}`], content: "x" });
    const index = store.index(projectId);
    expect(index).toMatchObject({ total: 40, summaries: false });
    expect(index.lines).toHaveLength(40);
    expect(index.lines[0]).toMatch(/^- thema-\d+-mit-begriffen: Thema \d+ mit Begriffen \[ui, t\d+\]$/);
    expect(store.tags(projectId)[0]).toBe("ui");
  });

  it("merges entries into the first one through the tool and hints at overlaps when saving", async () => {
    const { tools, context } = projectTools({ id: "s1", projectId, cwd: path.join(t.dir, "web") } as Parameters<typeof projectTools>[0], { knowledge: store, dev: {} as DevEnvironment });
    expect(context.join("\n")).not.toContain("Aufräumen");
    const tool = (name: string) => tools.find((x) => x.name === name)!;
    const menu = "FORGE zeigt statt des Browser-Menüs ein eigenes Kontextmenü. ContextMenuHost sitzt einmal in der App. Listen und Karten melden ihre Einträge mit addContextItems an.";
    await tool("knowledge_save").run({ title: "Rechtsklick-Menü (ContextMenuHost)", summary: "Eigenes Kontextmenü", tags: ["ui"], content: menu });
    await tool("knowledge_save").run({ title: "Deploy auf Coolify", summary: "Wie wir ausliefern", tags: ["deploy"], content: "Coolify baut das Dockerfile, Traefik komprimiert." });
    const saved = await tool("knowledge_save").run({ title: "Kontextmenü erweitern", summary: "Neue Einträge anmelden", tags: ["ui"], content: "Neue Listen melden Einträge mit addContextItems an, ContextMenuHost zeigt sie statt des Browser-Menüs." });
    expect(saved).toMatch(/^Gespeichert: kontextmenue-erweitern .*Überschneidet sich stark mit: rechtsklick-menue-contextmenuhost/);

    const later = projectTools({ id: "s2", projectId, cwd: path.join(t.dir, "web") } as Parameters<typeof projectTools>[0], { knowledge: store, dev: {} as DevEnvironment });
    expect(later.context.join("\n")).toContain("Aufräumen: Diese Einträge überschneiden sich wahrscheinlich: kontextmenue-erweitern + rechtsklick-menue-contextmenuhost");

    const merge = later.tools.find((x) => x.name === "knowledge_merge")!;
    expect(await merge.run({ ids: ["rechtsklick-menue-contextmenuhost", "kontextmenue-erweitern"], title: "Rechtsklick-Menü (ContextMenuHost, addContextItems)", summary: "Eigenes Kontextmenü", content: `${menu} Neue Listen tun das auch.` })).toBe(
      "Zusammengeführt: rechtsklick-menue-contextmenuhost (.forge/knowledge/rechtsklick-menue-contextmenuhost.md). Gelöscht: kontextmenue-erweitern.",
    );
    expect(store.list(projectId).map((e) => e.id).sort()).toEqual(["deploy-auf-coolify", "rechtsklick-menue-contextmenuhost"]);
    expect((await store.read(projectId, "rechtsklick-menue-contextmenuhost")).tags).toEqual(["ui"]);
    await expect(merge.run({ ids: ["deploy-auf-coolify", "fehlt"], title: "Deploy", summary: "Wie wir ausliefern", content: "x" })).rejects.toThrow(/Kein Eintrag „fehlt“/);
    expect(store.list(projectId)).toHaveLength(2);
  });

  it("lets Claude draft the merged text from the full entries and cleans up its answer", async () => {
    await store.save(projectId, { id: null, title: "Deploy auf Coolify", summary: "Wie wir ausliefern", tags: ["deploy"], content: "Coolify baut das Dockerfile." });
    await store.save(projectId, { id: null, title: "Traefik", summary: "Proxy", tags: ["deploy", "proxy"], content: "Traefik komprimiert, nicht Next." });
    const prompts: string[] = [];
    let answer: unknown = { title: " Deploy (Coolify, Traefik) ", summary: "Wie wir ausliefern.", tags: ["Deploy", "proxy", "deploy"], content: "# Deploy\n\nCoolify baut, Traefik komprimiert." };
    const runtime = {
      completeJson: async (prompt: string, _schema: unknown, opts: { model: string }) => {
        prompts.push(`${opts.model}:${prompt}`);
        return answer;
      },
    } as unknown as ClaudeRuntime;
    db.updateSettings({ claudePath: process.execPath });
    const assist = new ClaudeAssist(db, projects, new GitEngine(), runtime);
    const entries = await Promise.all(["deploy-auf-coolify", "traefik"].map((id) => store.read(projectId, id)));

    expect(await assist.mergeKnowledge(projectId, entries)).toEqual({ title: "Deploy (Coolify, Traefik)", summary: "Wie wir ausliefern.", tags: ["deploy", "proxy"], content: "# Deploy\n\nCoolify baut, Traefik komprimiert.", model: MERGE_MODEL });
    expect(prompts[0]).toMatch(/^sonnet:Führe diese Einträge/);
    expect(prompts[0]).toContain("=== Eintrag traefik");
    expect(prompts[0]).toContain("Traefik komprimiert, nicht Next.");

    answer = { title: "x", summary: "", tags: [], content: " " };
    await expect(assist.mergeKnowledge(projectId, entries)).rejects.toThrow(/keinen zusammengeführten Eintrag/);
    await expect(assist.mergeKnowledge(projectId, entries.slice(0, 1))).rejects.toThrow(/mindestens zwei/);
  });

  it("lets Claude pick the groups to merge from the outline and keeps only groups that can be merged", async () => {
    await store.save(projectId, { id: null, title: "Deploy auf Coolify", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy\n\n## Dockerfile\nCoolify baut.\n\n## Proxy\nTraefik." });
    await store.save(projectId, { id: null, title: "Traefik", summary: "Proxy", tags: ["deploy"], content: "Traefik komprimiert, nicht Next." });
    await store.save(projectId, { id: null, title: "Sync", summary: "Abgleich", tags: ["sync"], content: "Über GitHub." });
    const prompts: string[] = [];
    let answer: unknown = {
      groups: [
        { ids: ["deploy-auf-coolify", "traefik", "traefik", "fehlt"], reason: " Beide beschreiben die Auslieferung. " },
        { ids: ["traefik", "sync"], reason: "Schon vergeben" },
        { ids: ["sync"], reason: "Allein" },
      ],
    };
    const runtime = {
      completeJson: async (prompt: string, _schema: unknown, opts: { model: string }) => {
        prompts.push(`${opts.model}:${prompt}`);
        return answer;
      },
    } as unknown as ClaudeRuntime;
    db.updateSettings({ claudePath: process.execPath });
    const assist = new ClaudeAssist(db, projects, new GitEngine(), runtime);
    const entries = store.entriesSync(projectId);

    expect(await assist.planKnowledgeMerge(projectId, entries, [{ a: "traefik", b: "deploy-auf-coolify", score: 0.6 }])).toEqual({
      groups: [{ ids: ["deploy-auf-coolify", "traefik"], reason: "Beide beschreiben die Auslieferung." }],
      model: MERGE_MODEL,
    });
    expect(prompts[0]).toMatch(/^sonnet:Prüfe das Projektwissen/);
    expect(prompts[0]).toContain("Gliederung: Dockerfile | Proxy");
    expect(prompts[0]).toContain("- traefik + deploy-auf-coolify (60 %)");
    expect(prompts[0]).not.toContain("Coolify baut.");

    answer = { nichts: true };
    await expect(assist.planKnowledgeMerge(projectId, entries, [])).rejects.toThrow(/keinen Plan/);
    expect(await assist.planKnowledgeMerge(projectId, entries.slice(0, 1), [])).toEqual({ groups: [], model: MERGE_MODEL });
    expect(prompts).toHaveLength(2);
  });
});

describe("knowledge prompts in English", () => {
  const entry = { id: "deploy", title: "Deploy", summary: "How to deploy", tags: ["release"], updatedAt: "2026-10-18T10:00:00.000Z", content: "# Deploy\n\n## Steps\nRun it." };
  afterEach(() => setLanguage("de"));

  it("asks Claude in English when English is set", () => {
    setLanguage("en");
    const merge = buildMergePrompt([entry, { ...entry, id: "deploy-2" }]);
    expect(merge).toMatch(/^Merge these entries from the project knowledge/);
    expect(merge).toContain("=== Entry deploy (as of 2026-10-18) ===\nTitle: Deploy\nSummary: How to deploy\nTags: release");
    const plan = buildMergePlanPrompt([entry], [{ a: "deploy", b: "deploy-2", score: 0.7 }]);
    expect(plan).toContain("Outline: Steps");
    expect(plan).toContain("A local word comparison");
    const fix = buildFixPrompt(entry, [{ ref: "src/old.ts", kind: "path" }], "");
    expect(fix).toContain("Missing references: `src/old.ts`");
    expect(fix).toContain("Hints from the project:\n(none)");
    expect(JSON.stringify(MERGE_SCHEMA)).toContain("the merged entry in Markdown");
    expect(JSON.stringify(MERGE_PLAN_SCHEMA)).toContain("one short sentence");
    setLanguage("de");
    expect(buildMergePrompt([entry])).toMatch(/^Führe diese Einträge/);
    expect(JSON.stringify(MERGE_SCHEMA)).toContain("der zusammengeführte Eintrag in Markdown");
  });
});
