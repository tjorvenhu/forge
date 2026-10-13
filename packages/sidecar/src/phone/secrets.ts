import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Secrets of the phone feature (SIP password, OpenAI key), encrypted with DPAPI for the current
 * Windows user, so the file is useless on another account or machine. Secrets never go to the UI
 * or into logs.
 */
export class SecretStore {
  private cache = new Map<string, string | null>();

  constructor(private readonly dir: string) {}

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
    const value = await dpapi("unprotect", readFileSync(f, "utf8").trim());
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
    writeFileSync(f, await dpapi("protect", value));
    this.cache.set(name, value);
  }

  /** The encrypted files as they are, for backups; they stay readable only for this Windows user. */
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
    for (const [name, blob] of Object.entries(files)) if (/^[\w-]{1,64}$/.test(name)) writeFileSync(this.file(name), blob);
    this.cache.clear();
  }
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
      else reject(new Error(`Geheimnis konnte nicht ${op === "protect" ? "verschlüsselt" : "entschlüsselt"} werden: ${err.trim().slice(0, 200)}`));
    });
    child.stdin.end(input, "utf8");
  });
}
