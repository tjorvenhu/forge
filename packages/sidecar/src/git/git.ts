import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type BranchInfo, type CommitInfo, type FileDiff, type GitStatus, type GitSummary } from "@forge/protocol";
import { isInside } from "../util/paths.js";
import { run, type RunResult } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";
import { LOG_FORMAT, parseBranches, parseLog, parseStatusV2, parseUnifiedDiff, scopeToPrefix, summarize, untrackedDiff } from "./parsers.js";

const SENSITIVE_FILE =
  /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.p12|.*\.pfx|.*\.keystore|credentials(\..*)?\.json|secrets?\.(json|ya?ml|toml)|\.npmrc|\.pypirc|\.netrc)$/i;

const PROTECTED = new Set(["main", "master"]);

const ARTIFACT_PATH = /(^|\/)(node_modules|dist|build|target|\.next|out|coverage|__pycache__)\//;

export function isSensitiveFile(p: string): boolean {
  return SENSITIVE_FILE.test(p.replace(/\\/g, "/")) && !/\.example$|\.sample$|\.template$/i.test(p);
}

export function isArtifactPath(p: string): boolean {
  return ARTIFACT_PATH.test(p.replace(/\\/g, "/"));
}

export class GitEngine {
  /** shipped git when available, else the one on PATH */
  private get gitBin() {
    return resolveTool("git")?.path ?? "git";
  }

  private env(): NodeJS.ProcessEnv {
    // Literal pathspecs: file names like app/[id]/page.tsx or .e[n]v must not act as globs that
    // pull other files (e.g. .env) into a commit.
    return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" };
  }

  async exec(cwd: string, args: string[], input?: string, timeoutMs = 60_000): Promise<RunResult> {
    const r = await run(this.gitBin, ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args], {
      cwd,
      env: this.env(),
      input,
      timeoutMs,
    });
    if (r.spawnError) {
      if (r.spawnError.code === "ENOENT") throw new ForgeError("GIT_NOT_INSTALLED", "git wurde nicht gefunden. Bitte Git installieren.");
      throw new ForgeError("GIT_FAILED", r.spawnError.message);
    }
    return r;
  }

  private async ok(cwd: string, args: string[], input?: string, timeoutMs?: number): Promise<string> {
    const r = await this.exec(cwd, args, input, timeoutMs);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim() || `git ${args[0]} fehlgeschlagen (Code ${r.code})`;
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
      throw new ForgeError("PATH_INVALID", `Pfad liegt außerhalb des Projekts: ${p}`);
    }
  }

  async diff(cwd: string, file: string, staged: boolean): Promise<FileDiff> {
    this.assertRelative(cwd, file);
    const st = await this.status(cwd);
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
      throw new ForgeError("GIT_CONFLICT", "Es gibt ungelöste Konflikte. Bitte zuerst auflösen, dann committen.");
    }
    const byPath = new Map(st.files.map((f) => [f.path, f]));
    const unknown = paths.filter((p) => !byPath.has(p));
    if (unknown.length) {
      throw new ForgeError("VALIDATION", `Diese Dateien haben keine Änderungen: ${unknown.join(", ")}`, { paths: unknown });
    }

    // Only file names are checked: scanning contents cost one git process per file and made commits slow.
    if (!allowSensitive) {
      const flagged: Array<{ path: string; reason: string }> = [];
      for (const p of paths) {
        if (isSensitiveFile(p)) flagged.push({ path: p, reason: "sensible Datei" });
        else if (isArtifactPath(p)) flagged.push({ path: p, reason: "Build-Artefakt" });
      }
      if (flagged.length) {
        throw new ForgeError("POLICY_DENIED", "Sensible Dateien oder Build-Artefakte ausgewählt.", { flagged });
      }
    }

    const pathspec = new Set<string>();
    for (const p of paths) {
      pathspec.add(p);
      const orig = byPath.get(p)?.origPath;
      if (orig) pathspec.add(orig);
    }
    const list = [...pathspec];
    await this.ok(cwd, ["add", "-A", "--", ...list]);
    await this.ok(cwd, ["commit", "-q", "-F", "-", "--only", "--", ...list], message);
    const [hash = "", summary = ""] = (await this.ok(cwd, ["log", "-1", "--format=%H%n%s"])).split("\n").map((l) => l.replace(/\r$/, "").trim());
    return { hash, summary };
  }

  async log(cwd: string, limit: number): Promise<CommitInfo[]> {
    const hasHead = (await this.exec(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    if (!hasHead) return [];
    return parseLog(await this.ok(cwd, ["log", `-n${limit}`, `--format=${LOG_FORMAT}`]));
  }

  async branches(cwd: string): Promise<BranchInfo[]> {
    return parseBranches(await this.ok(cwd, ["branch", "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)"]));
  }

  async checkout(cwd: string, branch: string, create: boolean) {
    if (branch.startsWith("-")) throw new ForgeError("VALIDATION", "Ungültiger Branch-Name.");
    const check = await this.exec(cwd, ["check-ref-format", "--branch", branch]);
    if (check.code !== 0) throw new ForgeError("VALIDATION", `Ungültiger Branch-Name: ${branch}`);
    await this.ok(cwd, create ? ["switch", "-c", branch] : ["switch", branch]);
  }

  async currentBranch(cwd: string): Promise<string | null> {
    const r = await this.exec(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  /**
   * Pushes the current branch to origin. Never forces; protected branches need an explicit flag
   * from a user confirmation.
   */
  async push(cwd: string, allowProtected: boolean): Promise<{ branch: string; output: string }> {
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new ForgeError("GIT_FAILED", "Kein Branch ausgecheckt (detached HEAD).");
    if (PROTECTED.has(branch) && !allowProtected) {
      throw new ForgeError("POLICY_DENIED", `Push auf ${branch} braucht eine ausdrückliche Bestätigung.`, { protectedBranch: branch });
    }
    if (!(await this.remoteUrl(cwd))) throw new ForgeError("GIT_FAILED", "Kein Remote origin. Veröffentliche das Projekt zuerst auf GitHub.");
    const r = await this.exec(cwd, ["push", "-u", "origin", `HEAD:refs/heads/${branch}`], undefined, 180_000);
    const output = (r.stdout + r.stderr).trim();
    if (r.code !== 0) {
      if (/rejected|non-fast-forward|fetch first/i.test(output)) {
        throw new ForgeError("GIT_CONFLICT", "Push abgelehnt: Auf dem Remote gibt es neuere Commits. Erst Pull ausführen, dann erneut pushen.");
      }
      throw new ForgeError("GIT_FAILED", output || "Push fehlgeschlagen");
    }
    return { branch, output };
  }

  /** Fast-forward only: never creates merge commits or rewrites local work. */
  async pull(cwd: string): Promise<{ output: string }> {
    const st = await this.status(cwd);
    if (st.summary.conflicted) throw new ForgeError("GIT_CONFLICT", "Es gibt ungelöste Konflikte.");
    const r = await this.exec(cwd, ["pull", "--ff-only"], undefined, 180_000);
    const output = (r.stdout + r.stderr).trim();
    if (r.code !== 0) {
      if (/not possible to fast-forward|diverg/i.test(output)) {
        throw new ForgeError(
          "GIT_CONFLICT",
          "Lokaler und entfernter Stand sind auseinandergelaufen. Optionen: Claude bitten, die Änderungen per Rebase zusammenzuführen, oder einen neuen Branch anlegen und einen Pull Request öffnen.",
        );
      }
      if (/would be overwritten/i.test(output)) {
        throw new ForgeError("GIT_CONFLICT", "Lokale, nicht committete Änderungen würden überschrieben. Erst committen oder verwerfen.");
      }
      throw new ForgeError("GIT_FAILED", output || "Pull fehlgeschlagen");
    }
    return { output };
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
  if (u.startsWith("-")) return "Ungültige URL.";
  if (/^https:\/\/[^\s/]+\/[^\s]+$/.test(u)) return null;
  if (/^ssh:\/\/[^\s/]+\/[^\s]+$/.test(u)) return null;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(u)) return null;
  return "Nur https://, ssh:// oder git@host:pfad URLs sind erlaubt.";
}

export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return last.replace(/\.git$/, "") || "repo";
}
