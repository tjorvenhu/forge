import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { z } from "zod";
import { ForgeError } from "@forge/protocol";
import { tr } from "../i18n/index.js";

/** Parameters of the key derivation; stored next to the data, so every computer derives the same key. */
export const KdfParams = z.object({ salt: z.string().min(16), N: z.number().int().min(1024), r: z.number().int().min(1), p: z.number().int().min(1) });
export type KdfParams = z.infer<typeof KdfParams>;

export const SealedBox = z.object({ iv: z.string(), tag: z.string(), data: z.string() });
export type SealedBox = z.infer<typeof SealedBox>;

/** The key a computer keeps after the sync password was entered once (DPAPI-encrypted in the secret store). */
export const SyncKey = z.object({ kdf: KdfParams, key: z.string() });
export type SyncKey = z.infer<typeof SyncKey>;

export const MIN_PASSPHRASE = 12;
/** 64 MB of memory per derivation: slow to guess, still well under a second. */
const DEFAULT_N = 2 ** 16;

export function newKdf(N = DEFAULT_N): KdfParams {
  return { salt: randomBytes(16).toString("base64"), N, r: 8, p: 1 };
}

export async function deriveKey(passphrase: string, kdf: KdfParams): Promise<SyncKey> {
  if (passphrase.length < MIN_PASSPHRASE) throw new ForgeError("VALIDATION", tr().system.sync.passphraseTooShort(MIN_PASSPHRASE));
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(passphrase.normalize("NFC"), Buffer.from(kdf.salt, "base64"), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r }, (e, k) => (e ? reject(e) : resolve(k))),
  );
  return { kdf, key: key.toString("base64") };
}

/** AES-256-GCM: a wrong key or changed data fails on opening instead of giving garbage. */
export function seal(k: SyncKey, plaintext: string): SealedBox {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(k.key, "base64"), iv);
  const data = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function open(k: SyncKey, box: SealedBox): string {
  try {
    const d = createDecipheriv("aes-256-gcm", Buffer.from(k.key, "base64"), Buffer.from(box.iv, "base64"));
    d.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new ForgeError("VALIDATION", tr().system.sync.wrongPassphrase);
  }
}
