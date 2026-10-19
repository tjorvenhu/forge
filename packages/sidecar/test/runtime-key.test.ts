import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installedRuntimeKey } from "../src/update/app-update.js";

const SCRIPT = path.resolve(import.meta.dirname, "../../../scripts/prepare-runtime.mjs");

function script(flag: string): string {
  const r = spawnSync(process.execPath, [SCRIPT, flag], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

describe("runtime key", () => {
  it("is the same in prepare-runtime.mjs and in the installed app", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-runtime-"));
    try {
      writeFileSync(path.join(dir, "VERSIONS.json"), script("--versions"));
      const key = script("--key");
      // macOS and Linux ship node and gh only, behind the platform tag.
      expect(key).toMatch(process.platform === "win32" ? /^node-[\d.]+_git-[\d.]+_gh-[\d.]+_python-[\d.]+$/ : /^(darwin|linux)-(arm64|x64)_node-[\d.]+_gh-[\d.]+$/);
      expect(installedRuntimeKey(dir)).toBe(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("keeps the old key for installations without Python, so they get the full installer", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-runtime-"));
    try {
      writeFileSync(path.join(dir, "VERSIONS.json"), JSON.stringify({ node: "24.21.0", git: "2.56.0.2", gh: "2.102.0" }));
      expect(installedRuntimeKey(dir)).toBe("node-24.21.0_git-2.56.0.2_gh-2.102.0");
      expect(installedRuntimeKey(dir)).not.toBe(script("--key"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
