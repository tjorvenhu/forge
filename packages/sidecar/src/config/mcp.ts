import { readFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type McpScope, type McpServer, type McpServerConfig, type McpTransport } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import { claudeJsonPath, pathKey } from "../util/paths.js";
import { run } from "../util/proc.js";
import { updateSettings } from "./claude-config.js";

/** Parses `claude mcp list` output lines like `name: npx foo - ✓ Connected`. */
export function parseMcpList(out: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^([A-Za-z0-9_.-]+):\s+(.+?)\s+-\s+(.+)$/.exec(line);
    if (!m) continue;
    const statusText = m[3]!.trim();
    const status: McpServer["status"] = /connected/i.test(statusText) && !/fail/i.test(statusText)
      ? "connected"
      : /auth/i.test(statusText)
        ? "needs_auth"
        : /pending approval/i.test(statusText)
          ? "pending"
          : /fail|error/i.test(statusText)
            ? "failed"
            : "unknown";
    servers.push({ name: m[1]!, target: m[2]!, status, statusText: statusText.replace(/^[^\p{L}]+/u, "") });
  }
  return servers;
}

type RawEntry = Record<string, unknown>;
export interface ConfiguredServer {
  scope: McpScope;
  entry: RawEntry;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const servers = (v: unknown) => obj(v) as Record<string, RawEntry>;
const record = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(v)).filter((e): e is [string, string] => typeof e[1] === "string"));

/** The server lists of one folder per scope, read from ~/.claude.json and the folder's .mcp.json. */
export function scopeLists(claudeJson: Record<string, unknown>, mcpJson: Record<string, unknown>, cwd: string): Record<McpScope, Record<string, RawEntry>> {
  const key = pathKey(cwd);
  const local = Object.entries(servers(claudeJson.projects)).find(([p]) => pathKey(p) === key)?.[1];
  return { user: servers(claudeJson.mcpServers), project: servers(mcpJson.mcpServers), local: servers(local?.mcpServers) };
}

/**
 * Where each server of a folder is configured, as Claude Code resolves it: local (the folder's entry
 * in ~/.claude.json) wins over project (.mcp.json) wins over user (~/.claude.json at the top).
 */
export function configuredServers(lists: Record<McpScope, Record<string, RawEntry>>): Map<string, ConfiguredServer> {
  const found = new Map<string, ConfiguredServer>();
  for (const scope of ["user", "project", "local"] as const) {
    for (const [name, entry] of Object.entries(lists[scope])) found.set(name, { scope, entry });
  }
  return found;
}

function transportOf(entry: RawEntry): McpTransport | null {
  if (entry.type === "http" || entry.type === "sse") return entry.type;
  if ((entry.type === undefined || entry.type === "stdio") && typeof entry.command === "string") return "stdio";
  return null;
}

/** The entry in the form of the edit dialog; null for kinds FORGE does not edit (e.g. ws, sdk). */
export function toServerConfig(name: string, { scope, entry }: ConfiguredServer): McpServerConfig | null {
  const transport = transportOf(entry);
  if (!transport) return null;
  const oauth = obj(entry.oauth);
  return {
    name,
    scope,
    transport,
    target: String(transport === "stdio" ? entry.command : (entry.url ?? "")),
    args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [],
    env: record(entry.env),
    headers: record(entry.headers),
    oauth: typeof oauth.clientId === "string" ? { clientId: oauth.clientId, callbackPort: typeof oauth.callbackPort === "number" ? oauth.callbackPort : null } : null,
  };
}

export interface McpAddInput {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  target: string;
  args: string[];
  env: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: { clientId: string; clientSecret?: string; callbackPort?: number };
  replaces?: { name: string; scope: McpScope };
}

/**
 * Builds the argument list for `claude mcp add`; never goes through a shell. `-e` and `-H` take any
 * number of values, so the name comes first and `--` ends the values before command or URL. The
 * client secret itself goes in MCP_CLIENT_SECRET, never on the command line.
 */
export function mcpAddArgs(i: McpAddInput): string[] {
  const args = ["mcp", "add", i.name, "--scope", i.scope];
  if (i.transport !== "stdio") args.push("--transport", i.transport);
  for (const [k, v] of Object.entries(i.env)) args.push("-e", `${k}=${v}`);
  if (i.transport !== "stdio") {
    for (const [k, v] of Object.entries(i.headers ?? {})) args.push("-H", `${k}: ${v}`);
    if (i.oauth) {
      args.push("--client-id", i.oauth.clientId);
      if (i.oauth.clientSecret) args.push("--client-secret");
      if (i.oauth.callbackPort) args.push("--callback-port", String(i.oauth.callbackPort));
    }
  }
  args.push("--", i.target, ...(i.transport === "stdio" ? i.args : []));
  return args;
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  try {
    const j = JSON.parse((await readFile(p, "utf8")).replace(/^﻿/, "")) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class McpService {
  constructor(
    private readonly claude: () => string | null,
    private readonly env: () => Record<string, string>,
    private readonly claudeJson = claudeJsonPath,
  ) {}

  private async cli(args: string[], cwd: string, timeoutMs = 60_000, extraEnv: Record<string, string> = {}) {
    const bin = this.claude();
    if (!bin) throw new ForgeError("CLAUDE_NOT_INSTALLED", tr().system.claudeConfig.claudeNotInstalled);
    const r = await run(bin, args, { cwd, env: { ...this.env(), ...extraEnv }, timeoutMs });
    if (r.spawnError) throw new ForgeError("CLAUDE_RUNTIME", r.spawnError.message);
    return r;
  }

  private async lists(cwd: string) {
    const [claudeJson, mcpJson] = await Promise.all([readJson(this.claudeJson()), readJson(path.join(cwd, ".mcp.json"))]);
    return scopeLists(claudeJson, mcpJson, cwd);
  }

  private async find(cwd: string, name: string): Promise<ConfiguredServer> {
    const found = configuredServers(await this.lists(cwd)).get(name);
    if (!found) throw new ForgeError("NOT_FOUND", tr().system.claudeConfig.mcpNotConfigured(name));
    return found;
  }

  async list(cwd: string): Promise<McpServer[]> {
    const [r, lists] = await Promise.all([this.cli(["mcp", "list"], cwd, 90_000), this.lists(cwd)]);
    const configured = configuredServers(lists);
    if (r.code !== 0 && !r.stdout.trim()) throw new ForgeError("CLAUDE_RUNTIME", (r.stderr || tr().system.claudeConfig.mcpListFailed).trim());
    return parseMcpList(r.stdout).map((s) => {
      const c = configured.get(s.name);
      const cfg = c && toServerConfig(s.name, c);
      if (!c) return s;
      return {
        ...s,
        scope: c.scope,
        ...(cfg && { transport: cfg.transport, headerNames: Object.keys(cfg.headers), envNames: Object.keys(cfg.env), oauthClientId: !!cfg.oauth }),
      };
    });
  }

  async get(cwd: string, name: string): Promise<McpServerConfig> {
    const cfg = toServerConfig(name, await this.find(cwd, name));
    if (!cfg) throw new ForgeError("VALIDATION", tr().system.claudeConfig.mcpNotConfigured(name));
    return cfg;
  }

  async add(cwd: string, input: McpAddInput) {
    const old = input.replaces ? ((await this.lists(cwd))[input.replaces.scope][input.replaces.name] ?? null) : null;
    if (input.replaces && old) await this.remove(cwd, input.replaces.name, input.replaces.scope);
    const secret: Record<string, string> = input.oauth?.clientSecret ? { MCP_CLIENT_SECRET: input.oauth.clientSecret } : {};
    const r = await this.cli(mcpAddArgs(input), cwd, 60_000, secret);
    const output = (r.stdout + r.stderr).trim();
    if (r.code !== 0) {
      const why = output || tr().system.claudeConfig.addFailed;
      if (!input.replaces || !old) throw new ForgeError("CLAUDE_RUNTIME", why);
      const back = await this.cli(["mcp", "add-json", input.replaces.name, JSON.stringify(old), "--scope", input.replaces.scope], cwd);
      throw new ForgeError("CLAUDE_RUNTIME", back.code === 0 ? tr().system.claudeConfig.mcpEditRestored(why) : tr().system.claudeConfig.mcpEditLost(why));
    }
    // Whoever adds a shared server here wants it, so it does not wait for approval in `claude`.
    if (input.scope === "project") await this.approve(cwd, input.name);
    return { ok: true, output };
  }

  async remove(cwd: string, name: string, scope?: McpScope) {
    const where = scope ?? (await this.find(cwd, name)).scope;
    const r = await this.cli(["mcp", "remove", "--scope", where, name], cwd);
    const output = (r.stdout + r.stderr).trim();
    if (r.code !== 0) throw new ForgeError("CLAUDE_RUNTIME", output || tr().system.claudeConfig.removeFailed);
    return { ok: true, output };
  }

  /** Approves a .mcp.json server for this computer, the way `claude` does when asked. */
  async approve(cwd: string, name: string) {
    await updateSettings("local", cwd, (data) => {
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const enabled = list(data.enabledMcpjsonServers);
      const disabled = list(data.disabledMcpjsonServers).filter((n) => n !== name);
      return {
        ...data,
        enabledMcpjsonServers: enabled.includes(name) ? enabled : [...enabled, name],
        ...(Array.isArray(data.disabledMcpjsonServers) && { disabledMcpjsonServers: disabled }),
      };
    });
    return { ok: true };
  }
}
