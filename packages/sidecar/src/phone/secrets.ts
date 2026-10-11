import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Secrets of the phone feature (SIP password, OpenAI key). On Windows they are encrypted with DPAPI
 * for the current user, so the file is useless on another account or machine. Elsewhere the file is
 * readable by the owner only. Secrets never go to the UI or into logs.
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
    const stored = readFileSync(f, "utf8").trim();
    const value = process.platform === "win32" ? await dpapi("unprotect", stored) : Buffer.from(stored, "base64").toString("utf8");
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
    const stored = process.platform === "win32" ? await dpapi("protect", value) : Buffer.from(value, "utf8").toString("base64");
    writeFileSync(f, stored, { mode: 0o600 });
    this.cache.set(name, value);
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
      if (code === 0) resolve(out.replace(/^\uFEFF/, "").replace(/\r?\n$/, ""));
      else reject(new Error(`Geheimnis konnte nicht ${op === "protect" ? "verschlüsselt" : "entschlüsselt"} werden: ${err.trim().slice(0, 200)}`));
    });
    child.stdin.end(input, "utf8");
  });
}
