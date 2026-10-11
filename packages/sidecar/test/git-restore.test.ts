import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitEngine } from "../src/git/git.js";
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
  // A global core.autocrlf=true would turn the restored LF files into CRLF and make the comparison machine-dependent.
  await git(repo, "config", "core.autocrlf", "false");
});

afterEach(() => t.cleanup());

// Each case runs a dozen real git processes; on Windows under a full test run that exceeds the 5 s default.
describe("restoreTo", { timeout: 30_000 }, () => {
  it("brings files back to an older commit as uncommitted changes and keeps the history", async () => {
    writeFileSync(path.join(repo, "a.txt"), "alt\n");
    const first = await commitAll("erster Stand");
    writeFileSync(path.join(repo, "a.txt"), "neu\n");
    writeFileSync(path.join(repo, "b.txt"), "später dazugekommen\n");
    await commitAll("zweiter Stand");

    const r = await engine.restoreTo(repo, first.slice(0, 7));
    expect(r).toMatchObject({ commit: first, subject: "erster Stand", stashed: false, changed: 2 });
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("alt\n");
    expect(existsSync(path.join(repo, "b.txt"))).toBe(false);
    expect((await git(repo, "log", "--format=%s")).trim().split("\n")).toEqual(["zweiter Stand", "erster Stand"]);
  });

  it("stashes uncommitted work first, including new files", async () => {
    writeFileSync(path.join(repo, "a.txt"), "1\n");
    const first = await commitAll("init");
    writeFileSync(path.join(repo, "a.txt"), "halb fertig\n");
    writeFileSync(path.join(repo, "neu.txt"), "ungetrackt\n");

    const r = await engine.restoreTo(repo, first);
    expect(r.stashed).toBe(true);
    expect(r.changed).toBe(0);
    expect(existsSync(path.join(repo, "neu.txt"))).toBe(false);
    expect(await git(repo, "stash", "list")).toContain("FORGE: vor Wiederherstellung");
    await git(repo, "stash", "pop");
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("halb fertig\n");
    expect(readFileSync(path.join(repo, "neu.txt"), "utf8")).toBe("ungetrackt\n");
  });

  it("only touches the project folder when the project is a subfolder of the repo", async () => {
    mkdirSync(path.join(repo, "web"));
    writeFileSync(path.join(repo, "web", "page.txt"), "v1\n");
    writeFileSync(path.join(repo, "root.txt"), "r1\n");
    const first = await commitAll("v1");
    writeFileSync(path.join(repo, "web", "page.txt"), "v2\n");
    writeFileSync(path.join(repo, "root.txt"), "r2\n");
    await commitAll("v2");

    await engine.restoreTo(path.join(repo, "web"), first);
    expect(readFileSync(path.join(repo, "web", "page.txt"), "utf8")).toBe("v1\n");
    expect(readFileSync(path.join(repo, "root.txt"), "utf8")).toBe("r2\n");
  });

  it("rejects unknown commits and anything that is not a commit id", async () => {
    writeFileSync(path.join(repo, "a.txt"), "1\n");
    await commitAll("init");
    await expect(engine.restoreTo(repo, "deadbeef")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(engine.restoreTo(repo, "--force")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
