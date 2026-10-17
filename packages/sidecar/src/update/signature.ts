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

/** The signature of FORGE_x.zip is the asset FORGE_x.zip.sig (base64). */
export const SIG_SUFFIX = ".sig";

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
