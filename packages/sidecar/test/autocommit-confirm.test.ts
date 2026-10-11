import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEventBody } from "@forge/protocol";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { TurnAutomation } from "../src/sessions/turn-automation.js";
import { git, initRepo, tempDir } from "./helpers.js";

// Built at runtime so the source itself contains no token-shaped string.
const TOKEN = "gh" + "p_" + "A1b2C3d4".repeat(4);

let t: { dir: string; cleanup: () => void };
let db: Db;
let repo: string;
let recorded: SessionEventBody[];
let automation: TurnAutomation;
const sessionId = "s1";

beforeEach(async () => {
  t = tempDir();
  repo = path.join(t.dir, "proj");
  mkdirSync(repo, { recursive: true });
  await initRepo(repo);
  writeFileSync(path.join(repo, "README.md"), "start\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");

  db = new Db(path.join(t.dir, "forge.db"));
  const engine = new GitEngine();
  const projects = new ProjectManager(db, engine, () => "balanced");
  const project = await projects.import(repo);
  projects.update(project.id, { tags: ["auto-commit"] });
  const now = new Date().toISOString();
  db.insertSession({
    id: sessionId,
    projectId: project.id,
    claudeSessionId: null,
    cwd: repo,
    title: null,
    model: null,
    effort: null,
    profile: "balanced",
    permissionMode: "acceptEdits",
    status: "idle",
    apiKeySource: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  });
  recorded = [];
  automation = new TurnAutomation(db, projects, engine, {
    record: (_id, body) => recorded.push(body),
    emit: () => {},
    suggestCommitMessage: async () => ({ message: "feat: config" }),
  });
});

afterEach(() => {
  db.close();
  t.cleanup();
});

async function turnWithSecret(): Promise<string> {
  await automation.captureBaseline(sessionId, repo);
  writeFileSync(path.join(repo, "config.ts"), `export const token = "${TOKEN}";\n`);
  automation.schedule(sessionId);
  await automation.drain();
  const ask = recorded.find((b) => b.type === "automation.confirm");
  expect(ask).toMatchObject({ files: ["config.ts"], message: "feat: config" });
  return (ask as Extract<SessionEventBody, { type: "automation.confirm" }>).requestId;
}

const lastSubject = async () => (await git(repo, "log", "--format=%s", "-1")).trim();

describe("auto-commit with possible secrets", () => {
  it("asks instead of failing and commits after confirmation", async () => {
    const requestId = await turnWithSecret();
    expect(await lastSubject()).toBe("init");
    expect(recorded.some((b) => b.type === "automation" && !b.ok)).toBe(false);

    await automation.confirm(sessionId, requestId, true);
    expect(await lastSubject()).toBe("feat: config");
    expect(recorded).toContainEqual({ type: "automation.confirmResolved", requestId, decision: "commit" });
    expect(recorded.find((b) => b.type === "automation" && b.action === "commit")).toMatchObject({ ok: true, files: ["config.ts"] });
  });

  it("leaves the files uncommitted when the user declines", async () => {
    const requestId = await turnWithSecret();
    await automation.confirm(sessionId, requestId, false);
    expect(await lastSubject()).toBe("init");
    expect(recorded).toContainEqual({ type: "automation.confirmResolved", requestId, decision: "skip" });
  });

  it("expires when the files changed after the question", async () => {
    const requestId = await turnWithSecret();
    writeFileSync(path.join(repo, "config.ts"), "export const token = process.env.TOKEN;\n");
    await automation.confirm(sessionId, requestId, true);
    expect(await lastSubject()).toBe("init");
    expect(recorded).toContainEqual({ type: "automation.confirmResolved", requestId, decision: "expired" });
  });

  it("rejects unknown or already answered questions", async () => {
    const requestId = await turnWithSecret();
    await automation.confirm(sessionId, requestId, false);
    await expect(automation.confirm(sessionId, requestId, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(automation.confirm("other", "nope", true)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
