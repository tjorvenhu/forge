import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyRuleId, Settings } from "@forge/protocol";
import { DEFAULT_SETTINGS, Db, MIGRATIONS, AGENTS_ENABLED_VERSION } from "../src/persistence/db.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let file: string;

beforeEach(() => {
  t = tempDir();
  mkdirSync(t.dir, { recursive: true });
  file = path.join(t.dir, "forge.db");
});
afterEach(() => t.cleanup());

/**
 * Stores the list as an install before the update had it, then runs the update's migration on it.
 * Later migrations are not idempotent, so only this one runs again.
 */
function reopenFromBeforeUpdate(stored: PolicyRuleId[], rule: PolicyRuleId = "git-push-protected") {
  const db = new Db(file);
  db.updateSettings({ disabledPolicyRules: stored });
  db.sql.exec(MIGRATIONS.find((m) => m.includes(`'${rule}'`))!);
  return db;
}

describe("push to main/master", () => {
  it("is allowed by default on a new install", () => {
    const db = new Db(file);
    expect(db.getSettings().disabledPolicyRules).toEqual(["git-push-protected", "git-branch-delete"]);
    db.close();
  });

  it("gets switched off once for installs with their own blocklist and keeps their other choices", () => {
    const db = reopenFromBeforeUpdate(["git-reset-hard"]);
    expect(db.getSettings().disabledPolicyRules).toEqual(["git-reset-hard", "git-push-protected"]);
    db.close();
  });

  it("is switched off for installs that had every rule on", () => {
    const db = reopenFromBeforeUpdate([]);
    expect(db.getSettings().disabledPolicyRules).toEqual(["git-push-protected"]);
    db.close();
  });

  it("is not added twice and stays on when switched on again after the update", () => {
    let db = reopenFromBeforeUpdate(["git-push-protected"]);
    expect(db.getSettings().disabledPolicyRules).toEqual(["git-push-protected"]);
    db.updateSettings({ disabledPolicyRules: [] });
    db.close();
    db = new Db(file);
    expect(db.getSettings().disabledPolicyRules).toEqual([]);
    db.close();
  });
});

describe("language", () => {
  const migration = MIGRATIONS.find((m) => m.includes("SELECT 'language'"))!;
  let saved: Settings["language"];
  // setup-language.ts makes German the default for the other tests; here the real default counts.
  beforeEach(() => {
    saved = DEFAULT_SETTINGS.language;
    DEFAULT_SETTINGS.language = "en";
  });
  afterEach(() => {
    DEFAULT_SETTINGS.language = saved;
  });

  /** Runs the language migration again as on an update, after taking out what the first run stored. */
  function rerunMigration(db: Db) {
    db.sql.exec("DELETE FROM settings WHERE key = 'language'");
    db.sql.exec(migration);
  }

  it("is English on a new install", () => {
    expect(migration).toContain("'language'");
    const db = new Db(file);
    expect(db.getSettings().language).toBe("en");
    rerunMigration(db);
    expect(db.getSettings().language).toBe("en");
    db.close();
  });

  it("stays German for installs that already had settings", () => {
    const db = new Db(file);
    db.updateSettings({ defaultProfile: "balanced" });
    rerunMigration(db);
    expect(db.getSettings().language).toBe("de");
    db.close();
  });

  it("stays German for installs that already had projects", () => {
    const db = new Db(file);
    db.insertProject(
      { id: "p1", name: "p", path: t.dir, favorite: false, tags: [], technologies: [], profile: "balanced", defaultModel: null, defaultEffort: null, createdAt: new Date().toISOString(), lastOpenedAt: null, testCommand: null, devCommand: null, parentId: null, gitEnabled: true, agentsEnabled: true, group: null },
      t.dir.toLowerCase(),
    );
    rerunMigration(db);
    expect(db.getSettings().language).toBe("de");
    db.close();
  });

  it("keeps a language that was already chosen", () => {
    const db = new Db(file);
    db.updateSettings({ language: "en" });
    db.sql.exec(migration);
    expect(db.getSettings().language).toBe("en");
    db.close();
  });
});

describe("deleting local branches", () => {
  it("gets switched off once on update and keeps the other choices", () => {
    const db = reopenFromBeforeUpdate(["git-push-protected", "git-reset-hard"], "git-branch-delete");
    expect(db.getSettings().disabledPolicyRules).toEqual(["git-push-protected", "git-reset-hard", "git-branch-delete"]);
    db.close();
  });

  it("stays on when switched on again after the update", () => {
    let db = reopenFromBeforeUpdate(["git-push-protected"], "git-branch-delete");
    db.updateSettings({ disabledPolicyRules: ["git-push-protected"] });
    db.close();
    db = new Db(file);
    expect(db.getSettings().disabledPolicyRules).toEqual(["git-push-protected"]);
    db.close();
  });
});

// Every migration on a real file, twice per test: the Windows runner needs over 5 s for that.
describe("agents_enabled migration order", { timeout: 30_000 }, () => {
  /** An install whose schema has every migration up to agents_enabled but that one, stored as `userVersion`. */
  function withoutAgentsEnabled(userVersion: number) {
    const sql = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, AGENTS_ENABLED_VERSION).filter((m) => !m.includes("agents_enabled"))) sql.exec(m);
    sql.exec(`PRAGMA user_version = ${userVersion}`);
    sql.close();
  }

  function agentsEnabledColumns(db: Db) {
    return (db.sql.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).filter((c) => c.name === "agents_enabled");
  }

  it("adds the column for installs from 0.1.111 to 0.1.117", () => {
    withoutAgentsEnabled(AGENTS_ENABLED_VERSION - 1);
    const db = new Db(file);
    expect(agentsEnabledColumns(db)).toHaveLength(1);
    db.close();
  });

  it("adds the column for installs that 0.1.118 migrated without it", () => {
    withoutAgentsEnabled(AGENTS_ENABLED_VERSION);
    const db = new Db(file);
    expect(agentsEnabledColumns(db)).toHaveLength(1);
    db.close();
  });

  it("leaves complete installs alone", () => {
    new Db(file).close();
    const db = new Db(file);
    expect(agentsEnabledColumns(db)).toHaveLength(1);
    expect((db.sql.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    db.close();
  });
});
