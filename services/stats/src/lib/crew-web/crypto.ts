/**
 * Crypto of a crew in the browser, with WebCrypto: the same boxes and keys as FORGE's sidecar
 * (packages/sidecar/src/crew/crypto.ts). AES-256-GCM with room and key id as AAD; X25519 plus HKDF
 * for the key two members share. Everything is base64url, as there.
 */

export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

export interface KeyPair {
  pub: string;
  priv: string;
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto is not available (needs https)");
  return s;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64 and base64url, with or without padding. */
export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(bytes = 16): string {
  return toB64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

export const newKey = (): string => randomId(32);

async function aesKey(key: string): Promise<CryptoKey> {
  return subtle().importKey("raw", fromB64(key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(key: string, plaintext: string, aad = ""): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  // Plain objects, no DOM type names: FORGE's sidecar tests compile this file without the DOM lib.
  const params = { name: "AES-GCM", iv, tagLength: 128, ...(aad ? { additionalData: enc.encode(aad) } : {}) };
  const out = new Uint8Array(await subtle().encrypt(params, await aesKey(key), enc.encode(plaintext)));
  // WebCrypto appends the tag; the sidecar keeps it apart.
  return { iv: toB64url(iv), tag: toB64url(out.subarray(out.length - 16)), data: toB64url(out.subarray(0, out.length - 16)) };
}

/** null when the key is wrong or the box was changed. */
export async function open(key: string, box: Sealed, aad = ""): Promise<string | null> {
  try {
    const data = fromB64(box.data);
    const tag = fromB64(box.tag);
    const joined = new Uint8Array(data.length + tag.length);
    joined.set(data);
    joined.set(tag, data.length);
    const params = { name: "AES-GCM", iv: fromB64(box.iv), tagLength: 128, ...(aad ? { additionalData: enc.encode(aad) } : {}) };
    return dec.decode(await subtle().decrypt(params, await aesKey(key), joined));
  } catch {
    return null;
  }
}

/** X25519 key pair as base64url raw keys (public: 32 bytes, private: the JWK's d), like the sidecar's. */
export async function newKeyPair(): Promise<KeyPair> {
  const pair = (await subtle().generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as { privateKey: CryptoKey };
  const jwk = await subtle().exportKey("jwk", pair.privateKey);
  if (!jwk.d || !jwk.x) throw new Error("X25519 key without d/x");
  return { pub: jwk.x, priv: jwk.d };
}

/** X25519 of our private and the peer's public key, through HKDF (sha256, no salt, info "forge-crew:<info>"). */
export async function sharedKey(own: KeyPair, peerPub: string, info: string): Promise<string> {
  const s = subtle();
  const priv = await s.importKey("jwk", { kty: "OKP", crv: "X25519", d: own.priv, x: own.pub }, { name: "X25519" }, false, ["deriveBits"]);
  const pub = await s.importKey("raw", fromB64(peerPub), { name: "X25519" }, false, []);
  const secret = await s.deriveBits({ name: "X25519", public: pub }, priv, 256);
  const ikm = await s.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(`forge-crew:${info}`) }, ikm, 256);
  return toB64url(new Uint8Array(bits));
}

/** Short code of a public key (like 4821-0937); the members see the same one with the join request. */
export async function fingerprint(pub: string): Promise<string> {
  const h = new DataView(await subtle().digest("SHA-256", fromB64(pub)));
  const s = (h.getUint32(0) % 100_000_000).toString().padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Whether this browser has what a crew needs (X25519 came late to Safari and Firefox). */
export async function supported(): Promise<boolean> {
  try {
    await newKeyPair();
    return typeof DecompressionStream === "function";
  } catch {
    return false;
  }
}

/** The text of base64 gzip (a session copy). */
export async function gunzipBase64(b64: string): Promise<string> {
  const stream = new Blob([fromB64(b64)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
