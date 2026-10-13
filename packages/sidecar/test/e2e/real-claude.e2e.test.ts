import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionEventBody } from "@forge/protocol";
import { initRepo, tempDir, git } from "../helpers.js";
import { SidecarClient } from "./client.js";
import { PhoneAgent } from "../../src/phone/phone-agent.js";

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
    const u = await c.request("system.usage", { refresh: true });
    expect(u.error).toBeNull();
    if (d.auth.subscriptionType) {
      expect(u.available).toBe(true);
      expect(u.windows.some((w) => w.key === "five_hour")).toBe(true);
    }
    console.log("[e2e] usage", u.windows.map((w) => `${w.label} ${w.utilization}%`).join(", "));
    console.log("[e2e] claude", d.claude.version, "auth", d.auth.authMethod, d.auth.subscriptionType, "apiKeyEnv", d.apiKeyEnvPresent);
  }, 60_000);

  it("imports the project (path with spaces/umlauts)", async () => {
    const p = await c.request("projects.import", { path: projectPath });
    projectId = p.id;
    expect(p.exists).toBe(true);
    expect(p.profile).toBe("autonomous");
    // The following tests start from Balanced and switch profiles explicitly.
    await c.request("projects.update", { projectId, profile: "balanced" });
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
    const suggestion = await c.request("git.suggestCommitMessage", { projectId, paths: ["hello.txt"] });
    expect(suggestion.message.length).toBeGreaterThan(5);
    expect(suggestion.message.split("\n")[0]!.length).toBeLessThanOrEqual(100);
    console.log("[e2e] commit suggestion:", JSON.stringify(suggestion.message));
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
    await c.request("projects.update", { projectId, profile: "autonomous" });
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
  }, 240_000);

  it("switches a running session from Balanced to Autonomous without a restart", async () => {
    let before = c.events.length;
    const s = await c.request("sessions.start", { projectId, model: MODEL, prompt: "Reply with the single word READY." });
    expect(s.permissionMode).toBe("acceptEdits");
    await c.waitTurn(s.id, before);
    await c.request("projects.update", { projectId, profile: "autonomous" });
    expect((await c.request("sessions.get", { sessionId: s.id })).permissionMode).toBe("bypassPermissions");
    before = c.events.length;
    await c.request("sessions.send", { sessionId: s.id, text: "Run exactly this shell command with the Bash tool: git status --short. Then reply DONE." });
    const result = await c.waitTurn(s.id, before);
    expect(result).toMatchObject({ type: "turn.result", isError: false });
    const approvals = c.events.slice(before).filter((e) => e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "approval.request");
    expect(approvals).toEqual([]);
    await c.request("sessions.close", { sessionId: s.id });
    await c.request("projects.update", { projectId, profile: "balanced" });
  }, 240_000);

  it("shows a background task and follows the turn Claude starts when it finishes", async () => {
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt:
        "Use the Bash tool with run_in_background set to true to run: sleep 10 && echo FINISHED. Do not wait for it; reply with the word STARTED. When you later learn it finished, reply with the word COMPLETE.",
    });
    await c.waitTurn(s.id, before);
    const mid = await c.request("sessions.get", { sessionId: s.id });
    expect(mid.background.length).toBe(1);
    const afterFirst = c.events.length;
    // The second turn has no user message: FORGE must report it as running and then finish it.
    await c.waitFor(
      (e) => c.events.indexOf(e) >= afterFirst && e.event === "session.updated" && e.payload.id === s.id && e.payload.status === "running",
      120_000,
      "running again",
    );
    const result = await c.waitTurn(s.id, afterFirst);
    expect(result).toMatchObject({ type: "turn.result", isError: false });
    const done = await c.request("sessions.get", { sessionId: s.id });
    expect(done).toMatchObject({ status: "idle", background: [] });
    const states = c.events
      .slice(before)
      .flatMap((e) => (e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "background.task" ? [e.payload.body.state] : []));
    expect(states).toEqual(["started", "completed"]);
    await c.request("sessions.close", { sessionId: s.id });
  }, 240_000);

  it("sends an image attachment that Claude can see", async () => {
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt: "Welche Farbe hat das angehängte Bild? Antworte nur mit einem Wort.",
      attachments: [{ kind: "data", name: "farbe.png", mediaType: "image/png", base64: solidPng(16, 16, [220, 20, 20]).toString("base64") }],
    });
    const result = await c.waitTurn(s.id, before);
    expect(result).toMatchObject({ isError: false });
    if (result?.type === "turn.result") expect(result.text ?? "").toMatch(/rot|red/i);
    const stored = await c.request("sessions.events", { sessionId: s.id });
    const um = stored.find((e) => e.body.type === "user.message")?.body;
    expect(um).toMatchObject({ attachments: [{ name: "farbe.png", mediaType: "image/png" }] });
    await c.request("sessions.close", { sessionId: s.id });
  }, 240_000);

  it("rewinds files Claude changed after a message (checkpointing)", async () => {
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt: "Create the file rewind-me.txt with the content 'temp' using the Write tool. Reply with one word.",
    });
    await c.waitTurn(s.id, before);
    expect(existsSync(path.join(projectPath, "rewind-me.txt"))).toBe(true);
    const stored = await c.request("sessions.events", { sessionId: s.id });
    const uuid = stored.find((e) => e.body.type === "user.message" && e.body.uuid)?.body;
    if (uuid?.type !== "user.message" || !uuid.uuid) throw new Error("no uuid");
    const dry = await c.request("sessions.rewind", { sessionId: s.id, messageUuid: uuid.uuid, dryRun: true });
    expect(dry.canRewind).toBe(true);
    const r = await c.request("sessions.rewind", { sessionId: s.id, messageUuid: uuid.uuid, dryRun: false });
    expect(r.canRewind).toBe(true);
    expect(existsSync(path.join(projectPath, "rewind-me.txt"))).toBe(false);
    await c.request("sessions.close", { sessionId: s.id });
  }, 240_000);

  it("summarizes a session from its recorded transcript", async () => {
    const r = await c.request("sessions.summarize", { sessionId });
    expect(r.summary.length).toBeGreaterThan(20);
    expect(r.summary).toMatch(/hello\.txt/i);
  }, 120_000);

  it("lists slash commands for the project", async () => {
    const cmds = await c.request("system.commands", { projectId });
    expect(Array.isArray(cmds)).toBe(true);
    console.log("[e2e] commands", cmds.length, cmds.slice(0, 8).map((x) => x.name).join(", "));
  }, 60_000);

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

  it("answers a question from Claude, also in Autonomous, and reports the context usage", async () => {
    await c.request("projects.update", { projectId, profile: "autonomous" });
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      prompt: "Use the AskUserQuestion tool exactly once to ask me which colour I prefer, with the options Rot and Blau. Then reply with only the colour I chose.",
    });
    const ask = await c.waitFor(
      (e) => c.events.indexOf(e) >= before && e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "approval.request",
      120_000,
      "question",
    );
    const req = ask.event === "session.event" && ask.payload.body.type === "approval.request" ? ask.payload.body : null;
    expect(req?.toolName).toBe("AskUserQuestion");
    const question = (req!.input.questions as Array<{ question: string }>)[0]!.question;
    await c.request("sessions.respondApproval", { sessionId: s.id, requestId: req!.requestId, decision: "allow", answers: { [question]: "Blau" } });
    const result = await c.waitTurn(s.id, before);
    expect(result).toMatchObject({ isError: false });
    if (result?.type === "turn.result") expect(result.text ?? "").toMatch(/Blau/i);
    const resolved = c.events.find((e) => e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "approval.resolved");
    expect(resolved?.event === "session.event" && resolved.payload.body).toMatchObject({ answers: { [question]: "Blau" } });

    await c.waitFor((e) => e.event === "session.updated" && e.payload.id === s.id && e.payload.context !== null, 30_000, "context");
    const ctx = await c.request("sessions.contextUsage", { sessionId: s.id });
    expect(ctx?.maxTokens).toBeGreaterThan(0);
    expect(ctx?.totalTokens).toBeGreaterThan(0);
    console.log("[e2e] context", ctx?.totalTokens, "/", ctx?.maxTokens, `${ctx?.percentage}%`);

    // The compact button sends /compact as a message.
    const beforeCompact = c.events.length;
    await c.request("sessions.send", { sessionId: s.id, text: "/compact", attachments: [] });
    await c.waitFor(
      (e) => c.events.indexOf(e) >= beforeCompact && e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "context.compacted",
      180_000,
      "context.compacted",
    );
    await c.waitTurn(s.id, beforeCompact);
    await c.request("sessions.close", { sessionId: s.id });
  }, 420_000);

  it("plan mode in Autonomous: the plan file is allowed, accepting the plan switches to the profile's mode", async () => {
    const before = c.events.length;
    const s = await c.request("sessions.start", {
      projectId,
      model: MODEL,
      planOnly: true,
      prompt: "Plan creating a file plan-ok.txt containing the word ok. Keep the plan to two short lines and present it with ExitPlanMode. After approval, create the file.",
    });
    expect(s.permissionMode).toBe("plan");
    const ask = await c.waitFor(
      (e) => c.events.indexOf(e) >= before && e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "approval.request",
      180_000,
      "plan approval",
    );
    const req = ask.event === "session.event" && ask.payload.body.type === "approval.request" ? ask.payload.body : null;
    expect(req?.toolName).toBe("ExitPlanMode");
    expect(typeof req?.input.plan).toBe("string");
    await c.request("sessions.respondApproval", { sessionId: s.id, requestId: req!.requestId, decision: "allow" });
    const result = await c.waitTurn(s.id, before);
    expect(result).toMatchObject({ isError: false });
    expect((await c.request("sessions.get", { sessionId: s.id })).permissionMode).toBe("bypassPermissions");
    expect(existsSync(path.join(projectPath, "plan-ok.txt"))).toBe(true);
    const blocked = c.events.filter((e) => c.events.indexOf(e) >= before && e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "policy.blocked");
    expect(blocked).toEqual([]);
    await c.request("sessions.close", { sessionId: s.id });
  }, 300_000);

  it("phone: Claude answers in short German sentences and uses the FORGE tools, also to hang up", async () => {
    const d = await c.request("system.diagnostics", {});
    const calls: string[] = [];
    const sentences: string[] = [];
    let turns = 0;
    let hungUp = false;
    let error: string | null = null;
    const agent = new PhoneAgent({
      claudePath: d.claude.path!,
      env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== "ANTHROPIC_API_KEY")) as Record<string, string>,
      cwd: t.dir,
      model: MODEL,
      context: "Eingehender Anruf. Steuern ist ohne PIN erlaubt.",
      tools: {
        status: async () => {
          calls.push("status");
          return "S1: „Warenkorb“ im Projekt shop, fertig, wartet auf Anweisungen, zuletzt vor 2 Minuten.";
        },
        details: async () => (calls.push("details"), "Letztes Ergebnis: Alle Tests grün."),
        sendMessage: async (s, text) => (calls.push(`send:${s}:${text}`), "Gesendet."),
        startSession: async () => (calls.push("start"), "Gestartet."),
        respond: async () => (calls.push("respond"), "Erledigt."),
        stop: async () => (calls.push("stop"), "Gestoppt."),
        close: async () => (calls.push("close"), "Geschlossen."),
        sessionSettings: async () => (calls.push("settings"), "Gesetzt."),
        cancelAutoContinue: async () => (calls.push("cancel"), "Abgebrochen."),
        remote: async (action) => (calls.push(`remote:${action}`), action === "on" ? "Remote Control ist an, 1 Session ist mit der Claude-App verbunden." : "Remote Control ist aus."),
        devServer: async () => (calls.push("dev"), "Läuft."),
        testDatabase: async () => (calls.push("testdb"), "Läuft."),
        knowledge: async () => (calls.push("knowledge"), "Nichts gefunden."),
        rememberNote: async () => (calls.push("remember"), "Abgelegt."),
        git: async (_p, action) => (calls.push(`git:${action}`), "Erledigt."),
        projects: async () => (calls.push("projects"), "shop"),
        usage: async () => (calls.push("usage"), "Fünf Stunden: 20 Prozent."),
        callBack: async (minutes: number) => (calls.push(`callBack:${minutes}`), "Rückruf vereinbart für 18:55 Uhr."),
      },
      onSentence: (s) => sentences.push(s),
      onTurnDone: () => turns++,
      onHangup: () => (hungUp = true),
      onError: (m) => (error = m),
    });
    try {
      agent.say("Hallo, wie ist der Stand meiner Sessions?");
      const deadline = Date.now() + 120_000;
      while (turns < 1 && !error && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      expect(error).toBeNull();
      expect(calls).toContain("status");
      expect(sentences.join(" ")).toMatch(/Warenkorb|S1/);
      expect(sentences.every((s) => !/[*#`]/.test(s))).toBe(true);
      // Short on the phone: no recap of everything it can do.
      expect(sentences.length).toBeLessThanOrEqual(3);
      console.log("[e2e] phone said:", sentences.join(" | "));

      // Steering runs right away, without asking back first.
      const said = sentences.length;
      agent.say("Schalte bitte Remote Control ein.");
      while (turns < 2 && !error && Date.now() < deadline + 60_000) await new Promise((r) => setTimeout(r, 200));
      expect(calls).toContain("remote:on");
      console.log("[e2e] phone said:", sentences.slice(said).join(" | "));

      agent.say("Danke, das war alles. Tschüss!");
      while (turns < 3 && !error && Date.now() < deadline + 120_000) await new Promise((r) => setTimeout(r, 200));
      expect(hungUp).toBe(true);
    } finally {
      agent.close();
    }
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

/** Minimal uncompressed-filter PNG with one solid color, for the attachment test. */
function solidPng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
