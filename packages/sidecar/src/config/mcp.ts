import { ForgeError, type McpServer } from "@forge/protocol";
import { run } from "../util/proc.js";

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
        : /fail|error/i.test(statusText)
          ? "failed"
          : "unknown";
    servers.push({ name: m[1]!, target: m[2]!, status, statusText: statusText.replace(/^[^\p{L}]+/u, "") });
  }
  return servers;
}

export interface McpAddInput {
  name: string;
  scope: "user" | "project" | "local";
  transport: "stdio" | "http" | "sse";
  target: string;
  args: string[];
  env: Record<string, string>;
}

/** Builds the argument list for `claude mcp add`; never goes through a shell. */
export function mcpAddArgs(i: McpAddInput): string[] {
  const args = ["mcp", "add", "--scope", i.scope];
  if (i.transport !== "stdio") args.push("--transport", i.transport);
  for (const [k, v] of Object.entries(i.env)) args.push("--env", `${k}=${v}`);
  args.push(i.name);
  if (i.transport === "stdio") args.push("--", i.target, ...i.args);
  else args.push(i.target);
  return args;
}

export class McpService {
  constructor(
    private readonly claude: () => string | null,
    private readonly env: () => Record<string, string>,
  ) {}

  private async cli(args: string[], cwd: string, timeoutMs = 60_000) {
    const bin = this.claude();
    if (!bin) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code ist nicht installiert.");
    const r = await run(bin, args, { cwd, env: this.env(), timeoutMs });
    if (r.spawnError) throw new ForgeError("CLAUDE_RUNTIME", r.spawnError.message);
    return r;
  }

  async list(cwd: string): Promise<McpServer[]> {
    const r = await this.cli(["mcp", "list"], cwd, 90_000);
    if (r.code !== 0 && !r.stdout.trim()) throw new ForgeError("CLAUDE_RUNTIME", (r.stderr || "claude mcp list fehlgeschlagen").trim());
    return parseMcpList(r.stdout);
  }

  async add(cwd: string, input: McpAddInput) {
    const r = await this.cli(mcpAddArgs(input), cwd);
    const output = (r.stdout + r.stderr).trim();
    if (r.code !== 0) throw new ForgeError("CLAUDE_RUNTIME", output || "Hinzufügen fehlgeschlagen");
    return { ok: true, output };
  }

  async remove(cwd: string, name: string, scope: string) {
    const r = await this.cli(["mcp", "remove", "--scope", scope, name], cwd);
    const output = (r.stdout + r.stderr).trim();
    if (r.code !== 0) throw new ForgeError("CLAUDE_RUNTIME", output || "Entfernen fehlgeschlagen");
    return { ok: true, output };
  }
}
