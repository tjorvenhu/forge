import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, ServerEvent } from "@forge/protocol";
import { AgentTeams, parseTeamMessage, projectForCwd } from "../src/teams/agent-teams.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let claudeDir: string;
let repo: string;
let events: ServerEvent[];

function project(id: string, dir: string, extra: Partial<Project> = {}): Project {
  return {
    id, name: id, path: dir, favorite: false, group: null, tags: [], technologies: [], profile: "balanced",
    defaultModel: null, defaultEffort: null, createdAt: "", lastOpenedAt: null, testCommand: null, devCommand: null,
    parentId: null, gitEnabled: true, agentsEnabled: true, teamsEnabled: true, exists: true, ...extra,
  };
}

const TEAM = "session-1a2b3c4d";
const teamDir = () => path.join(claudeDir, "teams", TEAM);
const tasksDir = () => path.join(claudeDir, "tasks", TEAM);
const json = (file: string, v: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(v, null, 2));
};

/** The files Claude Code writes when a lead spawns alpha and beta (format seen with CLI 2.1.308). */
function writeTeam() {
  json(path.join(teamDir(), "config.json"), {
    name: TEAM,
    createdAt: 1792683834733,
    leadAgentId: `team-lead@${TEAM}`,
    leadSessionId: "1a2b3c4d-65aa-4626-80c0-1a09095037b6",
    members: [
      { agentId: `team-lead@${TEAM}`, name: "team-lead", agentType: "team-lead", joinedAt: 1792683834733, cwd: path.join(repo, "src"), backendType: "in-process" },
      { agentId: `alpha@${TEAM}`, name: "alpha", color: "blue", joinedAt: 1792683845914, model: "haiku", prompt: "Du bist alpha.", cwd: repo, backendType: "in-process" },
      { agentId: `beta@${TEAM}`, name: "beta", color: "green", joinedAt: 1792683846760, model: "haiku", prompt: "Du bist beta.", cwd: repo, backendType: "in-process" },
    ],
  });
  json(path.join(tasksDir(), "1.json"), { id: "1", subject: "write A", description: "A", owner: "alpha", status: "completed", blocks: ["3"], blockedBy: [] });
  json(path.join(tasksDir(), "2.json"), { id: "2", subject: "write B", description: "B", owner: "beta", status: "in_progress", blocks: ["3"], blockedBy: [] });
  json(path.join(tasksDir(), "3.json"), { id: "3", subject: "combine", description: "", owner: "alpha", status: "pending", blocks: [], blockedBy: ["1", "2"] });
  writeFileSync(path.join(tasksDir(), ".highwatermark"), "3");
}

/** rmSync deletes nothing under a path with umlauts on Windows with Node 24.11 (24.21 is fine), and tempDir has one on purpose. */
function removeDir(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) removeDir(p);
    else unlinkSync(p);
  }
  rmdirSync(dir);
}

const inbox = (name: string) => path.join(teamDir(), "inboxes", `${name}.json`);

function service(projects: Project[], extra: Partial<ConstructorParameters<typeof AgentTeams>[0]> = {}) {
  return new AgentTeams({ claudeDir, projects: () => projects, emit: (e) => events.push(e), ...extra });
}

/** Claude Code's file of a running process (format seen with CLI 2.1.308). */
function writeSession(pid: number, sessionId: string, startedAt = 1792683833000) {
  json(path.join(claudeDir, "sessions", `${pid}.json`), { pid, sessionId, cwd: path.join(repo, "src"), startedAt, kind: "interactive", status: "busy" });
}

beforeEach(() => {
  t = tempDir();
  claudeDir = path.join(t.dir, ".claude");
  repo = path.join(t.dir, "shop");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  events = [];
});

afterEach(() => t.cleanup());

describe("AgentTeams", () => {
  it("reads members, the shared task list and the project of the lead's folder", () => {
    writeTeam();
    const teams = service([project("shop", repo), project("other", path.join(t.dir, "other"))]);
    teams.scan();
    const [team] = teams.list("shop");
    expect(team).toMatchObject({ name: TEAM, projectId: "shop", active: true, leadSessionId: "1a2b3c4d-65aa-4626-80c0-1a09095037b6" });
    expect(team!.members.map((m) => [m.name, m.lead, m.color, m.state])).toEqual([
      ["team-lead", true, null, "unknown"],
      ["alpha", false, "blue", "working"],
      ["beta", false, "green", "working"],
    ]);
    expect(team!.tasks.map((x) => [x.id, x.status, x.blocked])).toEqual([
      ["1", "completed", false],
      ["2", "in_progress", false],
      ["3", "pending", true],
    ]);
    expect(teams.list("other")).toEqual([]);
    expect(events.some((e) => e.event === "teams.updated" && e.payload.team === TEAM)).toBe(true);
  });

  it("keeps the messages it saw after Claude Code emptied the inbox, and reads results as idle", () => {
    writeTeam();
    const teams = service([project("shop", repo)]);
    json(inbox("beta"), [{ from: "alpha", text: "hello from alpha", summary: "Gruß", timestamp: "2026-10-22T15:44:13.410Z", msgV: 1, msg_id: "m1", type: "message", read: false }]);
    teams.scan();
    json(inbox("beta"), []);
    json(inbox("team-lead"), [
      {
        from: "beta",
        text: JSON.stringify({ type: "idle_notification", from: "beta", timestamp: "2026-10-22T15:44:16.138Z", result: "write B ist erledigt." }),
        timestamp: "2026-10-22T15:44:16.138Z",
        msgV: 1,
        msg_id: "m2",
        type: "message",
        read: false,
      },
    ]);
    // Task 2 done meanwhile: beta waits now, combine is free.
    json(path.join(tasksDir(), "2.json"), { id: "2", subject: "write B", description: "B", owner: "beta", status: "completed", blocks: ["3"], blockedBy: [] });
    teams.scan();
    const team = teams.list()[0]!;
    expect(team.messages.map((m) => [m.from, m.to, m.kind, m.text])).toEqual([
      ["alpha", "beta", "message", "hello from alpha"],
      ["beta", "team-lead", "idle", "write B ist erledigt."],
    ]);
    const beta = team.members.find((m) => m.name === "beta")!;
    expect([beta.state, beta.lastResult]).toEqual(["idle", "write B ist erledigt."]);
    expect(team.tasks.find((x) => x.id === "3")!.blocked).toBe(false);
  });

  it("marks a team as ended when Claude Code removes its folder, and keeps showing it", () => {
    writeTeam();
    const teams = service([project("shop", repo)]);
    teams.scan();
    removeDir(teamDir());
    teams.scan();
    const team = teams.list("shop")[0]!;
    expect(team.active).toBe(false);
    expect(team.endedAt).not.toBeNull();
    expect(team.tasks).toHaveLength(3);
  });

  it("writes a message into the inbox the way Claude Code does, and refuses unknown members", async () => {
    writeTeam();
    const teams = service([project("shop", repo)]);
    json(inbox("alpha"), [{ from: "team-lead", text: "los", timestamp: "2026-10-22T15:44:03.897Z", msgV: 1, msg_id: "a1", type: "message", read: true }]);
    expect(await teams.send(TEAM, "alpha", " Bitte auch Tests schreiben ")).toEqual(["alpha"]);
    const list = JSON.parse(readFileSync(inbox("alpha"), "utf8")) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ from: "user", text: "Bitte auch Tests schreiben", msgV: 1, type: "message", read: false });
    expect(typeof list[1]!.msg_id).toBe("string");
    expect(list[1]!.msg_id).not.toBe("a1");
    expect(existsSync(`${inbox("alpha")}.lock`)).toBe(false);

    expect(await teams.send(TEAM, "all", "Status?")).toEqual(["alpha", "beta"]);
    expect(await teams.send(TEAM, "lead", "Wie weit?")).toEqual(["team-lead"]);
    await expect(teams.send(TEAM, "gamma", "x")).rejects.toThrow(/gamma/);
  });

  it("waits for Claude Code's lock and takes over a stale one", async () => {
    writeTeam();
    const teams = service([project("shop", repo)]);
    mkdirSync(path.dirname(inbox("beta")), { recursive: true });
    mkdirSync(`${inbox("beta")}.lock`);
    const sent = teams.send(TEAM, "beta", "hallo");
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(inbox("beta"))).toBe(false);
    rmdirSync(`${inbox("beta")}.lock`);
    await sent;
    expect(JSON.parse(readFileSync(inbox("beta"), "utf8"))).toHaveLength(1);
  });

  it("refuses messages to an ended team", async () => {
    writeTeam();
    const teams = service([project("shop", repo)]);
    teams.scan();
    removeDir(teamDir());
    await expect(teams.send(TEAM, "alpha", "x")).rejects.toThrow();
  });

  it("counts a team as ended when its lead's process is gone, also when the folder stays", () => {
    writeTeam();
    writeSession(4242, "1a2b3c4d-65aa-4626-80c0-1a09095037b6");
    const alive = new Set([4242]);
    const teams = service([project("shop", repo)], { alive: (pid) => alive.has(pid) });
    teams.scan();
    expect(teams.list("shop")[0]).toMatchObject({ active: true, canStop: true });
    alive.delete(4242);
    teams.scan();
    expect(teams.list("shop")[0]).toMatchObject({ active: false, canStop: false });
    expect(existsSync(teamDir())).toBe(true);
  });

  it("finds the lead by folder and start time once /clear gave it a new session", () => {
    writeTeam();
    writeSession(4242, "99999999-0000-0000-0000-000000000000");
    const teams = service([project("shop", repo)], { alive: () => true });
    teams.scan();
    expect(teams.list("shop")[0]).toMatchObject({ active: true, canStop: true });
  });

  it("ends a team by ending its lead's process", async () => {
    writeTeam();
    writeSession(4242, "1a2b3c4d-65aa-4626-80c0-1a09095037b6");
    const alive = new Set([4242]);
    const killed: number[] = [];
    const teams = service([project("shop", repo)], { alive: (pid) => alive.has(pid), kill: (pid) => (killed.push(pid), alive.delete(pid)) });
    expect(await teams.stopTeam(TEAM)).toEqual({ ok: true });
    expect(killed).toEqual([4242]);
    expect(teams.list("shop")[0]!.active).toBe(false);
    await expect(teams.stopTeam(TEAM)).rejects.toThrow();
  });

  it("removes ended teams from the list with the folder Claude Code left behind", () => {
    writeTeam();
    writeSession(4242, "1a2b3c4d-65aa-4626-80c0-1a09095037b6");
    const alive = new Set([4242]);
    const teams = service([project("shop", repo)], { alive: (pid) => alive.has(pid) });
    teams.scan();
    expect(() => teams.dismiss(TEAM)).toThrow(/läuft noch|still running/);
    alive.delete(4242);
    expect(teams.dismiss(undefined, "shop")).toBe(1);
    expect(existsSync(teamDir())).toBe(false);
    teams.scan();
    expect(teams.list()).toEqual([]);
  });

  it("refuses to start a team when agent teams are switched off", () => {
    const off = service([project("shop", repo)], { enabled: () => false });
    expect(() => off.requestStart("shop")).toThrow(expect.objectContaining({ code: "TEAMS_DISABLED" }));
    const projectOff = service([project("shop", repo)], { enabled: (id) => id === null });
    expect(() => projectOff.requestStart("shop")).toThrow(/shop/);
  });

  it("asks the main window for a team terminal only in an existing project folder", () => {
    const teams = service([project("shop", repo), project("gone", path.join(t.dir, "gone"))]);
    expect(teams.requestStart("shop", "  Baue den Export ")).toEqual({ ok: true });
    expect(events.at(-1)).toEqual({ event: "team.start", payload: { projectId: "shop", prompt: "Baue den Export" } });
    expect(() => teams.requestStart("gone")).toThrow();
    expect(() => teams.requestStart("missing")).toThrow();
  });
});

describe("parseTeamMessage", () => {
  it("shows task assignments with their number and subject", () => {
    const m = parseTeamMessage(
      { from: "team-lead", text: JSON.stringify({ type: "task_assignment", taskId: "1", subject: "write A", description: "nur A" }), timestamp: "2026-10-22T15:44:03.897Z", msg_id: "x" },
      "alpha",
      "",
    );
    expect(m).toMatchObject({ kind: "task", from: "team-lead", to: "alpha", text: "#1 write A\nnur A" });
  });

  it("drops entries Claude Code would drop too", () => {
    expect(parseTeamMessage({ from: "a", text: 5 }, "b", "")).toBeNull();
    expect(parseTeamMessage({ text: "x" }, "b", "")).toBeNull();
  });
});

describe("projectForCwd", () => {
  it("takes the deepest project that contains the folder", () => {
    const root = project("shop", "/w/shop");
    const wt = project("wt", "/w/shop/.forge-worktrees/x", { parentId: "shop" });
    expect(projectForCwd([root, wt], "/w/shop/.forge-worktrees/x/src")?.id).toBe("wt");
    expect(projectForCwd([root, wt], "/w/shop")?.id).toBe("shop");
    expect(projectForCwd([root, wt], "/w/shopping")).toBeNull();
  });
});
