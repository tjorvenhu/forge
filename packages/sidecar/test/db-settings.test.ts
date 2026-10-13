import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyRuleId } from "@forge/protocol";
import { Db, MIGRATIONS } from "../src/persistence/db.js";
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
