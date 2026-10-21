import { randomUUID } from "node:crypto";
import { copyFile, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ForgeError,
  type BranchInfo,
  type CommitDetails,
  type CommitInfo,
  type FileDiff,
  type GitIntegrated,
  type GitIntegrationConflict,
  type GitStatus,
  type GitSummary,
} from "@forge/protocol";
import { isInside } from "../util/paths.js";
import { run, type RunResult } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";
import { LOG_FORMAT, parseBranches, parseCommitFiles, parseLog, parseStatusV2, parseUnifiedDiff, scopeToPrefix, summarize, untrackedDiff } from "./parsers.js";
import { tr } from "../i18n/index.js";

const SENSITIVE_FILE =
  /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.p12|.*\.pfx|.*\.keystore|credentials(\..*)?\.json|secrets?\.(json|ya?ml|toml)|\.npmrc|\.pypirc|\.netrc)$/i;

const PROTECTED = new Set(["main", "master"]);
const REMOTE_PREFIX = "refs/remotes/origin/";

/** files listed for one commit; a commit of a whole node_modules folder would flood the list */
const MAX_COMMIT_FILES = 2000;

const ARTIFACT_PATH = /(^|\/)(node_modules|dist|build|target|\.next|out|coverage|__pycache__)\//;

export function isSensitiveFile(p: string): boolean {
  return SENSITIVE_FILE.test(p.replace(/\\/g, "/")) && !/\.example$|\.sample$|\.template$/i.test(p);
}

export function isArtifactPath(p: string): boolean {
  return ARTIFACT_PATH.test(p.replace(/\\/g, "/"));
}

/** Missing git, with how to install it where FORGE does not ship it. */
export function gitMissing(platform: NodeJS.Platform = process.platform): string {
  const m = tr().system.git;
  return platform === "darwin" ? m.notInstalledMac : platform === "linux" ? m.notInstalledLinux : m.notInstalled;
}

export class GitEngine {
  /** shipped git when available, else the one on PATH; null when macOS or Linux have none */
  private get gitBin(): string | null {
    return resolveTool("git")?.path ?? (process.platform === "win32" ? "git" : null);
  }

  private env(): NodeJS.ProcessEnv {
    // Literal pathspecs: file names like app/[id]/page.tsx or .e[n]v must not act as globs that
    // pull other files (e.g. .env) into a commit.
    return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" };
  }

  async exec(cwd: string, args: string[], input?: string, timeoutMs = 60_000, env?: Record<string, string>): Promise<RunResult> {
    // core.longpaths: Git for Windows otherwise fails on paths over 260 characters (deep node_modules).
    const bin = this.gitBin;
    if (!bin) throw new ForgeError("GIT_NOT_INSTALLED", gitMissing());
    const r = await run(bin, ["-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "core.longpaths=true", ...args], {
      cwd,
      env: env ? { ...this.env(), ...env } : this.env(),
      input,
      timeoutMs,
    });
    if (r.spawnError) {
      if (r.spawnError.code === "ENOENT") throw new ForgeError("GIT_NOT_INSTALLED", gitMissing());
      throw new ForgeError("GIT_FAILED", r.spawnError.message);
    }
    return r;
  }

  private async ok(cwd: string, args: string[], input?: string, timeoutMs?: number): Promise<string> {
    const r = await this.exec(cwd, args, input, timeoutMs);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim() || tr().system.git.commandFailed(args[0], r.code);
      if (/not a git repository/i.test(msg)) throw new ForgeError("GIT_NOT_REPO", "Kein Git-Repository.");
      if (/conflict/i.test(msg)) throw new ForgeError("GIT_CONFLICT", msg);
      throw new ForgeError("GIT_FAILED", msg);
    }
    return r.stdout;
  }

  async version(): Promise<string | null> {
    try {
      const r = await this.exec(process.cwd(), ["--version"]);
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async isRepo(cwd: string): Promise<boolean> {
    const r = await this.exec(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async remoteUrl(cwd: string): Promise<string | null> {
    const r = await this.exec(cwd, ["remote", "get-url", "origin"]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /**
   * Status of the project folder. The folder may be a subfolder of a larger repository (monorepo):
   * only files below it are listed, with paths relative to it, so that every follow-up command
   * run with the same cwd (diff, add, commit) resolves them the same way.
   */
  async status(cwd: string): Promise<GitStatus> {
    const info = await this.exec(cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
    const [inside, prefix = ""] = info.stdout.split("\n").map((l) => l.replace(/\r$/, ""));
    if (info.code !== 0 || inside !== "true") throw new ForgeError("GIT_NOT_REPO", "Kein Git-Repository.");
    const out = await this.ok(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."]);
    const parsed = scopeToPrefix(parseStatusV2(out), prefix, true);
    return { summary: summarize(parsed, await this.remoteUrl(cwd)), files: parsed.files };
  }

  /**
   * Tree id of the project folder as it is on disk (tracked and untracked files, .gitignore applies),
   * written through a copy of the index: the real index and Claude's own git commands stay untouched.
   * Two of these tell which files changed in between, also when the changes were committed meanwhile.
   */
  async worktreeTree(cwd: string): Promise<string> {
    const index = path.resolve(cwd, (await this.ok(cwd, ["rev-parse", "--git-path", "index"])).trim());
    const tmp = path.join(os.tmpdir(), `forge-index-${randomUUID()}`);
    try {
      // The copy keeps the stat data, so only files touched since the last git command are hashed again.
      await copyFile(index, tmp).catch(() => {});
      const env = { GIT_INDEX_FILE: tmp };
      // --ignore-errors: a file locked by a running program must not cost the whole snapshot.
      await this.exec(cwd, ["add", "-A", "--ignore-errors", "--", "."], undefined, 60_000, env);
      const tree = (await this.exec(cwd, ["write-tree"], undefined, 60_000, env)).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new ForgeError("GIT_FAILED", tr().system.git.treeUnreadable);
      return tree;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Files of the project folder that differ between two trees of worktreeTree, relative to it. */
  async treeChanges(cwd: string, from: string, to: string): Promise<string[]> {
    if (from === to) return [];
    const out = await this.ok(cwd, ["diff", "--name-only", "--no-renames", "--relative", "-z", from, to]);
    return out.split("\0").filter(Boolean);
  }

  /** Lightweight summary for project cards; never throws for non-repos. */
  async summary(cwd: string): Promise<GitSummary | null> {
    try {
      return (await this.status(cwd)).summary;
    } catch (e) {
      if (e instanceof ForgeError && (e.code === "GIT_NOT_REPO" || e.code === "GIT_NOT_INSTALLED")) return null;
      throw e;
    }
  }

  private assertRelative(cwd: string, p: string) {
    if (path.isAbsolute(p) || !isInside(path.resolve(cwd, p), cwd)) {
      throw new ForgeError("PATH_INVALID", tr().system.git.pathOutside(p));
    }
  }

  /** `known`: a status the caller just read, saves three git processes per file when diffing many. */
  async diff(cwd: string, file: string, staged: boolean, known?: GitStatus): Promise<FileDiff> {
    this.assertRelative(cwd, file);
    const st = known ?? (await this.status(cwd));
    const entry = st.files.find((f) => f.path === file);
    if (entry?.kind === "untracked") {
      const abs = path.join(cwd, file);
      const s = await stat(abs);
      if (s.size > 5 * 1024 * 1024) {
        return { path: file, binary: true, additions: 0, deletions: 0, lines: [], truncated: true };
      }
      return untrackedDiff(file, await readFile(abs));
    }
    const args = ["diff", "--no-ext-diff", "--no-color", "-M"];
    if (staged) args.push("--cached");
    args.push("--", file);
    if (entry?.origPath) args.push(entry.origPath);
    return parseUnifiedDiff(file, await this.ok(cwd, args));
  }

  async stage(cwd: string, paths: string[]) {
    paths.forEach((p) => this.assertRelative(cwd, p));
    await this.ok(cwd, ["add", "--", ...paths]);
  }

  async unstage(cwd: string, paths: string[]) {
    paths.forEach((p) => this.assertRelative(cwd, p));
    const hasHead = (await this.exec(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    if (hasHead) await this.ok(cwd, ["reset", "-q", "HEAD", "--", ...paths]);
    else await this.ok(cwd, ["rm", "--cached", "-q", "--", ...paths]);
  }

  /**
   * Commits exactly the reviewed paths with their current working-tree content.
   * Other staged changes stay staged and are not part of the commit.
   */
  async commit(cwd: string, message: string, paths: string[], allowSensitive: boolean): Promise<{ hash: string; summary: string }> {
    paths.forEach((p) => this.assertRelative(cwd, p));
    const st = await this.status(cwd);
    if (st.summary.conflicted) {
      throw new ForgeError("GIT_CONFLICT", tr().system.git.conflictsBeforeCommit);
    }
    const byPath = new Map(st.files.map((f) => [f.path, f]));
    const unknown = paths.filter((p) => !byPath.has(p));
    if (unknown.length) {
      throw new ForgeError("VALIDATION", tr().system.git.noChanges(unknown.join(", ")), { paths: unknown });
    }

    // Only file names are checked: scanning contents cost one git process per file and made commits slow.
    if (!allowSensitive) {
      const flagged: Array<{ path: string; reason: string }> = [];
      for (const p of paths) {
        if (isSensitiveFile(p)) flagged.push({ path: p, reason: tr().system.git.sensitiveFile });
        else if (isArtifactPath(p)) flagged.push({ path: p, reason: "Build-Artefakt" });
      }
      if (flagged.length) {
        throw new ForgeError("POLICY_DENIED", tr().system.git.sensitiveSelected, { flagged });
      }
    }

    const pathspec = new Set<string>();
    for (const p of paths) {
      pathspec.add(p);
      const orig = byPath.get(p)?.origPath;
      if (orig) pathspec.add(orig);
    }
    const list = [...pathspec];
    // A staged deletion or the old side of a staged rename is neither on disk nor in the index:
    // `git add` fails on it ("pathspec did not match"). Staged-only entries need no add anyway.
    const toAdd = paths.filter((p) => byPath.get(p)?.unstaged);
    if (toAdd.length) await this.ok(cwd, ["add", "-A", "--", ...toAdd]);
    await this.ok(cwd, ["commit", "-q", "-F", "-", "--only", "--", ...list], message);
    const [hash = "", summary = ""] = (await this.ok(cwd, ["log", "-1", "--format=%H%n%s"])).split("\n").map((l) => l.replace(/\r$/, "").trim());
    return { hash, summary };
  }

  /**
   * Brings every file of the project folder back to the state of `commit`, as new uncommitted changes.
   * Branch and history stay as they are. Uncommitted work is stashed first, so nothing is lost.
   */
  async restoreTo(cwd: string, commit: string): Promise<{ commit: string; subject: string; stashed: boolean; changed: number }> {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new ForgeError("VALIDATION", tr().system.git.invalidCommit);
    const st = await this.status(cwd);
    if (st.summary.conflicted) {
      throw new ForgeError("GIT_CONFLICT", tr().system.git.conflictsBeforeRestore);
    }
    const resolved = await this.exec(cwd, ["rev-parse", "--verify", "-q", `${commit}^{commit}`]);
    if (resolved.code !== 0) throw new ForgeError("NOT_FOUND", tr().system.git.commitNotFound);
    const full = resolved.stdout.trim();
    const stashed = st.files.length > 0;
    if (stashed) {
      await this.ok(cwd, ["stash", "push", "--include-untracked", "-m", tr().system.git.restoreStash(full.slice(0, 7)), "--", "."]);
    }
    // Tracked files that do not exist in the source are removed, so the folder matches the commit exactly.
    await this.ok(cwd, ["restore", `--source=${full}`, "--staged", "--worktree", "--", "."]);
    const subject = (await this.ok(cwd, ["log", "-1", "--format=%s", full])).trim();
    const after = await this.status(cwd);
    return { commit: full, subject, stashed, changed: after.files.length };
  }

  async log(cwd: string, limit: number): Promise<CommitInfo[]> {
    const hasHead = (await this.exec(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    if (!hasHead) return [];
    return parseLog(await this.ok(cwd, ["log", "--topo-order", `-n${limit}`, `--format=${LOG_FORMAT}`]));
  }

  /**
   * Commits of the checked-out branch committed in [since, until) (ISO), newest first, only those that
   * touch the project folder: in a monorepo the other projects' commits stay out.
   */
  async logBetween(cwd: string, since: string, until: string, limit: number): Promise<CommitInfo[]> {
    const hasHead = (await this.exec(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    if (!hasHead) return [];
    // git reads "YYYY-MM-DD HH:MM:SS +0000" reliably; ISO with milliseconds it may misread.
    const gitDate = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000`;
    return parseLog(await this.ok(cwd, ["log", `--since=${gitDate(since)}`, `--until=${gitDate(until)}`, `-n${limit}`, `--format=${LOG_FORMAT}`, "HEAD", "--", "."]));
  }

  /**
   * Branches merged into HEAD of this folder in [since, until) (ISO), from the reflog, with the commits
   * each merge brought, newest first. Finds merges FORGE has no record of (by a build before agent_log,
   * by hand in a terminal). Only branches whose name starts with `prefix`.
   */
  async mergesBetween(cwd: string, since: string, until: string, prefix: string): Promise<Array<{ branch: string; at: string; commits: Array<{ hash: string; subject: string }> }>> {
    const r = await this.exec(cwd, ["log", "-g", "--date=unix", "--format=%H%x1f%gd%x1f%gs", "-n1000", "HEAD"]);
    if (r.code !== 0) return [];
    const from = Date.parse(since);
    const to = Date.parse(until);
    const entries = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", selector = "", subject = ""] = line.split("\x1f");
        return { hash, ms: Number(/@\{(\d+)\}/.exec(selector)?.[1] ?? NaN) * 1000, subject };
      });
    const out: Array<{ branch: string; at: string; commits: Array<{ hash: string; subject: string }> }> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (!(e.ms >= from && e.ms < to)) continue;
      const m = /^merge (?:refs\/heads\/)?(\S+): /.exec(e.subject);
      if (!m || !m[1]!.startsWith(prefix)) continue;
      const before = entries[i + 1]?.hash;
      const list = await this.exec(cwd, ["log", "-n500", "--format=%H%x1f%s", ...(before ? [`${before}..${e.hash}`] : ["-1", e.hash])]);
      const commits = list.code === 0 ? list.stdout.split("\n").filter(Boolean).map((l) => ({ hash: l.split("\x1f")[0]!, subject: l.split("\x1f")[1] ?? "" })) : [];
      out.push({ branch: m[1]!, at: new Date(e.ms).toISOString(), commits });
    }
    return out;
  }

  /**
   * The commit and the side it is compared with: its first parent, or the empty tree for a root commit
   * (merges are shown against the first parent, as git log --first-parent would).
   */
  private async commitRange(cwd: string, commit: string): Promise<[string, string]> {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new ForgeError("VALIDATION", tr().system.git.invalidCommit);
    const resolved = await this.exec(cwd, ["rev-parse", "--verify", "-q", `${commit}^{commit}`]);
    if (resolved.code !== 0) throw new ForgeError("NOT_FOUND", tr().system.git.commitNotFound);
    const full = resolved.stdout.trim();
    const parent = await this.exec(cwd, ["rev-parse", "--verify", "-q", `${full}^1`]);
    if (parent.code === 0) return [parent.stdout.trim(), full];
    return [(await this.ok(cwd, ["hash-object", "-t", "tree", "--stdin"], "")).trim(), full];
  }

  async commitFiles(cwd: string, commit: string): Promise<CommitDetails> {
    const [base, full] = await this.commitRange(cwd, commit);
    // --relative: paths below the project folder only, relative to it (see status for monorepos).
    const range = ["-M", "--relative", "-z", base, full, "--", "."];
    const [statusOut, numstatOut, body] = await Promise.all([
      this.ok(cwd, ["diff", "--no-ext-diff", "--name-status", ...range]),
      this.ok(cwd, ["diff", "--no-ext-diff", "--numstat", ...range]),
      this.ok(cwd, ["log", "-1", "--format=%b", full]),
    ]);
    const all = parseCommitFiles(statusOut, numstatOut);
    return { hash: full, body: body.trim(), files: all.slice(0, MAX_COMMIT_FILES), truncated: all.length > MAX_COMMIT_FILES };
  }

  async commitDiff(cwd: string, commit: string, file: string, origPath?: string): Promise<FileDiff> {
    this.assertRelative(cwd, file);
    if (origPath) this.assertRelative(cwd, origPath);
    const [base, full] = await this.commitRange(cwd, commit);
    const args = ["diff", "--no-ext-diff", "--no-color", "-M", "--relative", base, full, "--", file];
    if (origPath) args.push(origPath);
    return parseUnifiedDiff(file, await this.ok(cwd, args));
  }

  /** Local branches, then branches that exist only on origin (e.g. `dev` after a fresh clone). */
  async branches(cwd: string): Promise<BranchInfo[]> {
    const [local, remote] = await Promise.all([
      this.ok(cwd, ["branch", "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)"]),
      this.exec(cwd, ["for-each-ref", "--format=%(refname)", REMOTE_PREFIX]),
    ]);
    const list = parseBranches(local);
    const names = new Set(list.map((b) => b.name));
    for (const ref of remote.code === 0 ? remote.stdout.split("\n") : []) {
      const name = ref.trim().slice(REMOTE_PREFIX.length);
      if (!ref.startsWith(REMOTE_PREFIX) || !name || name === "HEAD" || names.has(name)) continue;
      list.push({ name, current: false, upstream: `origin/${name}`, remote: true });
    }
    return list;
  }

  async checkout(cwd: string, branch: string, create: boolean) {
    if (branch.startsWith("-")) throw new ForgeError("VALIDATION", tr().system.git.invalidBranch);
    const check = await this.exec(cwd, ["check-ref-format", "--branch", branch]);
    if (check.code !== 0) throw new ForgeError("VALIDATION", tr().system.git.invalidBranchNamed(branch));
    if (create) return void (await this.ok(cwd, ["switch", "-c", branch]));
    // Spelled out instead of relying on git's guess, which `checkout.guess=false` turns off.
    const local = await this.exec(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    const remote = local.code === 0 ? null : await this.exec(cwd, ["show-ref", "--verify", "--quiet", `${REMOTE_PREFIX}${branch}`]);
    await this.ok(cwd, remote?.code === 0 ? ["switch", "-c", branch, "--track", `origin/${branch}`] : ["switch", branch]);
  }

  /**
   * Deletes a local branch. Without `force` git refuses branches whose commits are in no other branch;
   * that comes back as CONFLICT so the caller can ask. The current and the default branch are kept.
   */
  async deleteBranch(cwd: string, branch: string, force: boolean) {
    if (branch.startsWith("-")) throw new ForgeError("VALIDATION", tr().system.git.invalidBranch);
    const check = await this.exec(cwd, ["check-ref-format", "--branch", branch]);
    if (check.code !== 0) throw new ForgeError("VALIDATION", tr().system.git.invalidBranchNamed(branch));
    if ((await this.currentBranch(cwd)) === branch) {
      throw new ForgeError("POLICY_DENIED", tr().system.git.deleteCurrentBranch);
    }
    if (new Set(["main", "master", await this.defaultBranch(cwd)]).has(branch)) {
      throw new ForgeError("POLICY_DENIED", tr().system.git.deleteDefaultBranch(branch));
    }
    const r = await this.exec(cwd, ["branch", force ? "-D" : "-d", "--", branch]);
    if (r.code === 0) return;
    const msg = (r.stderr || r.stdout).trim();
    if (/not fully merged/i.test(msg)) {
      throw new ForgeError("CONFLICT", tr().system.git.branchUnmerged(branch), { unmerged: true });
    }
    if (/used by worktree|checked out at/i.test(msg)) {
      throw new ForgeError("CONFLICT", tr().system.git.branchInWorktree(branch));
    }
    throw new ForgeError("GIT_FAILED", msg || tr().system.git.branchDeleteFailed);
  }

  async currentBranch(cwd: string): Promise<string | null> {
    const r = await this.exec(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /**
   * Pushes the current branch to origin. Never forces; protected branches need an explicit flag
   * from a user confirmation. New commits on origin are taken over first (see integrateRemote), so
   * a push is not rejected for being behind. Conflicts end in GIT_CONFLICT with `details.integration`.
   */
  async push(cwd: string, allowProtected: boolean): Promise<{ branch: string; output: string; integrated: GitIntegrated | null }> {
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new ForgeError("GIT_FAILED", tr().system.git.detachedHead);
    if (PROTECTED.has(branch) && !allowProtected) {
      throw new ForgeError("POLICY_DENIED", tr().system.git.pushNeedsConfirm(branch), { protectedBranch: branch });
    }
    if (!(await this.remoteUrl(cwd))) throw new ForgeError("GIT_FAILED", tr().system.git.noRemotePublish);
    const integrated = await this.integrateRemote(cwd, branch);
    const r = await this.exec(cwd, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`], undefined, 180_000);
    const output = (r.stdout + r.stderr).trim();
    if (r.code !== 0) {
      if (/rejected|non-fast-forward|fetch first/i.test(output)) {
        throw new ForgeError("GIT_CONFLICT", tr().system.git.pushRejected);
      }
      throw new ForgeError("GIT_FAILED", output || tr().system.git.pushFailed);
    }
    return { branch, output, integrated };
  }

  /** Top folder of the repository; projects in subfolders of one monorepo share it. */
  async repoRoot(cwd: string): Promise<string> {
    return path.resolve((await this.ok(cwd, ["rev-parse", "--show-toplevel"])).trim());
  }

  /** Commits of HEAD not on origin: ahead of the upstream, or on no origin branch when the branch has none. */
  async unpushedCount(cwd: string, summary: GitSummary): Promise<number> {
    if (summary.upstream) return summary.ahead;
    const r = await this.exec(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  /** Takes over new commits from origin: fast-forward, or a rebase of the local commits on top. */
  async pull(cwd: string): Promise<{ output: string; integrated: GitIntegrated | null }> {
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new ForgeError("GIT_FAILED", tr().system.git.detachedHead);
    if (!(await this.remoteUrl(cwd))) throw new ForgeError("GIT_FAILED", tr().system.git.noRemote);
    const integrated = await this.integrateRemote(cwd, branch);
    const output = !integrated
      ? tr().system.git.upToDate
      : integrated.mode === "fast-forward"
        ? tr().system.git.pulledFastForward(integrated.remoteCommits)
        : tr().system.git.pulledRebase(integrated.remoteCommits, integrated.localCommits);
    return { output, integrated };
  }

  /**
   * Fetches origin and brings the branch up to date with origin/<branch>. Without own commits it
   * fast-forwards; with own commits it rebases them on top (merge commits kept). Uncommitted
   * changes are stashed and put back. On a conflict the rebase is aborted, the repository is as
   * before, and GIT_CONFLICT carries the details for whoever resolves it.
   */
  async integrateRemote(cwd: string, branch: string): Promise<GitIntegrated | null> {
    const st = await this.status(cwd);
    if (st.summary.conflicted) throw new ForgeError("GIT_CONFLICT", tr().system.git.conflictsUnresolved);
    if (await this.operationInProgress(cwd)) {
      throw new ForgeError("GIT_CONFLICT", tr().system.git.operationInProgress);
    }
    const fetched = await this.exec(cwd, ["fetch", "--prune", "origin"], undefined, 120_000);
    if (fetched.code !== 0) throw new ForgeError("GIT_FAILED", (fetched.stderr || fetched.stdout).trim() || tr().system.git.fetchFailed);
    const remote = `refs/remotes/origin/${branch}`;
    if ((await this.exec(cwd, ["rev-parse", "--verify", "-q", remote])).code !== 0) return null;
    const counts = (await this.ok(cwd, ["rev-list", "--left-right", "--count", `HEAD...${remote}`])).trim().split(/\s+/);
    const localCommits = Number(counts[0] ?? 0);
    const remoteCommits = Number(counts[1] ?? 0);
    if (!remoteCommits) return null;

    if (!localCommits) {
      const r = await this.exec(cwd, ["merge", "--ff-only", "--autostash", remote], undefined, 120_000);
      if (r.code !== 0) throw new ForgeError("GIT_FAILED", (r.stderr || r.stdout).trim() || tr().system.git.fastForwardFailed);
      await this.assertNoConflicts(cwd, branch, remoteCommits, localCommits);
      return { mode: "fast-forward", remoteCommits, localCommits };
    }

    const r = await this.exec(cwd, ["rebase", "--autostash", "--rebase-merges", remote], undefined, 180_000);
    if (r.code !== 0) {
      const files = (await this.exec(cwd, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      await this.exec(cwd, ["rebase", "--abort"]);
      const integration: GitIntegrationConflict = { branch, remoteCommits, localCommits, files };
      throw new ForgeError(
        "GIT_CONFLICT",
        tr().system.git.rebaseConflict(branch, remoteCommits, localCommits, files),
        { integration },
      );
    }
    await this.assertNoConflicts(cwd, branch, remoteCommits, localCommits);
    return { mode: "rebase", remoteCommits, localCommits };
  }

  /** --autostash puts uncommitted changes back after the update; that step itself can conflict. */
  private async assertNoConflicts(cwd: string, branch: string, remoteCommits: number, localCommits: number) {
    const files = (await this.status(cwd)).files.filter((f) => f.kind === "conflicted").map((f) => f.path);
    if (!files.length) return;
    const integration: GitIntegrationConflict = { branch, remoteCommits, localCommits, files, stash: true };
    throw new ForgeError(
      "GIT_CONFLICT",
      tr().system.git.stashConflict(branch, files.join(", ")),
      { integration },
    );
  }

  private async operationInProgress(cwd: string): Promise<boolean> {
    const r = await this.exec(cwd, ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply", "--git-path", "MERGE_HEAD", "--git-path", "CHERRY_PICK_HEAD"]);
    const paths = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const p of paths) {
      if (await stat(path.resolve(cwd, p)).then(() => true, () => false)) return true;
    }
    return false;
  }

  async fetch(cwd: string) {
    await this.ok(cwd, ["fetch", "--prune"], undefined, 120_000);
  }

  /** Default branch of origin (origin/HEAD), falling back to main/master. */
  async defaultBranch(cwd: string): Promise<string> {
    const r = await this.exec(cwd, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, "");
    for (const b of ["main", "master"]) {
      if ((await this.exec(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${b}`])).code === 0) return b;
    }
    return "main";
  }

  /** Commit subjects and diff of HEAD against a base branch (for PR descriptions). */
  async rangeSummary(cwd: string, base: string): Promise<{ commits: string[]; diff: string }> {
    const ref = (await this.exec(cwd, ["rev-parse", "--verify", "-q", `origin/${base}`])).code === 0 ? `origin/${base}` : base;
    const log = await this.exec(cwd, ["log", "--format=%s", `${ref}..HEAD`]);
    const diff = await this.exec(cwd, ["diff", "--no-color", "--stat", "--patch", `${ref}...HEAD`], undefined, 60_000);
    return { commits: log.stdout.split("\n").filter(Boolean), diff: diff.stdout.slice(0, 40_000) };
  }

  async hasCommits(cwd: string): Promise<boolean> {
    return (await this.exec(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
  }

  /** First commit of a fresh repository so it can be pushed. */
  async initialCommit(cwd: string, message: string) {
    await this.ok(cwd, ["commit", "-q", "--allow-empty", "-F", "-"], message);
  }

  async identity(): Promise<{ name: string | null; email: string | null }> {
    const get = async (key: string) => {
      const r = await this.exec(process.cwd(), ["config", "--global", "--get", key]);
      return r.code === 0 ? r.stdout.trim() || null : null;
    };
    return { name: await get("user.name"), email: await get("user.email") };
  }

  async setIdentity(name: string, email: string) {
    await this.ok(process.cwd(), ["config", "--global", "user.name", name]);
    await this.ok(process.cwd(), ["config", "--global", "user.email", email]);
  }

  async init(cwd: string) {
    await this.ok(cwd, ["init", "-b", "main"]);
  }

  async clone(url: string, target: string, parent: string) {
    await this.ok(parent, ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=user", "clone", "--", url, target], undefined, 15 * 60_000);
  }
}

/** Accepts https://, ssh:// and scp-like git@host:path URLs only. */
export function validateCloneUrl(url: string): string | null {
  const u = url.trim();
  if (u.startsWith("-")) return tr().system.git.invalidUrl;
  if (/^https:\/\/[^\s/]+\/[^\s]+$/.test(u)) return null;
  if (/^ssh:\/\/[^\s/]+\/[^\s]+$/.test(u)) return null;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(u)) return null;
  return tr().system.git.urlSchemes;
}

export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return last.replace(/\.git$/, "") || "repo";
}
