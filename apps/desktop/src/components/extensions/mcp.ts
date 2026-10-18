import type { McpServer } from "@forge/protocol";
import type { SelectOption } from "@/components/ui/select";
import { t } from "@/i18n";

const m = t.extensions.mcp;

export type McpScope = "user" | "project" | "local";

export const MCP_STATUS: Record<McpServer["status"], string> = m.status;

export const MCP_STATUS_TONE = { connected: "success", failed: "danger", needs_auth: "warning", unknown: "neutral" } as const satisfies Record<McpServer["status"], string>;

// Status texts printed by `claude mcp list`; anything else is shown as the CLI wrote it.
const STATUS_TEXT: Array<[RegExp, string]> = [
  [/^connected$/i, m.statusText.connected],
  [/^failed to connect$/i, m.statusText.failedToConnect],
  [/^failed/i, m.statusText.failed],
  [/needs? auth/i, m.statusText.needsAuth],
  [/^(pending|connecting)/i, m.statusText.connecting],
  [/^disabled$/i, m.statusText.disabled],
];

export function mcpStatusText(raw: string): string {
  return STATUS_TEXT.find(([re]) => re.test(raw.trim()))?.[1] ?? raw;
}

const SCOPE_OPTIONS: SelectOption<McpScope>[] = [
  { value: "local", ...m.scopes.local },
  { value: "project", ...m.scopes.project },
  { value: "user", ...m.scopes.user },
];

/** Project and local scopes need an open project. */
export function mcpScopeOptions(projectId: string | undefined): SelectOption<McpScope>[] {
  return projectId ? SCOPE_OPTIONS : SCOPE_OPTIONS.filter((o) => o.value === "user");
}
