import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyRuleId } from "@forge/protocol";
import { checkToolUse, claudePlansDir, resolveToolPath, writesOutsideProject } from "../src/policy/guard.js";
import { effectivePermissionMode, PROFILES, resolveProfile } from "../src/policy/profiles.js";
import { redact, redactText } from "../src/policy/redact.js";

const home = os.homedir();
const projectDir = path.join(home, "Projects", "demo app");
// The shell forms below are those of Windows (Git Bash /c/, cmd, PowerShell), on every test platform.
const ctx = { projectDir, confineWritesToProject: false, currentBranch: "feature/x", home, platform: "win32" as NodeJS.Platform };
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
    // bypasses found in review
    ["git push origin HEAD:refs/heads/main", "git-push-protected"],
    ["git push origin refs/heads/master", "git-push-protected"],
    ['git push origin "main"', "git-push-protected"],
    ["git push origin 'HEAD:main'", "git-push-protected"],
    ["git push --mirror", "git-push-mirror"],
    ["git push origin --prune", "git-push-mirror"],
    ["git push origin --delete feature/x", "git-push-delete"],
    ["git push origin :feature/x", "git-push-delete"],
    ['git push origin "+feature/x"', "git-force-push"],
    ["rm -rf -- /", "rm-root"],
    ["rm --recursive --force ~", "rm-root"],
    ["rm -rf ${HOME}", "rm-root"],
    ['rm -rf "$HOME"', "rm-root"],
    ["rm -rf $HOME/*", "rm-root"],
    ["rm -rf ~/", "rm-root"],
    ["rm -rf /*", "rm-root"],
    ["rm -rf /c/", "rm-root"],
    ["rm -rf /mnt/c", "rm-root"],
    ["rm -r -f /", "rm-root"],
    ["sudo rm -Rf /", "rm-root"],
    ["cd x; rm -fr C:\\*", "rm-root"],
    ["Remove-Item -Recurse -Force $env:USERPROFILE\\*", "rm-root-win"],
    ['Remove-Item -Recurse -Force "${env:USERPROFILE}"', "rm-root-win"],
    ["Remove-Item -Path:C:\\ -Recurse", "rm-root-win"],
    ["rd /s /q C:\\", "rm-root-win"],
    ["cat ~/.npmrc", "sensitive-path"],
    ["cat $HOME/.docker/config.json", "sensitive-path"],
    ["Get-Content $env:USERPROFILE\\.npmrc", "sensitive-path"],
    [`type "${path.join(home, ".npmrc")}"`, "sensitive-path"],
  ])("blocks %s", (cmd, rule) => {
    expect(bash(cmd)).toBe(rule);
  });

  it.each([
    "git push origin feature/x",
    "git push -u origin feature/main-fix",
    "git push origin refs/heads/feature/x",
    "git push origin maintenance",
    "git push origin main:feature/x",
    "git status && git diff",
    "git branch feature/new",
    "rm -rf node_modules",
    "rm -rf ./dist",
    "rm -rf -- ./build",
    "rm --recursive --force dist/",
    "rm -rf ~/.cache/forge-test",
    "rm -rf $HOME/tmp/x",
    "rm -f /tmp/x.log",
    "rm *.log",
    "Remove-Item -Recurse -Force .\\dist",
    "Remove-Item -Recurse $env:TEMP\\forge-test",
    "rd /s /q build",
    'echo "rm -rf /"',
    "pnpm test",
    "git clean -n",
    "cat .npmrc",
    "cat ./config/.npmrc",
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

  it("applies to every tool that runs a shell command, like Monitor", () => {
    expect(checkToolUse("Monitor", { description: "x", timeout_ms: 1000, command: "rm -rf ~" }, ctx)?.rule).toBe("rm-root");
    expect(checkToolUse("Monitor", { description: "x", timeout_ms: 1000, command: "git push --force" }, ctx)?.rule).toBe("git-force-push");
    expect(checkToolUse("Monitor", { description: "x", timeout_ms: 1000, command: "tail -f log.txt" }, ctx)).toBeNull();
    expect(checkToolUse("Monitor", { description: "x", timeout_ms: 1000, ws: { url: "ws://localhost:1" } }, ctx)).toBeNull();
    expect(checkToolUse("WebFetch", { url: "https://example.com", prompt: "rm -rf /" }, ctx)).toBeNull();
  });

  const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

  it.each([
    ['cmd /c "rd /s /q C:\\"', "rm-root-win"],
    ['cmd //c "rd /s /q C:\\"', "rm-root-win"],
    ['cmd.exe /s /c "del /s /q %USERPROFILE%"', "rm-root-win"],
    ["powershell -Command 'Remove-Item -Recurse -Force $env:USERPROFILE'", "rm-root-win"],
    ['pwsh -c "Remove-Item -Recurse -Force C:\\"', "rm-root-win"],
    ['pwsh -NoProfile -c "cmd /c \'rd /s /q C:\\\'"', "rm-root-win"],
    ["bash -c 'rm -rf ~'", "rm-root"],
    ['sh -lc "cd /tmp && rm -rf $HOME"', "rm-root"],
    ["eval 'rm -rf /'", "rm-root"],
    ["bash -c 'cat ~/.netrc'", "sensitive-path"],
    [`powershell -EncodedCommand ${encoded("Remove-Item -Recurse -Force $env:USERPROFILE")}`, "rm-root-win"],
    [`pwsh -enc ${encoded("git push --force")}`, "git-force-push"],
    [`powershell -e ${encoded("Get-Content ~/.ssh/id_rsa")}`, "sensitive-path"],
  ])("checks the command inside a wrapper: %s", (cmd, rule) => {
    expect(bash(cmd)).toBe(rule);
  });

  it.each(["bash -c 'rm -rf ./dist'", 'cmd /c "rd /s /q build"', "powershell -Command 'Get-ChildItem'", `pwsh -enc ${encoded("Get-ChildItem")}`, "bash -c \"echo 'rm -rf /'\"", "bash scripts/build.sh"])(
    "allows harmless wrapped commands: %s",
    (cmd) => {
      expect(bash(cmd)).toBeNull();
    },
  );

  it("checks a push inside a wrapper against the protected branch", () => {
    expect(bash("bash -c 'git push'", { ...ctx, currentBranch: "main" })).toBe("git-push-protected");
  });

  const fwd = home.replace(/\\/g, "/");
  const gitBash = fwd.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

  it.each([
    [`rm -rf ${home}`, "rm-root"],
    [`rm -rf "${fwd.toUpperCase()}/"`, "rm-root"],
    [`rm -rf ${gitBash}`, "rm-root"],
    // WSL path of the Windows home; elsewhere /mnt/home/... is just some folder.
    ...(process.platform === "win32" ? [[`rm -rf /mnt${gitBash}`, "rm-root"]] : []),
    ["rm -rf /c/Users/someone", "rm-root"],
    ["rm -rf $USERPROFILE", "rm-root"],
    ["rm -rf ${USERPROFILE}/*", "rm-root"],
    [`Remove-Item -Recurse -Force "${home}"`, "rm-root-win"],
    ["rd /s /q C:\\Users", "rm-root-win"],
    ["cat /c/Users/x/.netrc", "sensitive-path"],
    [`cat ${gitBash}/.npmrc`, "sensitive-path"],
    ["cat $USERPROFILE/.npmrc", "sensitive-path"],
    [`type ${fwd.toLowerCase()}/.docker/config.json`, "sensitive-path"],
  ])("recognises the home folder as a path: %s", (cmd, rule) => {
    expect(bash(cmd)).toBe(rule);
  });

  it.each([`rm -rf ${path.join(projectDir, "dist")}`, `rm -rf ${gitBash}/Projects/demo/dist`, "rm -rf /c/Users/x/tmp", `cat ${gitBash}/Projects/demo/.npmrc`])(
    "allows paths below the home folder: %s",
    (cmd) => {
      expect(bash(cmd)).toBeNull();
    },
  );

  const unixCtx = (platform: NodeJS.Platform, h: string) => ({ ...ctx, platform, home: h, projectDir: `${h}/code/app` });

  it.each([
    ["linux", "rm -rf /home/someone", "rm-root"],
    ["linux", "rm -rf /home/", "rm-root"],
    ["linux", "rm -rf /root", "rm-root"],
    ["darwin", "rm -rf /Users/someone/*", "rm-root"],
    ["darwin", "rm -rf /Users", "rm-root"],
    ["linux", "cat /home/someone/.npmrc", "sensitive-path"],
    ["darwin", "rm -rf ~", "rm-root"],
  ] as const)("knows the homes of macOS and Linux (%s): %s", (platform, cmd, rule) => {
    expect(bash(cmd, unixCtx(platform, platform === "darwin" ? "/Users/me" : "/home/me"))).toBe(rule);
  });

  it.each([
    ["linux", "rm -rf /a"],
    ["linux", "rm -rf /c/build"],
    ["linux", "rm -rf /home/me/code/app/dist"],
    ["darwin", "rm -rf /Users/me/code/app/node_modules"],
  ] as const)("does not take one-letter folders for drives on macOS and Linux (%s): %s", (platform, cmd) => {
    expect(bash(cmd, unixCtx(platform, platform === "darwin" ? "/Users/me" : "/home/me"))).toBeNull();
  });

  it("still treats /a as a Git Bash drive on Windows", () => {
    expect(bash("rm -rf /a")).toBe("rm-root");
  });

  it.each([
    ["Git push --force", "git-force-push"],
    ["GIT push -f", "git-force-push"],
    ["git push --forc", "git-force-push"],
    ["git push --force-w", "git-force-push"],
    ["git push -fu origin feature/x", "git-force-push"],
    ["git push --mirr", "git-push-mirror"],
    ["git push origin --pru", "git-push-mirror"],
    ["git push origin --del x", "git-push-delete"],
    ["git push origin --delete=x", "git-push-delete"],
    ["git reset --har", "git-reset-hard"],
    ["Git Reset --HARD", "git-reset-hard"],
    ["git branch --del old", "git-branch-delete"],
    ["git branch -df old", "git-branch-delete"],
    ["git clean --forc -d", "git-clean-force"],
  ])("blocks case variants and abbreviated options: %s", (cmd, rule) => {
    expect(bash(cmd)).toBe(rule);
  });

  it.each(["git push --follow-tags origin feature/x", "git push --dry-run origin feature/x", "git push --porcelain origin feature/x", "git push --progress origin feature/x", "git reset --soft HEAD~1", "git branch --list"])(
    "allows other options with the same first letters: %s",
    (cmd) => {
      expect(bash(cmd)).toBeNull();
    },
  );
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

  it("lets Claude write its plan file outside the project, nothing else", () => {
    const plans = claudePlansDir(home);
    const strict = { ...ctx, confineWritesToProject: true, extraWriteDirs: [plans] };
    expect(checkToolUse("Write", { file_path: path.join(plans, "plan-x.md") }, strict)).toBeNull();
    expect(checkToolUse("Write", { file_path: path.join(home, ".claude", "settings.json") }, strict)?.rule).toBe("write-outside-project");
    expect(checkToolUse("Write", { file_path: path.join(plans, "..", "evil.md") }, strict)?.rule).toBe("write-outside-project");
    expect(writesOutsideProject("Write", { file_path: path.join(plans, "plan-x.md") }, projectDir, home, [plans])).toBe(false);
  });

  it("resolves ~ against the home folder when the context has no home (as in the session service)", () => {
    const prodCtx = { projectDir, confineWritesToProject: true, currentBranch: null, extraWriteDirs: [claudePlansDir()] };
    expect(checkToolUse("Write", { file_path: "~/.claude/settings.json" }, prodCtx)?.rule).toBe("write-outside-project");
    expect(checkToolUse("Read", { file_path: "~/.npmrc" }, prodCtx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Read", { file_path: "~/.docker/config.json" }, prodCtx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Write", { file_path: "src/~notes.md" }, prodCtx)).toBeNull();
    expect(resolveToolPath("~/x", projectDir)).toBe(path.join(home, "x"));
    expect(resolveToolPath("~", projectDir)).toBe(home);
  });

  it("blocks Grep and Glob that can reach a credentials folder through glob or search root", () => {
    expect(checkToolUse("Grep", { pattern: "PRIVATE", path: home, glob: ".ssh/*" }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Glob", { pattern: path.join(home, ".ssh", "*") }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Glob", { pattern: `${home.replace(/\\/g, "/")}/.s*/*` }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Glob", { pattern: "~/**/id_*" }, ctx)?.rule).toBe("sensitive-path");
    // search root above ~/.ssh: no glob, filename-only glob and wildcard first segment all reach it
    expect(checkToolUse("Grep", { pattern: "BEGIN OPENSSH", path: home }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Grep", { pattern: "x", path: "~", glob: "*" }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Grep", { pattern: "x", path: home, glob: "*/id_*" }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Glob", { pattern: "**/*", path: home }, ctx)?.rule).toBe("sensitive-path");
    expect(checkToolUse("Glob", { pattern: "**/*", path: path.parse(home).root }, ctx)?.rule).toBe("sensitive-path");
  });

  it("allows normal Grep and Glob calls", () => {
    expect(checkToolUse("Grep", { pattern: "password", path: "src" }, ctx)).toBeNull();
    expect(checkToolUse("Grep", { pattern: "TODO" }, ctx)).toBeNull();
    expect(checkToolUse("Grep", { pattern: "x", glob: "**/*.ts" }, ctx)).toBeNull();
    expect(checkToolUse("Glob", { pattern: "**/*.ts" }, ctx)).toBeNull();
    expect(checkToolUse("Glob", { pattern: "src/**/*.tsx", path: projectDir }, ctx)).toBeNull();
    // narrowed to a literal subfolder of home that holds no credentials
    expect(checkToolUse("Glob", { pattern: "Projects/**/*.ts", path: home }, ctx)).toBeNull();
    expect(checkToolUse("Grep", { pattern: "x", path: home, glob: "Projects/**/*.md" }, ctx)).toBeNull();
  });

  it("detects writes outside the project, including traversal", () => {
    expect(writesOutsideProject("Edit", { file_path: "../escape.txt" }, projectDir)).toBe(true);
    expect(writesOutsideProject("Edit", { file_path: "inner/../ok.txt" }, projectDir)).toBe(false);
    expect(writesOutsideProject("Read", { file_path: "../escape.txt" }, projectDir)).toBe(false);
  });
});

describe("guard: rules switched off in the settings", () => {
  const off = (...rules: PolicyRuleId[]) => ({ ...ctx, disabledRules: new Set(rules) });

  it("skips exactly the switched-off rule", () => {
    expect(bash("git push --force", off("git-force-push"))).toBeNull();
    expect(bash("git reset --hard", off("git-force-push"))).toBe("git-reset-hard");
    expect(bash("git branch -D old", off("git-branch-delete"))).toBeNull();
    expect(bash("format C:", off("format-disk"))).toBeNull();
  });

  it("switches off push from a protected branch together with push to it", () => {
    const onMain = { ...off("git-push-protected"), currentBranch: "main" };
    expect(bash("git push", { ...ctx, currentBranch: "main" })).toBe("git-push-protected");
    expect(bash("git push", onMain)).toBeNull();
    expect(bash("git push origin main", onMain)).toBeNull();
  });

  it("covers Unix and Windows root deletes with one rule", () => {
    expect(bash("rm -rf /", off("rm-root"))).toBeNull();
    expect(bash("Remove-Item -Recurse -Force C:\\", off("rm-root"))).toBeNull();
  });

  it("covers credentials in commands, file tools and searches with one rule", () => {
    const c = off("sensitive-path");
    expect(bash("cat ~/.ssh/id_rsa", c)).toBeNull();
    expect(checkToolUse("Read", { file_path: path.join(home, ".ssh", "id_rsa") }, c)).toBeNull();
    expect(checkToolUse("Grep", { pattern: "x", path: home }, c)).toBeNull();
  });

  it("allows writes outside the project in a confining profile", () => {
    const outside = { file_path: path.join(home, "other", "x.txt") };
    expect(checkToolUse("Write", outside, { ...off("write-outside-project"), confineWritesToProject: true })).toBeNull();
    expect(checkToolUse("Write", { file_path: path.join(home, ".ssh", "config") }, { ...off("write-outside-project"), confineWritesToProject: true })?.rule).toBe(
      "sensitive-path",
    );
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
  });

  it.each([
    ["OpenAI project key", "OPENAI=sk-proj-abcDEF123_ghiJKL456-mnoPQR789stu", "sk-proj-abc"],
    ["OpenAI service account key", "key sk-svcacct-abcdefghijklmnopqrstuvwx", "sk-svcacct-abc"],
    ["JSON password", '{"password": "hunter2hunter2"}', "hunter2"],
    ["JSON api key with single quotes", "{'api_key': 'abcdef123456'}", "abcdef123456"],
    ["SECRET_KEY", "SECRET_KEY=django-insecure-9f8e7d6c5b", "django-insecure"],
    ["GITHUB_TOKEN", "GITHUB_TOKEN=0123456789abcdef0123", "0123456789abcdef"],
    ["AWS secret in env", "AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMIK7MDENGbPxRfiCY", "wJalrXUtn"],
    ["Postgres URL", "DATABASE_URL=postgres://forge:s3cretPass@db.local:5432/app", "s3cretPass"],
    ["Redis URL", "redis://:hunter22@cache:6379", "hunter22"],
  ])("redacts %s", (_label, text, leaked) => {
    const out = redactText(text);
    expect(out).not.toContain(leaked);
    expect(out).toContain("[REDACTED]");
  });

  it("keeps the user part of connection strings", () => {
    expect(redactText("postgres://forge:s3cretPass@db.local:5432/app")).toBe("postgres://forge:[REDACTED]@db.local:5432/app");
  });

  it.each([
    "MAX_TOKENS=4096",
    "NODE_ENV=production",
    '"inputTokens": 123456789',
    "tokens: 1234",
    "The password field is required.",
    "http://localhost:3000/api",
    "https://example.com:8443/path@v2",
    "git@github.com:org/repo.git",
    "mailto:user@example.com",
    "GITHUB_TOKEN=${GITHUB_TOKEN}",
    "API_KEY=<your-key>",
    "PRIMARY_KEY=id",
    "const sk = 'sk-short';",
  ])("does not redact %s", (text) => {
    expect(redactText(text)).toBe(text);
  });

  it("redacts nested values without touching structure", () => {
    expect(redact({ a: ["ghp_abcdefghijklmnopqrstuvwxyz0123"], n: 1, ok: true })).toEqual({ a: ["[REDACTED]"], n: 1, ok: true });
  });
});
