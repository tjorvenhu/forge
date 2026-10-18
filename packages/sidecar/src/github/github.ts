import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, type GitHubAccount, type GitHubLoginState, type GitHubOrg, type GitHubRepo, type PullRequest } from "@forge/protocol";
import { run } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";
import { authorsQuery, avatarKey, commitsToResolve, parseAuthorsResponse } from "./avatars.js";
import { tr } from "../i18n/index.js";

const HOST = "github.com";

/**
 * GitHub access through the official CLI. FORGE never sees the token: gh stores it in the OS
 * credential store and git uses it via `gh auth setup-git`.
 */
export class GitHubService {
  private login: ChildProcess | null = null;
  private state: GitHubLoginState = { phase: "idle", code: null, url: null, message: null };
  /** per "owner/repo", per lower-case author email */
  private readonly avatarCache = new Map<string, Map<string, { url: string | null; at: number }>>();
  private readonly avatarJobs = new Map<string, Promise<void>>();

  constructor(private readonly emit: (s: GitHubLoginState) => void) {}

  private gh(): string {
    const t = resolveTool("gh");
    if (!t) throw new ForgeError("INTERNAL", tr().system.github.ghMissing);
    return t.path;
  }

  private env(): NodeJS.ProcessEnv {
    // No pager, no prompts, no browser launched by gh itself: FORGE opens the URL.
    return { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "", GH_NO_UPDATE_NOTIFIER: "1", GH_BROWSER: "none", BROWSER: "none" };
  }

  private async gh_(args: string[], timeoutMs = 30_000) {
    const r = await run(this.gh(), args, { env: this.env(), timeoutMs });
    if (r.spawnError) throw new ForgeError("INTERNAL", r.spawnError.message);
    return r;
  }

  private set(s: Partial<GitHubLoginState>) {
    this.state = { ...this.state, ...s };
    this.emit(this.state);
  }

  loginState(): GitHubLoginState {
    return this.state;
  }

  async account(): Promise<GitHubAccount | null> {
    const st = await this.gh_(["auth", "status", "--hostname", HOST, "--json", "hosts"]);
    try {
      const j = JSON.parse(st.stdout) as { hosts?: Record<string, Array<{ state?: string; active?: boolean; login?: string }>> };
      const entry = (j.hosts?.[HOST] ?? []).find((h) => h.active) ?? j.hosts?.[HOST]?.[0];
      if (!entry || entry.state !== "success" || !entry.login) return null;
      const user = await this.gh_(["api", "user"]);
      const u = user.code === 0 ? (JSON.parse(user.stdout) as { id?: number; name?: string | null; avatar_url?: string; html_url?: string }) : {};
      return { login: entry.login, id: u.id ?? null, name: u.name ?? null, avatarUrl: u.avatar_url ?? null, profileUrl: u.html_url ?? `https://github.com/${entry.login}` };
    } catch {
      return null;
    }
  }

  /** OAuth scopes of the signed-in account; null when nobody is signed in. */
  async scopes(): Promise<string[] | null> {
    const st = await this.gh_(["auth", "status", "--hostname", HOST, "--json", "hosts"]);
    try {
      const j = JSON.parse(st.stdout) as { hosts?: Record<string, Array<{ state?: string; active?: boolean; scopes?: string }>> };
      const entry = (j.hosts?.[HOST] ?? []).find((h) => h.active) ?? j.hosts?.[HOST]?.[0];
      if (!entry || entry.state !== "success") return null;
      return (entry.scopes ?? "").match(/[a-z_:]+/g) ?? [];
    } catch {
      return null;
    }
  }

  /**
   * Starts the device flow; the code and URL arrive as `github.login` events. With scopes, the
   * signed-in account is asked for additional permissions (e.g. delete_repo) instead.
   */
  startLogin(scopes: string[] = []): GitHubLoginState {
    if (this.login) return this.state;
    this.set({ phase: "starting", code: null, url: null, message: null });
    const args = scopes.length
      ? ["auth", "refresh", "--hostname", HOST, "--scopes", scopes.join(",")]
      : ["auth", "login", "--hostname", HOST, "--git-protocol", "https", "--web", "--skip-ssh-key"];
    const child = spawn(this.gh(), args, {
      env: this.env(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.login = child;
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (d: string) => {
      output += d;
      const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1] ?? null;
      const url = /(https:\/\/github\.com\/login\/device)/.exec(output)?.[1] ?? null;
      if (code && url && this.state.phase !== "waiting") this.set({ phase: "waiting", code, url });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.stdin?.on("error", () => {});
    child.stdin?.end("\n");
    child.on("error", (e) => {
      this.login = null;
      this.set({ phase: "error", message: e.message });
    });
    child.on("close", (exitCode) => {
      this.login = null;
      if (this.state.phase === "cancelled") return;
      if (exitCode === 0) {
        // Lets git push/pull over https use the gh credentials.
        void this.gh_(["auth", "setup-git", "--hostname", HOST]).finally(() => this.set({ phase: "done", code: null, url: null }));
      } else {
        this.set({ phase: "error", message: output.trim().split("\n").slice(-3).join(" ") || tr().system.github.ghExited(exitCode) });
      }
    });
    return this.state;
  }

  cancelLogin(): GitHubLoginState {
    if (this.login) {
      this.set({ phase: "cancelled", code: null, url: null });
      this.login.kill();
      this.login = null;
    }
    return this.state;
  }

  async logout(): Promise<void> {
    const acc = await this.account();
    if (!acc) return;
    const r = await this.gh_(["auth", "logout", "--hostname", HOST, "--user", acc.login]);
    if (r.code !== 0) throw new ForgeError("INTERNAL", (r.stderr || r.stdout).trim() || tr().system.github.logoutFailed);
    this.set({ phase: "idle", code: null, url: null, message: null });
  }

  async repos(): Promise<GitHubRepo[]> {
    const r = await this.gh_(["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt,url"], 60_000);
    if (r.code !== 0) throw new ForgeError("INTERNAL", (r.stderr || r.stdout).trim() || tr().system.github.reposFailed);
    const list = JSON.parse(r.stdout) as Array<{ nameWithOwner: string; description: string | null; isPrivate: boolean; updatedAt: string; url: string }>;
    return list.map((x) => ({ fullName: x.nameWithOwner, description: x.description || null, private: x.isPrivate, updatedAt: x.updatedAt, cloneUrl: `${x.url}.git` }));
  }

  /** Organisations of the signed-in account (needs the read:org scope, which `gh auth login` asks for). */
  async orgs(): Promise<GitHubOrg[]> {
    const r = await this.gh_(["api", "user/orgs?per_page=100"], 60_000);
    if (r.code !== 0) throw new ForgeError("INTERNAL", (r.stderr || r.stdout).trim() || tr().system.github.orgsFailed);
    const list = JSON.parse(r.stdout) as Array<{ login: string; avatar_url?: string | null }>;
    return list.map((o) => ({ login: o.login, avatarUrl: o.avatar_url ?? null })).sort((a, b) => a.login.localeCompare(b.login));
  }

  /**
   * Creates a GitHub repository for a local repo, adds it as origin and pushes the current branch.
   * In the signed-in account, or in one of its organisations with `owner`; never force-pushes.
   */
  async createRepo(dir: string, name: string, isPrivate: boolean, owner: string | null = null): Promise<string> {
    const repoName = owner ? `${owner}/${toRepoName(name)}` : toRepoName(name);
    const r = await run(this.gh(), ["repo", "create", repoName, isPrivate ? "--private" : "--public", "--source", dir, "--remote", "origin", "--push"], {
      cwd: dir,
      env: this.env(),
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || tr().system.github.createFailed);
    const url = /(https:\/\/github\.com\/[^\s]+)/.exec(r.stdout + r.stderr)?.[1] ?? null;
    return url ?? `https://github.com/${repoName}`;
  }

  /** Deletes a repository on GitHub. Needs the delete_repo scope, which FORGE asks for separately. */
  async deleteRepo(fullName: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) throw new ForgeError("VALIDATION", tr().system.github.invalidRepo(fullName));
    const r = await this.gh_(["repo", "delete", fullName, "--yes"], 60_000);
    if (r.code === 0) return;
    const out = (r.stderr || r.stdout).trim();
    if (/delete_repo/.test(out)) throw new ForgeError("POLICY_DENIED", tr().system.github.deleteScope);
    throw new ForgeError("GIT_FAILED", out.split("\n").slice(-2).join(" ") || tr().system.github.deleteFailed);
  }

  /** Visibility of a repository; null when it does not exist (or the account cannot see it). */
  async repoInfo(fullName: string): Promise<{ private: boolean } | null> {
    const r = await this.gh_(["api", `repos/${checkFullName(fullName)}`]);
    if (r.code !== 0) {
      if (isNotFound(r)) return null;
      throw new ForgeError("INTERNAL", ghError(r, tr().system.github.viewFailed));
    }
    return { private: (JSON.parse(r.stdout) as { private?: boolean }).private !== false };
  }

  /** Creates an empty private repository in the signed-in account. */
  async createPrivateRepo(name: string, description: string): Promise<void> {
    const r = await this.gh_(["repo", "create", toRepoName(name), "--private", "--description", description], 60_000);
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", ghError(r, tr().system.github.createFailed));
  }

  /** A text file of a repository's default branch with its blob sha; null when it (or any commit) does not exist. */
  async readRepoFile(fullName: string, file: string, ref?: string): Promise<{ sha: string; text: string } | null> {
    if (ref && !/^[0-9a-f]{7,64}$/.test(ref)) throw new ForgeError("VALIDATION", tr().system.github.invalidCommit);
    const endpoint = `repos/${checkFullName(fullName)}/contents/${file}${ref ? `?ref=${ref}` : ""}`;
    const meta = await this.gh_(["api", endpoint], 60_000);
    if (meta.code !== 0) {
      // An empty repository answers 404 as well.
      if (isNotFound(meta)) return null;
      throw new ForgeError("INTERNAL", ghError(meta, tr().system.github.readFailed));
    }
    const j = JSON.parse(meta.stdout) as { sha: string; content?: string; encoding?: string };
    if (j.encoding === "base64" && j.content) return { sha: j.sha, text: Buffer.from(j.content, "base64").toString("utf8") };
    // Files above 1 MB come without content in the JSON answer.
    const raw = await this.gh_(["api", "-H", "Accept: application/vnd.github.raw+json", endpoint], 120_000);
    if (raw.code !== 0) throw new ForgeError("INTERNAL", ghError(raw, tr().system.github.readFailed));
    return { sha: j.sha, text: raw.stdout };
  }

  /** Commits that changed a file, newest first; empty for an empty repository. */
  async repoFileHistory(fullName: string, file: string, limit = 50): Promise<Array<{ sha: string; date: string; message: string }>> {
    const r = await this.gh_(["api", `repos/${checkFullName(fullName)}/commits?path=${encodeURIComponent(file)}&per_page=${limit}`], 60_000);
    if (r.code !== 0) {
      if (isNotFound(r) || /HTTP 409/.test(r.stdout + r.stderr)) return [];
      throw new ForgeError("INTERNAL", ghError(r, tr().system.github.versionsFailed));
    }
    const list = JSON.parse(r.stdout) as Array<{ sha: string; commit: { message: string; committer?: { date?: string }; author?: { date?: string } } }>;
    return list.map((c) => ({ sha: c.sha, date: c.commit.committer?.date ?? c.commit.author?.date ?? "", message: c.commit.message }));
  }

  /**
   * Writes a text file as one commit. `sha` is the blob that was read (null for a new file); when
   * the file changed in the meantime GitHub refuses and this throws CONFLICT.
   */
  async writeRepoFile(fullName: string, file: string, text: string, sha: string | null, message: string): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "forge-gh-"));
    try {
      // The body goes through a file: the content is far longer than a Windows command line.
      const body = path.join(dir, "body.json");
      await writeFile(body, JSON.stringify({ message, content: Buffer.from(text, "utf8").toString("base64"), ...(sha ? { sha } : {}) }), "utf8");
      const r = await this.gh_(["api", "-X", "PUT", `repos/${checkFullName(fullName)}/contents/${file}`, "--input", body], 120_000);
      if (r.code === 0) return;
      // 422 also covers real validation errors (content too large); only the missing or old sha is a conflict.
      const out = r.stdout + r.stderr;
      if (/HTTP 409/.test(out) || (/HTTP 422/.test(out) && /\bsha\b/i.test(out))) throw new ForgeError("CONFLICT", tr().system.github.fileChanged);
      throw new ForgeError("GIT_FAILED", ghError(r, tr().system.github.saveFailed));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Pull request of the current branch, or null if there is none. */
  async prForBranch(cwd: string): Promise<PullRequest | null> {
    const r = await run(this.gh(), ["pr", "view", "--json", "number,title,state,url,isDraft,reviewDecision,baseRefName,headRefName,statusCheckRollup"], {
      cwd,
      env: this.env(),
      timeoutMs: 30_000,
    });
    if (r.code !== 0) return null;
    const j = JSON.parse(r.stdout) as {
      number: number;
      title: string;
      state: string;
      url: string;
      isDraft: boolean;
      reviewDecision: string | null;
      baseRefName: string;
      headRefName: string;
      statusCheckRollup?: Array<{ conclusion?: string | null; state?: string | null; status?: string | null }>;
    };
    const checks = j.statusCheckRollup ?? [];
    const failed = checks.filter((c) => /FAILURE|ERROR|CANCELLED|TIMED_OUT/i.test(c.conclusion ?? c.state ?? "")).length;
    const pending = checks.filter((c) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED/i.test(c.status ?? c.state ?? "") && !c.conclusion).length;
    return {
      number: j.number,
      title: j.title,
      state: j.state,
      url: j.url,
      draft: j.isDraft,
      reviewDecision: j.reviewDecision || null,
      base: j.baseRefName,
      head: j.headRefName,
      checks: { total: checks.length, failed, pending },
    };
  }

  async createPr(cwd: string, p: { title: string; body: string; base: string; head: string; draft: boolean }): Promise<string> {
    const args = ["pr", "create", "--title", p.title, "--body", p.body, "--base", p.base, "--head", p.head];
    if (p.draft) args.push("--draft");
    const r = await run(this.gh(), args, { cwd, env: this.env(), timeoutMs: 60_000 });
    const out = (r.stdout + r.stderr).trim();
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", out.split("\n").slice(-2).join(" ") || tr().system.github.prFailed);
    return /(https:\/\/github\.com\/\S+\/pull\/\d+)/.exec(out)?.[1] ?? out;
  }

  /**
   * GitHub pictures of commit authors whose email does not name the account, by the email as given.
   * One GraphQL request per call for the authors not cached yet; never throws, so a missing gh,
   * no sign-in or no access just means no pictures.
   */
  async authorAvatars(remote: string | null, commits: ReadonlyArray<{ hash: string; authorEmail: string; avatarUrl: string | null }>): Promise<Record<string, string | null>> {
    const repo = githubRepoFromRemote(remote);
    if (!repo) return {};
    const cache = this.avatarCache.get(repo) ?? new Map<string, { url: string | null; at: number }>();
    this.avatarCache.set(repo, cache);
    // One lookup per repository at a time; whoever waited finds its authors in the cache afterwards.
    for (let running = this.avatarJobs.get(repo); running; running = this.avatarJobs.get(repo)) await running;

    const fresh = (key: string) => {
      const hit = cache.get(key);
      return !!hit && (hit.url !== null || Date.now() - hit.at < AVATAR_MISS_TTL_MS);
    };
    const pending = commitsToResolve(commits.filter((c) => !c.avatarUrl), fresh);
    if (pending.size) {
      const job = this.lookupAuthors(repo, pending, cache)
        .catch(() => {})
        .finally(() => this.avatarJobs.delete(repo));
      this.avatarJobs.set(repo, job);
      await job;
    }

    const out: Record<string, string | null> = {};
    for (const c of commits) {
      if (c.avatarUrl) continue;
      const hit = cache.get(avatarKey(c.authorEmail));
      if (hit) out[c.authorEmail] = hit.url;
    }
    return out;
  }

  private async lookupAuthors(repo: string, pending: Map<string, string[]>, cache: Map<string, { url: string | null; at: number }>) {
    // Marked as not found first, so a failing gh (missing, signed out, offline) is not asked again on every refresh.
    for (const key of pending.keys()) cache.set(key, { url: null, at: Date.now() });
    const targets = [...pending.entries()].flatMap(([key, hashes]) => hashes.map((hash) => ({ key, hash })));
    const [owner = "", name = ""] = repo.split("/");
    const r = await this.gh_(["api", "graphql", "-f", `query=${authorsQuery(targets.map((t) => t.hash))}`, "-f", `owner=${owner}`, "-f", `name=${name}`]);
    // gh exits non-zero when the answer has partial errors (e.g. an unknown commit), the data is still there.
    const urls = parseAuthorsResponse(r.stdout, targets.length);
    const now = Date.now();
    targets.forEach((t, i) => {
      const url = urls[i];
      if (url) cache.set(t.key, { url, at: now });
    });
  }

  shutdown() {
    this.login?.kill();
  }
}

/** Authors without a GitHub account found are asked again after this, e.g. once their commits are pushed. */
const AVATAR_MISS_TTL_MS = 10 * 60_000;

/** "owner/repo" for github.com remotes (https or scp-like), else null. */
export function githubRepoFromRemote(remote: string | null): string | null {
  if (!remote) return null;
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function checkFullName(fullName: string): string {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) throw new ForgeError("VALIDATION", tr().system.github.invalidRepo(fullName));
  return fullName;
}

function isNotFound(r: { stdout: string; stderr: string }): boolean {
  return /HTTP 404|Not Found/i.test(r.stdout + r.stderr);
}

function ghError(r: { stdout: string; stderr: string }, fallback: string): string {
  return (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || fallback;
}

/** GitHub repository names: letters, digits, dot, dash, underscore. */
export function toRepoName(name: string): string {
  return name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[.-]+/, "").slice(0, 100) || "projekt";
}
