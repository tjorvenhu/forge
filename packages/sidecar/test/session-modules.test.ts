import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@forge/protocol";
import type { ApprovalRequest, ClaudeRuntime, RuntimeSession } from "../src/claude/runtime.js";
import { Normalizer } from "../src/claude/normalize.js";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { PROFILES } from "../src/policy/profiles.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { ApprovalGate, denyPending } from "../src/sessions/approvals.js";
import type { LiveSession } from "../src/sessions/live-session.js";
import { PermissionModes } from "../src/sessions/permission-mode.js";
import { SessionCore } from "../src/sessions/session-core.js";
import { buildTitlePrompt, cleanTitle, isTitleWorthy } from "../src/sessions/titles.js";
import { RuntimeCatalog } from "../src/sessions/runtime-catalog.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let db: Db;
let core: SessionCore;
const SID = "s1";

beforeEach(async () => {
  t = tempDir();
  const dir = path.join(t.dir, "proj");
  mkdirSync(dir, { recursive: true });
  db = new Db(path.join(t.dir, "forge.db"));
  const project = await new ProjectManager(db, new GitEngine(), () => "balanced").import(dir);
  const now = new Date().toISOString();
  db.insertSession({
    id: SID,
    projectId: project.id,
    claudeSessionId: null,
    cwd: dir,
    title: "x",
    model: null,
    effort: null,
    profile: "balanced",
    permissionMode: "acceptEdits",
    status: "running",
    apiKeySource: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  });
  core = new SessionCore(db, () => {});
});
afterEach(() => {
  db.close();
  t.cleanup();
});

function liveSession(rt: Partial<RuntimeSession> = {}): LiveSession {
  const live: LiveSession = {
    rt: { close: () => {}, kill: () => {}, setPermissionMode: async () => {}, ...rt } as RuntimeSession,
    normalizer: new Normalizer(),
    pending: new Map(),
    profile: PROFILES.balanced,
    projectDir: path.join(t.dir, "proj"),
    interrupting: false,
    closing: false,
    turnActive: true,
    ended: Promise.resolve(),
    markEnded: () => {},
    seenUuids: new Set(),
    remoteTurn: null,
    background: new Map(),
    subagents: new Map(),
    taskToolUse: new Map(),
    context: null,
  };
  core.live.set(SID, live);
  return live;
}

const request = (requestId: string): ApprovalRequest => ({
  requestId,
  toolUseId: `t-${requestId}`,
  toolName: "Bash",
  input: { command: "ls" },
  title: null,
  description: null,
  reason: null,
  suppressAlwaysAllow: false,
});

describe("ApprovalGate", () => {
  let tags: string[] = [];
  const host = { abortReason: () => "Abgebrochen", syncPermissionMode: () => {}, projectTags: () => tags };

  it("looks up the branch only for a push", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "feature\n", stderr: "" }));
    const gate = new ApprovalGate(core, { exec } as unknown as GitEngine, host);
    const live = liveSession();
    expect(await gate.guard(SID, live, "Bash", { command: "pnpm test" }, "t1")).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    await gate.guard(SID, live, "Bash", { command: "git push" }, "t2");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("denies an aborted prompt and stays silent when the process was replaced", async () => {
    const gate = new ApprovalGate(core, {} as GitEngine, host);
    const live = liveSession();
    const ac = new AbortController();
    const pending = gate.request(SID, live, request("r1"), ac.signal);
    expect(db.getSession(SID)?.status).toBe("waiting_approval");
    core.live.delete(SID);
    ac.abort();
    await expect(pending).resolves.toEqual({ behavior: "deny", message: "Abgebrochen" });
    expect(db.getSession(SID)?.status).toBe("waiting_approval");
    expect(live.pending.size).toBe(0);
  });

  it("denies all open prompts at once", async () => {
    const gate = new ApprovalGate(core, {} as GitEngine, host);
    const live = liveSession();
    const a = gate.request(SID, live, request("a"), new AbortController().signal);
    const b = gate.request(SID, live, request("b"), new AbortController().signal);
    denyPending(live, "Gestoppt");
    await expect(Promise.all([a, b])).resolves.toEqual([
      { behavior: "deny", message: "Gestoppt" },
      { behavior: "deny", message: "Gestoppt" },
    ]);
    expect(db.getSession(SID)?.status).toBe("running");
  });

  it("checks the no-network tag on every call, not only at process start", async () => {
    const gate = new ApprovalGate(core, {} as GitEngine, host);
    const live = liveSession();
    tags = [];
    expect(await gate.guard(SID, live, "WebFetch", { url: "https://example.com" }, "t1")).toBeNull();
    tags = ["no-network"];
    expect((await gate.guard(SID, live, "WebFetch", { url: "https://example.com" }, "t2"))?.rule).toBe("no-network");
    expect((await gate.guard(SID, live, "WebSearch", { query: "x" }, "t3"))?.rule).toBe("no-network");
    expect(await gate.guard(SID, live, "Read", { file_path: "a.txt" }, "t4")).toBeNull();
    tags = [];
  });
});

describe("PermissionModes", () => {
  const projectWith = (profile: string) => ({ get: () => ({ profile, tags: [] }) }) as unknown as ProjectManager;

  it("checks mode reports during a profile switch against the new profile", async () => {
    let release = () => {};
    const modes: string[] = [];
    const live = liveSession({
      setPermissionMode: (m) => {
        modes.push(m);
        return new Promise<void>((r) => (release = r));
      },
    });
    const pm = new PermissionModes(core, projectWith("autonomous"), { reopen: async () => {} });
    const applying = pm.applyProjectProfile(db.getSession(SID)!.projectId);
    // Claude Code reports the new mode before setPermissionMode resolved.
    pm.sync(SID, "bypassPermissions");
    release();
    await applying;
    expect(live.profile.id).toBe("autonomous");
    expect(modes).toEqual(["bypassPermissions"]);
    expect(db.getSession(SID)).toMatchObject({ profile: "autonomous", permissionMode: "bypassPermissions" });
    expect(db.listEvents(SID).map((e) => e.body.type)).not.toContain("policy.blocked");
  });

  it("ends the process when the new profile's mode cannot be set", async () => {
    const close = vi.fn();
    const live = liveSession({ close, setPermissionMode: async () => Promise.reject(new Error("gone")) });
    live.profile = PROFILES.autonomous;
    await new PermissionModes(core, projectWith("balanced"), { reopen: async () => {} }).applyProjectProfile(db.getSession(SID)!.projectId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(live.closing).toBe(true);
    expect(live.profile.id).toBe("balanced");
    expect(db.listEvents(SID).at(-1)?.body).toMatchObject({ type: "error", message: expect.stringMatching(/Profil ließ sich nicht übernehmen/) });
  });

  it("restarts the process when the new profile has no session-wide approvals", async () => {
    const close = vi.fn();
    const reopen = vi.fn(async () => {});
    const live = liveSession({ close });
    await new PermissionModes(core, projectWith("safe"), { reopen }).applyProjectProfile(db.getSession(SID)!.projectId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith(SID);
    expect(live.profile.id).toBe("safe");
    expect(db.getSession(SID)).toMatchObject({ profile: "safe", permissionMode: "default" });
    expect(db.listEvents(SID).find((e) => e.body.type === "status")?.body).toMatchObject({ detail: expect.stringMatching(/neu gestartet/) });
  });

  it("does not restart for a switch that keeps session-wide approvals", async () => {
    const close = vi.fn();
    const reopen = vi.fn(async () => {});
    liveSession({ close });
    await new PermissionModes(core, projectWith("autonomous"), { reopen }).applyProjectProfile(db.getSession(SID)!.projectId);
    expect(close).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("ends a process whose mode above the profile cannot be reset", async () => {
    const close = vi.fn();
    const live = liveSession({ close, setPermissionMode: async () => Promise.reject(new Error("gone")) });
    new PermissionModes(core, {} as ProjectManager, { reopen: async () => {} }).sync(SID, "bypassPermissions");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(live.closing).toBe(true);
    expect(db.getSession(SID)?.permissionMode).toBe("acceptEdits");
    expect(db.listEvents(SID).map((e) => e.body.type)).toEqual(["policy.blocked", "error"]);
  });
});

describe("session title helpers", () => {
  it("cleans model answers to one short line", () => {
    expect(cleanTitle("„Login-Seite bauen.“")).toBe("Login-Seite bauen");
    expect(cleanTitle('Titel: "Menü umbauen"!\nWeitere Erklärung')).toBe("Menü umbauen");
    expect(cleanTitle("\n\n  **Tests reparieren**  \n")).toBe("Tests reparieren");
    expect(cleanTitle("")).toBe("");
    const long = cleanTitle("Wort ".repeat(40));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("lets only messages about the work change the title", () => {
    expect(isTitleWorthy("Baue eine Login-Seite")).toBe(true);
    expect(isTitleWorthy("Vom Handy: bitte README lesen", "remote")).toBe(true);
    expect(isTitleWorthy("Bitte mach weiter mit dem Login")).toBe(true);
    expect(isTitleWorthy("Mach bitte mit der Aufgabe weiter", "auto")).toBe(false);
    expect(isTitleWorthy("/compact Fokus auf die API")).toBe(false);
    expect(isTitleWorthy("ok")).toBe(false);
    expect(isTitleWorthy("Ja, mach weiter bitte!")).toBe(false);
    expect(isTitleWorthy("Danke, das passt so.")).toBe(false);
  });

  it("puts the newest prompt first and shortens long ones", () => {
    const prompt = buildTitlePrompt(["Neu\nmit Zeilen", "x".repeat(500)]);
    expect(prompt).toMatch(/Neueste Anfrage: Neu mit Zeilen\nDavor: x{299}…$/);
  });
});

describe("RuntimeCatalog", () => {
  const model = (value: string, displayName: string) => ({ value, displayName, description: "" });
  const init = (...models: Array<ReturnType<typeof model>>) => ({ models: [model("default", "Default"), ...models], commands: [], agents: [] }) as never;

  it("notices new models from Claude Code and remembers them across restarts", async () => {
    const events: ServerEvent[] = [];
    const catalog = () => new RuntimeCatalog(new SessionCore(db, (e) => events.push(e)), {} as ProjectManager, {} as ClaudeRuntime);
    const first = catalog();
    // The first list ever: nothing to announce.
    first.noteInitialization(init(model("opus", "Opus 5.5"), model("haiku", "Haiku 4.5")));
    expect(events).toEqual([]);
    first.noteInitialization(init(model("opus", "Opus 5.5"), model("haiku", "Haiku 4.5")));
    expect(events).toEqual([]);

    // A Claude Code update brings a model: after a restart, FORGE still knows what is new.
    const next = catalog();
    next.noteInitialization(init(model("opus", "Opus 5.5"), model("haiku", "Haiku 4.5"), model("claude-opus-6", "Opus 6")));
    expect(events).toEqual([{ event: "runtime.models", payload: { added: [{ value: "claude-opus-6", displayName: "Opus 6" }] } }]);
    // A model that goes away is a change, but nothing new.
    next.noteInitialization(init(model("opus", "Opus 5.5"), model("claude-opus-6", "Opus 6")));
    expect(events.at(-1)).toEqual({ event: "runtime.models", payload: { added: [] } });
    expect(await next.runtimeInfo()).toMatchObject({ models: [{ value: "default" }, { value: "opus" }, { value: "claude-opus-6" }] });
  });

  it("reads the list again after invalidate and keeps the old one when that fails", async () => {
    let probes = 0;
    const runtime = {
      probe: async () => {
        probes++;
        if (probes > 1) throw new Error("offline");
        return init(model("opus", "Opus 5.5"));
      },
    } as unknown as ClaudeRuntime;
    db.updateSettings({ claudePath: process.execPath });
    const catalog = new RuntimeCatalog(core, {} as ProjectManager, runtime);
    expect((await catalog.runtimeInfo())?.models).toHaveLength(2);
    await catalog.runtimeInfo();
    expect(probes).toBe(1);
    catalog.invalidate();
    expect((await catalog.runtimeInfo())?.models).toHaveLength(2);
    expect(probes).toBe(2);
  });
});
