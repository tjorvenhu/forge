import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

/**
 * Crypto of a crew. Room traffic is sealed with the crew key (AES-256-GCM, 32 random bytes). An invite
 * carries its own key, only good for asking to join; the crew key reaches a newcomer sealed for the
 * X25519 key the newcomer sent along, so whoever only read the invite cannot read the crew.
 */

export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

export const newKey = (): string => randomBytes(32).toString("base64url");
/** Random id in base64url (room, member, invite, task ...). */
export const randomId = (bytes = 16): string => randomBytes(bytes).toString("base64url");

/** `aad` binds the box to its room and key id, so a box cannot be replayed into another context. */
export function seal(key: string, plaintext: string, aad = ""): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("base64url"), tag: c.getAuthTag().toString("base64url"), data: data.toString("base64url") };
}

/** null when the key is wrong or the box was changed. */
export function open(key: string, box: Sealed, aad = ""): string | null {
  try {
    const d = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64url"), Buffer.from(box.iv, "base64url"));
    if (aad) d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(Buffer.from(box.tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(box.data, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** X25519 key pair as base64url raw keys (public: 32 bytes, private: the JWK's d). */
export function newKeyPair(): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }).x!;
  const priv = privateKey.export({ format: "jwk" }).d!;
  return { pub, priv };
}

/** The key two members share: X25519 of one's private and the other's public key, through HKDF. */
export function sharedKey(own: { pub: string; priv: string }, peerPub: string, info: string): string {
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: own.priv, x: own.pub }, format: "jwk" });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peerPub }, format: "jwk" });
  const secret = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from(`forge-crew:${info}`, "utf8"), 32)).toString("base64url");
}

/**
 * Short code of a public key, shown on both sides of a join request (like 4821-0937): the members can
 * check it with the newcomer before letting them in.
 */
export function fingerprint(pub: string): string {
  const h = createHash("sha256").update(Buffer.from(pub, "base64url")).digest();
  const n = h.readUInt32BE(0) % 100_000_000;
  const s = n.toString().padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
