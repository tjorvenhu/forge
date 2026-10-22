import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupPart } from "@forge/protocol";
import { BackupService } from "../src/backup/backup.js";
import { Db } from "../src/persistence/db.js";
import { pathKey } from "../src/util/paths.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  mkdirSync(t.dir, { recursive: true });
  const db = new Db(path.join(t.dir, "forge.db"));
  cleanups.push(() => db.close());
  const claudeDir = path.join(t.dir, "claude");
  mkdirSync(path.join(claudeDir, "agents"), { recursive: true });
  const claudeJson = path.join(t.dir, ".claude.json");
  let identity = { name: "Ada" as string | null, email: "ada@example.org" as string | null };
  let secretFiles: Record<string, string> = { "sip-password": "ENCRYPTED" };
  const restoredParts: BackupPart[][] = [];
  const svc = new BackupService({
    dir: path.join(t.dir, "backups"),
    db,
    appVersion: "0.1.0",
    git: {
      identity: async () => identity,
      setIdentity: async (name, email) => {
        identity = { name, email };
      },
    },
    secrets: {
      encrypted: () => secretFiles,
      restoreEncrypted: (f) => {
        secretFiles = f;
      },
    },
    afterRestore: async (parts) => {
      restoredParts.push(parts);
    },
    log: () => {},
    claudeDir,
    claudeJson,
  });
  const project = (id: string, name: string) => {
    const p = path.join(t.dir, name);
    mkdirSync(p, { recursive: true });
    db.insertProject(
      { id, name, path: p, favorite: false, tags: [], technologies: [], profile: "balanced", defaultModel: null, defaultEffort: null, createdAt: "2026-10-12T10:00:00.000Z", lastOpenedAt: null, testCommand: null, devCommand: null, parentId: null, gitEnabled: true, agentsEnabled: true, teamsEnabled: true, group: null },
      pathKey(p),
    );
  };
  return { t, db, svc, claudeDir, claudeJson, project, restoredParts, getIdentity: () => identity, getSecrets: () => secretFiles };
}

describe("backups", () => {
  it("saves settings, projects, phone, git identity and Claude configuration, and restores them", async () => {
    const { db, svc, claudeDir, claudeJson, project, restoredParts, getIdentity, getSecrets } = setup();
    db.updateSettings({ sounds: false, defaultModel: "opus" });
    db.setPhoneSettings({ server: "pbx.local", username: "42" });
    project("p1", "Alpha");
    writeFileSync(path.join(claudeDir, "CLAUDE.md"), "Regeln v1");
    writeFileSync(path.join(claudeDir, "agents", "reviewer.md"), "Agent v1");
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { docs: { command: "docs-mcp" } } }));

    const saved = await svc.create("manual");
    expect(saved.parts.map((p) => p.part)).toEqual(["settings", "projects", "phone", "claude", "git"]);

    // Everything changes after the backup.
    db.updateSettings({ sounds: true, defaultModel: "haiku" });
    db.updateProject("p1", { name: "Umbenannt", favorite: true });
    db.setPhoneSettings({ server: "other" });
    writeFileSync(path.join(claudeDir, "CLAUDE.md"), "Regeln kaputt");
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 9, mcpServers: { neu: { command: "neu" } } }));
    project("p2", "Beta");

    const r = await svc.restore({ id: saved.id! }, ["settings", "projects", "phone", "claude", "git"]);
    expect(r.restored).toEqual(["settings", "projects", "phone", "claude", "git"]);
    expect(restoredParts).toHaveLength(1);
    expect(db.getSettings()).toMatchObject({ sounds: false, defaultModel: "opus" });
    expect(db.getProject("p1")).toMatchObject({ name: "Alpha", favorite: false });
    // Projects added since stay.
    expect(db.getProject("p2")?.name).toBe("Beta");
    expect(db.getPhoneSettings()).toEqual({ server: "pbx.local", username: "42" });
    expect(getSecrets()).toEqual({ "sip-password": "ENCRYPTED" });
    expect(readFileSync(path.join(claudeDir, "CLAUDE.md"), "utf8")).toBe("Regeln v1");
    // MCP servers are merged into the current .claude.json; the CLI's own fields stay.
    expect(JSON.parse(readFileSync(claudeJson, "utf8"))).toEqual({ numStartups: 9, mcpServers: { neu: { command: "neu" }, docs: { command: "docs-mcp" } } });
    expect(getIdentity()).toEqual({ name: "Ada", email: "ada@example.org" });
    // The state before the restore was saved first.
    expect(r.safety.reason).toBe("before-restore");
  });

  it("restores only the chosen parts and brings back a removed project", async () => {
    const { db, svc, project } = setup();
    project("p1", "Alpha");
    db.updateSettings({ sounds: false });
    const saved = await svc.create("manual");
    db.deleteProject("p1");
    db.updateSettings({ sounds: true });
    await svc.restore({ id: saved.id! }, ["projects"]);
    expect(db.getProject("p1")?.name).toBe("Alpha");
    expect(db.getSettings().sounds).toBe(true);
  });

  it("saves the prompt templates and restores them, skipping those of a project that is gone", async () => {
    const { db, svc, project } = setup();
    project("p1", "Alpha");
    project("p2", "Beta");
    const tpl = (id: string, projectId: string | null, text: string) => ({ id, projectId, name: id, description: null, text, sortOrder: 0, createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z" });
    db.putTemplate(tpl("global", null, "Review"));
    db.putTemplate(tpl("alpha", "p1", "Tests für {datei}"));
    db.putTemplate(tpl("beta", "p2", "Beta"));
    const saved = await svc.create("manual");
    expect(saved.parts.find((p) => p.part === "templates")?.label).toBe("3 Vorlagen");

    db.putTemplate({ ...tpl("global", null, "geändert"), updatedAt: "2026-10-13T10:00:00.000Z" });
    db.deleteTemplate("alpha");
    db.deleteProject("p2");
    const r = await svc.restore({ id: saved.id! }, ["templates"]);
    expect(r.restored).toEqual(["templates"]);
    expect(db.listTemplates("all").map((x) => [x.id, x.text])).toEqual([
      ["global", "Review"],
      ["alpha", "Tests für {datei}"],
    ]);
    expect(r.notes).toContain("Eine Vorlage gehört zu einem Projekt, das nicht in FORGE ist, und wurde übersprungen.");
  });

  it("skips the start backup when nothing changed and keeps the newest ones", async () => {
    const { db, svc, t } = setup();
    expect(await svc.createOnStart()).not.toBeNull();
    expect(await svc.createOnStart()).toBeNull();
    db.updateSettings({ sounds: false });
    expect(await svc.createOnStart()).not.toBeNull();
    expect(await svc.list()).toHaveLength(2);
    expect(readdirSync(path.join(t.dir, "backups"))).toHaveLength(2);
  });

  it("exports to a file, reads it back and rejects other files", async () => {
    const { svc, t, db } = setup();
    db.updateSettings({ sounds: false });
    const file = path.join(t.dir, "export", "forge-backup.json");
    await svc.exportTo(file);
    expect((await svc.inspect(file)).parts[0]).toEqual({ part: "settings", label: "1 Einstellungen" });
    db.updateSettings({ sounds: true });
    await svc.restore({ path: file }, ["settings"]);
    expect(db.getSettings().sounds).toBe(false);

    const other = path.join(t.dir, "other.json");
    writeFileSync(other, JSON.stringify({ hello: "world" }));
    await expect(svc.inspect(other)).rejects.toThrow(/kein FORGE-Backup/);
    await expect(svc.restore({ id: "../../etc" }, ["settings"])).rejects.toThrow(/Ungültige/);
  });

  it("never writes Claude files outside the Claude folder", async () => {
    const { svc, t, claudeDir } = setup();
    const file = path.join(t.dir, "evil.json");
    await svc.exportTo(file);
    const data = JSON.parse(readFileSync(file, "utf8")) as { claude: { files: Record<string, string> } };
    data.claude.files["../escaped.txt"] = "nope";
    writeFileSync(file, JSON.stringify(data));
    await svc.restore({ path: file }, ["claude"]);
    expect(readdirSync(path.dirname(claudeDir))).not.toContain("escaped.txt");
  });

  /** Exports the current state, lets `edit` change the file and returns its path. */
  const craft = async (s: ReturnType<typeof setup>, edit: (data: { settings: Record<string, string>; claude: { files: Record<string, string>; mcpServers: Record<string, unknown> | null } }) => void) => {
    const file = path.join(s.t.dir, "crafted.json");
    await s.svc.exportTo(file);
    const data = JSON.parse(readFileSync(file, "utf8")) as Parameters<typeof edit>[0];
    edit(data);
    writeFileSync(file, JSON.stringify(data));
    return file;
  };

  it("writes only the Claude files a backup takes, not credentials, transcripts or plugin code", async () => {
    const s = setup();
    writeFileSync(path.join(s.claudeDir, ".credentials.json"), "echt");
    const file = await craft(s, (d) => {
      Object.assign(d.claude.files, {
        ".credentials.json": "gefälscht",
        "agents/../.credentials.json": "gefälscht",
        "projects/p/verlauf.jsonl": "x",
        "plugins/cache/p/index.js": "x",
        "agents/tool.exe": "x",
        "skills/pdf/SKILL.md": "Skill",
        "settings.json": "{}",
      });
    });
    await s.svc.restore({ path: file }, ["claude"]);
    expect(readFileSync(path.join(s.claudeDir, ".credentials.json"), "utf8")).toBe("echt");
    expect(existsSync(path.join(s.claudeDir, "projects"))).toBe(false);
    expect(existsSync(path.join(s.claudeDir, "plugins"))).toBe(false);
    expect(existsSync(path.join(s.claudeDir, "agents", "tool.exe"))).toBe(false);
    expect(readFileSync(path.join(s.claudeDir, "skills", "pdf", "SKILL.md"), "utf8")).toBe("Skill");
    expect(readFileSync(path.join(s.claudeDir, "settings.json"), "utf8")).toBe("{}");
  });

  it("merges MCP servers into a .claude.json with BOM, creates a missing one and stops on one it cannot read", async () => {
    const s = setup();
    const file = await craft(s, (d) => {
      d.claude.mcpServers = { docs: { command: "docs-mcp" } };
    });
    writeFileSync(s.claudeJson, "\uFEFF" + JSON.stringify({ numStartups: 4, oauthAccount: { id: "a" } }));
    await s.svc.restore({ path: file }, ["claude"]);
    expect(JSON.parse(readFileSync(s.claudeJson, "utf8"))).toEqual({ numStartups: 4, oauthAccount: { id: "a" }, mcpServers: { docs: { command: "docs-mcp" } } });

    rmSync(s.claudeJson);
    await s.svc.restore({ path: file }, ["claude"]);
    expect(JSON.parse(readFileSync(s.claudeJson, "utf8"))).toEqual({ mcpServers: { docs: { command: "docs-mcp" } } });

    writeFileSync(s.claudeJson, '{"numStartups": 4, "oauthAccount": ');
    s.db.updateSettings({ sounds: false });
    await expect(s.svc.restore({ path: file }, ["settings", "claude"])).rejects.toThrow(/kein gültiges JSON\. Das Backup wurde nicht wiederhergestellt/);
    expect(readFileSync(s.claudeJson, "utf8")).toBe('{"numStartups": 4, "oauthAccount": ');
    // Nothing else was set back either.
    expect(s.db.getSettings().sounds).toBe(false);
  });

  it("keeps settings an older backup does not know and skips values that are no JSON", async () => {
    const s = setup();
    s.db.updateSettings({ sounds: false });
    const file = await craft(s, (d) => {
      delete d.settings.setupDone;
      delete d.settings.syncEnabled;
      delete d.settings.syncAsked;
      d.settings.defaultModel = "kein json";
    });
    s.db.updateSettings({ sounds: true, setupDone: true, syncEnabled: true, syncAsked: true, defaultModel: "opus" });
    const r = await s.svc.restore({ path: file }, ["settings"]);
    expect(s.db.getSettings()).toMatchObject({ sounds: false, setupDone: true, syncEnabled: true, syncAsked: true, defaultModel: "opus" });
    expect(r.notes.join(" ")).toMatch(/beschädigt .*defaultModel/);

    // A backup that has them sets them back like any other setting.
    const withThem = await craft(s, (d) => {
      d.settings.setupDone = "false";
    });
    s.db.updateSettings({ setupDone: true });
    await s.svc.restore({ path: withThem }, ["settings"]);
    expect(s.db.getSettings().setupDone).toBe(false);
  });
});
