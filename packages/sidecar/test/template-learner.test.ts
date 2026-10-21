import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/persistence/db.js";
import { TemplateService } from "../src/templates/templates.js";
import { buildLearnPrompt, LEARN_AFTER_MESSAGES, LEARN_MIN_GAP_MS, LEARN_MIN_HISTORY, LEARN_SCHEMA, MAX_NEW_PER_RUN, TemplateLearner } from "../src/templates/learner.js";
import { setLanguage } from "../src/i18n/index.js";
import { AUTO_CONTINUE_PROMPT } from "../src/sessions/auto-continue.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let db: Db;
let templates: TemplateService;
let learner: TemplateLearner;
let prompts: string[];
let answer: unknown;
let learned: string[][];
let clock: number;

function addProject(id: string) {
  db.insertProject(
    { id, name: id, path: `C:\\${id}`, favorite: false, tags: [], technologies: [], profile: "balanced", defaultModel: null, defaultEffort: null, createdAt: "2026-10-01T00:00:00Z", lastOpenedAt: null, testCommand: null, devCommand: null, parentId: null, gitEnabled: true, agentsEnabled: true, group: null },
    `c:\\${id}`,
  );
  const now = new Date().toISOString();
  db.insertSession({ id: `s-${id}`, projectId: id, claudeSessionId: null, cwd: `C:\\${id}`, title: null, model: null, effort: null, profile: "balanced", permissionMode: "default", status: "idle", apiKeySource: null, createdAt: now, updatedAt: now, lastError: null });
}

function write(n: number, text = (i: number) => `Nachricht ${i}`, project = "shop") {
  for (let i = 0; i < n; i++) {
    db.appendEvent(`s-${project}`, { type: "user.message", text: text(i), uuid: `u-${project}-${i}-${Math.random()}` });
    learner.noteMessage();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  t = tempDir();
  mkdirSync(t.dir, { recursive: true });
  db = new Db(path.join(t.dir, "forge.db"));
  addProject("shop");
  templates = new TemplateService({ db, rootOf: (id) => id, emit: () => {} });
  prompts = [];
  learned = [];
  clock = Date.parse("2026-10-18T10:00:00Z");
  answer = { templates: [] };
  learner = new TemplateLearner({
    db,
    templates,
    projects: () => db.listProjects(),
    ask: async (prompt) => {
      prompts.push(prompt);
      return answer;
    },
    learned: (names) => learned.push(names),
    log: () => {},
    now: () => clock,
  });
});
afterEach(() => {
  learner.stop();
  db.close();
  t.cleanup();
});

const pushTemplate = { name: "Committen und pushen", text: "Committe alle offenen Änderungen und pushe sie.", project: null, count: 12 };

describe("template learning", () => {
  it("looks only in the app, once enough was written, and saves repeated requests as learned templates", async () => {
    answer = { templates: [pushTemplate, { name: "Im Browser prüfen", text: "Prüfe {seite} im Browser.", project: "shop", count: 4 }] };
    write(LEARN_MIN_HISTORY);
    await settle();
    expect(prompts).toEqual([]);

    learner.start();
    write(1);
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[shop] Nachricht 0");
    const list = templates.list(undefined, true);
    expect(list.map((x) => [x.name, x.projectId, x.learned])).toEqual([
      ["Committen und pushen", null, true],
      ["Im Browser prüfen", "shop", true],
    ]);
    expect(learned).toEqual([["Committen und pushen", "Im Browser prüfen"]]);
  });

  it("waits for new messages and hours before the next look", async () => {
    learner.start();
    write(LEARN_MIN_HISTORY);
    await settle();
    expect(prompts).toHaveLength(1);
    write(LEARN_AFTER_MESSAGES);
    await settle();
    expect(prompts).toHaveLength(1);
    clock += LEARN_MIN_GAP_MS;
    write(1);
    await settle();
    expect(prompts).toHaveLength(2);
  });

  it("leaves out automatic messages, too few repeats, duplicates and what the user deleted", async () => {
    write(LEARN_MIN_HISTORY);
    db.appendEvent("s-shop", { type: "user.message", text: AUTO_CONTINUE_PROMPT, uuid: "auto", source: "auto" });
    templates.save({ id: null, projectId: null, name: "Pushen", description: null, text: "Push bitte alles.", learned: false });
    answer = {
      templates: [
        pushTemplate,
        { name: "Einmal gefragt", text: "Etwas, das nur zweimal vorkam.", project: null, count: 2 },
        { name: "Pushen", text: "Pushe alles nach GitHub.", project: null, count: 5 },
      ],
    };
    const first = await learner.learn();
    expect(prompts[0]).not.toContain(AUTO_CONTINUE_PROMPT);
    expect(first.added.map((x) => x.name)).toEqual(["Committen und pushen"]);
    expect(learned).toEqual([]);

    templates.delete(first.added[0]!.id);
    const again = await learner.learn();
    expect(again.added).toEqual([]);
    expect(again.message).toBe("Keine neuen wiederkehrenden Aufträge gefunden.");
    expect(prompts[1]).toContain("Abgelehnte Vorlagen:\n- committe alle offenen");
  });

  it("adds at most a few per look and makes an edited one the user's", async () => {
    write(LEARN_MIN_HISTORY);
    answer = { templates: Array.from({ length: 5 }, (_, i) => ({ name: `Auftrag ${"abcde"[i]}`, text: `Mach Aufgabe ${"abcde"[i]} komplett fertig.`, project: null, count: 3 })) };
    const r = await learner.learn();
    expect(r.added).toHaveLength(MAX_NEW_PER_RUN);
    const edited = templates.save({ ...r.added[0]!, text: "Mach Aufgabe a fertig und teste sie." });
    expect(edited.learned).toBeUndefined();
    templates.delete(edited.id);
    expect(db.getTemplateLearning().dismissed).toEqual([]);
  });

  it("says when there is too little to learn from and does not count that as a look", async () => {
    write(3);
    expect((await learner.learn()).message).toMatch(/^Noch zu wenige Nachrichten/);
    expect(prompts).toEqual([]);
    expect(db.getTemplateLearning().lastRunAt).toBeNull();
  });
});

describe("template learning in English", () => {
  afterEach(() => setLanguage("de"));

  it("asks for templates in English and reports in English", async () => {
    setLanguage("en");
    const prompt = buildLearnPrompt([{ text: "push", project: "shop" }], [], []);
    expect(prompt).toMatch(/^Below are messages a user sent to Claude Code/);
    expect(prompt).toContain("Existing templates:\n(none)");
    expect(prompt).toContain("Messages:\n[shop] push");
    expect(JSON.stringify(LEARN_SCHEMA)).toContain("2 to 4 words to find it again");
    expect((await learner.learn()).message).toMatch(/^Not enough messages to learn from yet/);
  });
});
