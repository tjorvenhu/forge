import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserRelay, findLoginUrl, installCommand, stripAnsi } from "../src/claude/setup.js";
import { bundledPathEntries, bundledRelPath, extraUnixBinDirs, isStorePythonStub, pythonUserScripts, resolveTool } from "../src/util/tools.js";
import { claudeCandidates, hasOwnClaude, ownClaudeCandidates, sessionEnv } from "../src/claude/environment.js";
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

  it("relays the page Claude Code opens through a script of the platform", () => {
    const relay = browserRelay("linux");
    try {
      expect(relay.program.endsWith("open.sh")).toBe(true);
      expect(readFileSync(relay.program, "utf8")).toMatch(/^#!\/bin\/sh\nprintf '%s\\n' "\$\*" > '.+url\.txt'\n$/);
      if (process.platform !== "win32") {
        execFileSync(relay.program, [url]);
        expect(relay.read()).toBe(url);
      }
    } finally {
      relay.dispose();
    }
    const win = browserRelay("win32");
    try {
      expect(win.program.endsWith("open.cmd")).toBe(true);
    } finally {
      win.dispose();
    }
  });

  it("installs Claude Code with the official script of the platform", () => {
    expect(installCommand("win32").command).toBe("powershell.exe");
    expect(installCommand("darwin")).toEqual({ command: "/bin/bash", args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"] });
  });

  it("finds Claude Code where the installers put it", () => {
    expect(claudeCandidates("/home/x", "linux")).toEqual([path.join("/home/x", ".local", "bin", "claude"), path.join("/home/x", ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
    expect(claudeCandidates("C:\\Users\\x", "win32")[0]).toBe(path.join("C:\\Users\\x", ".local", "bin", "claude.exe"));
  });

  it("keeps FORGE's own install locations apart from externally managed ones", () => {
    // own = what the official installer writes and `claude update` self-updates; no Homebrew paths here
    expect(ownClaudeCandidates("/home/x", "linux")).toEqual([path.join("/home/x", ".local", "bin", "claude"), path.join("/home/x", ".claude", "local", "claude")]);
    expect(ownClaudeCandidates("/home/x", "linux")).not.toContain("/opt/homebrew/bin/claude");
  });

  it("detects whether FORGE has its own install", () => {
    const { dir: home, cleanup } = tempDir("forge-own-claude-");
    try {
      expect(hasOwnClaude(home, "linux")).toBe(false);
      mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
      writeFileSync(path.join(home, ".local", "bin", "claude"), "");
      expect(hasOwnClaude(home, "linux")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("bundled runtime resolution", () => {
  const t = tempDir("forge-runtime-");
  const prev = process.env.FORGE_RUNTIME_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.FORGE_RUNTIME_DIR;
    else process.env.FORGE_RUNTIME_DIR = prev;
  });

  const onWindows = process.platform === "win32";

  it.runIf(onWindows)("prefers shipped git/gh and adds them to the session PATH", () => {
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
    expect(resolveTool("python")?.bundled ?? false).toBe(false);
    expect(bundledPathEntries()).toEqual([]);
  });

  it.runIf(onWindows)("puts the shipped python and its user script folder on the session PATH", () => {
    const rt = tempDir("forge-runtime-py-");
    try {
      for (const rel of ["git/cmd/git.exe", "gh/bin/gh.exe", "python/python.exe"]) {
        mkdirSync(path.dirname(path.join(rt.dir, rel)), { recursive: true });
        writeFileSync(path.join(rt.dir, rel), "");
      }
      writeFileSync(path.join(rt.dir, "VERSIONS.json"), JSON.stringify({ node: "24.21.0", git: "2.56.0.2", gh: "2.102.0", python: "3.14.8" }));
      process.env.FORGE_RUNTIME_DIR = rt.dir;
      expect(resolveTool("python")).toEqual({ path: path.join(rt.dir, "python", "python.exe"), bundled: true });
      const scripts = pythonUserScripts("3.14.8");
      expect(scripts).toMatch(/[\\/]Python314[\\/]Scripts$/);
      expect(bundledPathEntries()).toEqual([path.join(rt.dir, "git", "cmd"), path.join(rt.dir, "gh", "bin"), path.join(rt.dir, "python"), scripts]);
      // In front of WindowsApps, whose python.exe only opens the Store.
      const env = sessionEnv(true, { Path: "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps" });
      expect(env.Path?.split(path.delimiter)).toEqual([...bundledPathEntries(), "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps"]);
      expect(env.PYTHONUTF8).toBe("1");
      expect(sessionEnv(true, { PYTHONUTF8: "0" }).PYTHONUTF8).toBe("0");
    } finally {
      rt.cleanup();
    }
  });

  it("finds the user script folder like site.py", () => {
    expect(pythonUserScripts("3.14.8", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toBe(path.join("C:\\Users\\x\\AppData\\Roaming", "Python", "Python314", "Scripts"));
    expect(pythonUserScripts("3.14.8", { APPDATA: "C:\\a", PYTHONUSERBASE: "D:\\py" }, "win32")).toBe(path.join("D:\\py", "Python314", "Scripts"));
    expect(pythonUserScripts(undefined, { APPDATA: "C:\\a" }, "win32")).toBeNull();
    // macOS and Linux: site.py's posix_user scheme
    expect(pythonUserScripts("3.14.8", {}, "darwin", "/Users/x")).toBe(path.join("/Users/x", "Library", "Python", "3.14", "bin"));
    expect(pythonUserScripts("3.14.8", {}, "linux", "/home/x")).toBe(path.join("/home/x", ".local", "bin"));
    expect(pythonUserScripts("3.14.8", { PYTHONUSERBASE: "/opt/py" }, "linux", "/home/x")).toBe(path.join("/opt/py", "bin"));
  });

  it("knows the runtime layout of every platform", () => {
    expect(bundledRelPath("gh", "win32")).toBe(path.join("gh", "bin", "gh.exe"));
    expect(bundledRelPath("git", "win32")).toBe(path.join("git", "cmd", "git.exe"));
    expect(bundledRelPath("node", "darwin")).toBe(path.join("node", "bin", "node"));
    expect(bundledRelPath("gh", "linux")).toBe(path.join("gh", "bin", "gh"));
    // git, Git Bash and python come from the system on macOS and Linux
    for (const tool of ["git", "bash", "python"] as const) expect(bundledRelPath(tool, "darwin")).toBeNull();
  });

  it("puts only the shipped gh on the session PATH on macOS and Linux", () => {
    const rt = tempDir("forge-runtime-unix-");
    try {
      for (const rel of ["gh/bin/gh", "node/bin/node"]) {
        mkdirSync(path.dirname(path.join(rt.dir, rel)), { recursive: true });
        writeFileSync(path.join(rt.dir, rel), "");
      }
      process.env.FORGE_RUNTIME_DIR = rt.dir;
      expect(bundledPathEntries("linux")).toEqual([path.join(rt.dir, "gh", "bin")]);
      expect(bundledPathEntries("darwin")).toEqual([path.join(rt.dir, "gh", "bin")]);
    } finally {
      rt.cleanup();
    }
  });

  it("looks in the folders of Homebrew and co. that a desktop launcher leaves off PATH", () => {
    expect(extraUnixBinDirs("/Users/x", "darwin")).toEqual(["/opt/homebrew/bin", "/usr/local/bin", path.join("/Users/x", ".local", "bin")]);
    expect(extraUnixBinDirs("/home/x", "linux")).toContain("/snap/bin");
    expect(extraUnixBinDirs("C:\\Users\\x", "win32")).toEqual([]);
  });

  it.runIf(onWindows)("does not take the Store placeholder in WindowsApps for a Python", () => {
    const t = tempDir("forge-store-");
    try {
      const apps = path.join(t.dir, "WindowsApps");
      mkdirSync(apps, { recursive: true });
      writeFileSync(path.join(apps, "python.exe"), "");
      expect(isStorePythonStub(path.join(apps, "python.exe"))).toBe(true);
      mkdirSync(path.join(apps, "PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0"));
      expect(isStorePythonStub(path.join(apps, "python.exe"))).toBe(false);
      expect(isStorePythonStub("C:\\Python314\\python.exe")).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});
