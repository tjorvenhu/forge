import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolicyRuleId } from "@forge/protocol";
import { Db } from "../src/persistence/db.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let file: string;

beforeEach(() => {
  t = tempDir();
  mkdirSync(t.dir, { recursive: true });
  file = path.join(t.dir, "forge.db");
});
afterEach(() => t.cleanup());

/** Stores the list, then reopens the database one schema version back, as an install before the update. */
function reopenFromBeforeUpdate(stored: PolicyRuleId[]) {
  const db = new Db(file);
  db.updateSettings({ disabledPolicyRules: stored });
  const version = (db.sql.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  db.sql.exec(`PRAGMA user_version = ${version - 1}`);
  db.close();
  return new Db(file);
}

describe("push to main/master", () => {
  it("is allowed by default on a new install", () => {
    const db = new Db(file);
    expect(db.getSettings().disabledPolicyRules).toEqual(["git-push-protected"]);
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
