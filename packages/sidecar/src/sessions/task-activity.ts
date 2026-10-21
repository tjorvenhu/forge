const MAX_SUBJECT = 80;

const one = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const line = v.trim().split(/\r?\n/, 1)[0]!.trim();
  if (!line) return null;
  return line.length > MAX_SUBJECT ? `${line.slice(0, MAX_SUBJECT - 1)}…` : line;
};

const base = (v: unknown): string | null => {
  const p = one(v);
  // Both separators: the CLI may report Windows paths whatever platform reads them.
  return p ? p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p : null;
};

const host = (v: unknown): string | null => {
  const u = one(v);
  if (!u) return null;
  try {
    return new URL(u).host || u;
  } catch {
    return u;
  }
};

/**
 * Progress line of a subagent from its latest tool call ("Read runAgent.ts", "Bash pnpm test").
 * Replaces Claude Code's agentProgressSummaries: in an SDK session those fork the whole subagent
 * conversation every 30 s, which costs about one extra model step each time.
 */
export function toolActivity(name: string, input: Record<string, unknown>): string {
  const tool = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") || name : name;
  const subject =
    base(input.file_path) ??
    base(input.notebook_path) ??
    one(input.command) ??
    one(input.pattern) ??
    one(input.query) ??
    host(input.url) ??
    one(input.description) ??
    one(input.prompt) ??
    base(input.path);
  return subject ? `${tool} ${subject}` : tool;
}
