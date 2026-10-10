import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/util/proc.js";

export function tempDir(prefix = "forge-test-"): { dir: string; cleanup: () => void } {
  // Spaces and umlauts on purpose: paths like these must work everywhere.
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(base, "Projekte mit Ümläut");
  return {
    dir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export async function git(cwd: string, ...args: string[]) {
  const r = await run("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

export async function initRepo(cwd: string) {
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@forge.local");
  await git(cwd, "config", "user.name", "FORGE Test");
  await git(cwd, "config", "commit.gpgsign", "false");
}
