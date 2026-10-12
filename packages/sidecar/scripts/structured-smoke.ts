/**
 * Smoke test of structured output with the installed Claude Code CLI (subscription, model haiku).
 *
 *   pnpm tsx scripts/structured-smoke.ts
 */
import os from "node:os";
import { AgentSdkRuntime } from "../src/claude/runtime.js";
import { locateClaude, sessionEnv } from "../src/claude/environment.js";

const claudePath = locateClaude(null);
if (!claudePath) {
  console.error("Claude Code nicht gefunden");
  process.exit(2);
}
const rt = new AgentSdkRuntime();
const t = Date.now();
const out = await rt.completeJson(
  "Schreibe Titel und Beschreibung für einen Pull Request. Commits: - feat: CSV-Export für Bestellungen - test: Export-Tests",
  { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"], additionalProperties: false },
  { cwd: os.tmpdir(), env: sessionEnv(true), claudePath, model: "haiku" },
);
console.log(`nach ${Date.now() - t} ms:`, JSON.stringify(out, null, 2));
