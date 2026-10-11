import { createHash, randomBytes } from "node:crypto";

export type DigestAlgorithm = "MD5" | "MD5-sess" | "SHA-256" | "SHA-256-sess";

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque: string | null;
  algorithm: DigestAlgorithm;
  qop: "auth" | "auth-int" | null;
  /** the nonce expired; the credentials were fine (RFC 2617 3.2.1) */
  stale: boolean;
}

const ALGORITHMS: Record<string, DigestAlgorithm> = { MD5: "MD5", "MD5-SESS": "MD5-sess", "SHA-256": "SHA-256", "SHA-256-SESS": "SHA-256-sess" };
/** best first: SHA-256 (RFC 8760) before MD5 */
const PREFERENCE: DigestAlgorithm[] = ["SHA-256", "SHA-256-sess", "MD5", "MD5-sess"];

/**
 * Parses `Digest realm="x", nonce="y", qop="auth", algorithm=MD5`. Returns null for challenges FORGE
 * cannot answer (other schemes, unknown algorithms, qop without auth or auth-int), so the caller can
 * pick another one instead of sending a wrong answer.
 */
export function parseChallenge(header: string): DigestChallenge | null {
  const m = /^\s*Digest\s+(.*)$/i.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  for (let p = re.exec(m[1]!); p; p = re.exec(m[1]!)) params[p[1]!.toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : (p[3] ?? "");
  if (!params.nonce) return null;
  const algorithm = ALGORITHMS[(params.algorithm ?? "MD5").toUpperCase()];
  if (!algorithm) return null;
  let qop: DigestChallenge["qop"] = null;
  if (params.qop !== undefined) {
    const qops = params.qop.split(",").map((q) => q.trim().toLowerCase());
    if (qops.includes("auth")) qop = "auth";
    else if (qops.includes("auth-int")) qop = "auth-int";
    else return null;
  }
  return {
    realm: params.realm ?? "",
    nonce: params.nonce,
    opaque: params.opaque ?? null,
    algorithm,
    qop,
    stale: (params.stale ?? "").toLowerCase() === "true",
  };
}

/** The strongest challenge FORGE can answer from all WWW-/Proxy-Authenticate headers of a response. */
export function pickChallenge(headers: string[]): DigestChallenge | null {
  const parsed = headers.map(parseChallenge).filter((c): c is DigestChallenge => c !== null);
  parsed.sort((a, b) => PREFERENCE.indexOf(a.algorithm) - PREFERENCE.indexOf(b.algorithm));
  return parsed[0] ?? null;
}

function hash(algorithm: DigestAlgorithm, s: string): string {
  return createHash(algorithm.startsWith("SHA-256") ? "sha256" : "md5").update(s).digest("hex");
}

/** Quoted-string value (RFC 3261 25.1): backslash and double quote must be escaped. */
function quoted(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Authorization header value for a challenge (RFC 2617 / RFC 8760). */
export function digestAuthorization(
  ch: DigestChallenge,
  opts: { username: string; password: string; method: string; uri: string; body?: string; nc?: number; cnonce?: string },
): string {
  const alg = ch.algorithm;
  const nc = (opts.nc ?? 1).toString(16).padStart(8, "0");
  const cnonce = opts.cnonce ?? randomBytes(8).toString("hex");
  const sess = alg.endsWith("-sess");
  let ha1 = hash(alg, `${opts.username}:${ch.realm}:${opts.password}`);
  if (sess) ha1 = hash(alg, `${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = ch.qop === "auth-int" ? hash(alg, `${opts.method}:${opts.uri}:${hash(alg, opts.body ?? "")}`) : hash(alg, `${opts.method}:${opts.uri}`);
  const response = ch.qop ? hash(alg, `${ha1}:${ch.nonce}:${nc}:${cnonce}:${ch.qop}:${ha2}`) : hash(alg, `${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username=${quoted(opts.username)}`,
    `realm=${quoted(ch.realm)}`,
    `nonce=${quoted(ch.nonce)}`,
    `uri=${quoted(opts.uri)}`,
    `response="${response}"`,
    `algorithm=${alg}`,
  ];
  if (ch.qop) parts.push(`qop=${ch.qop}`, `nc=${nc}`, `cnonce=${quoted(cnonce)}`);
  else if (sess) parts.push(`cnonce=${quoted(cnonce)}`);
  if (ch.opaque !== null) parts.push(`opaque=${quoted(ch.opaque)}`);
  return `Digest ${parts.join(", ")}`;
}
