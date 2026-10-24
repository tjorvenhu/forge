import { t } from "@/i18n";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** Parses "NAME=wert" lines for an MCP server. Returns a message for the first invalid line. */
export function parseEnvLines(text: string): { env: Record<string, string>; error: null } | { env: null; error: string } {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) return { env: null, error: t.extensions.env.noEquals(line) };
    const name = line.slice(0, eq).trim();
    if (!ENV_NAME.test(name)) return { env: null, error: t.extensions.env.invalidName(name || line) };
    env[name] = line.slice(eq + 1);
  }
  return { env, error: null };
}

/** Parses "Name: Wert" lines (HTTP headers); the value may contain colons itself. */
export function parseHeaderLines(text: string): { headers: Record<string, string>; error: null } | { headers: null; error: string } {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) return { headers: null, error: t.extensions.env.noColon(line) };
    const name = line.slice(0, colon).trim();
    if (!HEADER_NAME.test(name)) return { headers: null, error: t.extensions.env.invalidHeader(name || line) };
    headers[name] = line.slice(colon + 1).trim();
  }
  return { headers, error: null };
}

export const isHeaderName = (name: string) => HEADER_NAME.test(name);
