import { spawn, type ChildProcess } from "node:child_process";
import { ForgeError, type GitHubAccount, type GitHubLoginState, type GitHubRepo } from "@forge/protocol";
import { run } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";

const HOST = "github.com";

/**
 * GitHub access through the official CLI. FORGE never sees the token: gh stores it in the OS
 * credential store and git uses it via `gh auth setup-git`.
 */
export class GitHubService {
  private login: ChildProcess | null = null;
  private state: GitHubLoginState = { phase: "idle", code: null, url: null, message: null };

  constructor(private readonly emit: (s: GitHubLoginState) => void) {}

  private gh(): string {
    const t = resolveTool("gh");
    if (!t) throw new ForgeError("INTERNAL", "GitHub CLI fehlt in dieser Installation.");
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

  /** Starts the device flow; the code and URL arrive as `github.login` events. */
  startLogin(): GitHubLoginState {
    if (this.login) return this.state;
    this.set({ phase: "starting", code: null, url: null, message: null });
    const child = spawn(this.gh(), ["auth", "login", "--hostname", HOST, "--git-protocol", "https", "--web", "--skip-ssh-key"], {
      env: this.env(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.login = child;
    let output = "";
    const onData = (d: Buffer) => {
      output += d.toString();
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
        this.set({ phase: "error", message: output.trim().split("\n").slice(-3).join(" ") || `gh beendet mit Code ${exitCode}` });
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
    if (r.code !== 0) throw new ForgeError("INTERNAL", (r.stderr || r.stdout).trim() || "Abmelden fehlgeschlagen");
    this.set({ phase: "idle", code: null, url: null, message: null });
  }

  async repos(): Promise<GitHubRepo[]> {
    const r = await this.gh_(["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt,url"], 60_000);
    if (r.code !== 0) throw new ForgeError("INTERNAL", (r.stderr || r.stdout).trim() || "Repositories konnten nicht geladen werden");
    const list = JSON.parse(r.stdout) as Array<{ nameWithOwner: string; description: string | null; isPrivate: boolean; updatedAt: string; url: string }>;
    return list.map((x) => ({ fullName: x.nameWithOwner, description: x.description || null, private: x.isPrivate, updatedAt: x.updatedAt, cloneUrl: `${x.url}.git` }));
  }

  /**
   * Creates a GitHub repository for a local repo, adds it as origin and pushes the current branch.
   * Uses the signed-in account; never force-pushes.
   */
  async createRepo(dir: string, name: string, isPrivate: boolean): Promise<string> {
    const repoName = toRepoName(name);
    const r = await run(this.gh(), ["repo", "create", repoName, isPrivate ? "--private" : "--public", "--source", dir, "--remote", "origin", "--push"], {
      cwd: dir,
      env: this.env(),
      timeoutMs: 120_000,
    });
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "Repository konnte nicht erstellt werden");
    const url = /(https:\/\/github\.com\/[^\s]+)/.exec(r.stdout + r.stderr)?.[1] ?? null;
    return url ?? `https://github.com/${repoName}`;
  }

  shutdown() {
    this.login?.kill();
  }
}

/** GitHub repository names: letters, digits, dot, dash, underscore. */
export function toRepoName(name: string): string {
  return name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[.-]+/, "").slice(0, 100) || "projekt";
}
