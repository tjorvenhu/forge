import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEARCH_MARK_END, SEARCH_MARK_START, type DevServerState } from "@forge/protocol";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { detectDevCommand } from "../src/projects/tech.js";
import { DevServerService, findLocalUrl, stripAnsi } from "../src/devserver/dev-server.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let db: Db;
let projects: ProjectManager;
let projectId: string;

beforeEach(async () => {
  t = tempDir();
  mkdirSync(path.join(t.dir, "web"), { recursive: true });
  db = new Db(path.join(t.dir, "forge.db"));
  projects = new ProjectManager(db, new GitEngine(), () => "balanced");
  projectId = (await projects.import(path.join(t.dir, "web"))).id;
});
afterEach(() => {
  db.close();
  t.cleanup();
});

function addSession(id: string, title: string) {
  const now = new Date().toISOString();
  db.insertSession({
    id,
    projectId,
    claudeSessionId: null,
    cwd: t.dir,
    title,
    model: null,
    effort: null,
    profile: "balanced",
    permissionMode: "acceptEdits",
    status: "stopped",
    apiKeySource: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  });
}

describe("full-text search over session timelines", () => {
  it("finds prompts and answers by word prefix, ignoring case and accents", () => {
    addSession("s1", "Datenbank");
    db.appendEvent("s1", { type: "user.message", text: "Wie läuft die Migration der Tabelle?" });
    db.appendEvent("s1", { type: "assistant.text", messageId: "m1", index: 0, text: "Die MIGRATION ist in db.ts, Schritt 6." });
    db.appendEvent("s1", { type: "tool.use", toolUseId: "t", name: "Read", input: { note: "migration" }, parentToolUseId: null });

    const hits = db.searchEvents("migra", 10);
    expect(hits.map((h) => h.role).sort()).toEqual(["assistant", "user"]);
    expect(hits[0]).toMatchObject({ sessionId: "s1", projectId, sessionTitle: "Datenbank", projectName: "web" });
    expect(hits.find((h) => h.role === "user")!.snippet).toContain(`${SEARCH_MARK_START}Migration${SEARCH_MARK_END}`);
    expect(db.searchEvents("LAUFT tabelle", 10)).toHaveLength(1);
    expect(db.searchEvents("migration nirgends", 10)).toHaveLength(0);
  });

  it("treats FTS syntax in the query as plain words", () => {
    addSession("s2", "x");
    db.appendEvent("s2", { type: "user.message", text: "foo OR bar" });
    expect(() => db.searchEvents('"foo* NEAR( ) -', 10)).not.toThrow();
    expect(db.searchEvents("((( ***", 10)).toEqual([]);
  });

  it("drops hits together with the session", () => {
    addSession("s3", "weg");
    db.appendEvent("s3", { type: "user.message", text: "Einmalig Zitronenfalter" });
    expect(db.searchEvents("zitronen", 5)).toHaveLength(1);
    db.deleteSession("s3");
    expect(db.searchEvents("zitronen", 5)).toHaveLength(0);
  });
});

describe("dev server", () => {
  it("detects the dev command from package.json", async () => {
    const dir = path.join(t.dir, "web");
    expect(await detectDevCommand(dir)).toBeNull();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "node s.js" } }));
    expect(await detectDevCommand(dir)).toBe("npm start");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", start: "x" } }));
    expect(await detectDevCommand(dir)).toBe("npm run dev");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    expect(await detectDevCommand(dir)).toBe("pnpm dev");
  });

  it("finds the local address in typical dev server output", () => {
    expect(findLocalUrl("  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m")).toBe("http://localhost:5173/");
    expect(findLocalUrl("   - Network: http://192.168.1.4:3000\n   - Local:   http://localhost:3000")).toBe("http://localhost:3000");
    expect(findLocalUrl("Listening on http://0.0.0.0:8000.")).toBe("http://localhost:8000");
    expect(findLocalUrl("ready in 300 ms")).toBeNull();
    expect(stripAnsi("\u001b[1mfett\u001b[22m")).toBe("fett");
  });

  it("starts the command, reports the address and output, and stops the whole process tree", async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const svc = new DevServerService(projects, () => ({ ...process.env }) as Record<string, string>, (e) => events.push(e));
    await expect(svc.start(projectId)).rejects.toThrow(/Kein Dev-Server-Befehl/);

    const script = path.join(t.dir, "web", "server.cjs");
    writeFileSync(script, "console.log('  Local: http://localhost:4321/');\nsetInterval(() => {}, 1000);\n");
    projects.update(projectId, { devCommand: `node "${script}"` });
    const started = await svc.start(projectId);
    expect(started).toMatchObject({ status: "running", command: `node "${script}"` });

    const deadline = Date.now() + 15_000;
    while (!(await svc.state(projectId)).url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect((await svc.state(projectId)).url).toBe("http://localhost:4321/");
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.output(projectId)).toContain("Local: http://localhost:4321/");
    expect(events.some((e) => e.event === "devserver.output")).toBe(true);

    const stopped = await svc.stop(projectId);
    expect(stopped.status).toBe("stopped");
    const last = events.filter((e) => e.event === "devserver.updated").at(-1)?.payload as DevServerState;
    expect(last.status).toBe("stopped");
  }, 30_000);

  it("starts only one process on a double click", async () => {
    const script = path.join(t.dir, "web", "count.cjs");
    const marker = path.join(t.dir, "starts.txt");
    writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");\nsetInterval(() => {}, 1000);\n`);
    projects.update(projectId, { devCommand: `node "${script}"` });
    const svc = new DevServerService(projects, () => ({ ...process.env }) as Record<string, string>, () => {});
    const [a, b] = await Promise.all([svc.start(projectId), svc.start(projectId)]);
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    const deadline = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1000));
    expect(readFileSync(marker, "utf8")).toBe("x");
    await svc.stop(projectId);
  }, 30_000);

  it("reports a command that exits on its own", async () => {
    const svc = new DevServerService(projects, () => ({ ...process.env }) as Record<string, string>, () => {});
    projects.update(projectId, { devCommand: `node -e "process.exit(4)"` });
    await svc.start(projectId);
    const deadline = Date.now() + 15_000;
    while ((await svc.state(projectId)).status === "running" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(await svc.state(projectId)).toMatchObject({ status: "exited", exitCode: 4 });
    expect(svc.output(projectId)).toContain("Exit-Code 4");
  }, 30_000);
});
