import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Crew, Project, ServerEvent, Session, SessionEventBody } from "@forge/protocol";
import { claudeProjectDir, type ShareDeps } from "../src/crew/share.js";
import type { CopyImport } from "../src/sessions/session-service.js";
import { createRelayServer } from "../../../services/stats/src/lib/crew-relay-node.js";
import { CrewWebClient, type Storage } from "../../../services/stats/src/lib/crew-web/client.js";
import * as web from "../../../services/stats/src/lib/crew-web/crypto.js";
import { decodeInvite as decodeInviteWeb } from "../../../services/stats/src/lib/crew-web/wire.js";
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

  it("speaks the same crypto in the browser (WebCrypto) as in the sidecar", async () => {
    const key = newKey();
    const fromNode = seal(key, "hallö", "room|room:1");
    expect(await web.open(key, fromNode, "room|room:1")).toBe("hallö");
    expect(await web.open(key, fromNode, "other|room:1")).toBeNull();
    expect(open(key, await web.seal(key, "zurück", "room|room:2"), "room|room:2")).toBe("zurück");
    const node = newKeyPair();
    const browser = await web.newKeyPair();
    expect(await web.sharedKey(browser, node.pub, "grant:7")).toBe(sharedKey(node, browser.pub, "grant:7"));
    expect(await web.fingerprint(node.pub)).toBe(fingerprint(node.pub));
    const code = encodeInvite({ v: 1, u: "https://relay.example/crew", r: "abcdefghijklmnopqrstuv", i: "inv", k: newKey(), x: 2_000_000_000, n: "Crew", p: "app", o: null, c: null, f: "Anna" });
    // The link of the invite dialog works in FORGE and on the page.
    expect(decodeInvite(`https://forge.vanturis.de/crew#${code}`)?.n).toBe("Crew");
    expect(decodeInviteWeb(`https://forge.vanturis.de/crew#${code}`)?.f).toBe("Anna");
    expect(decodeInviteWeb("forge-crew1.kaputt")).toBeNull();
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
    // Sessions of other members land here (crew/share.ts); their events, worktrees and Claude folder.
    const sessionEvents = new Map<string, SessionEventBody[]>();
    const imported: Array<CopyImport & { id: string }> = [];
    const appended: SessionEventBody[] = [];
    const worktreeProjects: Project[] = [];
    const claudeDir = path.join(t.dir, `claude-${name}`);
    const share: ShareDeps = {
      sessions: {
        get: (id) => sessions.get(id) ?? null,
        recentEvents: (id) => sessionEvents.get(id) ?? [],
        importCopy: (o) => {
          const s: Session = { ...session(`copy-${name}-${imported.length + 1}`, o.projectId, o.cwd, o.title), claudeSessionId: o.claudeSessionId, ...(o.mirror ? { mirror: o.mirror } : {}) };
          imported.push({ ...o, id: s.id });
          sessions.set(s.id, s);
          return s;
        },
        appendMirror: (_id, bodies) => void appended.push(...bodies),
        setMirrorLive: () => {},
        endMirrors: () => {},
      },
      // Tracked changes are enough for the test (FORGE's own snapshot also takes untracked files).
      snapshot: async (dir) => (await git(dir, "stash", "create")).trim() || null,
      worktree: async (parent, branch, startAt) => {
        const wdir = path.join(t.dir, `wt-${name}-${worktreeProjects.length + 1}`);
        await git(parent.path, "worktree", "add", "-b", branch, wdir, startAt);
        const wp = { ...project(`wt-${name}-${worktreeProjects.length + 1}`, wdir), parentId: parent.id };
        worktreeProjects.push(wp);
        return wp;
      },
      git: new GitEngine(),
      claudeDir,
      projects: () => [proj, ...worktreeProjects],
    };
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
        share,
      });
    const svc = make();
    services.push(svc);
    return { svc, events, sessions, started, proj, dir, make, secrets, sessionEvents, imported, appended, claudeDir };
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

  it("lets a member watch another member's session live and take it over with its files and Claude's conversation", { timeout: 90_000 }, async () => {
    const origin = path.join(t.dir, "origin-share.git");
    await git(t.dir, "init", "--bare", "-b", "main", origin);
    const dirA = path.join(t.dir, "anna-s");
    mkdirSync(dirA);
    await initRepo(dirA);
    writeFileSync(path.join(dirA, "README.md"), "hallo\n");
    await git(dirA, "add", ".");
    await git(dirA, "commit", "-m", "start");
    await git(dirA, "remote", "add", "origin", origin);
    await git(dirA, "push", "-u", "origin", "main");
    const dirB = path.join(t.dir, "ben-s");
    await git(t.dir, "clone", origin, dirB);
    await git(dirB, "config", "user.email", "ben@forge.local");
    await git(dirB, "config", "user.name", "Ben");
    await git(dirB, "config", "commit.gpgsign", "false");

    const a = installation("Anna", dirA, "pa");
    const b = installation("Ben", dirB, "pb");
    await a.svc.start();
    await b.svc.start();
    const created = await a.svc.create("pa", "Share");
    await b.svc.join("pb", created.invite!.code);
    const request = await waitFor("join request", () => crewOf(a.svc)?.requests[0]);
    await a.svc.respond(created.id, request.id, true);
    await waitFor("Ben is a member", () => crewOf(b.svc)?.membership === "member" && crewOf(a.svc)?.members.length === 2);
    const benId = crewOf(b.svc)!.selfId;

    // Ben works: a commit not pushed yet, a change not committed, and a session with Claude's transcript.
    writeFileSync(path.join(dirB, "feature.ts"), "export const f = 1;\n");
    await git(dirB, "add", "feature.ts");
    await git(dirB, "commit", "-m", "Feature angefangen");
    writeFileSync(path.join(dirB, "README.md"), "hallo von Ben\n");
    const benSession: Session = { ...session("sb", "pb", dirB, "Login bauen"), claudeSessionId: "claude-ben-1" };
    b.sessions.set("sb", benSession);
    b.sessionEvents.set("sb", [
      { type: "user.message", text: "Bau die Login-Seite" },
      { type: "assistant.text", messageId: "m1", index: 0, text: "Mache ich." },
    ]);
    const transcriptDir = claudeProjectDir(b.claudeDir, dirB);
    mkdirSync(transcriptDir, { recursive: true });
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    writeFileSync(path.join(transcriptDir, "claude-ben-1.jsonl"), line({ type: "user", sessionId: "claude-ben-1", cwd: dirB, message: { role: "user", content: `Lies ${path.join(dirB, "README.md")}` } }));
    b.svc.onServerEvent({ event: "session.event", payload: { seq: 1, sessionId: "sb", ts: "", body: { type: "user.message", text: "Bau die Login-Seite" } } });
    await waitFor("Ben's session at Anna", () => crewOf(a.svc)?.members.find((m) => m.id === benId)?.agents.find((x) => x.id === "sb"));

    // View: Ben is asked first, says yes for good; Anna gets a read-only copy that stays live.
    const asked = a.svc.shareAsk(created.id, benId, "sb", "view");
    expect(asked).toMatchObject({ state: "asking", agentTitle: "Login bauen" });
    const pendingShare = await waitFor("request at Ben", () => crewOf(b.svc)?.shareRequests[0]);
    expect(pendingShare).toMatchObject({ agentId: "sb", mode: "view" });
    expect(b.events.some((e) => e.event === "crew.notice" && e.payload.kind === "share")).toBe(true);
    b.svc.shareRespond(crewOf(b.svc)!.id, pendingShare.id, true, true);
    await waitFor("live view at Anna", () => crewOf(a.svc)?.shares.find((x) => x.id === asked.id && x.state === "live"));
    expect(a.imported[0]).toMatchObject({ projectId: "pa", claudeSessionId: null, mirror: { memberId: benId, remoteSessionId: "sb", live: true } });
    expect(a.imported[0]!.events.map((e) => e.type)).toEqual(["user.message", "assistant.text"]);
    expect(a.events.some((e) => e.event === "crew.notice" && e.payload.kind === "shared" && e.payload.ref === a.imported[0]!.id)).toBe(true);
    b.svc.onServerEvent({ event: "session.event", payload: { seq: 2, sessionId: "sb", ts: "", body: { type: "assistant.text", messageId: "m2", index: 0, text: "Formular steht." } } });
    await waitFor("live event at Anna", () => a.appended.find((x) => x.type === "assistant.text" && x.text === "Formular steht."));
    a.svc.shareStop(created.id, asked.id);
    expect(crewOf(a.svc)!.shares.find((x) => x.id === asked.id)!.state).toBe("ended");

    // Takeover, now allowed without asking: chat, Claude's conversation and Ben's files in a worktree.
    const take = a.svc.shareAsk(created.id, benId, "sb", "takeover");
    const done = await waitFor("takeover done", () => crewOf(a.svc)?.shares.find((x) => x.id === take.id && (x.state === "done" || x.state === "failed")), 60_000);
    expect(done.error).toBeNull();
    const copy = a.imported[1]!;
    expect(copy.title).toContain("Login bauen");
    expect(copy.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    // git may check files out with CRLF (core.autocrlf on Windows)
    const read = (f: string) => readFileSync(path.join(copy.cwd, f), "utf8").replace(/\r\n/g, "\n");
    expect(read("README.md")).toBe("hallo von Ben\n");
    expect(read("feature.ts")).toBe("export const f = 1;\n");
    // Ben's commit is the worktree's HEAD; his uncommitted change is uncommitted here too.
    expect((await git(copy.cwd, "log", "-1", "--format=%s")).trim()).toBe("Feature angefangen");
    expect((await git(copy.cwd, "status", "--porcelain")).trim()).toBe("M README.md");
    const transcript = readFileSync(path.join(claudeProjectDir(a.claudeDir, copy.cwd), `${copy.claudeSessionId}.jsonl`), "utf8");
    expect(transcript).toContain(copy.claudeSessionId!);
    expect(transcript).not.toContain("claude-ben-1");
    expect(transcript).toContain(JSON.stringify(path.join(copy.cwd, "README.md")).slice(1, -1));
  });

  it("lets someone follow the crew in the browser: join, read, write, plan and watch a session live", { timeout: 60_000 }, async () => {
    const dirA = path.join(t.dir, "anna-w");
    mkdirSync(dirA);
    const a = installation("Anna", dirA, "pa");
    await a.svc.start();
    const created = await a.svc.create("pa", "Team App");
    const store = new Map<string, string>();
    const storage: Storage = { get: (k) => store.get(k) ?? null, set: (k, v) => void (v === null ? store.delete(k) : store.set(k, v)) };
    const ben = await CrewWebClient.join(`${relayUrl.replace(/\/crew$/, "")}/crew#${created.invite!.code}`, { name: "Ben", color: "#30a46c" }, { storage });
    ben.start();
    try {
      expect(ben.view().membership).toBe("pending");
      const request = await waitFor("browser request at Anna", () => crewOf(a.svc)?.requests[0]);
      expect(request.code).toBe(ben.view().joinCode);
      await a.svc.respond(created.id, request.id, true);
      await waitFor("browser is a member", () => ben.view().membership === "member" && ben.view().members.length === 2);
      expect(ben.view().name).toBe("Team App");
      const benId = ben.view().selfId;
      await waitFor("Anna sees Ben in the browser", () => crewOf(a.svc)?.members.find((m) => m.id === benId && m.web && m.online));

      // Writing and planning from the phone reaches FORGE, and FORGE's answers reach the phone.
      await ben.message("Bin unterwegs, schaue mit.");
      await waitFor("message at Anna", () => crewOf(a.svc)?.feed.find((f) => f.kind === "message" && f.from === benId));
      const task = await ben.addTask({ title: "Footer prüfen", assignee: crewOf(a.svc)!.selfId });
      await waitFor("task at Anna", () => crewOf(a.svc)?.tasks.find((x) => x.id === task.id));
      a.svc.message(created.id, "Danke!");
      await waitFor("answer in the browser", () => ben.view().feed.find((f) => f.text === "Danke!"));

      // What Anna's agent does shows in the browser.
      a.sessions.set("sa", session("sa", "pa", dirA, "Header"));
      a.sessionEvents.set("sa", [{ type: "user.message", text: "Bau den Header" }]);
      a.svc.onServerEvent({ event: "session.event", payload: { seq: 1, sessionId: "sa", ts: "", body: { type: "user.message", text: "Bau den Header" } } });
      const anna = await waitFor("Anna's agent in the browser", () => ben.view().members.find((m) => m.agents.some((x) => x.task === "Bau den Header")));

      // A live view of the session: Anna agrees, the copy (only the newest events) and then new events arrive.
      await ben.watch(anna.id, "sa");
      const ask = await waitFor("share request at Anna", () => crewOf(a.svc)?.shareRequests[0]);
      a.svc.shareRespond(created.id, ask.id, true);
      await waitFor("live in the browser", () => ben.view().watch?.state === "live");
      expect(ben.view().watch!.events).toEqual([{ type: "user.message", text: "Bau den Header" }]);
      a.svc.onServerEvent({ event: "session.event", payload: { seq: 2, sessionId: "sa", ts: "", body: { type: "assistant.text", messageId: "m1", index: 0, text: "Header steht." } } });
      await waitFor("live event in the browser", () => ben.view().watch?.events.some((x) => (x as { text?: string }).text === "Header steht."));
      ben.stopWatch();

      // A reload keeps the crew; the owner can still remove the browser member.
      ben.stop();
      const again = CrewWebClient.list({ storage });
      expect(again.map((c) => c.view().membership)).toEqual(["member"]);
      again[0]!.start();
      await waitFor("online again", () => again[0]!.view().connection === "online");
      await a.svc.removeMember(created.id, benId);
      await waitFor("browser removed", () => again[0]!.view().membership === "removed");
      again[0]!.stop();
    } finally {
      ben.stop();
    }
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
