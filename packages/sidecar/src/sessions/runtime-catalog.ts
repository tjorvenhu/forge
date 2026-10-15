import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import type { PlanUsage, RuntimeInfo, SlashCommand } from "@forge/protocol";
import type { ClaudeRuntime } from "../claude/runtime.js";
import { locateClaude, sessionEnv } from "../claude/environment.js";
import { resetSince, settleUsage } from "../claude/usage.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionCore } from "./session-core.js";

/** Claude Code updates itself in the background; its model list is read again after this long. */
const MODELS_MAX_AGE_MS = 60 * 60_000;

/**
 * What the installed Claude Code offers: capabilities, models, slash commands, MCP servers and plan
 * usage. Taken from running sessions where possible and cached, so UI refreshes do not spawn a CLI.
 */
export class RuntimeCatalog {
  private initCache: SDKControlInitializeResponse | null = null;
  /** when initCache was read; older than MODELS_MAX_AGE_MS, runtimeInfo asks Claude Code again */
  private initAt = 0;
  /** model values of the last list, to notice changes */
  private lastModels: string | null = null;
  private cliCapabilities: string[] = [];
  /** from the latest system/init; null until a session has started */
  private mcpServers: Array<{ name: string; status: string }> | null = null;
  private usageCache: { at: number; value: PlanUsage } | null = null;
  private commandCache = new Map<string, { at: number; value: SlashCommand[] }>();

  constructor(
    private readonly core: SessionCore,
    private readonly projects: ProjectManager,
    private readonly runtime: ClaudeRuntime,
    /** clock for the plan usage cache and passed reset times */
    private readonly now: () => number = Date.now,
  ) {}

  capabilities() {
    return this.runtime.capabilities(this.initCache, this.cliCapabilities);
  }

  /** The initialize response of a started session. */
  noteInitialization(init: SDKControlInitializeResponse) {
    this.initCache = init;
    this.initAt = Date.now();
    this.noticeModels(init);
  }

  /** A short CLI start; Claude Code refreshes an expired login on the way (needed by the dictation). */
  async refreshLogin() {
    const settings = this.core.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) return;
    this.noteInitialization(await this.runtime.probe({ cwd: process.cwd(), env: sessionEnv(settings.stripApiKey), claudePath }));
  }

  /**
   * After Claude Code was installed, updated, signed in or out: the next runtimeInfo reads the list
   * again, and the usage of the old account (or of none) is not served for another minute.
   */
  invalidate() {
    this.initAt = 0;
    this.commandCache.clear();
    this.usageCache = null;
  }

  /**
   * Tells the UI when Claude Code's model list changed, and which models are new. New models come with
   * Claude Code updates (also its own background updates), so no FORGE update is needed for them.
   */
  private noticeModels(init: SDKControlInitializeResponse) {
    const models = (init.models ?? []).filter((m) => m.value !== "default");
    const values = models.map((m) => m.value);
    const key = values.join("\n");
    if (key === this.lastModels) return;
    const first = this.lastModels === null;
    this.lastModels = key;
    const known = this.core.db.getKnownModels();
    const added = known ? models.filter((m) => !known.includes(m.value)) : [];
    if (!known || added.length) this.core.db.setKnownModels([...new Set([...(known ?? []), ...values])]);
    if (!first || added.length) this.core.emit({ event: "runtime.models", payload: { added: added.map((m) => ({ value: m.value, displayName: m.displayName || m.value })) } });
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

  /**
   * Plan usage, cached for a minute so frequent UI refreshes do not spawn a CLI each time. A window
   * that reset after the cached reading makes it stale, so the next call reads the new window.
   */
  async planUsage(refresh: boolean): Promise<PlanUsage> {
    const cache = this.usageCache;
    const now = this.now();
    if (!refresh && cache && now - cache.at < 60_000 && !resetSince(cache.value, cache.at, now)) return settleUsage(cache.value, now);
    const settings = this.core.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    const unavailable = (error: string): PlanUsage => ({ available: false, subscriptionType: null, windows: [], fetchedAt: new Date().toISOString(), error });
    if (!claudePath) return unavailable("Claude Code nicht gefunden");
    try {
      const value = await this.runtime.planUsage({ cwd: process.cwd(), env: sessionEnv(settings.stripApiKey), claudePath });
      const at = this.now();
      this.usageCache = { at, value };
      return settleUsage(value, at);
    } catch (e) {
      return unavailable(e instanceof Error ? e.message.slice(0, 300) : String(e));
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo | null> {
    if (!this.initCache || Date.now() - this.initAt > MODELS_MAX_AGE_MS) {
      const settings = this.core.db.getSettings();
      const claudePath = locateClaude(settings.claudePath);
      try {
        if (!claudePath) throw new Error("Claude Code nicht gefunden");
        this.noteInitialization(await this.runtime.probe({ cwd: process.cwd(), env: sessionEnv(settings.stripApiKey), claudePath }));
      } catch {
        // A failed refresh keeps the last list; it is tried again on the next call.
      }
    }
    if (!this.initCache) return null;
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
