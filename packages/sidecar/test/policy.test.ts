import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolUse, writesOutsideProject } from "../src/policy/guard.js";
import { effectivePermissionMode, PROFILES, resolveProfile } from "../src/policy/profiles.js";
import { containsSecret, redact, redactText } from "../src/policy/redact.js";

const home = os.homedir();
const projectDir = path.join(home, "Projects", "demo app");
const ctx = { projectDir, confineWritesToProject: false, currentBranch: "feature/x", home };
const bash = (command: string, c = ctx) => checkToolUse("Bash", { command }, c)?.rule ?? null;

describe("guard: shell rules (all profiles)", () => {
  it.each([
    ["git push --force origin feature/x", "git-force-push"],
    ["git push -f", "git-force-push"],
    ["git push --force-with-lease", "git-force-push"],
    ["git push origin +feature/x", "git-force-push"],
    ["git push origin main", "git-push-protected"],
    ["git push origin HEAD:master", "git-push-protected"],
    ["npm test && git reset --hard HEAD~1", "git-reset-hard"],
    ["git branch -D old", "git-branch-delete"],
    ["git branch --delete old", "git-branch-delete"],
    ["git clean -fdx", "git-clean-force"],
    ["rm -rf /", "rm-root"],
    ["rm -rf ~", "rm-root"],
    ["rm -rf C:/", "rm-root"],
    ["Remove-Item -Recurse -Force C:\\", "rm-root-win"],
    ["format C:", "format-disk"],
    ["cat ~/.ssh/id_rsa", "sensitive-path"],
    ["type %USERPROFILE%\\.aws\\credentials", "sensitive-path"],
  ])("blocks %s", (cmd, rule) => {
    expect(bash(cmd)).toBe(rule);
  });

  it.each([
    "git push origin feature/x",
    "git push -u origin feature/main-fix",
    "git status && git diff",
    "git branch feature/new",
    "rm -rf node_modules",
    "rm -rf ./dist",
    "pnpm test",
    "git clean -n",
  ])("allows %s", (cmd) => {
    expect(bash(cmd)).toBeNull();
  });

  it("blocks plain push while on a protected branch", () => {
    expect(bash("git push", { ...ctx, currentBranch: "main" })).toBe("git-push-protected");
    expect(bash("git push", ctx)).toBeNull();
  });

  it("applies to the PowerShell tool too", () => {
    expect(checkToolUse("PowerShell", { command: "git push --force" }, ctx)?.rule).toBe("git-force-push");
  });
});

describe("guard: file tools", () => {
  it("blocks sensitive paths for every file tool", () => {
    expect(checkToolUse("Read", { file_path: path.join(home, ".ssh", "id_rsa") }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Read", { file_path: "~/.aws/credentials" }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Grep", { path: path.join(home, ".gnupg") }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Read", { file_path: path.join(projectDir, "src", "index.ts") }, ctx)).toBeNull();
  });

  it("confines writes to the project only when the profile says so", () => {
    const outside = { file_path: path.join(home, "other", "x.txt") };
    expect(checkToolUse("Write", outside, ctx)).toBeNull();
    expect(checkToolUse("Write", outside, { ...ctx, confineWritesToProject: true })?.rule).toBe("write-outside-project");
    expect(checkToolUse("Write", { file_path: "src/ok.ts" }, { ...ctx, confineWritesToProject: true })).toBeNull();
    expect(checkToolUse("Read", outside, { ...ctx, confineWritesToProject: true })).toBeNull();
  });

  it("detects writes outside the project, including traversal", () => {
    expect(writesOutsideProject("Edit", { file_path: "../escape.txt" }, projectDir)).toBe(true);
    expect(writesOutsideProject("Edit", { file_path: "inner/../ok.txt" }, projectDir)).toBe(false);
    expect(writesOutsideProject("Read", { file_path: "../escape.txt" }, projectDir)).toBe(false);
  });
});

describe("profiles", () => {
  it("maps profiles to real Claude permission modes", () => {
    expect(PROFILES.safe.permissionMode).toBe("default");
    expect(PROFILES.safe.allowSessionScope).toBe(false);
    expect(PROFILES.safe.disallowedTools).toContain("WebFetch");
    expect(PROFILES.balanced.permissionMode).toBe("acceptEdits");
    expect(PROFILES.autonomous.permissionMode).toBe("bypassPermissions");
    expect(effectivePermissionMode(PROFILES.balanced, true)).toBe("plan");
  });

  it("allows autonomous without unlock, except in sandbox-only projects", () => {
    expect(resolveProfile("autonomous", []).id).toBe("autonomous");
    expect(() => resolveProfile("autonomous", ["sandbox-only"])).toThrow(/sandbox-only/);
    expect(resolveProfile("balanced", ["sandbox-only"]).id).toBe("balanced");
  });
});

describe("redaction", () => {
  it("masks common credentials", () => {
    const text = [
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "aws AKIAABCDEFGHIJKLMNOP",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123",
      'password: "hunter2hunter2"',
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = redactText(text);
    expect(out).not.toMatch(/sk-ant-api03|ghp_abc|AKIAABCD|hunter2|abcdefghijklmnopqrstuvwxyz\.123|OPENSSH PRIVATE KEY-----\nabc/);
    expect(containsSecret(text)).toBe(true);
    expect(containsSecret("const x = 1;")).toBe(false);
  });

  it("redacts nested values without touching structure", () => {
    expect(redact({ a: ["ghp_abcdefghijklmnopqrstuvwxyz0123"], n: 1, ok: true })).toEqual({ a: ["[REDACTED]"], n: 1, ok: true });
  });
});
