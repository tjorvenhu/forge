import { readFile } from "node:fs/promises";
import os from "node:os";
import type { Capability, Diagnostics, ToolCheck } from "@forge/protocol";
import { run } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";
import { claudeJsonPath } from "../util/paths.js";
import { apiKeyEnvPresent, locateClaude, sessionEnv } from "./environment.js";

async function versionOf(bin: string | null, args: string[], env?: NodeJS.ProcessEnv, bundled = false): Promise<ToolCheck> {
  if (!bin) return { found: false, bundled, version: null, path: null, error: "nicht gefunden" };
  const r = await run(bin, args, { timeoutMs: 15_000, env });
  if (r.spawnError) return { found: false, bundled, version: null, path: bin, error: r.spawnError.message };
  if (r.code !== 0) return { found: true, bundled, version: null, path: bin, error: (r.stderr || r.stdout).trim().slice(0, 300) };
  return { found: true, bundled, version: r.stdout.trim().split("\n")[0] ?? null, path: bin, error: null };
}

const NOT_CHECKED: Diagnostics["auth"] = {
  checked: false,
  loggedIn: false,
  authMethod: null,
  subscriptionType: null,
  rateLimitTier: null,
  apiProvider: null,
  error: null,
};

/**
 * Rate limit tier of the Claude account (e.g. `default_claude_max_20x`). `claude auth status` does not
 * report it; Claude Code keeps it in `oauthAccount` of .claude.json. Only this one field is read.
 */
export async function readRateLimitTier(file = claudeJsonPath()): Promise<string | null> {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as { oauthAccount?: Record<string, unknown> };
    const a = j.oauthAccount ?? {};
    const tier = a.userRateLimitTier ?? a.organizationRateLimitTier;
    return typeof tier === "string" && tier ? tier : null;
  } catch {
    return null;
  }
}

/** Sign-in state as `claude auth status` reports it. */
export async function readAuth(claudeBin: string, env: Record<string, string>): Promise<Diagnostics["auth"]> {
  const auth = { ...NOT_CHECKED };
  const r = await run(claudeBin, ["auth", "status"], { timeoutMs: 20_000, env });
  auth.checked = true;
  try {
    // Only non-identifying fields are kept; email and org are dropped on purpose.
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    auth.loggedIn = j.loggedIn === true;
    auth.authMethod = typeof j.authMethod === "string" ? j.authMethod : null;
    auth.subscriptionType = typeof j.subscriptionType === "string" ? j.subscriptionType : null;
    auth.apiProvider = typeof j.apiProvider === "string" ? j.apiProvider : null;
    if (auth.loggedIn && auth.subscriptionType) auth.rateLimitTier = await readRateLimitTier();
  } catch {
    auth.error = (r.stderr || r.stdout).trim().slice(0, 300) || "Auth-Status nicht lesbar";
  }
  return auth;
}

export async function collectDiagnostics(opts: {
  claudePathSetting: string | null;
  stripApiKey: boolean;
  dataDir: string;
  capabilities: Capability[];
}): Promise<Diagnostics> {
  const env = sessionEnv(opts.stripApiKey);
  const claudeBin = locateClaude(opts.claudePathSetting);
  const gitTool = resolveTool("git");
  const ghTool = resolveTool("gh");
  const ghBin = ghTool?.path ?? null;

  const [claude, git, gh] = await Promise.all([
    versionOf(claudeBin, ["--version"], env),
    versionOf(gitTool?.path ?? null, ["--version"], undefined, gitTool?.bundled),
    versionOf(ghBin, ["--version"], undefined, ghTool?.bundled),
  ]);

  const auth = claude.found && claudeBin ? await readAuth(claudeBin, env) : NOT_CHECKED;

  let ghAuth: boolean | null = null;
  if (gh.found && ghBin) {
    const r = await run(ghBin, ["auth", "status"], { timeoutMs: 15_000 });
    ghAuth = r.code === 0;
  }

  return {
    platform: `${os.type()} ${os.release()} (${process.arch})`,
    nodeVersion: process.version,
    dataDir: opts.dataDir,
    claude,
    auth,
    apiKeyEnvPresent: apiKeyEnvPresent(),
    apiKeyStripped: opts.stripApiKey,
    git,
    gh: { ...gh, authenticated: ghAuth },
    capabilities: opts.capabilities,
  };
}
