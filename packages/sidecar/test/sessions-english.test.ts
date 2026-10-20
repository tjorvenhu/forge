import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeRuntime } from "../src/claude/runtime.js";
import { GitEngine } from "../src/git/git.js";
import { setLanguage } from "../src/i18n/index.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { AUTO_CONTINUE_PROMPT, autoContinuePrompt } from "../src/sessions/auto-continue.js";
import { ClaudeAssist } from "../src/sessions/claude-assist.js";
import { isRemotePlaceholderTitle, remotePlaceholderTitle } from "../src/sessions/live-session.js";
import { taskNote } from "../src/sessions/task-message.js";
import { buildTitlePrompt } from "../src/sessions/titles.js";
import { UPDATE_CONTINUE_PROMPT, updateContinuePrompt } from "../src/sessions/update-resume.js";
import { tempDir } from "./helpers.js";

describe("session prompts in English", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let projectId: string;

  beforeEach(async () => {
    setLanguage("en");
    t = tempDir();
    const dir = path.join(t.dir, "proj");
    mkdirSync(dir, { recursive: true });
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, new GitEngine(), () => "balanced");
    projectId = (await projects.import(dir)).id;
    db.updateSettings({ claudePath: process.execPath });
    const now = new Date().toISOString();
    db.insertSession({
      id: "s1",
      projectId,
      claudeSessionId: null,
      cwd: dir,
      title: "x",
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
  });
  afterEach(() => {
    setLanguage("de");
    db.close();
    t.cleanup();
  });

  it("asks for an English session title", () => {
    const prompt = buildTitlePrompt(["Build the login page", "Older request"]);
    expect(prompt).toMatch(/^Write a short English title/);
    expect(prompt).toMatch(/Newest request: Build the login page\nBefore: Older request$/);
  });

  it("asks for an English summary and labels the transcript in English", async () => {
    db.appendEvent("s1", { type: "user.message", text: "Fix the tests", uuid: "u1" });
    db.appendEvent("s1", { type: "turn.result", isError: false } as never);
    const prompts: string[] = [];
    const runtime = { complete: async (p: string) => (prompts.push(p), " - done ") } as unknown as ClaudeRuntime;
    const assist = new ClaudeAssist(db, projects, new GitEngine(), runtime);
    expect((await assist.summarize("s1")).summary).toBe("- done");
    expect(prompts[0]).toMatch(/^Summarize this Claude Code session .* In English, at most 6 bullet points:/);
    expect(prompts[0]).toContain("USER: Fix the tests");
    expect(prompts[0]).toContain("RESULT: done");
  });

  it("answers a phone question from the named sessions' histories", async () => {
    db.appendEvent("s1", { type: "user.message", text: "Add passkey login", uuid: "u1" });
    db.appendEvent("s1", { type: "assistant.text", text: "Passkeys work, Safari is untested." } as never);
    const prompts: Array<{ p: string; purpose: string; effort?: string }> = [];
    const runtime = { complete: async (p: string, o: { purpose: string; effort?: string }) => (prompts.push({ p, purpose: o.purpose, effort: o.effort }), " Safari is still untested. ") } as unknown as ClaudeRuntime;
    const assist = new ClaudeAssist(db, projects, new GitEngine(), runtime);
    expect((await assist.answerQuestion("What is left?", [{ id: "s1", label: "S2 Passkeys" }])).answer).toBe("Safari is still untested.");
    expect(prompts[0]!.purpose).toBe("phone");
    // The caller waits in silence on the line.
    expect(prompts[0]!.effort).toBe("low");
    expect(prompts[0]!.p).toMatch(/^The user asks about their Claude Code sessions on the phone\./);
    expect(prompts[0]!.p).toContain("Question: What is left?\n\n=== Session S2 Passkeys\nUSER: Add passkey login\nCLAUDE: Passkeys work, Safari is untested.");
  });

  it("writes the pull request prompt in English and reads an English fallback answer", async () => {
    const git = {
      currentBranch: async () => "feature",
      defaultBranch: async () => "main",
      rangeSummary: async () => ({ commits: ["Add login"], diff: "+login" }),
    } as unknown as GitEngine;
    const prompts: string[] = [];
    const runtime = {
      completeJson: async (p: string) => {
        prompts.push(p);
        throw new Error("no structured output");
      },
      complete: async (p: string) => (prompts.push(p), "TITLE: Add login\nDESCRIPTION:\nAdds the login page."),
    } as unknown as ClaudeRuntime;
    const pr = await new ClaudeAssist(db, projects, git, runtime).suggestPullRequest(projectId);
    expect(pr).toEqual({ title: "Add login", body: "Adds the login page.", base: "main", head: "feature" });
    expect(prompts[0]).toMatch(/^Write the title and description for a GitHub pull request\./);
    expect(prompts[0]).toContain("Diff (truncated):");
    expect(prompts[1]).toContain("TITLE: <title>");
  });

  it("tells Claude about messages to tasks in English", () => {
    const note = taskNote({ ref: { taskId: "a1", toolUseId: null, kind: "agent", description: "Research" }, running: false, command: null });
    expect(note).toMatch(/^\[FORGE note, not written by the user\] .*subagent "Research" \(agentId a1, finished\).*SendMessage tool \(to: "a1"\)/);
    const shell = taskNote({ ref: { taskId: "b2", toolUseId: null, kind: "shell", description: "Server" }, running: true, command: "pnpm dev" });
    expect(shell).toContain('background task "Server" (task ID b2, command: pnpm dev; still running)');
  });

  it("sends the automatic messages in English and keeps the German constants for older events", () => {
    expect(autoContinuePrompt()).toBe("The usage limit has reset. Please continue where you left off.");
    expect(updateContinuePrompt()).toMatch(/^FORGE was just updated and restarted\./);
    expect(AUTO_CONTINUE_PROMPT).toMatch(/^Das Nutzungslimit/);
    expect(UPDATE_CONTINUE_PROMPT).toMatch(/^FORGE wurde gerade aktualisiert/);
  });

  it("recognizes the placeholder title of a remote session in both languages", () => {
    expect(remotePlaceholderTitle()).toBe("Remote session");
    expect(isRemotePlaceholderTitle("Remote session")).toBe(true);
    expect(isRemotePlaceholderTitle("Remote-Session")).toBe(true);
    expect(isRemotePlaceholderTitle("Login page")).toBe(false);
  });
});
