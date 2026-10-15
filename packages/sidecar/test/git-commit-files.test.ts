import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
import { parseCommitFiles } from "../src/git/parsers.js";
import { git, initRepo, tempDir } from "./helpers.js";

let t: { dir: string; cleanup: () => void };
let repo: string;
const engine = new GitEngine();

async function commitAll(message: string): Promise<string> {
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", message);
  return (await git(repo, "rev-parse", "HEAD")).trim();
}

beforeEach(async () => {
  t = tempDir();
  repo = path.join(t.dir, "repo");
  mkdirSync(repo, { recursive: true });
  await initRepo(repo);
  await git(repo, "config", "core.autocrlf", "false");
});

afterEach(() => t.cleanup());

describe("parseCommitFiles", () => {
  it("joins name-status and numstat, renames included", () => {
    const status = ["M", "src/a.ts", "R087", "old.ts", "new.ts", "A", "logo.png", "D", "weg.txt", ""].join("\0");
    const numstat = ["3\t1\tsrc/a.ts", "2\t2\t", "old.ts", "new.ts", "-\t-\tlogo.png", "0\t4\tweg.txt", ""].join("\0");
    expect(parseCommitFiles(status, numstat)).toEqual([
      { path: "src/a.ts", origPath: null, kind: "modified", additions: 3, deletions: 1, binary: false },
      { path: "new.ts", origPath: "old.ts", kind: "renamed", additions: 2, deletions: 2, binary: false },
      { path: "logo.png", origPath: null, kind: "added", additions: 0, deletions: 0, binary: true },
      { path: "weg.txt", origPath: null, kind: "deleted", additions: 0, deletions: 4, binary: false },
    ]);
  });
});

describe("commitFiles and commitDiff", { timeout: 30_000 }, () => {
  it("lists the files of a commit against its parent, with the message body", async () => {
    writeFileSync(path.join(repo, "a.txt"), "eins\nzwei\n");
    writeFileSync(path.join(repo, "b.txt"), "bleibt\n");
    await commitAll("erster Stand");
    writeFileSync(path.join(repo, "a.txt"), "eins\ndrei\nvier\n");
    rmSync(path.join(repo, "b.txt"));
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "zweiter Stand", "-m", "Mit Beschreibung.");
    const head = (await git(repo, "rev-parse", "HEAD")).trim();

    const d = await engine.commitFiles(repo, head.slice(0, 7));
    expect(d.hash).toBe(head);
    expect(d.body).toBe("Mit Beschreibung.");
    expect(d.truncated).toBe(false);
    expect(d.files).toEqual([
      { path: "a.txt", origPath: null, kind: "modified", additions: 2, deletions: 1, binary: false },
      { path: "b.txt", origPath: null, kind: "deleted", additions: 0, deletions: 1, binary: false },
    ]);

    const diff = await engine.commitDiff(repo, head, "a.txt");
    expect(diff.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["drei", "vier"]);
    expect(diff.lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["zwei"]);
  });

  it("shows a root commit as all added", async () => {
    writeFileSync(path.join(repo, "a.txt"), "hallo\n");
    const root = await commitAll("init");
    const d = await engine.commitFiles(repo, root);
    expect(d.files).toEqual([{ path: "a.txt", origPath: null, kind: "added", additions: 1, deletions: 0, binary: false }]);
    expect((await engine.commitDiff(repo, root, "a.txt")).additions).toBe(1);
  });

  it("only lists files of the project folder, relative to it", async () => {
    mkdirSync(path.join(repo, "app"), { recursive: true });
    writeFileSync(path.join(repo, "app", "x.txt"), "1\n");
    writeFileSync(path.join(repo, "aussen.txt"), "1\n");
    await commitAll("init");
    writeFileSync(path.join(repo, "app", "x.txt"), "2\n");
    writeFileSync(path.join(repo, "aussen.txt"), "2\n");
    const head = await commitAll("beides");
    const d = await engine.commitFiles(path.join(repo, "app"), head);
    expect(d.files.map((f) => f.path)).toEqual(["x.txt"]);
  });

  it("refuses unknown commits and paths outside the project", async () => {
    writeFileSync(path.join(repo, "a.txt"), "1\n");
    const head = await commitAll("init");
    await expect(engine.commitFiles(repo, "deadbeef")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(engine.commitDiff(repo, head, "../x.txt")).rejects.toMatchObject({ code: "PATH_INVALID" });
  });
});
