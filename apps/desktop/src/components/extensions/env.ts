import { t } from "@/i18n";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
