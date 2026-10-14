import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as cfg from "../src/config/claude-config.js";
import { mcpAddArgs, parseMcpList } from "../src/config/mcp.js";
import { git, initRepo, tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let home: string;
let proj: string;
const prevHome = process.env.CLAUDE_CONFIG_DIR;
const prevData = process.env.FORGE_DATA_DIR;

beforeEach(async () => {
  t = tempDir("forge-cfg-");
  home = path.join(t.dir, "claude-home");
  proj = path.join(t.dir, "projekt");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  await initRepo(proj);
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.FORGE_DATA_DIR = path.join(t.dir, "forge-data");
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevHome;
  if (prevData === undefined) delete process.env.FORGE_DATA_DIR;
  else process.env.FORGE_DATA_DIR = prevData;
  t.cleanup();
});

describe("CLAUDE.md files", () => {
  it("lists global, project and local files with fixed paths", async () => {
    const list = await cfg.listMemory(proj);
    expect(list.map((m) => [m.scope, m.exists])).toEqual([
      ["global", false],
      ["project", false],
      ["local", false],
    ]);
    expect(list[0]!.path).toBe(path.join(home, "CLAUDE.md"));
  });

  it("creates, reads and detects concurrent changes", async () => {
    const w = await cfg.writeMemory("global", null, "# Regeln\n", null);
    expect(readFileSync(w.path, "utf8")).toBe("# Regeln\n");
    const r = await cfg.readMemory("global", null);
    expect(r.content).toBe("# Regeln\n");
    await expect(cfg.writeMemory("global", null, "neu", null)).rejects.toThrow(/existiert bereits/);
    await expect(cfg.writeMemory("global", null, "neu", r.mtimeMs! - 5000)).rejects.toThrow(/außerhalb von FORGE/);
    await cfg.writeMemory("global", null, "neu", r.mtimeMs);
    expect(readFileSync(w.path + ".bak", "utf8")).toBe("# Regeln\n");
  });

  it("keeps CLAUDE.local.md out of git", async () => {
    await cfg.writeMemory("local", proj, "privat", null);
    expect(readFileSync(path.join(proj, ".git", "info", "exclude"), "utf8")).toMatch(/^CLAUDE\.local\.md$/m);
  });

  it("keeps CLAUDE.local.md out of git in a worktree, where .git is a file", async () => {
    writeFileSync(path.join(proj, "README.md"), "x\n");
    await git(proj, "add", ".");
    await git(proj, "commit", "-m", "init");
    const wt = path.join(t.dir, "wt");
    await git(proj, "worktree", "add", "-b", "feature", wt);
    const w = await cfg.writeMemory("local", wt, "privat", null);
    expect(readFileSync(w.path, "utf8")).toBe("privat");
    expect(await git(wt, "status", "--porcelain")).toBe("");
  });

  it("writes atomically without leaving temp files", async () => {
    const w = await cfg.writeMemory("global", null, "eins", null);
    await cfg.writeMemory("global", null, "zwei", (await cfg.readMemory("global", null)).mtimeMs);
    expect(readFileSync(w.path, "utf8")).toBe("zwei");
    expect(readdirSync(home).sort()).toEqual(["CLAUDE.md", "CLAUDE.md.bak"]);
  });

  it("requires a project for project scopes", () => {
    expect(() => cfg.memoryPath("project", null)).toThrow(/Projekt/);
  });
});

describe("skills and subagents", () => {
  it("creates from template, lists with description and rejects bad names", async () => {
    await cfg.writeDoc("skill", "user", null, "release-notes", cfg.docTemplate("skill", "release-notes", "Schreibt Release Notes"), null);
    await cfg.writeDoc("agent", "project", proj, "reviewer", cfg.docTemplate("agent", "reviewer", "Prüft Diffs"), null);
    const skills = await cfg.listDocs("skill", proj);
    expect(skills).toEqual([expect.objectContaining({ name: "release-notes", scope: "user", description: "Schreibt Release Notes" })]);
    expect(existsSync(path.join(home, "skills", "release-notes", "SKILL.md"))).toBe(true);
    const agents = await cfg.listDocs("agent", proj);
    expect(agents[0]).toMatchObject({ name: "reviewer", scope: "project" });
    await expect(cfg.writeDoc("skill", "user", null, "../evil", "x", null)).rejects.toThrow(/Name/);
    await cfg.deleteDoc("skill", "user", null, "release-notes");
    expect(await cfg.listDocs("skill", null)).toEqual([]);
  });

  it("moves deleted skills with all files to the FORGE trash and keeps a .bak of subagents", async () => {
    await cfg.writeDoc("skill", "project", proj, "deploy", cfg.docTemplate("skill", "deploy", "Deployt"), null);
    const folder = path.join(proj, ".claude", "skills", "deploy");
    writeFileSync(path.join(folder, "script.sh"), "echo hi\n");
    const { backupPath } = await cfg.deleteDoc("skill", "project", proj, "deploy");
    expect(existsSync(folder)).toBe(false);
    expect(backupPath && path.dirname(backupPath)).toBe(cfg.skillTrashDir());
    expect(path.basename(backupPath!)).toMatch(/^project-deploy-/);
    expect(readFileSync(path.join(backupPath!, "script.sh"), "utf8")).toBe("echo hi\n");
    expect(existsSync(path.join(backupPath!, "SKILL.md"))).toBe(true);

    await cfg.writeDoc("agent", "user", null, "reviewer", "inhalt", null);
    const r = await cfg.deleteDoc("agent", "user", null, "reviewer");
    expect(r.backupPath).toBe(path.join(home, "agents", "reviewer.md.bak"));
    expect(readFileSync(r.backupPath!, "utf8")).toBe("inhalt");
    expect(await cfg.listDocs("agent", null)).toEqual([]);
  });
});

describe("hooks", () => {
  it("validates structure and replaces only the hooks key", async () => {
    const settings = path.join(home, "settings.json");
    writeFileSync(settings, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
    const r = await cfg.readHooks("user", null);
    expect(r.hooks).toBe("{}");
    const hooks = JSON.stringify({ PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "pnpm lint" }] }] });
    await cfg.writeHooks("user", null, hooks, r.mtimeMs);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.permissions.allow).toEqual(["Bash(ls)"]);
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe("pnpm lint");
  });

  it("rejects invalid hooks", () => {
    expect(cfg.validateHooks({ Nope: [] })).toMatch(/Unbekanntes/);
    expect(cfg.validateHooks({ Stop: [{ hooks: [] }] })).toMatch(/nicht leere/);
    expect(cfg.validateHooks({ Stop: [{ hooks: [{ type: "command" }] }] })).toMatch(/command/);
    expect(cfg.validateHooks({ Stop: [{ hooks: [{ type: "command", command: "echo ok" }] }] })).toBeNull();
  });
});

describe("mcp", () => {
  it("parses claude mcp list output", () => {
    const out = [
      "Checking MCP server health...",
      "",
      "context7: npx -y @upstash/context7-mcp - ✓ Connected",
      "github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect",
      "linear: https://mcp.linear.app/sse (SSE) - ⚠ Needs authentication",
    ].join("\n");
    expect(parseMcpList(out).map((s) => [s.name, s.status])).toEqual([
      ["context7", "connected"],
      ["github", "failed"],
      ["linear", "needs_auth"],
    ]);
  });

  /**
   * Reads arguments the way the claude CLI (commander) does: `-e/--env` takes values until the next
   * option, `--` ends all options, the rest are <name> <commandOrUrl> [args...].
   */
  const parseAdd = (argv: string[]) => {
    const opts: Record<string, string[]> = {};
    const positional: string[] = [];
    let variadic: string | null = null;
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--") {
        positional.push(...argv.slice(i + 1));
        break;
      }
      if (a.startsWith("-")) {
        const key = { "-e": "env", "--env": "env", "-s": "scope", "--scope": "scope", "-t": "transport", "--transport": "transport" }[a] ?? a;
        if (key === "env") variadic = key;
        else {
          variadic = null;
          opts[key] = [argv[++i]!];
          continue;
        }
        opts[key] ??= [];
        continue;
      }
      if (variadic) opts[variadic]!.push(a);
      else positional.push(a);
    }
    const [name, target, ...args] = positional;
    return { name, target, args, env: opts.env ?? [], scope: opts.scope?.[0], transport: opts.transport?.[0] };
  };

  it("builds add arguments the claude CLI reads back as meant, without a shell", () => {
    const stdio = mcpAddArgs({ name: "ctx", scope: "user", transport: "stdio", target: "npx", args: ["-y", "pkg"], env: { TOKEN: "x", OTHER: "y" } });
    expect(stdio).toEqual(["mcp", "add", "ctx", "--scope", "user", "-e", "TOKEN=x", "-e", "OTHER=y", "--", "npx", "-y", "pkg"]);
    expect(parseAdd(stdio)).toEqual({ name: "ctx", target: "npx", args: ["-y", "pkg"], env: ["TOKEN=x", "OTHER=y"], scope: "user", transport: undefined });

    const http = mcpAddArgs({ name: "remote", scope: "project", transport: "http", target: "https://x.example/mcp", args: [], env: { KEY: "1" } });
    expect(parseAdd(http)).toEqual({ name: "remote", target: "https://x.example/mcp", args: [], env: ["KEY=1"], scope: "project", transport: "http" });
    expect(parseAdd(mcpAddArgs({ name: "remote", scope: "local", transport: "sse", target: "https://x.example/sse", args: [], env: {} }))).toMatchObject({
      name: "remote",
      target: "https://x.example/sse",
      env: [],
    });
  });
});
