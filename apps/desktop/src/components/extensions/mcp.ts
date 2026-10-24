import type { McpScope, McpServer, McpServerConfig } from "@forge/protocol";
import type { SelectOption } from "@/components/ui/select";
import { isHeaderName } from "./env";
import { t } from "@/i18n";

const m = t.extensions.mcp;

export type { McpScope };

export const MCP_STATUS: Record<McpServer["status"], string> = m.status;

export const MCP_STATUS_TONE = { connected: "success", failed: "danger", needs_auth: "warning", pending: "warning", unknown: "neutral" } as const satisfies Record<
  McpServer["status"],
  string
>;

// Status texts printed by `claude mcp list`; anything else is shown as the CLI wrote it.
const STATUS_TEXT: Array<[RegExp, string]> = [
  [/^connected$/i, m.statusText.connected],
  [/^failed to connect$/i, m.statusText.failedToConnect],
  [/^failed/i, m.statusText.failed],
  [/needs? auth/i, m.statusText.needsAuth],
  [/^pending approval/i, m.statusText.pending],
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

/** Project and local scopes need a project; without any there is only the global one. */
export function mcpScopeOptions(hasProject: string | boolean | undefined): SelectOption<McpScope>[] {
  return hasProject ? SCOPE_OPTIONS : SCOPE_OPTIONS.filter((o) => o.value === "user");
}

export const mcpScopeLabel = (scope: McpScope) => m.scopes[scope].label;

export type McpAuthKind = "none" | "bearer" | "apiKey" | "oauth";

/** The authentication fields of the server dialog (HTTP and SSE). */
export interface McpAuthForm {
  kind: McpAuthKind;
  token: string;
  keyHeader: string;
  keyValue: string;
  clientId: string;
  clientSecret: string;
  callbackPort: string;
  /** further headers as "Name: Wert" lines */
  headers: string;
}

export const EMPTY_AUTH: McpAuthForm = { kind: "none", token: "", keyHeader: "X-API-Key", keyValue: "", clientId: "", clientSecret: "", callbackPort: "", headers: "" };

const BEARER = /^bearer\s+/i;

/** Fills the fields from a configured server: an Authorization: Bearer header becomes the token field. */
export function authForm(cfg: McpServerConfig): McpAuthForm {
  const headers = { ...cfg.headers };
  const form = { ...EMPTY_AUTH };
  if (cfg.oauth) {
    form.kind = "oauth";
    form.clientId = cfg.oauth.clientId;
    form.callbackPort = cfg.oauth.callbackPort ? String(cfg.oauth.callbackPort) : "";
  } else {
    const auth = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
    if (auth && BEARER.test(headers[auth]!)) {
      form.kind = "bearer";
      form.token = headers[auth]!.replace(BEARER, "");
      delete headers[auth];
    }
  }
  form.headers = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return form;
}

const port = (v: string) => (/^\d+$/.test(v.trim()) && +v >= 1 && +v <= 65535 ? +v : null);

/** Whether the chosen kind has what it needs, and a message for an invalid port. */
export function authProblem(form: McpAuthForm): { incomplete: boolean; error: string | null } {
  const error = form.kind === "oauth" && form.callbackPort.trim() && port(form.callbackPort) === null ? t.extensions.addMcp.invalidPort : null;
  const incomplete =
    (form.kind === "bearer" && !form.token.trim()) ||
    (form.kind === "apiKey" && (!isHeaderName(form.keyHeader.trim()) || !form.keyValue.trim())) ||
    (form.kind === "oauth" && !form.clientId.trim());
  return { incomplete, error };
}

/** Headers and OAuth client for mcp.add; `extra` are the parsed further headers. */
export function authPayload(form: McpAuthForm, extra: Record<string, string>): { headers: Record<string, string>; oauth?: { clientId: string; clientSecret?: string; callbackPort?: number } } {
  const headers = { ...extra };
  if (form.kind === "bearer") headers.Authorization = `Bearer ${form.token.trim().replace(BEARER, "")}`;
  if (form.kind === "apiKey") headers[form.keyHeader.trim()] = form.keyValue.trim();
  if (form.kind !== "oauth") return { headers };
  const p = port(form.callbackPort);
  return { headers, oauth: { clientId: form.clientId.trim(), ...(form.clientSecret && { clientSecret: form.clientSecret }), ...(p && { callbackPort: p }) } };
}

/** Short note what a server sends to log in, from names only. */
export function authSummary(s: McpServer): string | null {
  const parts = [...(s.headerNames ?? []), ...(s.envNames ?? []), ...(s.oauthClientId ? [t.extensions.mcpTab.oauthClient] : [])];
  return parts.length ? parts.join(", ") : null;
}
