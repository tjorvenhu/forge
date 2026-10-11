import type { McpServer } from "@forge/protocol";
import type { SelectOption } from "@/components/ui/select";

export type McpScope = "user" | "project" | "local";

export const MCP_STATUS: Record<McpServer["status"], string> = { connected: "verbunden", failed: "Verbindung fehlgeschlagen", needs_auth: "Anmeldung nötig", unknown: "unbekannt" };

export const MCP_STATUS_TONE = { connected: "success", failed: "danger", needs_auth: "warning", unknown: "neutral" } as const satisfies Record<McpServer["status"], string>;

// Status texts printed by `claude mcp list`; anything else is shown as the CLI wrote it.
const STATUS_TEXT: Array<[RegExp, string]> = [
  [/^connected$/i, "Verbunden"],
  [/^failed to connect$/i, "Verbindung fehlgeschlagen"],
  [/^failed/i, "Fehlgeschlagen"],
  [/needs? auth/i, "Anmeldung nötig"],
  [/^(pending|connecting)/i, "Verbindung wird aufgebaut"],
  [/^disabled$/i, "Deaktiviert"],
];

export function mcpStatusText(raw: string): string {
  return STATUS_TEXT.find(([re]) => re.test(raw.trim()))?.[1] ?? raw;
}

const SCOPE_OPTIONS: SelectOption<McpScope>[] = [
  { value: "local", label: "Lokal", description: "Nur dieses Projekt, nur für dich" },
  { value: "project", label: "Projekt", description: "In .mcp.json, wird mit dem Projekt geteilt" },
  { value: "user", label: "Global", description: "Alle Projekte" },
];

/** Project and local scopes need an open project. */
export function mcpScopeOptions(projectId: string | undefined): SelectOption<McpScope>[] {
  return projectId ? SCOPE_OPTIONS : SCOPE_OPTIONS.filter((o) => o.value === "user");
}
