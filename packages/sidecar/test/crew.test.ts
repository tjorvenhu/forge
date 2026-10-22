import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Crew, Project, ServerEvent, Session } from "@forge/protocol";
import { createRelayServer } from "../../../services/stats/src/lib/crew-relay-node.js";
import { CrewService } from "../src/crew/crew-service.js";
import { fingerprint, newKey, newKeyPair, open, seal, sharedKey } from "../src/crew/crypto.js";
import { crewSessionTools, describeCrew } from "../src/crew/session-tools.js";
import { mergeTask, overlap, pruneTasks } from "../src/crew/state.js";
import { decodeInvite, encodeInvite, type TaskEntry } from "../src/crew/wire.js";
import { GitEngine } from "../src/git/git.js";
import { git, initRepo, tempDir } from "./helpers.js";

function project(id: string, dir: string): Project {
  return {
    id, name: id, path: dir, favorite: false, group: null, tags: [], technologies: [], profile: "balanced",
    defaultModel: null, defaultEffort: null, createdAt: "", lastOpenedAt: null, testCommand: null, devCommand: null,
    parentId: null, gitEnabled: true, agentsEnabled: true, teamsEnabled: true, exists: true,
  };
}

function session(id: string, projectId: string, cwd: string, title: string): Session {
  return {
    id, projectId, claudeSessionId: null, cwd, title, model: null, effort: null, profile: "balanced", permissionMode: "default",
    status: "idle", apiKeySource: null, createdAt: "", updatedAt: "", lastError: null, live: true, background: [], subagents: [], context: null, autoContinueAt: null,
  };
}

async function waitFor<T>(what: string, check: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe("crew building blocks", () => {
  it("seals with the crew key and binds the box to its room", () => {
    const key = newKey();
    const box = seal(key, "hallo", "room|room:1");
    expect(open(key, box, "room|room:1")).toBe("hallo");
    expect(open(key, box, "other|room:1")).toBeNull();
    expect(open(newKey(), box, "room|room:1")).toBeNull();
  });

  it("gives two members the same shared key, and a stranger another", () => {
    const a = newKeyPair();
    const b = newKeyPair();
    const c = newKeyPair();
    expect(sharedKey(a, b.pub, "grant:1")).toBe(sharedKey(b, a.pub, "grant:1"));
    expect(sharedKey(a, b.pub, "grant:1")).not.toBe(sharedKey(c, b.pub, "grant:1"));
    expect(sharedKey(a, b.pub, "grant:1")).not.toBe(sharedKey(a, b.pub, "grant:2"));
    expect(fingerprint(a.pub)).toMatch(/^\d{4}-\d{4}$/);
  });

  it("reads back what an invite code carries and refuses garbage", () => {
    const code = encodeInvite({ v: 1, u: "https://relay.example", r: "abcdefghijklmnopqrstuv", i: "inv", k: newKey(), x: 2_000_000_000, n: "Crew", p: "app", o: "github.com/a/b", c: "https://github.com/a/b.git", f: "Anna" });
    expect(decodeInvite(`  ${code}\n`)?.n).toBe("Crew");
    expect(decodeInvite("forge-crew1.kaputt")).toBeNull();
    expect(decodeInvite("hallo")).toBeNull();
  });

  it("keeps the newest version of a task on every member", () => {
    const t = (updatedAt: string, title: string): TaskEntry => ({ id: "t1", title, detail: "", status: "open", createdBy: "a", assignee: null, owner: null, note: null, source: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt });
    const tasks = [t("2026-01-01T00:00:01.000Z", "alt")];
    expect(mergeTask(tasks, t("2026-01-01T00:00:00.500Z", "älter"))).toBe(false);
    expect(mergeTask(tasks, t("2026-01-01T00:00:02.000Z", "neu"))).toBe(true);
    expect(tasks[0]!.title).toBe("neu");
    const pruned = pruneTasks([{ ...t("2020-01-01T00:00:00.000Z", "weg"), deleted: true }, t("2026-01-01T00:00:00.000Z", "bleibt")], Date.parse("2026-01-02T00:00:00.000Z"));
    expect(pruned.map((x) => x.title)).toEqual(["bleibt"]);
  });

  it("finds files both members touch, regardless of slashes and case", () => {
    expect(overlap(["src\\App.tsx", "README.md"], ["src/app.tsx", "x"])).toEqual(["src\\App.tsx"]);
  });
});

describe("two FORGE installations in one crew", () => {
  let t: ReturnType<typeof tempDir>;
  let relay: ReturnType<typeof createRelayServer>;
  let relayUrl: string;
  const services: CrewService[] = [];

  beforeEach(async () => {
    t = tempDir("forge-crew-");
    mkdirSync(t.dir, { recursive: true });
    relay = createRelayServer({ heartbeatMs: 1_000 });
    await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", () => r()));
    // CREW_TEST_RELAY: base URL of a running website (next start) to test the real routes instead.
    relayUrl = process.env.CREW_TEST_RELAY ?? `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}/crew`;
  });

  afterEach(async () => {
    for (const s of services.splice(0)) s.stop();
    await relay.close();
    // git commands and saves already under way finish on their own; Windows keeps their files open until then.
    for (let i = 0; ; i++) {
      try {
        t.cleanup();
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  /** One installation: its own data folder, secrets, project checkout and sessions. */
  function installation(name: string, dir: string, projectId: string) {
    const secrets = new Map<string, string>();
    const events: ServerEvent[] = [];
    const sessions = new Map<string, Session>();
    const started: Array<{ projectId: string; prompt: string; team?: boolean }> = [];
    const proj = project(projectId, dir);
    const dataDir = path.join(t.dir, `data-${name}`);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "profile.json"), JSON.stringify({ name, color: "#3e8cf0", relayUrl }));
    const make = () =>
      new CrewService({
        dir: dataDir,
        secrets: {
          get: async (n) => secrets.get(n) ?? null,
          set: async (n, v) => void (v ? secrets.set(n, v) : secrets.delete(n)),
        },
        projects: () => [proj],
        git: new GitEngine(),
        sessions: {
          get: (id) => sessions.get(id) ?? null,
          start: async (pid, prompt) => {
            started.push({ projectId: pid, prompt });
            const s = session(`task-${started.length}`, pid, dir, "Crew-Aufgabe");
            sessions.set(s.id, s);
            return s;
          },
          startTeam: async (pid, prompt) => {
            started.push({ projectId: pid, prompt, team: true });
            const s = { ...session(`team-${started.length}`, pid, dir, "Crew-Team"), team: true };
            sessions.set(s.id, s);
            return s;
          },
          busy: () => false,
        },
        emit: (e) => events.push(e),
      });
    const svc = make();
    services.push(svc);
    return { svc, events, sessions, started, proj, dir, make, secrets };
  }

  const crewOf = (svc: CrewService): Crew | undefined => svc.list()[0];

  it("lets a newcomer in with the check code, then shares tasks, messages, work and pushes", { timeout: 60_000 }, async () => {
    const origin = path.join(t.dir, "origin.git");
    await git(t.dir, "init", "--bare", "-b", "main", origin);
    const dirA = path.join(t.dir, "anna");
    mkdirSync(dirA);
    await initRepo(dirA);
    writeFileSync(path.join(dirA, "README.md"), "hallo\n");
    await git(dirA, "add", ".");
    await git(dirA, "commit", "-m", "start");
    await git(dirA, "remote", "add", "origin", origin);
    await git(dirA, "push", "-u", "origin", "main");
    const dirB = path.join(t.dir, "ben");
    await git(t.dir, "clone", origin, dirB);
    await git(dirB, "config", "user.email", "ben@forge.local");
    await git(dirB, "config", "user.name", "Ben");
    await git(dirB, "config", "commit.gpgsign", "false");

    const a = installation("Anna", dirA, "pa");
    const b = installation("Ben", dirB, "pb");
    await a.svc.start();
    await b.svc.start();

    const created = await a.svc.create("pa", "Team App");
    expect(created.members.map((m) => m.name)).toEqual(["Anna"]);
    const code = created.invite!.code;

    // The invite finds Ben's copy of the project by its origin.
    const info = await b.svc.inspect(code);
    expect(info).toMatchObject({ crewName: "Team App", from: "Anna", expired: false, joined: false });
    expect(info.projectIds).toEqual(["pb"]);

    const pending = await b.svc.join("pb", code);
    expect(pending.membership).toBe("pending");
    expect(pending.joinCode).toMatch(/^\d{4}-\d{4}$/);

    // Anna sees the request with the same check code and lets Ben in.
    const request = await waitFor("join request at Anna", () => crewOf(a.svc)?.requests[0]);
    expect(request.code).toBe(pending.joinCode);
    expect(a.events.some((e) => e.event === "crew.notice" && e.payload.kind === "request")).toBe(true);
    await a.svc.respond(created.id, request.id, true);

    await waitFor("Ben is a member", () => crewOf(b.svc)?.membership === "member");
    await waitFor("both see two members", () => crewOf(a.svc)?.members.length === 2 && crewOf(b.svc)?.members.length === 2);
    const crewA = crewOf(a.svc)!;
    const crewB = crewOf(b.svc)!;
    expect(crewB.name).toBe("Team App");
    const benId = crewB.selfId;
    expect(b.events.some((e) => e.event === "crew.notice" && e.payload.kind === "joined")).toBe(true);

    // A task for Ben reaches him, and his taking it reaches Anna.
    const task = a.svc.addTask(crewA.id, { title: "Login-Seite bauen", detail: "src/login.tsx", assignee: benId });
    await waitFor("task at Ben", () => crewOf(b.svc)?.tasks.find((x) => x.id === task.id));
    expect(b.events.some((e) => e.event === "crew.notice" && e.payload.kind === "task" && e.payload.ref === task.id)).toBe(true);
    b.svc.updateTask(crewB.id, task.id, { status: "in_progress" }, "Login");
    await waitFor("task taken at Anna", () => crewOf(a.svc)?.tasks.find((x) => x.id === task.id && x.status === "in_progress" && x.owner?.member === benId && x.owner.agent === "Login"));

    // Anna's agent hears about Ben's message with its next message.
    const annaSession = session("sa", "pa", dirA, "Header");
    a.sessions.set("sa", annaSession);
    a.svc.sessionStarted("sa", "pa");
    b.svc.message(crewB.id, "Ich übernehme die Login-Seite.");
    await waitFor("message at Anna", () => crewOf(a.svc)?.feed.find((f) => f.kind === "message"));
    const note = a.svc.takeNews("sa", false);
    expect(note).toContain("Ich übernehme die Login-Seite.");
    expect(note).toContain("Ben");
    expect(a.svc.takeNews("sa", false)).toBeNull();

    // Ben's agent edits a file: Anna sees it in his presence and her agent is warned before editing it.
    const benSession = session("sb", "pb", dirB, "Login");
    b.sessions.set("sb", benSession);
    b.svc.onServerEvent({ event: "session.event", payload: { seq: 1, sessionId: "sb", ts: "", body: { type: "user.message", text: "Bau die Login-Seite" } } });
    b.svc.onServerEvent({ event: "session.event", payload: { seq: 2, sessionId: "sb", ts: "", body: { type: "tool.use", toolUseId: "t1", name: "Write", input: { file_path: path.join(dirB, "src", "login.tsx") }, parentToolUseId: null } } });
    await waitFor("Ben's agent at Anna", () => crewOf(a.svc)?.members.find((m) => m.id === benId)?.agents.find((x) => x.files.includes("src/login.tsx")));
    // Ben's session is an agent team: its members work in the background while the lead waits, and the crew sees it working.
    const benTeam: Session = { ...benSession, team: true, background: [{ taskId: "k1", description: "Formular", taskType: "local_agent", toolUseId: "a1", startedAt: "", summary: null }] };
    b.sessions.set("sb", benTeam);
    b.svc.onServerEvent({ event: "session.updated", payload: benTeam });
    await waitFor("Ben's team at Anna", () => crewOf(a.svc)?.members.find((m) => m.id === benId)?.agents.find((x) => x.status === "working" && x.team?.working === 1));
    expect(describeCrew(crewOf(a.svc)!)).toMatch(/Agent-Team|agent team/);
    expect(describeCrew(crewOf(a.svc)!)).toContain("src/login.tsx");
    const warning = a.svc.editWarning("sa", "Edit", { file_path: path.join(dirA, "src", "login.tsx") });
    expect(warning).toContain("Ben");
    expect(warning).toContain("src/login.tsx");
    expect(a.svc.editWarning("sa", "Edit", { file_path: path.join(dirA, "src", "login.tsx") })).toBeNull();
    expect(a.svc.editWarning("sa", "Edit", { file_path: path.join(dirA, "README.md") })).toBeNull();

    // Ben pushes a commit; Anna's FORGE takes it over on its own (nothing runs there).
    mkdirSync(path.join(dirB, "src"), { recursive: true });
    writeFileSync(path.join(dirB, "src", "login.tsx"), "export const Login = 1;\n");
    await git(dirB, "add", ".");
    await git(dirB, "commit", "-m", "Login-Seite");
    await git(dirB, "push", "origin", "main");
    b.svc.onServerEvent({ event: "session.event", payload: { seq: 3, sessionId: "sb", ts: "", body: { type: "turn.result", subtype: "success", isError: false, durationMs: 1, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, text: "Login-Seite steht." } } });
    await waitFor("push in Anna's feed", () => crewOf(a.svc)?.feed.find((f) => f.kind === "push" && f.text.includes("Login-Seite")), 20_000);
    await waitFor("Anna pulled", () => existsSync(path.join(dirA, "src", "login.tsx")), 20_000);
    await waitFor("pulled notice", () => a.events.some((e) => e.event === "crew.notice" && e.payload.kind === "pulled"));
    // The finished turn is in the feed, so everyone sees what is done.
    expect(crewOf(a.svc)!.feed.some((f) => f.kind === "turn" && f.text.includes("Bau die Login-Seite"))).toBe(true);

    // After a restart Anna still has the crew with its tasks.
    a.svc.stop();
    await new Promise((r) => setTimeout(r, 700));
    const again = a.make();
    services.push(again);
    await again.start();
    expect(crewOf(again)?.tasks.map((x) => x.title)).toEqual(["Login-Seite bauen"]);
    expect(crewOf(again)?.members).toHaveLength(2);

    // Anna removes Ben: his FORGE drops the crew, the new key never reaches him.
    await waitFor("Anna online again", () => crewOf(again)?.connection === "online");
    await again.removeMember(crewOf(again)!.id, benId);
    await waitFor("Ben is out", () => b.svc.list().length === 0);
    expect(b.events.some((e) => e.event === "crew.notice" && e.payload.kind === "removed")).toBe(true);
    expect(crewOf(again)!.members.map((m) => m.name)).toEqual(["Anna"]);

    // A task can go to an agent team instead of a single session.
    const big = again.addTask(crewOf(again)!.id, { title: "Suche bauen", detail: "", assignee: null });
    const r = await again.startTask(crewOf(again)!.id, big.id, true);
    expect(a.started.at(-1)).toMatchObject({ team: true });
    expect(r.sessionId).toMatch(/^team-/);
  });

  it("tells a newcomer when the request was declined", { timeout: 30_000 }, async () => {
    const dirA = path.join(t.dir, "a");
    const dirB = path.join(t.dir, "b");
    mkdirSync(dirA);
    mkdirSync(dirB);
    const a = installation("Anna", dirA, "pa");
    const b = installation("Ben", dirB, "pb");
    await a.svc.start();
    await b.svc.start();
    const created = await a.svc.create("pa");
    await b.svc.join("pb", created.invite!.code);
    const request = await waitFor("request", () => crewOf(a.svc)?.requests[0]);
    await a.svc.respond(created.id, request.id, false);
    await waitFor("Ben rejected", () => crewOf(b.svc)?.membership === "rejected");
    expect(crewOf(a.svc)!.requests).toHaveLength(0);
    expect(crewOf(a.svc)!.members).toHaveLength(1);
    // A new attempt with a fresh invite replaces the rejected one.
    const fresh = await a.svc.invite(created.id);
    const retry = await b.svc.join("pb", fresh.code);
    expect(retry.membership).toBe("pending");
    expect(b.svc.list()).toHaveLength(1);
  });

  it("gives sessions of a crew project the crew tools and tells them how to work together", async () => {
    const dirA = path.join(t.dir, "a");
    mkdirSync(dirA);
    const a = installation("Anna", dirA, "pa");
    await a.svc.start();
    expect(crewSessionTools(a.svc, "s1", "pa", () => "Header")).toBeNull();
    const crew = await a.svc.create("pa", "Team App");
    a.sessions.set("s1", session("s1", "pa", dirA, "Header"));
    const extra = crewSessionTools(a.svc, "s1", "pa", () => "Header")!;
    expect(extra.tools.map((x) => x.name)).toEqual(["crew_status", "crew_task", "crew_message"]);
    expect(extra.tools.every((x) => x.autoAllow)).toBe(true);
    expect(extra.context).toContain("Team App");
    const task = extra.tools.find((x) => x.name === "crew_task")!;
    expect(await task.run({ action: "add", title: "API bauen" })).toMatch(/^Aufgabe angelegt: \S+ „API bauen“/);
    const id = crewOf(a.svc)!.tasks[0]!.id;
    expect(await task.run({ action: "take", id })).toContain("läuft");
    expect(crewOf(a.svc)!.tasks[0]!.owner).toEqual({ member: crew.selfId, agent: "Header" });
    expect(await task.run({ action: "done", id, note: "steht" })).toContain("fertig");
    const status = await extra.tools.find((x) => x.name === "crew_status")!.run({});
    expect(status).toContain("Team App");
    expect(status).toContain("API bauen");
    await expect(extra.tools.find((x) => x.name === "crew_message")!.run({ text: "hi", to: "Niemand" })).rejects.toThrow(/Kein Crew-Mitglied/);
  });

  it("refuses an expired invite and a second crew for the same project", async () => {
    const dirA = path.join(t.dir, "a");
    mkdirSync(dirA);
    const a = installation("Anna", dirA, "pa");
    await a.svc.start();
    await a.svc.create("pa");
    await expect(a.svc.create("pa")).rejects.toThrow(/schon in einer Crew/);
    const old = encodeInvite({ v: 1, u: relayUrl, r: "abcdefghijklmnopqrstuv", i: "inv", k: newKey(), x: 1_000, n: "Alt", p: "app", o: null, c: null, f: "X" });
    expect((await a.svc.inspect(old)).expired).toBe(true);
    await expect(a.svc.join("pa", old)).rejects.toThrow(/abgelaufen/);
  });
});
