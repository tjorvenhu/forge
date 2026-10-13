import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { connectionUrl, dbNameFor, DevToolsService, FIRST_DB_PORT, parseDotenv } from "../src/devtools/dev-tools.js";
import { DevEnvironment } from "../src/devtools/environment.js";
import { failureReason, TestDbService } from "../src/devtools/test-db.js";
import { DevServerService } from "../src/devserver/dev-server.js";
import { KnowledgeStore, parseEntry, rank, serializeEntry, slugifyId, titleOverlap } from "../src/knowledge/knowledge.js";
import { projectTools } from "../src/sessions/forge-tools.js";
import { tempDir } from "./helpers.js";

describe("parseDotenv", () => {
  it("reads the usual .env forms", () => {
    const env = parseDotenv(
      [
        "# Kommentar",
        "PLAIN=wert",
        "export EXPORTED=ja",
        "SPACED = mit leerzeichen  ",
        'DOUBLE="zeile1\\nzeile2"',
        "SINGLE='kein \\n umbruch'",
        "COMMENTED=abc # dahinter",
        'MULTI="a',
        'b"',
        "EMPTY=",
        "PLAIN=später",
        "kaputt ohne gleich",
      ].join("\r\n"),
    );
    expect(env).toEqual({
      PLAIN: "später",
      EXPORTED: "ja",
      SPACED: "mit leerzeichen",
      DOUBLE: "zeile1\nzeile2",
      SINGLE: "kein \\n umbruch",
      COMMENTED: "abc",
      MULTI: "a\nb",
      EMPTY: "",
    });
  });
});

describe("dbNameFor", () => {
  it("makes a valid database name from a project name", () => {
    expect(dbNameFor("Mein Shop 2")).toBe("mein_shop_2");
    expect(dbNameFor("Größe & Übersicht")).toBe("groesse_uebersicht");
    expect(dbNameFor("2048-game")).toBe("db_2048_game");
    expect(dbNameFor("!!!")).toBe("app");
  });
});

describe("knowledge format and ranking", () => {
  it("round-trips entries and reads hand-written files", () => {
    const text = serializeEntry({ title: 'Auth "neu"', summary: "Wie Login läuft", tags: ["auth", "supabase"], updatedAt: "2026-10-13T08:00:00.000Z", content: "# Auth\n\nText" });
    expect(parseEntry("auth", text, new Date(0))).toEqual({ id: "auth", title: 'Auth "neu"', summary: "Wie Login läuft", tags: ["auth", "supabase"], updatedAt: "2026-10-13T08:00:00.000Z", content: "# Auth\n\nText\n" });

    const hand = parseEntry("deploy", "---\ntitle: Deploy auf Coolify\ntags: [deploy, docker]\n---\nErster Satz zum Deploy.\n", new Date("2026-01-01T00:00:00Z"));
    expect(hand).toMatchObject({ title: "Deploy auf Coolify", tags: ["deploy", "docker"], summary: "Erster Satz zum Deploy.", updatedAt: "2026-01-01T00:00:00.000Z" });

    const bare = parseEntry("notiz", "# Überschrift\n\nInhalt", new Date(0));
    expect(bare).toMatchObject({ title: "Überschrift", summary: "Überschrift" });
  });

  it("slugs titles and compares them", () => {
    expect(slugifyId("Datenbank-Migrationen mit Prisma!")).toBe("datenbank-migrationen-mit-prisma");
    expect(slugifyId("Größen")).toBe("groessen");
    expect(titleOverlap("Migrationen mit Prisma", "Prisma Migrationen")).toBe(1);
    expect(titleOverlap("Deploy", "Tests")).toBe(0);
  });

  it("ranks title and tag hits above body hits and needs all words for the top spot", () => {
    const e = (id: string, title: string, tags: string[], content: string) => ({ id, title, summary: "", tags, updatedAt: "", content });
    const hits = rank(
      [
        e("body", "Allgemeines", [], "Hier steht nebenbei etwas zu prisma und migration."),
        e("title", "Prisma-Migrationen", ["datenbank"], "Ablauf."),
        e("other", "Deploy", ["coolify"], "Nichts davon."),
      ],
      "prisma migration",
    );
    expect(hits.map((h) => h.id)).toEqual(["title", "body"]);
    expect(hits[1]!.snippet).toContain("prisma");
  });
});

describe("services", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let projectId: string;
  let otherId: string;

  beforeEach(async () => {
    t = tempDir();
    mkdirSync(path.join(t.dir, "web"), { recursive: true });
    mkdirSync(path.join(t.dir, "api"), { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, new GitEngine(), () => "balanced");
    projectId = (await projects.import(path.join(t.dir, "web"))).id;
    otherId = (await projects.import(path.join(t.dir, "api"))).id;
  });

  afterEach(() => {
    db.close();
    t.cleanup();
  });

  it("keeps dev tools per project with stable, distinct ports", () => {
    const tools = new DevToolsService(db, projects);
    const a = tools.get(projectId);
    expect(a.database).toMatchObject({ port: FIRST_DB_PORT, name: "web", envVar: "DATABASE_URL", withDevServer: false });
    expect(a.database.password).toMatch(/^[0-9a-f]{24}$/);
    expect(tools.get(projectId)).toEqual(a);
    expect(tools.get(otherId).database.port).toBe(FIRST_DB_PORT + 1);
    expect(() => tools.update(projectId, { database: { port: FIRST_DB_PORT + 1 } })).toThrow(/anderen Projekts/);

    const next = tools.update(projectId, { env: "API_URL=http://localhost:4000\nSECRET='x'", database: { name: "shop_test" } });
    expect(next.database).toMatchObject({ name: "shop_test", password: a.database.password });
    expect(tools.testVariables(projectId)).toEqual({ API_URL: "http://localhost:4000", SECRET: "x" });
    tools.update(projectId, { useEnv: false });
    expect(tools.testVariables(projectId)).toEqual({});
    expect(connectionUrl(next.database)).toBe(`postgresql://forge:${a.database.password}@127.0.0.1:${FIRST_DB_PORT}/shop_test`);
  });

  it("lists only .env files of the project root, examples first", async () => {
    const dir = path.join(t.dir, "web");
    writeFileSync(path.join(dir, ".env"), "A=1");
    writeFileSync(path.join(dir, ".env.example"), "A=");
    writeFileSync(path.join(dir, ".envrc"), "x");
    mkdirSync(path.join(dir, ".env.d"));
    const tools = new DevToolsService(db, projects);
    expect(await tools.envFiles(projectId)).toEqual([".env.example", ".env"]);
    expect(await tools.readEnvFile(projectId, ".env")).toBe("A=1");
    await expect(tools.readEnvFile(projectId, "../api/.env")).rejects.toThrow(/Keine Datei/);
  });

  it("passes the test environment to the dev server and notes it in the output", async () => {
    const tools = new DevToolsService(db, projects);
    tools.update(projectId, { env: "FORGE_TEST_VAR=hallo" });
    const testDb = new TestDbService({ dataDir: t.dir, devTools: tools, emit: () => {}, binDir: path.join(t.dir, "no-pg") });
    const env: DevEnvironment = new DevEnvironment(tools, testDb, () => devServers);
    const devServers = new DevServerService(projects, () => ({ ...process.env }) as Record<string, string>, () => {}, (id) => env.devServerPrep(id));
    const script = path.join(t.dir, "web", "echo.cjs");
    writeFileSync(script, "console.log('VAR=' + process.env.FORGE_TEST_VAR); setInterval(() => {}, 1000);\n");
    projects.update(projectId, { devCommand: `node "${script}"` });
    await devServers.start(projectId);
    const deadline = Date.now() + 15_000;
    while (!devServers.output(projectId).includes("VAR=") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(devServers.output(projectId)).toContain("[FORGE] Test-Umgebung: FORGE_TEST_VAR");
    expect(devServers.output(projectId)).toContain("VAR=hallo");
    await devServers.stop(projectId);
    const described = await env.describe(projectId);
    expect(described).toContain("Variablen FORGE_TEST_VAR");
    expect(described.split("\n").find((l) => l.startsWith("Test-Umgebung"))).not.toContain("hallo");
  }, 30_000);

  it("stores knowledge in the project, finds it and refuses near duplicates", async () => {
    const changed: string[] = [];
    const store = new KnowledgeStore(projects, (id) => changed.push(id));
    const saved = await store.save(projectId, { id: null, title: "Prisma Migrationen", summary: "Wie Migrationen laufen", tags: ["DB", "prisma"], content: "Immer `pnpm prisma migrate dev`." });
    expect(saved).toMatchObject({ id: "prisma-migrationen", tags: ["db", "prisma"] });
    expect(existsSync(path.join(t.dir, "web", ".forge", "knowledge", "prisma-migrationen.md"))).toBe(true);
    expect(changed).toEqual([projectId]);
    const second = await store.save(projectId, { id: null, title: "Prisma Migrationen", summary: "", tags: [], content: "x" });
    expect(second.id).toBe("prisma-migrationen-2");
    await store.delete(projectId, second.id);

    expect(store.search(projectId, "migrate")[0]?.id).toBe("prisma-migrationen");
    expect(store.index(projectId)).toEqual({ lines: ["- prisma-migrationen: Prisma Migrationen. Wie Migrationen laufen [db, prisma]"], total: 1 });
    await expect(store.read(projectId, "../../secret")).rejects.toThrow(/Ungültige Kennung/);

    const { tools, context } = projectTools(
      { id: "s1", projectId, cwd: path.join(t.dir, "web") } as Parameters<typeof projectTools>[0],
      { knowledge: store, dev: {} as DevEnvironment },
    );
    expect(context.join("\n")).toContain("prisma-migrationen: Prisma Migrationen");
    const save = tools.find((x) => x.name === "knowledge_save")!;
    expect(await save.run({ title: "Migrationen mit Prisma", summary: "Doppelt", content: "y" })).toMatch(/Nicht gespeichert.*prisma-migrationen/);
    expect(await save.run({ id: "prisma-migrationen", title: "Prisma Migrationen", summary: "Neu", content: "Neuer Text" })).toMatch(/^Aktualisiert/);
    expect((await store.read(projectId, "prisma-migrationen")).tags).toEqual(["db", "prisma"]);
  });

  it("explains a failed start from the PostgreSQL log", () => {
    expect(failureReason('2026-10-13 LOG:  starting\n2026-10-13 FATAL:  could not bind IPv4 address "127.0.0.1": Address already in use\n')).toBe(
      'could not bind IPv4 address "127.0.0.1": Address already in use',
    );
    expect(failureReason("LOG: alles gut")).toBeNull();
  });

  // Real PostgreSQL: set FORGE_TEST_PG_BIN to the bin folder of the binaries (see devtools/test-db.ts).
  it.skipIf(!process.env.FORGE_TEST_PG_BIN)(
    "initializes, starts, renames, stops and resets a real PostgreSQL",
    async () => {
      const tools = new DevToolsService(db, projects);
      tools.update(projectId, { database: { port: 55000 + Math.floor(Math.random() * 500) } });
      const states: string[] = [];
      const testDb = new TestDbService({ dataDir: t.dir, devTools: tools, emit: (s) => states.push(s.status), binDir: process.env.FORGE_TEST_PG_BIN });
      try {
        const up = await testDb.start(projectId);
        expect(up).toMatchObject({ status: "running", installed: true, initialized: true });
        expect(states).toContain("starting");
        expect(testDb.log(projectId)).toMatch(/ready to accept connections/);
        const created = JSON.parse(readFileSync(path.join(t.dir, "testdb", projectId, "databases.json"), "utf8")) as string[];
        expect(created).toEqual(["web"]);

        await testDb.stop(projectId);
        expect(testDb.state(projectId).status).toBe("stopped");
        tools.update(projectId, { database: { name: "web_zwei" } });
        expect((await testDb.start(projectId)).url).toMatch(/\/web_zwei$/);
        await testDb.stop(projectId);
        expect(JSON.parse(readFileSync(path.join(t.dir, "testdb", projectId, "databases.json"), "utf8"))).toEqual(["web", "web_zwei"]);

        await testDb.reset(projectId);
        expect(testDb.state(projectId)).toMatchObject({ status: "stopped", initialized: false });
      } finally {
        testDb.shutdown();
      }
    },
    180_000,
  );
});
