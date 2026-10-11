import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, RuntimeSession } from "../src/claude/runtime.js";
import { Normalizer } from "../src/claude/normalize.js";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { PROFILES } from "../src/policy/profiles.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { ApprovalGate, denyPending } from "../src/sessions/approvals.js";
import type { LiveSession } from "../src/sessions/live-session.js";
import { PermissionModes } from "../src/sessions/permission-mode.js";
import { SessionCore } from "../src/sessions/session-core.js";
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
    rt: { close: () => {}, setPermissionMode: async () => {}, ...rt } as RuntimeSession,
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
  const host = { abortReason: () => "Abgebrochen", syncPermissionMode: () => {} };

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
});

describe("PermissionModes", () => {
  it("ends a process whose mode above the profile cannot be reset", async () => {
    const close = vi.fn();
    const live = liveSession({ close, setPermissionMode: async () => Promise.reject(new Error("gone")) });
    new PermissionModes(core, {} as ProjectManager).sync(SID, "bypassPermissions");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(live.closing).toBe(true);
    expect(db.getSession(SID)?.permissionMode).toBe("acceptEdits");
    expect(db.listEvents(SID).map((e) => e.body.type)).toEqual(["policy.blocked", "error"]);
  });
});
