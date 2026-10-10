import os from "node:os";
import type { Capability, Diagnostics, ToolCheck } from "@forge/protocol";
import { run, which } from "../util/proc.js";
import { apiKeyEnvPresent, locateClaude, sessionEnv } from "./environment.js";

async function versionOf(bin: string | null, args: string[], env?: NodeJS.ProcessEnv): Promise<ToolCheck> {
  if (!bin) return { found: false, version: null, path: null, error: "nicht gefunden" };
  const r = await run(bin, args, { timeoutMs: 15_000, env });
  if (r.spawnError) return { found: false, version: null, path: bin, error: r.spawnError.message };
  if (r.code !== 0) return { found: true, version: null, path: bin, error: (r.stderr || r.stdout).trim().slice(0, 300) };
  return { found: true, version: r.stdout.trim().split("\n")[0] ?? null, path: bin, error: null };
}

export async function collectDiagnostics(opts: {
  claudePathSetting: string | null;
  stripApiKey: boolean;
  dataDir: string;
  capabilities: Capability[];
}): Promise<Diagnostics> {
  const env = sessionEnv(opts.stripApiKey);
  const claudeBin = locateClaude(opts.claudePathSetting);
  // winget installs gh without updating the PATH of already running processes.
  const ghBin = which("gh") ?? (process.platform === "win32" ? which("gh", "C:\\Program Files\\GitHub CLI") : null);

  const [claude, git, gh] = await Promise.all([
    versionOf(claudeBin, ["--version"], env),
    versionOf(which("git"), ["--version"]),
    versionOf(ghBin, ["--version"]),
  ]);

  const auth: Diagnostics["auth"] = {
    checked: false,
    loggedIn: false,
    authMethod: null,
    subscriptionType: null,
    apiProvider: null,
    error: null,
  };
  if (claude.found && claudeBin) {
    const r = await run(claudeBin, ["auth", "status"], { timeoutMs: 20_000, env });
    auth.checked = true;
    try {
      // Only non-identifying fields are kept; email and org are dropped on purpose.
      const j = JSON.parse(r.stdout) as Record<string, unknown>;
      auth.loggedIn = j.loggedIn === true;
      auth.authMethod = typeof j.authMethod === "string" ? j.authMethod : null;
      auth.subscriptionType = typeof j.subscriptionType === "string" ? j.subscriptionType : null;
      auth.apiProvider = typeof j.apiProvider === "string" ? j.apiProvider : null;
    } catch {
      auth.error = (r.stderr || r.stdout).trim().slice(0, 300) || "Auth-Status nicht lesbar";
    }
  }

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
