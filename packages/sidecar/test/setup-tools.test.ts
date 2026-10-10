import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLoginUrl, stripAnsi } from "../src/claude/setup.js";
import { bundledPathEntries, resolveTool } from "../src/util/tools.js";
import { sessionEnv } from "../src/claude/environment.js";
import { tempDir } from "./helpers.js";

describe("claude login output parsing", () => {
  // Shape recorded from `claude auth login` (2.1.296) in an isolated config dir.
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz";
  const raw = `Opening browser to sign in…\nIf the browser didn't open, visit: \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\nPaste code here if prompted > `;

  it("extracts the URL from OSC 8 hyperlinks", () => {
    expect(findLoginUrl(raw)).toBe(url);
    expect(findLoginUrl("no url yet")).toBeNull();
  });

  it("strips escape sequences for the log", () => {
    expect(stripAnsi("\u001b[32mok\u001b[0m")).toBe("ok");
    expect(stripAnsi(raw)).not.toContain("\u001b");
  });
});

describe.runIf(process.platform === "win32")("bundled runtime resolution", () => {
  const t = tempDir("forge-runtime-");
  const prev = process.env.FORGE_RUNTIME_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.FORGE_RUNTIME_DIR;
    else process.env.FORGE_RUNTIME_DIR = prev;
  });

  it("prefers shipped git/gh and adds them to the session PATH", () => {
    const rt = t.dir;
    for (const rel of ["git/cmd/git.exe", "gh/bin/gh.exe", "git/bin/bash.exe"]) {
      mkdirSync(path.dirname(path.join(rt, rel)), { recursive: true });
      writeFileSync(path.join(rt, rel), "");
    }
    process.env.FORGE_RUNTIME_DIR = rt;
    expect(resolveTool("git")).toEqual({ path: path.join(rt, "git", "cmd", "git.exe"), bundled: true });
    expect(resolveTool("gh")?.bundled).toBe(true);
    expect(bundledPathEntries()).toEqual([path.join(rt, "git", "cmd"), path.join(rt, "gh", "bin")]);
    const env = sessionEnv(true, { Path: "C:\\Windows" });
    expect(env.Path?.startsWith(path.join(rt, "git", "cmd"))).toBe(true);
    t.cleanup();
  });

  it("falls back to the system when nothing is shipped", () => {
    delete process.env.FORGE_RUNTIME_DIR;
    expect(resolveTool("git")?.bundled ?? false).toBe(false);
    expect(bundledPathEntries()).toEqual([]);
  });
});
