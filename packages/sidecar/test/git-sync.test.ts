import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeError, type GitIntegrationConflict } from "@forge/protocol";
import { GitEngine } from "../src/git/git.js";
import { integrationPrompt } from "../src/git/integration-prompt.js";
import { createHandlers, type Services } from "../src/rpc/handlers.js";
import { git, initRepo, tempDir } from "./helpers.js";

const engine = new GitEngine();
let t: ReturnType<typeof tempDir>;
let mine: string;
let theirs: string;

async function commitFile(repo: string, file: string, content: string, message: string) {
  writeFileSync(path.join(repo, file), content);
  await git(repo, "add", file);
  await git(repo, "commit", "-q", "-m", message);
}

async function conflictOf(p: Promise<unknown>): Promise<GitIntegrationConflict> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ForgeError);
  expect((e as ForgeError).code).toBe("GIT_CONFLICT");
  return ((e as ForgeError).details as { integration: GitIntegrationConflict }).integration;
}

beforeEach(async () => {
  t = tempDir();
  const remote = path.join(t.dir, "remote.git");
  mine = path.join(t.dir, "mine");
  theirs = path.join(t.dir, "theirs");
  mkdirSync(remote, { recursive: true });
  await git(remote, "init", "-q", "--bare", "-b", "main");
  mkdirSync(mine);
  await initRepo(mine);
  await commitFile(mine, "a.txt", "eins\nzwei\ndrei\n", "init");
  await git(mine, "remote", "add", "origin", remote);
  await git(mine, "push", "-q", "-u", "origin", "main");
  await git(t.dir, "clone", "-q", remote, theirs);
  await git(theirs, "config", "user.email", "other@forge.local");
  await git(theirs, "config", "user.name", "Other");
}, 30_000);
afterEach(() => t.cleanup());

// Real git with a bare remote: dozens of git processes per test, slow on Windows under parallel load.
const SLOW = { timeout: 30_000 };

describe("push takes over new commits from origin first", SLOW, () => {
  it("rebases local commits on top of new remote commits, keeps uncommitted work, then pushes", async () => {
    await commitFile(theirs, "b.txt", "von dort\n", "remote: b");
    await git(theirs, "push", "-q");
    await commitFile(mine, "c.txt", "von hier\n", "local: c");
    writeFileSync(path.join(mine, "a.txt"), "eins\nzwei\ndrei\nvier\n");

    const r = await engine.push(mine, true);
    expect(r.integrated).toEqual({ mode: "rebase", remoteCommits: 1, localCommits: 1 });
    expect(await git(mine, "log", "--format=%s", "origin/main")).toMatch(/^local: c\r?\nremote: b\r?\ninit/);
    expect(readFileSync(path.join(mine, "a.txt"), "utf8")).toContain("vier");
  });

  it("fast-forwards when there are no local commits", async () => {
    await commitFile(theirs, "b.txt", "von dort\n", "remote: b");
    await git(theirs, "push", "-q");
    const r = await engine.pull(mine);
    expect(r.integrated).toEqual({ mode: "fast-forward", remoteCommits: 1, localCommits: 0 });
    expect(readFileSync(path.join(mine, "b.txt"), "utf8")).toMatch(/^von dort\r?\n$/);
  });

  it("aborts a conflicting rebase, leaves the repository as it was and names the files", async () => {
    await commitFile(theirs, "a.txt", "eins\nZWEI dort\ndrei\n", "remote: a");
    await git(theirs, "push", "-q");
    await commitFile(mine, "a.txt", "eins\nZWEI hier\ndrei\n", "local: a");
    const head = (await git(mine, "rev-parse", "HEAD")).trim();

    const c = await conflictOf(engine.push(mine, true));
    expect(c).toMatchObject({ branch: "main", remoteCommits: 1, localCommits: 1, files: ["a.txt"] });
    expect((await git(mine, "rev-parse", "HEAD")).trim()).toBe(head);
    expect((await engine.status(mine)).files).toEqual([]);
    expect(await git(mine, "status")).not.toMatch(/rebase in progress/i);
  });

  it("checks the protected branch before touching anything", async () => {
    await commitFile(theirs, "b.txt", "von dort\n", "remote: b");
    await git(theirs, "push", "-q");
    await commitFile(mine, "c.txt", "von hier\n", "local: c");
    const head = (await git(mine, "rev-parse", "HEAD")).trim();
    await expect(engine.push(mine, false)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect((await git(mine, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it("pushes a new branch that origin does not have yet", async () => {
    await git(mine, "checkout", "-q", "-b", "feature/x");
    await commitFile(mine, "c.txt", "neu\n", "feature");
    const r = await engine.push(mine, false);
    expect(r).toMatchObject({ branch: "feature/x", integrated: null });
    expect(await git(theirs, "ls-remote", "origin", "feature/x")).toMatch(/refs\/heads\/feature\/x/);
  });
});

describe("git.push and git.pull handlers", SLOW, () => {
  function handlers() {
    const started: Array<{ projectId: string; prompt: string }> = [];
    const h = createHandlers({
      git: engine,
      projects: { requireExisting: () => ({ path: mine }), requireGit: () => ({ path: mine }) },
      sessions: {
        start: async (p: { projectId: string; prompt: string }) => {
          started.push(p);
          return { id: "s1" };
        },
      },
      notifyProject: () => {},
    } as unknown as Services);
    return { h, started };
  }

  it("start a Claude session when origin's commits conflict, and report what was taken over otherwise", async () => {
    await commitFile(theirs, "a.txt", "eins\nZWEI dort\ndrei\n", "remote: a");
    await git(theirs, "push", "-q");
    await commitFile(mine, "a.txt", "eins\nZWEI hier\ndrei\n", "local: a");
    const { h, started } = handlers();

    const r = await h["git.push"]({ projectId: "p1", allowProtected: true });
    expect(r).toMatchObject({ branch: null, session: { id: "s1" } });
    expect(started).toHaveLength(1);
    expect(started[0]!.prompt).toContain("git push origin main");

    const pulled = await h["git.pull"]({ projectId: "p1" });
    expect(pulled.session).toMatchObject({ id: "s1" });
    expect(started[1]!.prompt).toContain("Nicht pushen.");
  });

  it("passes other errors through without a session", async () => {
    const { h, started } = handlers();
    await expect(h["git.push"]({ projectId: "p1", allowProtected: false })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(started).toHaveLength(0);
  });
});

describe("integrationPrompt", () => {
  it("asks Claude to rebase, ask when unsure and push without force", () => {
    const p = integrationPrompt({ branch: "main", remoteCommits: 2, localCommits: 1, files: ["a.txt"] }, true);
    expect(p).toContain("- a.txt");
    expect(p).toContain("git rebase --autostash --rebase-merges origin/main");
    expect(p).toContain("AskUserQuestion");
    expect(p).toContain("git push origin main");
    expect(p).toContain("Kein Force-Push");
    expect(integrationPrompt({ branch: "main", remoteCommits: 2, localCommits: 1, files: [] }, false)).toContain("Nicht pushen.");
  });
});
