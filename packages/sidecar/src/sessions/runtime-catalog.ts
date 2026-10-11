import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import type { PlanUsage, RuntimeInfo, SlashCommand } from "@forge/protocol";
import type { ClaudeRuntime } from "../claude/runtime.js";
import { locateClaude, sessionEnv } from "../claude/environment.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionCore } from "./session-core.js";

/**
 * What the installed Claude Code offers: capabilities, models, slash commands, MCP servers and plan
 * usage. Taken from running sessions where possible and cached, so UI refreshes do not spawn a CLI.
 */
export class RuntimeCatalog {
  private initCache: SDKControlInitializeResponse | null = null;
  private cliCapabilities: string[] = [];
  /** from the latest system/init; null until a session has started */
  private mcpServers: Array<{ name: string; status: string }> | null = null;
  private usageCache: { at: number; value: PlanUsage } | null = null;
  private commandCache = new Map<string, { at: number; value: SlashCommand[] }>();

  constructor(
    private readonly core: SessionCore,
    private readonly projects: ProjectManager,
    private readonly runtime: ClaudeRuntime,
  ) {}

  capabilities() {
    return this.runtime.capabilities(this.initCache, this.cliCapabilities);
  }

  /** The initialize response of a started session. */
  noteInitialization(init: SDKControlInitializeResponse) {
    this.initCache = init;
  }

  /** Capabilities and MCP servers from a session's system/init message. */
  noteSystemInit(m: Record<string, unknown>) {
    if (Array.isArray(m.capabilities)) this.cliCapabilities = m.capabilities.filter((c): c is string => typeof c === "string");
    if (Array.isArray(m.mcp_servers)) {
      this.mcpServers = m.mcp_servers.map((s: { name?: unknown; status?: unknown }) => ({
        name: String(s.name ?? ""),
        status: String(s.status ?? "unknown"),
      }));
    }
  }

  /** Plan usage, cached for a minute so frequent UI refreshes do not spawn a CLI each time. */
  async planUsage(refresh: boolean): Promise<PlanUsage> {
    if (!refresh && this.usageCache && Date.now() - this.usageCache.at < 60_000) return this.usageCache.value;
    const settings = this.core.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    const unavailable = (error: string): PlanUsage => ({ available: false, subscriptionType: null, windows: [], fetchedAt: new Date().toISOString(), error });
    if (!claudePath) return unavailable("Claude Code nicht gefunden");
    try {
      const value = await this.runtime.planUsage({ cwd: process.cwd(), env: sessionEnv(settings.stripApiKey), claudePath });
      this.usageCache = { at: Date.now(), value };
      return value;
    } catch (e) {
      return unavailable(e instanceof Error ? e.message.slice(0, 300) : String(e));
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo | null> {
    if (!this.initCache) {
      const settings = this.core.db.getSettings();
      const claudePath = locateClaude(settings.claudePath);
      if (!claudePath) return null;
      try {
        this.initCache = await this.runtime.probe({ cwd: process.cwd(), env: sessionEnv(settings.stripApiKey), claudePath });
      } catch {
        return null;
      }
    }
    return { ...toRuntimeInfo(this.initCache), mcpServers: this.mcpServers ?? [] };
  }

  /** Slash commands for a project; from the live session when there is one, else a short probe. */
  async commands(projectId: string | undefined): Promise<SlashCommand[]> {
    const dir = projectId ? this.projects.requireExisting(projectId).path : process.cwd();
    const liveOne = [...this.core.live.values()].find((l) => l.projectDir === dir && !l.closing);
    if (liveOne) {
      try {
        return await liveOne.rt.supportedCommands();
      } catch {
        /* fall back to probe */
      }
    }
    const cached = this.commandCache.get(dir);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const settings = this.core.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) return [];
    const value = await this.runtime.commands({ cwd: dir, env: sessionEnv(settings.stripApiKey), claudePath });
    this.commandCache.set(dir, { at: Date.now(), value });
    return value;
  }
}

function toRuntimeInfo(init: SDKControlInitializeResponse): RuntimeInfo {
  return {
    models: (init.models ?? []).map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      supportsEffort: m.supportsEffort,
      supportedEffortLevels: m.supportedEffortLevels,
    })),
    commands: (init.commands ?? []).map((c) => ({ name: c.name, description: c.description })),
    agents: (init.agents ?? []).map((a) => ({ name: a.name, description: a.description })),
    mcpServers: [],
    account: { subscriptionType: init.account?.subscriptionType ?? null, apiProvider: init.account?.apiProvider ?? null },
  };
}
