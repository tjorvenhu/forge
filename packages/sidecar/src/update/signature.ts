import { createPublicKey, verify } from "node:crypto";

/**
 * Public half of the key release.yml signs every release asset with (secret FORGE_UPDATE_SIGNING_KEY,
 * scripts/sign-update.mjs). An asset without a valid signature is never installed, so a changed file
 * on GitHub or on the way is caught even when GitHub reports no checksum.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEANolNUx40wUqNPeUVaSGEP8kerxC73987vPWhk9Y6Buc=
-----END PUBLIC KEY-----
`;

/** Releases up to 0.1.101 sign each asset in its own file: FORGE_x.zip.sig (base64). */
export const SIG_SUFFIX = ".sig";

/**
 * Since then one file per release, FORGE_<v>.sig, holds the signatures of all its assets as JSON
 * ({ "<asset name>": "<base64>" }). The name has no underscore after the version, unlike a per-asset .sig.
 */
export const SIG_MANIFEST = /^FORGE_[^_]+\.sig$/i;

/** The signature of `name` from the content of a signature file; "" when it holds none for it. */
export function signatureFrom(sigFileName: string, content: string, name: string): string {
  if (!SIG_MANIFEST.test(sigFileName)) return content;
  try {
    const entry = (JSON.parse(content) as Record<string, unknown>)[name];
    return typeof entry === "string" ? entry : "";
  } catch {
    return "";
  }
}

/**
 * What gets signed: the asset name and the SHA-256 of its content. The name binds the signature to
 * version and runtime, so a validly signed file cannot pose as another one.
 */
export function signedMessage(name: string, sha256Hex: string): Buffer {
  return Buffer.from(`FORGE-UPDATE-1\n${name}\n${sha256Hex.toLowerCase()}`, "utf8");
}

export function verifySignature(name: string, sha256Hex: string, signatureBase64: string, publicKey: string = UPDATE_PUBLIC_KEY): boolean {
  try {
    return verify(null, signedMessage(name, sha256Hex), createPublicKey(publicKey), Buffer.from(signatureBase64.trim(), "base64"));
  } catch {
    return false;
  }
}
