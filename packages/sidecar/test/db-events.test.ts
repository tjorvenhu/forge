import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db, EVENT_PAGE_LIMIT } from "../src/persistence/db.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let db: Db;
const sid = "s1";

beforeEach(() => {
  t = tempDir();
  mkdirSync(t.dir, { recursive: true });
  db = new Db(path.join(t.dir, "forge.db"));
  const now = new Date().toISOString();
  db.insertProject(
    { id: "p1", name: "p", path: t.dir, favorite: false, tags: [], technologies: [], profile: "balanced", defaultModel: null, defaultEffort: null, createdAt: now, lastOpenedAt: null, testCommand: null, devCommand: null, parentId: null, gitEnabled: true },
    t.dir.toLowerCase(),
  );
  db.insertSession({ id: sid, projectId: "p1", claudeSessionId: null, cwd: t.dir, title: null, model: null, effort: null, profile: "balanced", permissionMode: "default", status: "idle", apiKeySource: null, createdAt: now, updatedAt: now, lastError: null });
});
afterEach(() => {
  db.close();
  t.cleanup();
});

describe("listEvents", () => {
  it("returns the newest events of a long session in ascending order and pages older ones", () => {
    const total = EVENT_PAGE_LIMIT + 5;
    db.sql.exec("BEGIN");
    for (let i = 1; i <= total; i++) {
      db.appendEvent(sid, i % 1000 === 0 ? { type: "user.message", text: `m${i}`, uuid: `u${i}` } : { type: "error", message: `e${i}`, retryable: false });
    }
    db.sql.exec("COMMIT");
    const page = db.listEvents(sid);
    expect(page).toHaveLength(EVENT_PAGE_LIMIT);
    expect(page[0]!.seq).toBe(6);
    expect(page.at(-1)!.seq).toBe(total);
    expect(db.listEvents(sid, 0, { beforeSeq: 6 }).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(db.listEvents(sid, EVENT_PAGE_LIMIT).map((e) => e.seq)).toEqual([20_001, 20_002, 20_003, 20_004, 20_005]);
    // the echo filter needs every user message id, not just the newest page
    expect(db.listUserMessageUuids(sid)).toHaveLength(20);
  });
});
