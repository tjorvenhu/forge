import { createHash, randomBytes } from "node:crypto";

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque: string | null;
  algorithm: string;
  qop: string | null;
}

/** Parses `Digest realm="x", nonce="y", qop="auth", algorithm=MD5`. */
export function parseChallenge(header: string): DigestChallenge | null {
  const m = /^\s*Digest\s+(.*)$/i.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  for (let p = re.exec(m[1]!); p; p = re.exec(m[1]!)) params[p[1]!.toLowerCase()] = p[2] ?? p[3] ?? "";
  if (!params.nonce) return null;
  const qops = (params.qop ?? "").split(",").map((q) => q.trim().toLowerCase());
  return {
    realm: params.realm ?? "",
    nonce: params.nonce,
    opaque: params.opaque ?? null,
    algorithm: (params.algorithm ?? "MD5").toUpperCase(),
    qop: qops.includes("auth") ? "auth" : null,
  };
}

function hash(algorithm: string, s: string): string {
  return createHash(algorithm.startsWith("SHA-256") ? "sha256" : "md5").update(s).digest("hex");
}

/** Authorization header value for a challenge (RFC 2617 / RFC 8760, qop=auth or none). */
export function digestAuthorization(
  ch: DigestChallenge,
  opts: { username: string; password: string; method: string; uri: string; nc?: number; cnonce?: string },
): string {
  const alg = ch.algorithm === "SHA-256" ? "SHA-256" : "MD5";
  const ha1 = hash(alg, `${opts.username}:${ch.realm}:${opts.password}`);
  const ha2 = hash(alg, `${opts.method}:${opts.uri}`);
  const nc = (opts.nc ?? 1).toString(16).padStart(8, "0");
  const cnonce = opts.cnonce ?? randomBytes(8).toString("hex");
  const response = ch.qop ? hash(alg, `${ha1}:${ch.nonce}:${nc}:${cnonce}:${ch.qop}:${ha2}`) : hash(alg, `${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${opts.username}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${opts.uri}"`,
    `response="${response}"`,
    `algorithm=${alg}`,
  ];
  if (ch.qop) parts.push(`qop=${ch.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (ch.opaque !== null) parts.push(`opaque="${ch.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}
