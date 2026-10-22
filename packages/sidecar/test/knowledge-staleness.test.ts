import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/persistence/db.js";
import { GitEngine } from "../src/git/git.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { KNOWLEDGE_DIR, KnowledgeStore, parseVerified } from "../src/knowledge/knowledge.js";
import { extractRefs, hunksWith, looksLikeCode, RefChecker } from "../src/knowledge/staleness.js";
import { projectTools } from "../src/sessions/forge-tools.js";
import type { DevEnvironment } from "../src/devtools/environment.js";
import { git, initRepo, tempDir } from "./helpers.js";

const refs = (text: string) => extractRefs(text).map((r) => `${r.kind}:${r.ref}`);

describe("extractRefs", () => {
  it("finds paths, file names and code names", () => {
    const text = [
      "UI in `apps/desktop/src/components/knowledge/KnowledgeTab.tsx:42`, Tests in packages/sidecar/test/knowledge.test.ts.",
      "Komponente `KnowledgeTab.tsx`, Hook `useKnowledge`, Konstante `INDEX_MAX_CHARS`, Werkzeug `knowledge_read`.",
      "Aufruf `ClaudeAssist.mergeKnowledge`, `openExtensions(tab, skillsTab)`, `mcp__forge__knowledge_save`, Ordner `src-tauri/src/`.",
    ].join("\n");
    expect(refs(text)).toEqual([
      "path:apps/desktop/src/components/knowledge/KnowledgeTab.tsx",
      "path:KnowledgeTab.tsx",
      "name:useKnowledge",
      "name:INDEX_MAX_CHARS",
      "name:knowledge_read",
      "name:ClaudeAssist.mergeKnowledge",
      "name:openExtensions",
      "name:knowledge_save",
      "path:src-tauri/src/",
      "path:packages/sidecar/test/knowledge.test.ts",
    ]);
    expect(extractRefs("`ClaudeAssist.mergeKnowledge`")[0]!.lookup).toEqual(["ClaudeAssist.mergeKnowledge", "ClaudeAssist", "mergeKnowledge"]);
    expect(extractRefs("`runtime.completeJson`")[0]!.lookup).toEqual(["runtime.completeJson", "completeJson"]);
  });

  it("leaves commands, options, values and plain words alone", () => {
    const text = [
      "`-D`, `--force`, `pnpm dev`, `retry: false`, `true`, `main`, `Strg+K`, `text-ui`, `role=\"status\"`, `git grep -F -w`.",
      "`https://github.com/x/y.ts`, `github.com/vanturis/repo`, `~/.claude/settings.json`, `C:\\Users\\x\\a.ts`, `/c/Users/x`.",
      "`node_modules/react/index.js`, `dist/main.js`, `Next.js`, `@tanstack/react-query`, `*.md`, `<id>.md`, `src/a.ts`, `foo.ts`.",
      "`GitHub`, `URLs`, `IDs`, `macOS`, `NODE_OPTIONS`, `ANTHROPIC_API_KEY`, `1.5/2.0`, `v1.2.3`, `Button`, `Enter`, `.env`, `setup.exe`, `forge.db`.",
      "Siehe https://example.com/docs/page.html und www.example.org/a/b.ts.",
      "```bash",
      "pnpm exec vitest run test/removed.test.ts",
      "const x = removedFunction();",
      "```",
    ].join("\n");
    expect(refs(text)).toEqual([]);
  });

  it("tells code names from words", () => {
    for (const w of ["useKnowledge", "KnowledgeTab", "INDEX_MAX_CHARS", "knowledge_read", "HTMLElement", "useUi"]) expect(looksLikeCode(w), w).toBe(true);
    for (const w of ["pnpm", "false", "Button", "URLs", "GitHub", "NODE_ENV", "TypeScript", "main", "PRs"]) expect(looksLikeCode(w), w).toBe(false);
  });

  it("cuts the hunks of a patch that mention a name", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-export function oldName() {}",
      "+export function newName() {}",
      "@@ -10 +10 @@",
      "-const other = 1;",
      "+const other = 2;",
    ].join("\n");
    expect(hunksWith(patch, "oldName", 1000)).toBe("--- src/a.ts\n@@ -1,2 +1,2 @@\n-export function oldName() {}\n+export function newName() {}");
  });
});

// Many real git calls: on Windows these run past the 5 s default when all packages test at once.
describe("RefChecker", { timeout: 30_000 }, () => {
  let t: ReturnType<typeof tempDir>;
  let root: string;
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  const entry = (content: string, verified: string[] = []) => [{ id: "e", content, verified }];

  beforeEach(async () => {
    t = tempDir();
    root = t.dir;
    mkdirSync(root, { recursive: true });
    await initRepo(root);
    write("apps/desktop/src-tauri/src/lib.rs", "fn show_in_explorer() {}\n");
    write("apps/desktop/src/lib/utils.ts", "export function cn() {}\nexport const useUi = () => ({ openFile() {} });\n");
    write("packages/sidecar/src/assist.ts", "export class ClaudeAssist { mergeKnowledge() {} planMerge() {} }\nexport const INDEX_MAX_CHARS = 8000;\n");
    write("packages/sidecar/src/old-helper.ts", "export function legacyHelper() {}\n");
    write("README.md", "Mentions `docOnlyName` and legacyHelper.\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "Start");
  });

  afterEach(() => t.cleanup());

  it("reports removed files and names with a hint and stays quiet about the rest", async () => {
    const checker = new RefChecker(new GitEngine());
    const text = [
      "`packages/sidecar/src/assist.ts`, `src-tauri/src/lib.rs`, `@/lib/utils`, `apps/desktop/src/lib/utils.js`, `ClaudeAssist.mergeKnowledge`, `INDEX_MAX_CHARS`.",
      "`packages/sidecar/src/old-helper.ts`, `old-helper.ts`, `legacyHelper`, `useUi.openFile`.",
      "Nie im Projekt: `extendTailwindMerge`, `other-repo/src/thing.ts`, `origin/main`, `text/plain`, `RegisterHotKey`, `apps/desktop/.preview/index.html`, `docOnlyName`.",
    ].join("\n");
    const first = await checker.check(root, true, entry(text));
    expect(first.git).toBe(true);
    expect(first.results.get("e")!.missing).toEqual([]);

    // The helper moves to another folder, legacyHelper goes away (README still mentions it: docs do not count).
    mkdirSync(path.join(root, "packages/sidecar/src/util"), { recursive: true });
    renameSync(path.join(root, "packages/sidecar/src/old-helper.ts"), path.join(root, "packages/sidecar/src/util/old-helper.ts"));
    writeFileSync(path.join(root, "packages/sidecar/src/util/old-helper.ts"), "export function newHelper() {}\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "Helfer umgebaut");

    const after = await checker.check(root, true, entry(text));
    const missing = after.results.get("e")!.missing;
    expect(missing.map((m) => m.ref)).toEqual(["packages/sidecar/src/old-helper.ts", "legacyHelper"]);
    expect(missing[0]!.hint).toBe("gleicher Name: packages/sidecar/src/util/old-helper.ts");
    expect(missing[1]!.hint).toMatch(/^zuletzt geändert in [0-9a-f]+: Helfer umgebaut$/);

    // Claude gets the diff of the commit that removed the name.
    const details = await checker.details(root, true, missing);
    expect(details).toContain("`legacyHelper`");
    expect(details).toContain("-export function legacyHelper() {}");
    expect(details).toMatch(/Dateien in [0-9a-f]+: .*packages.sidecar.src.util.old-helper.ts/);

    // Refs marked as fine are left out.
    expect((await checker.check(root, true, entry(text, ["legacyHelper"]))).results.get("e")!.missing.map((m) => m.ref)).toEqual(["packages/sidecar/src/old-helper.ts"]);
  });

  it("reports bare file names only once the project had them", async () => {
    const checker = new RefChecker(new GitEngine());
    const text = "`old-helper.ts` und `vite.config.ts`";
    expect((await checker.check(root, true, entry(text))).results.get("e")!.missing).toEqual([]);
    rmSync(path.join(root, "packages/sidecar/src/old-helper.ts"));
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "Helfer weg");
    expect((await checker.check(root, true, entry(text))).results.get("e")!.missing.map((m) => m.ref)).toEqual(["old-helper.ts"]);
  });

  it("caches per entry text and project state", async () => {
    const checker = new RefChecker(new GitEngine());
    const text = "`legacyHelper`";
    const a = (await checker.check(root, true, entry(text))).results.get("e");
    expect((await checker.check(root, true, entry(text))).results.get("e")).toBe(a);
    // An uncommitted change counts as well.
    writeFileSync(path.join(root, "packages/sidecar/src/old-helper.ts"), "export function renamedHelper() {}\n");
    const b = (await checker.check(root, true, entry(text))).results.get("e");
    expect(a!.missing).toEqual([]);
    expect(b).not.toBe(a);
    expect(b!.missing.map((m) => m.ref)).toEqual(["legacyHelper"]);
    await git(root, "commit", "-am", "umbenannt");
    expect((await checker.check(root, true, entry(text))).results.get("e")!.missing[0]!.hint).toMatch(/umbenannt$/);
  });

  it("without git counts names only after an earlier check saw them, and keeps that across restarts", async () => {
    const state = path.join(t.dir, "..", "refs.json");
    const text = "`legacyHelper`, `RegisterHotKey`, `packages/sidecar/src/gone.ts`";
    const first = await new RefChecker(new GitEngine(), state).check(root, false, entry(text));
    expect(first.git).toBe(false);
    expect(first.results.get("e")!.missing.map((m) => m.ref)).toEqual(["packages/sidecar/src/gone.ts"]);
    writeFileSync(path.join(root, "packages/sidecar/src/old-helper.ts"), "export function other() {}\n");
    const later = await new RefChecker(new GitEngine(), state).check(root, false, entry(text), true);
    expect(later.results.get("e")!.missing).toEqual([
      { ref: "legacyHelper", kind: "name", hint: "war bei einer früheren Prüfung noch im Projekt" },
      { ref: "packages/sidecar/src/gone.ts", kind: "path" },
    ]);
  });
});

describe("KnowledgeStore staleness", { timeout: 30_000 }, () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let store: KnowledgeStore;
  let projectId: string;
  let root: string;

  beforeEach(async () => {
    t = tempDir();
    root = path.join(t.dir, "web");
    mkdirSync(path.join(root, "src"), { recursive: true });
    await initRepo(root);
    writeFileSync(path.join(root, "src", "app.ts"), "export function startApp() {}\nexport function stopApp() {}\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "Start");
    writeFileSync(path.join(root, "src", "app.ts"), "export function startApp() {}\n");
    await git(root, "commit", "-am", "stopApp entfernt");
    db = new Db(path.join(t.dir, "forge.db"));
    const projects = new ProjectManager(db, new GitEngine(), () => "balanced");
    projectId = (await projects.import(root)).id;
    store = new KnowledgeStore(projects, () => {});
  });

  afterEach(() => {
    db.close();
    t.cleanup();
  });

  it("marks false alarms in the entry without touching its date, and drops marks the text no longer needs", async () => {
    const e = await store.save(projectId, { id: null, title: "App starten", summary: "Wie die App startet", tags: ["app"], content: "# App\n\n`startApp` in `src/app.ts`, beenden mit `stopApp`." });
    const report = await store.staleness(projectId);
    expect(report.entries).toEqual([{ id: e.id, missing: [{ ref: "stopApp", kind: "name", hint: expect.stringMatching(/stopApp entfernt$/) }], checked: 3 }]);

    expect(await store.markChecked(projectId, e.id)).toEqual({ verified: ["stopApp"] });
    const file = path.join(root, KNOWLEDGE_DIR, `${e.id}.md`);
    expect(parseVerified(readFileSync(file, "utf8"))).toEqual(["stopApp"]);
    expect((await store.read(projectId, e.id)).updatedAt).toBe(e.updatedAt);
    expect((await store.staleness(projectId, { ids: [e.id] })).entries[0]!.missing).toEqual([]);

    // Saving keeps the mark while the text still has the ref, and drops it once the ref is gone.
    await store.save(projectId, { id: e.id, title: e.title, summary: e.summary, tags: e.tags, content: `${e.content}\nNoch ein Satz.` });
    expect(parseVerified(readFileSync(file, "utf8"))).toEqual(["stopApp"]);
    await store.save(projectId, { id: e.id, title: e.title, summary: e.summary, tags: e.tags, content: "# App\n\n`startApp` in `src/app.ts`." });
    expect(parseVerified(readFileSync(file, "utf8"))).toEqual([]);
    await expect(store.fixContext(projectId, e.id)).rejects.toThrow(/nichts zu korrigieren/);
  });

  it("tells Claude in knowledge_read and knowledge_search which refs no longer exist", async () => {
    const e = await store.save(projectId, { id: null, title: "App beenden", summary: "Wie die App endet", tags: ["app"], content: "# App\n\nBeenden mit `stopApp`." });
    const fakeDev = { config: () => ({}) } as unknown as DevEnvironment;
    const rec = { id: "s1", projectId } as Parameters<typeof projectTools>[0];
    const { tools } = projectTools(rec, { knowledge: store, dev: fakeDev });
    const read = await tools.find((x) => x.name === "knowledge_read")!.run({ id: e.id });
    expect(read).toContain("Veraltet: Diese Verweise gibt es im Projekt nicht mehr: `stopApp`.");
    const search = await tools.find((x) => x.name === "knowledge_search")!.run({ query: "beenden" });
    expect(search).toContain("Veraltet, gibt es nicht mehr: `stopApp`");

    const ctx = await store.fixContext(projectId, e.id);
    expect(ctx.missing.map((m) => m.ref)).toEqual(["stopApp"]);
    expect(ctx.details).toContain("-export function stopApp() {}");
  });

  it("lets Claude list outdated entries and mark false alarms with knowledge_check and knowledge_mark_checked", async () => {
    const e = await store.save(projectId, { id: null, title: "App beenden", summary: "Wie die App endet", tags: ["app"], content: "# App\n\nBeenden mit `stopApp`." });
    await store.save(projectId, { id: null, title: "App starten", summary: "Wie die App startet", tags: ["app"], content: "# App\n\n`startApp` in `src/app.ts`." });
    const rec = { id: "s1", projectId } as Parameters<typeof projectTools>[0];
    const { tools } = projectTools(rec, { knowledge: store, dev: { config: () => ({}) } as unknown as DevEnvironment });
    const tool = (name: string) => tools.find((x) => x.name === name)!;

    const found = await tool("knowledge_check").run({});
    expect(found).toMatch(new RegExp(`^Veraltete Verweise in 1 von 2 Einträgen:\\n- ${e.id}: \`stopApp\` \\(.*stopApp entfernt\\)\\n`));
    expect(found).toContain("knowledge_mark_checked");

    expect(await tool("knowledge_mark_checked").run({ id: e.id })).toBe(`Als geprüft markiert: ${e.id} (\`stopApp\`).`);
    expect(await tool("knowledge_mark_checked").run({ id: e.id })).toBe(`Nichts zu markieren: ${e.id} hat keine fehlenden Verweise.`);
    expect(await tool("knowledge_check").run({ refresh: true })).toBe("Keine veralteten Verweise (2 Einträge geprüft).");
    expect(await tool("knowledge_check").run({ ids: [e.id] })).toBe("Keine veralteten Verweise (1 Eintrag geprüft).");
  });
});
