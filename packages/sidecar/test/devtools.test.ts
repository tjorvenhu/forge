import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { connectionUrl, dbNameFor, DevToolsService, FIRST_DB_PORT, parseDotenv } from "../src/devtools/dev-tools.js";
import { DevEnvironment } from "../src/devtools/environment.js";
import { failureReason, POSTGRES, postgresPackage, TestDbService } from "../src/devtools/test-db.js";
import { DevServerService } from "../src/devserver/dev-server.js";
import type { WorktreeSetup } from "../src/automation/worktree-setup.js";
import { covering, KnowledgeStore, overlaps, parseEntry, rank, serializeEntry, slugifyId, titleOverlap } from "../src/knowledge/knowledge.js";
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

  it("finds entries that cover the same topic, not those that merely share words", () => {
    const e = (id: string, title: string, tags: string[], content: string) => ({ id, title, summary: "", tags, updatedAt: "", content });
    const menu = e(
      "kontextmenue",
      "Rechtsklick-Menü (ContextMenuHost, addContextItems)",
      ["ui", "kontextmenue"],
      "FORGE zeigt statt des Browser-Menüs ein eigenes Kontextmenü. ContextMenuHost sitzt einmal in der App. Listen und Karten melden ihre Einträge mit addContextItems an; Trenner und Untermenüs gehen über die Gruppe.",
    );
    const deploy = e("deploy", "Deploy auf Coolify", ["deploy", "docker"], "Coolify baut das Dockerfile, Traefik komprimiert. Umgebungsvariablen stehen in Coolify, nicht in Dateien im Repo.");
    const tests = e("tests", "Tests im Gesamtlauf", ["tests", "ui"], "Vitest läuft pro Paket. Lange Tests bekommen eigene Zeitlimits, sonst scheitern sie im Gesamtlauf.");
    const note = e("notiz", "Kontextmenü erweitern", ["ui", "kontextmenue"], "Neue Listen melden ihre Einträge mit addContextItems an, ContextMenuHost zeigt sie statt des Browser-Menüs.");

    expect(overlaps([menu, deploy, tests, note]).map((o) => [o.a, o.b])).toEqual([["notiz", "kontextmenue"]]);
    expect(covering([menu, deploy, tests], note).map((c) => c.id)).toEqual(["kontextmenue"]);
    expect(covering([menu, deploy, tests], { ...deploy, title: "Coolify", content: "Traefik komprimiert, Coolify baut das Dockerfile." }).map((c) => c.id)).toEqual(["deploy"]);
    expect(covering([menu, deploy], tests)).toEqual([]);
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

  it("runs an agent's dev server with its own port and says so", async () => {
    const tools = new DevToolsService(db, projects);
    const testDb = new TestDbService({ dataDir: t.dir, devTools: tools, emit: () => {}, binDir: path.join(t.dir, "no-pg") });
    const script = path.join(t.dir, "web", "port.cjs");
    writeFileSync(script, "console.log('PORT=' + process.env.PORT + ' ARGS=' + process.argv.slice(2).join(' ')); setInterval(() => {}, 1000);\n");
    const setup = {
      devServerPort: async (_id: string, command: string) => ({ env: { PORT: "4100" }, command: `${command} --port 4100`, note: "Eigener Port dieses Agenten: 4100" }),
    } as unknown as WorktreeSetup;
    const env: DevEnvironment = new DevEnvironment(tools, testDb, () => devServers, () => setup);
    const devServers = new DevServerService(projects, () => ({ ...process.env }) as Record<string, string>, () => {}, (id, command) => env.devServerPrep(id, command));
    projects.update(projectId, { devCommand: `node "${script}"` });
    const st = await devServers.start(projectId);
    expect(st.command).toBe(`node "${script}" --port 4100`);
    const deadline = Date.now() + 15_000;
    while (!devServers.output(projectId).includes("PORT=") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(devServers.output(projectId)).toContain("[FORGE] Eigener Port dieses Agenten: 4100");
    expect(devServers.output(projectId)).toContain("PORT=4100 ARGS=--port 4100");
    await devServers.stop(projectId);
  }, 30_000);

  it("gives an agent its own copy of the project's test database and deletes it with the agent", async () => {
    const tools = new DevToolsService(db, projects);
    const wtDir = path.join(t.dir, "web-agent");
    mkdirSync(wtDir, { recursive: true });
    const wtId = (await projects.import(wtDir, projectId)).id;
    const testDb = new TestDbService({ dataDir: t.dir, devTools: tools, emit: () => {}, binDir: path.join(t.dir, "no-pg") });
    expect(await testDb.seed(projectId)).toBe("none");
    expect(await testDb.seed(wtId)).toBe("none");

    const base = path.join(t.dir, "testdb", projectId);
    mkdirSync(path.join(base, "data", "base"), { recursive: true });
    writeFileSync(path.join(base, "data", "PG_VERSION"), "17");
    writeFileSync(path.join(base, "data", "base", "1"), "tabelle");
    // Left behind by a server that is gone: without pg_ctl it counts as not running.
    writeFileSync(path.join(base, "data", "postmaster.pid"), "123\n");
    writeFileSync(path.join(base, "databases.json"), '["web"]');
    expect(await testDb.seed(wtId)).toBe("copied");
    const own = path.join(t.dir, "testdb", wtId);
    expect(readFileSync(path.join(own, "data", "base", "1"), "utf8")).toBe("tabelle");
    expect(existsSync(path.join(own, "data", "postmaster.pid"))).toBe(false);
    expect(readFileSync(path.join(own, "databases.json"), "utf8")).toBe('["web"]');
    expect(await testDb.seed(wtId)).toBe("exists");
    expect(testDb.state(wtId)).toMatchObject({ projectId: wtId, initialized: true });

    await testDb.forget(wtId);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(path.join(base, "data", "PG_VERSION"))).toBe(true);
  });

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
    expect(store.index(projectId)).toEqual({ lines: ["- prisma-migrationen: Prisma Migrationen. Wie Migrationen laufen [db, prisma]"], total: 1, summaries: true });
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

  it("keeps the valid parts of a stored configuration with a broken field", () => {
    const tools = new DevToolsService(db, projects);
    db.setDevTools(projectId, { env: "A=1", useEnv: false, database: { port: 54400, name: "Kaputt Name!", password: "geheim", withDevServer: true, envVar: null } });
    expect(tools.get(projectId)).toEqual({ env: "A=1", useEnv: false, database: { port: 54400, name: "web", password: "geheim", withDevServer: true, envVar: null } });
    expect(db.getDevTools(projectId)).toMatchObject({ database: { name: "web", password: "geheim" } });

    db.setDevTools(otherId, { env: 42, database: { port: "x" } });
    const fresh = tools.get(otherId);
    expect(fresh).toMatchObject({ env: "", useEnv: true, database: { name: "api", withDevServer: false, envVar: "DATABASE_URL" } });
    expect(fresh.database.port).not.toBe(54400);
    expect(fresh.database.password).toMatch(/^[0-9a-f]{24}$/);
  });

  const whereExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  it.skipIf(!existsSync(whereExe))("stops and deletes in one job on reset, so a start cannot slip in between", async () => {
    // where.exe stands in for the binaries: it rejects PostgreSQL's arguments at once, which is enough here.
    const bin = path.join(t.dir, "fake-pg");
    mkdirSync(bin, { recursive: true });
    for (const n of ["pg_ctl", "postgres", "initdb"]) copyFileSync(whereExe, path.join(bin, `${n}.exe`));
    const tools = new DevToolsService(db, projects);
    const states: string[] = [];
    const testDb = new TestDbService({ dataDir: t.dir, devTools: tools, emit: (s) => states.push(s.status), binDir: bin });
    const data = path.join(t.dir, "testdb", projectId, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, "PG_VERSION"), "17");

    const reset = testDb.reset(projectId);
    const start = testDb.start(projectId).catch((e: Error) => e);
    await reset;
    expect(await start).toBeInstanceOf(Error);
    expect(states.indexOf("starting")).toBeGreaterThan(states.lastIndexOf("stopped"));
    expect(existsSync(path.join(data, "PG_VERSION"))).toBe(false);

    await testDb.forget(projectId);
    expect(existsSync(path.join(t.dir, "testdb", projectId))).toBe(false);
  });

  it("gives up on a PostgreSQL download that does not answer or stalls and frees the queue", async () => {
    const tools = new DevToolsService(db, projects);
    const progress = new Map<string, number[]>();
    const testDb = new TestDbService({
      dataDir: t.dir,
      devTools: tools,
      emit: (s) => {
        if (s.status === "installing" && s.progress) progress.set(s.projectId, [...(progress.get(s.projectId) ?? []), s.progress]);
      },
      binDir: path.join(t.dir, "pg", POSTGRES.build, "bin"),
      download: { url: "http://127.0.0.1:9/pg.tgz", connectMs: 100, stallMs: 200 },
    });
    try {
      // fetch that never answers but honors the abort signal, like a dead connection
      vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
      await expect(testDb.start(projectId)).rejects.toThrow(/antwortet nicht/);
      expect(testDb.state(projectId)).toMatchObject({ status: "failed", progress: null });
      expect(testDb.state(projectId).error).toMatch(/antwortet nicht/);

      // Body that sends 60 % and then nothing more; two projects start at once and share the download.
      vi.stubGlobal("fetch", async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(600));
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": "1000" } });
      });
      const started = Date.now();
      const both = await Promise.allSettled([testDb.start(projectId), testDb.start(otherId)]);
      expect(Date.now() - started).toBeLessThan(5000);
      for (const r of both) expect(r.status === "rejected" && String(r.reason)).toMatch(/keine Daten/);
      expect(progress.get(projectId)).toContain(0.6);
      expect(progress.get(otherId)).toContain(0.6);

      // The queue is free again.
      expect((await testDb.stop(projectId)).status).toBe("stopped");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("explains a failed start from the PostgreSQL log", () => {
    expect(failureReason('2026-10-13 LOG:  starting\n2026-10-13 FATAL:  could not bind IPv4 address "127.0.0.1": Address already in use\n')).toBe(
      'could not bind IPv4 address "127.0.0.1": Address already in use',
    );
    expect(failureReason("LOG: alles gut")).toBeNull();
  });

  it("pins one PostgreSQL package per platform, all of the same build", () => {
    expect(postgresPackage("win32-x64")).toMatchObject({ url: "https://registry.npmjs.org/@embedded-postgres/windows-x64/-/windows-x64-17.10.0-beta.17.tgz", size: 37_794_841 });
    const all = (["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"] as const).map((t) => postgresPackage(t));
    expect(new Set(all.map((p) => p.build)).size).toBe(1);
    expect(new Set(all.map((p) => p.integrity)).size).toBe(4);
    for (const p of all) expect(p.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(postgresPackage("linux-x64").url).toContain("@embedded-postgres/linux-x64/-/linux-x64-");
    expect(POSTGRES.build).toBe(all[0]!.build);
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

  it.skipIf(!process.env.FORGE_TEST_PG_BIN)(
    "runs an agent's copy of a real PostgreSQL beside the project's, on its own port",
    async () => {
      const tools = new DevToolsService(db, projects);
      const port = 55000 + Math.floor(Math.random() * 300);
      tools.update(projectId, { database: { port } });
      const wtDir = path.join(t.dir, "web-agent");
      mkdirSync(wtDir, { recursive: true });
      const wtId = (await projects.import(wtDir, projectId)).id;
      const testDb = new TestDbService({ dataDir: t.dir, devTools: tools, emit: () => {}, binDir: process.env.FORGE_TEST_PG_BIN });
      try {
        await testDb.start(projectId);
        // A file copy of a running server would not be consistent.
        expect(await testDb.seed(wtId)).toBe("parent-running");
        await testDb.stop(projectId);
        expect(await testDb.seed(wtId)).toBe("copied");
        const [main, agent] = await Promise.all([testDb.start(projectId), testDb.start(wtId)]);
        expect(main.url).toContain(`:${port}/web`);
        expect(agent.status).toBe("running");
        const agentPort = Number(/:(\d+)\//.exec(agent.url)?.[1]);
        expect(agentPort).toBeGreaterThanOrEqual(55330);
        expect(agentPort).not.toBe(port);
        expect(agent.url).toMatch(/\/web$/);
        await testDb.forget(wtId);
        expect(existsSync(path.join(t.dir, "testdb", wtId))).toBe(false);
        expect(testDb.state(projectId).status).toBe("running");
        await testDb.stop(projectId);
      } finally {
        testDb.shutdown();
      }
    },
    180_000,
  );
});
