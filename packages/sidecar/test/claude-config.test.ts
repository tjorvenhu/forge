import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as cfg from "../src/config/claude-config.js";
import { mcpAddArgs, parseMcpList } from "../src/config/mcp.js";
import { initRepo, tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let home: string;
let proj: string;
const prevHome = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  t = tempDir("forge-cfg-");
  home = path.join(t.dir, "claude-home");
  proj = path.join(t.dir, "projekt");
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  await initRepo(proj);
  process.env.CLAUDE_CONFIG_DIR = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevHome;
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

  it("builds add arguments without a shell", () => {
    expect(mcpAddArgs({ name: "ctx", scope: "user", transport: "stdio", target: "npx", args: ["-y", "pkg"], env: { TOKEN: "x" } })).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "--env",
      "TOKEN=x",
      "ctx",
      "--",
      "npx",
      "-y",
      "pkg",
    ]);
    expect(mcpAddArgs({ name: "remote", scope: "project", transport: "http", target: "https://x.example/mcp", args: [], env: {} })).toEqual([
      "mcp",
      "add",
      "--scope",
      "project",
      "--transport",
      "http",
      "remote",
      "https://x.example/mcp",
    ]);
  });
});
