/** How a remote URL reaches its server; "other": a local path or a transport FORGE does not convert. */
export type RemoteKind = "https" | "ssh" | "other";

interface ParsedRemote {
  kind: "https" | "ssh";
  host: string;
  /** owner/repo.git, without a leading slash */
  path: string;
}

const HTTP = /^https?:\/\/(?:[^@/]+@)?([^/:@]+)(?::\d+)?\/(.+)$/i;
const SSH_URL = /^ssh:\/\/(?:[^@/]+@)?([^/:@]+)(?::\d+)?\/(.+)$/i;
/** git@github.com:owner/repo.git; a one-letter host would be a Windows drive (C:\repo) */
const SCP = /^(?:[^@/\\]+@)?([^/:@\\]{2,}):(?!\/\/)(.+)$/;

function parseRemote(url: string): ParsedRemote | null {
  const u = url.trim();
  const http = HTTP.exec(u);
  if (http) return { kind: "https", host: http[1]!, path: http[2]!.replace(/\/+$/, "") };
  const ssh = SSH_URL.exec(u) ?? SCP.exec(u);
  if (ssh) return { kind: "ssh", host: ssh[1]!, path: ssh[2]!.replace(/^\/+|\/+$/g, "") };
  return null;
}

export function remoteKind(url: string): RemoteKind {
  return parseRemote(url)?.kind ?? "other";
}

/**
 * The same repository over the other transport: git@host:owner/repo.git or https://host/owner/repo.git.
 * null when the URL is neither https nor ssh. Ports and credentials are dropped, they belong to one transport.
 */
export function convertRemoteUrl(url: string, to: "https" | "ssh"): string | null {
  const p = parseRemote(url);
  if (!p || !p.path) return null;
  return to === "ssh" ? `git@${p.host}:${p.path}` : `https://${p.host}/${p.path}`;
}

/** The URL with a token or password in it replaced by ***, for showing and reading aloud. */
export function redactRemoteUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/i, "$1***@").replace(/^(\w+:\/\/[^/@:]+):[^/@]*@/, "$1:***@");
}

/**
 * Whether git may be pointed at this URL. A leading "-" would be read as an option, ext:: and fd::
 * run commands instead of reaching a server.
 */
export function isValidRemoteUrl(url: string): boolean {
  const u = url.trim();
  return u.length > 0 && u.length <= 2048 && !/\s/.test(u) && ![...u].some((c) => c < " ") &&!u.startsWith("-") && !/^(ext|fd)::/i.test(u);
}

/**
 * The repository a remote URL points to, the same over https and ssh: host/owner/repo in lower case,
 * without .git. Local paths and other transports: the trimmed URL itself. Crew members find their
 * copy of the project with it.
 */
export function remoteIdentity(url: string): string {
  const p = parseRemote(url);
  if (!p || !p.path) return url.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  return `${p.host}/${p.path.replace(/\.git$/i, "")}`.toLowerCase();
}
