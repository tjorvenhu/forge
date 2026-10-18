import os from "node:os";
import { ForgeError, type MarketplacePlugin } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import { run } from "../util/proc.js";

interface ListJson {
  installed?: Array<{ id?: string; scope?: string; enabled?: boolean }>;
  available?: Array<{ pluginId?: string; name?: string; description?: string; marketplaceName?: string; installCount?: number }>;
}

/** Merges `claude plugin list --available --json` into one list, installed first, then by installs. */
export function parsePluginList(json: string): MarketplacePlugin[] {
  let data: ListJson;
  try {
    data = JSON.parse(json) as ListJson;
  } catch {
    throw new ForgeError("CLAUDE_RUNTIME", tr().system.claudeConfig.pluginsUnreadable);
  }
  const installed = new Map<string, boolean>();
  for (const p of data.installed ?? []) {
    if (!p.id || (p.scope && p.scope !== "user")) continue;
    installed.set(p.id, p.enabled !== false);
  }
  const byId = new Map<string, MarketplacePlugin>();
  for (const p of data.available ?? []) {
    if (!p.pluginId || byId.has(p.pluginId)) continue;
    const [name, marketplace = ""] = p.pluginId.split("@");
    byId.set(p.pluginId, {
      id: p.pluginId,
      name: p.name ?? name ?? p.pluginId,
      description: (p.description ?? "").trim(),
      marketplace: p.marketplaceName ?? marketplace,
      installCount: typeof p.installCount === "number" ? p.installCount : null,
      installed: installed.has(p.pluginId),
      enabled: installed.has(p.pluginId) ? installed.get(p.pluginId)! : null,
    });
  }
  for (const [id, enabled] of installed) {
    if (byId.has(id)) continue;
    const [name = id, marketplace = ""] = id.split("@");
    byId.set(id, { id, name, description: "", marketplace, installCount: null, installed: true, enabled });
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.installed) - Number(a.installed) || (b.installCount ?? -1) - (a.installCount ?? -1) || a.name.localeCompare(b.name),
  );
}

/** Marketplace plugins through the Claude Code CLI, always in user scope. */
export class PluginService {
  private cache: { at: number; list: MarketplacePlugin[] } | null = null;

  constructor(
    private readonly claude: () => string | null,
    private readonly env: () => Record<string, string>,
  ) {}

  private async cli(args: string[], timeoutMs: number) {
    const bin = this.claude();
    if (!bin) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code ist nicht installiert.");
    const r = await run(bin, args, { cwd: os.homedir(), env: this.env(), timeoutMs });
    if (r.spawnError) throw new ForgeError("CLAUDE_RUNTIME", r.spawnError.message);
    return r;
  }

  async catalog(refresh = false): Promise<MarketplacePlugin[]> {
    // The CLI needs a few seconds for the list; it only changes when the marketplaces update.
    if (!refresh && this.cache && Date.now() - this.cache.at < 10 * 60_000) return this.cache.list;
    if (refresh) await this.cli(["plugin", "marketplace", "update"], 120_000);
    const r = await this.cli(["plugin", "list", "--available", "--json"], 90_000);
    if (r.code !== 0) throw new ForgeError("CLAUDE_RUNTIME", (r.stderr || r.stdout || tr().system.claudeConfig.pluginListFailed).trim());
    const list = parsePluginList(r.stdout);
    this.cache = { at: Date.now(), list };
    return list;
  }

  async install(id: string): Promise<MarketplacePlugin[]> {
    const r = await this.cli(["plugin", "install", "--scope", "user", id], 300_000);
    if (r.code !== 0) throw new ForgeError("CLAUDE_RUNTIME", (r.stderr || r.stdout || tr().system.claudeConfig.installFailed).trim());
    this.cache = null;
    return this.catalog();
  }

  async uninstall(id: string): Promise<MarketplacePlugin[]> {
    const r = await this.cli(["plugin", "uninstall", "--scope", "user", id], 120_000);
    if (r.code !== 0) throw new ForgeError("CLAUDE_RUNTIME", (r.stderr || r.stdout || "Entfernen fehlgeschlagen").trim());
    this.cache = null;
    return this.catalog();
  }

  async setEnabled(id: string, enabled: boolean): Promise<MarketplacePlugin[]> {
    const r = await this.cli(["plugin", enabled ? "enable" : "disable", "--scope", "user", id], 60_000);
    if (r.code !== 0) throw new ForgeError("CLAUDE_RUNTIME", (r.stderr || r.stdout || (enabled ? tr().system.claudeConfig.enableFailed : tr().system.claudeConfig.disableFailed)).trim());
    this.cache = null;
    return this.catalog();
  }
}
