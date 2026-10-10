import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type BranchInfo, type CommitInfo, type FileDiff, type GitStatus, type GitSummary } from "@forge/protocol";
import { containsSecret } from "../policy/redact.js";
import { isInside } from "../util/paths.js";
import { run, type RunResult } from "../util/proc.js";
import { LOG_FORMAT, parseBranches, parseLog, parseStatusV2, parseUnifiedDiff, summarize, untrackedDiff } from "./parsers.js";

const SENSITIVE_FILE =
  /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.p12|.*\.pfx|.*\.keystore|credentials(\..*)?\.json|secrets?\.(json|ya?ml|toml)|\.npmrc|\.pypirc|\.netrc)$/i;

const ARTIFACT_PATH = /(^|\/)(node_modules|dist|build|target|\.next|out|coverage|__pycache__)\//;

export function isSensitiveFile(p: string): boolean {
  return SENSITIVE_FILE.test(p.replace(/\\/g, "/")) && !/\.example$|\.sample$|\.template$/i.test(p);
}

export function isArtifactPath(p: string): boolean {
  return ARTIFACT_PATH.test(p.replace(/\\/g, "/"));
}

export class GitEngine {
  private gitBin = "git";

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
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

  async status(cwd: string): Promise<GitStatus> {
    if (!(await this.isRepo(cwd))) throw new ForgeError("GIT_NOT_REPO", "Kein Git-Repository.");
    const out = await this.ok(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const parsed = parseStatusV2(out);
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

    if (!allowSensitive) {
      const flagged: Array<{ path: string; reason: string }> = [];
      for (const p of paths) {
        if (isSensitiveFile(p)) flagged.push({ path: p, reason: "sensible Datei" });
        else if (isArtifactPath(p)) flagged.push({ path: p, reason: "Build-Artefakt" });
        else if (byPath.get(p)?.kind !== "deleted") {
          const d = await this.diff(cwd, p, false).catch(() => null);
          const added = d?.lines.filter((l) => l.kind === "add").map((l) => l.text).join("\n") ?? "";
          if (added && containsSecret(added)) flagged.push({ path: p, reason: "möglicher Schlüssel/Token im Inhalt" });
        }
      }
      if (flagged.length) {
        throw new ForgeError("POLICY_DENIED", "Commit gestoppt: mögliche Secrets oder Build-Artefakte ausgewählt.", { flagged });
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
    const hash = (await this.ok(cwd, ["rev-parse", "HEAD"])).trim();
    const summary = (await this.ok(cwd, ["log", "-1", "--format=%s"])).trim();
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
