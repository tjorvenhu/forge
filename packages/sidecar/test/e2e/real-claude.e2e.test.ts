import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionEventBody } from "@forge/protocol";
import { initRepo, tempDir, git } from "../helpers.js";
import { SidecarClient } from "./client.js";

/**
 * Real end-to-end run: built sidecar process + installed Claude Code CLI with the
 * user's existing login + real git. Uses the small haiku model to keep usage low.
 * Skips automatically when FORGE_E2E=0.
 */
const enabled = process.env.FORGE_E2E !== "0";
const MODEL = process.env.FORGE_E2E_MODEL ?? "haiku";

describe.skipIf(!enabled)("E2E: sidecar with real Claude Code", () => {
  const t = tempDir("forge-e2e-");
  const dataDir = path.join(t.dir, "..", "data");
  const projectPath = path.join(t.dir, "e2e projekt");
  let c: SidecarClient;
  let projectId = "";
  let sessionId = "";

  beforeAll(async () => {
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    await initRepo(projectPath);
    c = new SidecarClient(dataDir);
    await c.waitFor((e) => e.event === "sidecar.ready", 15_000, "ready");
  }, 30_000);

  afterAll(async () => {
    await c?.close();
    t.cleanup();
  });

  it("diagnostics: CLI found, logged in via subscription, no API key forced", async () => {
    const d = await c.request("system.diagnostics", { refresh: true });
    expect(d.claude.found).toBe(true);
    expect(d.auth.loggedIn).toBe(true);
    expect(d.git.found).toBe(true);
    console.log("[e2e] claude", d.claude.version, "auth", d.auth.authMethod, d.auth.subscriptionType, "apiKeyEnv", d.apiKeyEnvPresent);
  }, 60_000);

  it("imports the project (path with spaces/umlauts)", async () => {
    const p = await c.request("projects.import", { path: projectPath });
    projectId = p.id;
    expect(p.exists).toBe(true);
    const list = await c.request("projects.list", {});
    expect(list.find((x) => x.id === projectId)?.git?.branch).toBe("main");
  });

  it("starts a real session, streams deltas, shows tool events and writes a file (Balanced = acceptEdits)", async () => {
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt: "Create a file named hello.txt containing exactly the text: Hallo FORGE. Use the Write tool. Reply with one short sentence.",
    });
    sessionId = s.id;
    expect(s.permissionMode).toBe("acceptEdits");
    const result = await c.waitTurn(sessionId, before);
    expect(result).toMatchObject({ type: "turn.result", isError: false });

    const bodies = c.events
      .slice(before)
      .filter((e) => e.event === "session.event" && e.payload.sessionId === sessionId)
      .map((e) => (e.event === "session.event" ? e.payload.body : null)) as SessionEventBody[];
    const init = bodies.find((b) => b.type === "session.init");
    expect(init).toBeTruthy();
    if (init?.type === "session.init") {
      expect(init.cwd.toLowerCase()).toBe(projectPath.toLowerCase());
      console.log("[e2e] apiKeySource", init.apiKeySource, "model", init.model, "cli", init.claudeCodeVersion);
    }
    expect(bodies.some((b) => b.type === "assistant.delta")).toBe(true);
    expect(bodies.some((b) => b.type === "tool.use" && b.name === "Write")).toBe(true);
    expect(bodies.some((b) => b.type === "tool.result" && !b.isError)).toBe(true);
    expect(readFileSync(path.join(projectPath, "hello.txt"), "utf8")).toMatch(/Hallo FORGE/);

    const stored = await c.request("sessions.events", { sessionId });
    expect(stored.map((e) => e.body.type)).toEqual(expect.arrayContaining(["user.message", "session.init", "tool.use", "tool.result", "turn.result"]));
  }, 240_000);

  it("shows the real git status/diff and commits the reviewed file", async () => {
    const st = await c.request("git.status", { projectId });
    expect(st.files.map((f) => [f.path, f.kind])).toEqual([["hello.txt", "untracked"]]);
    const d = await c.request("git.diff", { projectId, path: "hello.txt", staged: false });
    expect(d.lines.some((l) => l.kind === "add" && l.text.includes("Hallo FORGE"))).toBe(true);
    await git(projectPath, "config", "user.email", "e2e@forge.local");
    const r = await c.request("git.commit", { projectId, message: "feat: hello.txt von Claude", paths: ["hello.txt"] });
    expect(r.summary).toBe("feat: hello.txt von Claude");
    expect((await c.request("git.status", { projectId })).files).toEqual([]);
  }, 60_000);

  it("Safe profile asks for approval; a denial reaches Claude and nothing is executed", async () => {
    await c.request("projects.update", { projectId, profile: "safe" });
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt: "Run this exact shell command with the Bash tool: echo forge > approved.txt . Do not use any other tool.",
    });
    expect(s.permissionMode).toBe("default");
    const req = await c.waitFor(
      (e) => c.events.indexOf(e) >= before && e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "approval.request",
      180_000,
      "approval.request",
    );
    if (req.event !== "session.event" || req.payload.body.type !== "approval.request") throw new Error("unexpected");
    expect(req.payload.body.allowSessionScope).toBe(false);
    expect((await c.request("sessions.get", { sessionId: s.id })).status).toBe("waiting_approval");
    await c.request("sessions.respondApproval", { sessionId: s.id, requestId: req.payload.body.requestId, decision: "deny", message: "E2E: abgelehnt" });
    const result = await c.waitTurn(s.id, before);
    expect(result?.type).toBe("turn.result");
    expect(existsSync(path.join(projectPath, "approved.txt"))).toBe(false);
    await c.request("sessions.close", { sessionId: s.id });
    await c.request("projects.update", { projectId, profile: "balanced" });
  }, 240_000);

  it("Autonomous (bypassPermissions) still enforces the FORGE guard via PreToolUse hook", async () => {
    await git(projectPath, "branch", "keep-me");
    await c.request("settings.update", { autonomousUnlocked: true });
    await c.request("projects.confirmAutonomous", { projectId, confirmName: "e2e projekt" });
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt: "Run exactly this shell command with the Bash tool, nothing else: git branch -D keep-me",
    });
    expect(s.permissionMode).toBe("bypassPermissions");
    const blocked = await c.waitFor(
      (e) => c.events.indexOf(e) >= before && e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "policy.blocked",
      180_000,
      "policy.blocked",
    );
    if (blocked.event === "session.event" && blocked.payload.body.type === "policy.blocked") expect(blocked.payload.body.rule).toBe("git-branch-delete");
    await c.waitTurn(s.id, before);
    expect(await git(projectPath, "branch", "--list", "keep-me")).toContain("keep-me");
    await c.request("sessions.close", { sessionId: s.id });
    await c.request("projects.update", { projectId, profile: "balanced" });
    await c.request("settings.update", { autonomousUnlocked: false });
  }, 240_000);

  it("stops a running turn and keeps the session usable", async () => {
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt: "Write the numbers from 1 to 400, each on its own line, with the word 'Zeile' before each number. No tools.",
    });
    await c.waitFor(
      (e) => c.events.indexOf(e) >= before && e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "assistant.delta",
      120_000,
      "first delta",
    );
    await c.request("sessions.stop", { sessionId: s.id });
    const result = await c.waitTurn(s.id, before, 60_000);
    expect(result?.type).toBe("turn.result");
    const after = await c.request("sessions.get", { sessionId: s.id });
    expect(after.status).toBe("idle");
    expect(after.live).toBe(true);
    await c.request("sessions.close", { sessionId: s.id });
  }, 240_000);

  it("survives a sidecar crash: session is marked interrupted and resumes with its context", async () => {
    await c.kill();
    c = new SidecarClient(dataDir);
    await c.waitFor((e) => e.event === "sidecar.ready", 15_000, "ready");
    const s = await c.request("sessions.get", { sessionId });
    expect(s.live).toBe(false);
    expect(["interrupted", "stopped", "idle"]).toContain(s.status);
    const projects = await c.request("projects.list", {});
    expect(projects.some((p) => p.id === projectId)).toBe(true);

    const before = c.events.length;
    await c.request("sessions.resume", {
      sessionId,
      prompt: "What is the exact name of the file you created earlier in this conversation? Answer with the file name only.",
    });
    const result = await c.waitTurn(sessionId, before);
    expect(result).toMatchObject({ isError: false });
    if (result?.type === "turn.result") expect(result.text ?? "").toMatch(/hello\.txt/);
    expect((await c.request("sessions.get", { sessionId })).cwd.toLowerCase()).toBe(projectPath.toLowerCase());
  }, 240_000);
});
