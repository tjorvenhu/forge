import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tr } from "../i18n/index.js";
import { which } from "../util/proc.js";

/** Turns a secret into the text stored in its file and back. */
export interface SecretCipher {
  protect(plain: string): Promise<string>;
  unprotect(blob: string): Promise<string>;
}

/**
 * Secrets of the phone feature (SIP password, OpenAI key), encrypted for the current user, so the
 * file is useless on another account or machine: with DPAPI on Windows, elsewhere with a key from the
 * system keychain (masterKeyCipher). Secrets never go to the UI or into logs.
 */
export class SecretStore {
  private cache = new Map<string, string | null>();
  private readonly cipher: SecretCipher;

  constructor(
    private readonly dir: string,
    cipher?: SecretCipher,
  ) {
    this.cipher = cipher ?? defaultCipher(dir);
  }

  private file(name: string) {
    return path.join(this.dir, `${name}.secret`);
  }

  has(name: string): boolean {
    return existsSync(this.file(name));
  }

  async get(name: string): Promise<string | null> {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const f = this.file(name);
    if (!existsSync(f)) return null;
    const value = await this.cipher.unprotect(readFileSync(f, "utf8").trim());
    this.cache.set(name, value);
    return value;
  }

  async set(name: string, value: string | null) {
    const f = this.file(name);
    this.cache.delete(name);
    if (!value) {
      rmSync(f, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(f, await this.cipher.protect(value), { mode: 0o600 });
    this.cache.set(name, value);
  }

  /** The encrypted files as they are, for backups; they stay readable only for this user. */
  encrypted(): Record<string, string> {
    if (!existsSync(this.dir)) return {};
    const out: Record<string, string> = {};
    for (const f of readdirSync(this.dir)) if (f.endsWith(".secret")) out[f.slice(0, -".secret".length)] = readFileSync(path.join(this.dir, f), "utf8").trim();
    return out;
  }

  /** Puts encrypted files from a backup back; secrets missing from it are removed, except `keep`. */
  restoreEncrypted(files: Record<string, string>, keep: string[] = []) {
    mkdirSync(this.dir, { recursive: true });
    for (const name of Object.keys(this.encrypted())) if (!(name in files) && !keep.includes(name)) rmSync(this.file(name), { force: true });
    for (const [name, blob] of Object.entries(files)) if (/^[\w-]{1,64}$/.test(name)) writeFileSync(this.file(name), blob, { mode: 0o600 });
    this.cache.clear();
  }
}

/** DPAPI on Windows; the keychain (macOS) or the Secret Service (Linux) holds the key elsewhere. */
export function defaultCipher(dir: string, platform: NodeJS.Platform = process.platform): SecretCipher {
  if (platform === "win32") return { protect: (v) => dpapi("protect", v), unprotect: (b) => dpapi("unprotect", b) };
  const hasSecrets = () => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".secret"));
  return masterKeyCipher(platform === "darwin" ? [keychainKey()] : [keyFile(dir, true), secretServiceKey(), keyFile(dir)], hasSecrets);
}

/** Runs DPAPI through Windows PowerShell; the secret travels via stdin, never on the command line. */
function dpapi(op: "protect" | "unprotect", input: string): Promise<string> {
  const script =
    op === "protect"
      ? "[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($t); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))"
      : "[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd().Trim(); $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($t),$null,'CurrentUser'); [Text.Encoding]::UTF8.GetString($b)";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve((out.charCodeAt(0) === 0xfeff ? out.slice(1) : out).replace(/\r?\n$/, ""));
      else reject(new Error(tr().phone.line.secretFailed(op === "protect", err.trim().slice(0, 200))));
    });
    child.stdin.end(input, "utf8");
  });
}

/**
 * Where the 32-byte key of masterKeyCipher lives. load gives null when there is none yet and throws
 * when the store cannot be asked; save gives false when it cannot keep one.
 */
export interface KeyBackend {
  load(): Promise<Buffer | null>;
  save(key: Buffer): Promise<boolean>;
}

/** Prefix of a blob encrypted by masterKeyCipher: AES-256-GCM, then base64 of iv, tag and ciphertext. */
const AES_PREFIX = "aes1:";
const KEY_SERVICE = "forge";
const KEY_ACCOUNT = "secrets-master-key";

/**
 * Encrypts with AES-256-GCM under one random key per user. The first backend that has a key wins;
 * without one a new key goes to the first backend that keeps it. While secrets exist (`hasSecrets`)
 * and a backend could not be asked (a locked keychain), no new key is made: it would orphan them.
 */
export function masterKeyCipher(backends: KeyBackend[], hasSecrets: () => boolean = () => false): SecretCipher {
  let key: Promise<Buffer> | null = null;
  const masterKey = () => {
    key ??= (async () => {
      let failure: unknown = null;
      for (const b of backends) {
        const k = await b.load().catch((e: unknown) => {
          failure ??= e;
          return null;
        });
        if (k?.length === 32) return k;
      }
      if (failure && hasSecrets()) throw failure;
      const fresh = randomBytes(32);
      for (const b of backends) if (await b.save(fresh).catch(() => false)) return fresh;
      throw new Error("no key store");
    })();
    key.catch(() => (key = null));
    return key;
  };
  return {
    async protect(plain) {
      const k = await masterKey().catch((e: unknown) => {
        throw new Error(tr().phone.line.secretFailed(true, e instanceof Error ? e.message : String(e)), { cause: e });
      });
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", k, iv);
      const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return AES_PREFIX + Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    },
    async unprotect(blob) {
      try {
        if (!blob.startsWith(AES_PREFIX)) throw new Error("unknown format");
        const raw = Buffer.from(blob.slice(AES_PREFIX.length), "base64");
        const d = createDecipheriv("aes-256-gcm", await masterKey(), raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
      } catch (e) {
        throw new Error(tr().phone.line.secretFailed(false, e instanceof Error ? e.message : String(e)), { cause: e });
      }
    },
  };
}

function exec(cmd: string, args: string[], input?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

const decodeKey = (text: string): Buffer | null => {
  const k = Buffer.from(text.trim(), "base64");
  return k.length === 32 ? k : null;
};

/** The login keychain of macOS through /usr/bin/security; the key goes in via stdin (security -i), never as an argument. */
export function keychainKey(): KeyBackend {
  const security = "/usr/bin/security";
  return {
    async load() {
      const r = await exec(security, ["find-generic-password", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w"]);
      // 44: no such item
      if (r.code === 44) return null;
      if (r.code !== 0) throw new Error(r.err.trim() || `security ${r.code}`);
      return decodeKey(r.out);
    },
    async save(key) {
      const r = await exec(security, ["-i"], `add-generic-password -U -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -l FORGE -w ${key.toString("base64")}\n`);
      return r.code === 0 && !/error/i.test(r.err);
    },
  };
}

/** The Secret Service (GNOME Keyring, KWallet) through secret-tool of libsecret, when it is installed. */
export function secretServiceKey(): KeyBackend {
  return {
    async load() {
      const tool = which("secret-tool");
      if (!tool) return null;
      const r = await exec(tool, ["lookup", "service", KEY_SERVICE, "account", KEY_ACCOUNT]);
      if (r.code === 0 && r.out.trim()) return decodeKey(r.out);
      // Nothing found ends with code 1 and no message; a missing keyring daemon says why.
      if (r.err.trim()) throw new Error(r.err.trim());
      return null;
    },
    async save(key) {
      const tool = which("secret-tool");
      if (!tool) return false;
      const r = await exec(tool, ["store", "--label=FORGE", "service", KEY_SERVICE, "account", KEY_ACCOUNT], key.toString("base64"));
      return r.code === 0;
    },
  };
}

/**
 * The key in a file next to the secrets, readable only by the user (0600). Weaker than a keychain:
 * anything running as this user, or a copy of the home folder, reads it. Only for Linux systems
 * without a Secret Service. `existingOnly`: load an existing file, never create one.
 */
export function keyFile(dir: string, existingOnly = false): KeyBackend {
  const file = path.join(dir, "master.key");
  return {
    async load() {
      return existsSync(file) ? decodeKey(readFileSync(file, "utf8")) : null;
    },
    async save(key) {
      if (existingOnly) return false;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, key.toString("base64"), { mode: 0o600 });
      chmodSync(file, 0o600);
      return true;
    },
  };
}
