const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9]{32,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, "$1[REDACTED]"],
  // user:password@ in connection strings and URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]*:)([^\s@/"'`]+)(@)/gi, "$1[REDACTED]$3"],
  // password: x, "password": "x", api_key=x (the key may be quoted, as in JSON)
  [
    /((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)(?![$<{[])([^\s"'`,;]{6,})/gi,
    "$1[REDACTED]",
  ],
  // GITHUB_TOKEN=x, SECRET_KEY=x, NPM_AUTH_TOKEN: x; values that look like references ($X, <x>, {x}) stay
  [
    /(\b[A-Z0-9_]*(?:TOKEN|SECRET|_KEY|PASSWORD|PASSWD|_PAT|CREDENTIALS?)["']?\s*[:=]\s*["']?)(?![$<{[])([^\s"'`,;]{8,})/g,
    "$1[REDACTED]",
  ],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep-redacts all string leaves of a JSON-like value. */
export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out as T;
  }
  return value;
}
