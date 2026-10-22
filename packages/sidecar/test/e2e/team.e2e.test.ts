import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentTeam, ServerEvent } from "@forge/protocol";
import { initRepo, tempDir } from "../helpers.js";
import { SidecarClient } from "./client.js";

/**
 * A real agent team: built sidecar, installed Claude Code, the user's login. Costs noticeably more
 * than the other E2E tests (a lead on Opus and several members), so it runs only on request:
 * FORGE_E2E_TEAM=1 pnpm --filter @forge/sidecar test:e2e -- team
 *
 * The goal has three independent parts, so a good lead splits it, runs the members in parallel on
 * their models and has the result tested. Everything the team did is printed for tuning the prompts.
 */
const enabled = process.env.FORGE_E2E_TEAM === "1";
const LEAD = (process.env.FORGE_E2E_TEAM_LEAD ?? "opus") as "opus" | "sonnet" | "fable";
const TIMEOUT_MS = 20 * 60_000;

const GOAL = `Build a tiny string utility library in plain JavaScript (ES modules, no dependencies, no build step).
Three independent functions, each in its own file with its own test file using node:test and node:assert:
1. src/slugify.js: slugify(text) turns "Hello, World!" into "hello-world" (lowercase, umlauts ä ö ü ß become ae oe ue ss, everything else not a-z0-9 becomes a single dash, no dashes at the ends).
2. src/roman.js: toRoman(n) for 1..3999 ("MCMXCIV" for 1994), throws RangeError outside.
3. src/wordcount.js: wordCount(text) returns a Map of lowercase word -> count, words are runs of letters (including umlauts) or digits.
Tests live in test/<name>.test.js. Done when "node --test" passes.`;

describe.skipIf(!enabled)("E2E: agent team with real Claude Code", () => {
  const t = tempDir("forge-team-e2e-");
  const dataDir = path.join(t.dir, "..", "data-team");
  const projectPath = path.join(t.dir, "team projekt");
  let c: SidecarClient;
  let projectId = "";
  const approvals: string[] = [];

  beforeAll(async () => {
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({ name: "strings", type: "module", private: true, scripts: { test: "node --test" } }, null, 2));
    await initRepo(projectPath);
    c = new SidecarClient(dataDir);
    await c.waitFor((e) => e.event === "sidecar.ready", 15_000, "ready");
    await c.request("settings.update", { agentTeams: true });
    const p = await c.request("projects.import", { path: projectPath });
    projectId = p.id;
    await c.request("projects.update", { projectId, profile: "balanced", testCommand: "node --test" });
  }, 60_000);

  afterAll(async () => {
    await c?.close();
    t.cleanup();
  });

  it(
    "plans, splits the work across members on their models and gets it done",
    async () => {
      const started = Date.now();
      const s = await c.request("teams.start", { projectId, prompt: GOAL, leadModel: LEAD });
      // Anything a member or the lead still asks for (team checks run on their own) is allowed and logged.
      const onEvent = (e: ServerEvent) => {
        if (e.event !== "session.event" || e.payload.sessionId !== s.id || e.payload.body.type !== "approval.request") return;
        const b = e.payload.body;
        approvals.push(`${b.toolName}: ${typeof b.input.command === "string" ? b.input.command : (b.title ?? "")}`);
        void c.request("sessions.respondApproval", { sessionId: s.id, requestId: b.requestId, decision: "allow", scope: "once" });
      };
      (c as unknown as { listeners: Array<(e: ServerEvent) => void> }).listeners.push(onEvent);
      for (const e of c.events) onEvent(e);

      // Done: the lead is idle and no member works any more (background members wake the lead again).
      let team: AgentTeam | null = null;
      let quietSince = 0;
      while (Date.now() - started < TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 5_000));
        team = await c.request("teams.get", { sessionId: s.id });
        const quiet = team.status === "idle" && !team.members.some((m) => m.state === "working");
        if (!quiet) quietSince = 0;
        else if (!quietSince) quietSince = Date.now();
        else if (Date.now() - quietSince > 15_000) break;
        if (team.status === "error") break;
      }
      expect(team).not.toBeNull();
      const tm = team!;
      const minutes = ((Date.now() - started) / 60_000).toFixed(1);
      const leadText = c.events.flatMap((e) =>
        e.event === "session.event" && e.payload.sessionId === s.id && e.payload.body.type === "assistant.text" && !e.payload.body.parentToolUseId ? [e.payload.body.text] : [],
      );

      console.log(`\n[team] ${minutes} min, lead ${tm.leadModel}, status ${tm.status}`);
      for (const m of tm.members)
        console.log(`[team] member ${m.role ?? m.agentType} on ${m.model} ${m.background ? "bg" : "fg"} ${m.state} ${m.toolUses} steps ${m.tokens ?? "?"} tokens  ${m.title}  files=${m.files.join(",")}`);
      for (const x of tm.tasks) console.log(`[team] plan ${x.status} ${x.subject}`);
      for (const [model, u] of Object.entries(tm.models)) console.log(`[team] usage ${model} in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens} $${u.costUsd.toFixed(3)}`);
      console.log(`[team] approvals asked (${approvals.length}):\n  ${approvals.join("\n  ")}`);
      console.log(`[team] lead's last words:\n${leadText.at(-1) ?? "(none)"}`);
      // Overlapping starts show whether the members ran in parallel.
      const spans = tm.members.map((m) => [Date.parse(m.startedAt), m.endedAt ? Date.parse(m.endedAt) : Date.now()] as const);
      const parallel = spans.some(([a0, a1], i) => spans.some(([b0], j) => j !== i && b0 >= a0 && b0 < a1));
      console.log(`[team] members ran in parallel: ${parallel}`);

      expect(tm.members.length).toBeGreaterThan(0);
      for (const f of ["src/slugify.js", "src/roman.js", "src/wordcount.js"]) expect(existsSync(path.join(projectPath, f)), f).toBe(true);
      const out = execFileSync(process.execPath, ["--test"], { cwd: projectPath, encoding: "utf8" });
      console.log(`[team] node --test:\n${out.split("\n").filter((l) => /^# (tests|pass|fail)/.test(l)).join("\n")}`);
    },
    TIMEOUT_MS + 60_000,
  );
});
