import { ForgeError, type DevChannelState, type DevPromoteResult, type UpdateChannel } from "@forge/protocol";
import { resolveTool } from "../util/tools.js";
import { runGh, UPDATE_REPO } from "./app-update.js";
import { tr } from "../i18n/index.js";

export const DEV_BRANCH = "dev";
export const MAIN_BRANCH = "main";
/** Workflow that builds the releases of both branches (.github/workflows/release.yml). */
const RELEASE_WORKFLOW = "release.yml";
// The update check runs every 30 minutes; the access answer may be that old before GitHub is asked again.
const CACHE_MS = 10 * 60_000;
const MAX_COMMITS = 20;

type Gh = (args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface DevChannelDeps {
  /** the channel chosen in the settings */
  setting(): UpdateChannel;
  log(message: string): void;
  /** tests pass a fake */
  gh?: Gh;
  hasGh?: () => boolean;
  repo?: string;
}

const lastLine = (r: { stdout: string; stderr: string }) => (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-1)[0] ?? "";

/**
 * The dev channel: pre-releases built from the branch dev. Only an account that may push to the
 * repository (gh login) can switch to it and bring dev into main. The releases themselves are public;
 * the check keeps the channel to the people who work on FORGE.
 */
export class DevChannelService {
  private cached: { state: DevChannelState; at: number } | null = null;
  private readonly gh: Gh;
  private readonly hasGh: () => boolean;
  private readonly repo: string;

  constructor(private readonly d: DevChannelDeps) {
    this.gh = d.gh ?? runGh;
    this.hasGh = d.hasGh ?? (() => !!resolveTool("gh"));
    this.repo = d.repo ?? UPDATE_REPO;
  }

  async state(refresh = false): Promise<DevChannelState> {
    // Only a granted access is kept: after signing in to GitHub the next look should see it.
    if (!refresh && this.cached?.state.allowed && Date.now() - this.cached.at < CACHE_MS) return this.cached.state;
    const state = await this.load();
    this.cached = { state, at: Date.now() };
    return state;
  }

  /** After a GitHub login or logout: the next look asks GitHub again, also for a granted access. */
  forget(): void {
    this.cached = null;
  }

  /** The channel the update check uses: dev only while the account may use it. */
  async effective(): Promise<UpdateChannel> {
    if (this.d.setting() !== "dev") return "stable";
    const st = await this.state();
    if (!st.allowed) this.d.log(`Update: Dev-Kanal gewählt, aber nicht erlaubt (${st.reason}); geprüft wird main`);
    return st.allowed ? "dev" : "stable";
  }

  /** Throws unless the signed-in account may push to the repository; asks GitHub again. */
  async requireAccess(): Promise<DevChannelState> {
    const st = await this.state(true);
    if (!st.allowed) throw new ForgeError("POLICY_DENIED", st.message ?? tr().system.devChannel.noLogin);
    return st;
  }

  /**
   * Brings dev into main on GitHub: a fast-forward when main has nothing of its own, otherwise a merge
   * commit. With `release` the release workflow of main starts right away instead of at night.
   */
  async promote(release: boolean): Promise<DevPromoteResult> {
    const m = tr().system.devChannel;
    const st = await this.requireAccess();
    if (st.ahead === null) throw new ForgeError("VALIDATION", st.message ?? m.noDevBranch(this.repo));
    if (st.ahead === 0) return { mode: "none", sha: null, releaseStarted: false };
    let result: DevPromoteResult;
    try {
      result = st.behind === 0 ? await this.fastForward() : await this.merge();
    } finally {
      this.cached = null;
    }
    this.d.log(`Dev nach Main übernommen (${result.mode}, ${result.sha?.slice(0, 7) ?? "?"})`);
    if (!release) return result;
    const r = await this.gh(["api", "-X", "POST", `repos/${this.repo}/actions/workflows/${RELEASE_WORKFLOW}/dispatches`, "-f", `ref=${MAIN_BRANCH}`], 30_000);
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", m.releaseFailed(lastLine(r)));
    this.d.log("Release von main gestartet");
    return { ...result, releaseStarted: true };
  }

  private async fastForward(): Promise<DevPromoteResult> {
    const ref = await this.gh(["api", `repos/${this.repo}/git/ref/heads/${DEV_BRANCH}`, "--jq", ".object.sha"], 30_000);
    const sha = ref.stdout.trim();
    if (ref.code !== 0 || !sha) throw new ForgeError("GIT_FAILED", tr().system.devChannel.promoteFailed(lastLine(ref)));
    // force=false: GitHub refuses unless main is an ancestor of the dev commit.
    const r = await this.gh(["api", "-X", "PATCH", `repos/${this.repo}/git/refs/heads/${MAIN_BRANCH}`, "-f", `sha=${sha}`, "-F", "force=false"], 30_000);
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", tr().system.devChannel.promoteFailed(lastLine(r)));
    return { mode: "fast-forward", sha, releaseStarted: false };
  }

  private async merge(): Promise<DevPromoteResult> {
    const m = tr().system.devChannel;
    const r = await this.gh(
      ["api", "-X", "POST", `repos/${this.repo}/merges`, "-f", `base=${MAIN_BRANCH}`, "-f", `head=${DEV_BRANCH}`, "-f", "commit_message=Dev nach Main übernommen", "--jq", ".sha"],
      60_000,
    );
    if (r.code !== 0) throw new ForgeError("GIT_FAILED", /\b409\b|conflict/i.test(`${r.stderr}${r.stdout}`) ? m.conflict : m.promoteFailed(lastLine(r)));
    // 204 (nothing to merge) has no body
    const sha = r.stdout.trim() || null;
    return { mode: sha ? "merge" : "none", sha, releaseStarted: false };
  }

  private async load(): Promise<DevChannelState> {
    const m = tr().system.devChannel;
    const base: DevChannelState = { repo: this.repo, login: null, allowed: false, reason: "error", ahead: null, behind: null, commits: [], message: null, checkedAt: new Date().toISOString() };
    if (!this.hasGh()) return { ...base, reason: "no-gh", message: m.noGh };
    try {
      const token = await this.gh(["auth", "token"], 10_000);
      if (token.code !== 0 || !token.stdout.trim()) return { ...base, reason: "no-login", message: m.noLogin };
      const user = await this.gh(["api", "user", "--jq", ".login"], 30_000);
      const login = user.stdout.trim();
      if (user.code !== 0 || !login) return { ...base, reason: "no-login", message: m.noLogin };
      // permissions only comes with a token; for a public repository pull is true for everyone, push only for members.
      const repo = await this.gh(["api", `repos/${this.repo}`, "--jq", ".permissions.push"], 30_000);
      if (repo.code !== 0) return { ...base, login, message: m.failed(lastLine(repo)) };
      if (repo.stdout.trim() !== "true") return { ...base, login, reason: "no-access", message: m.noAccess(login, this.repo) };
      const allowed = { ...base, login, allowed: true, reason: "ok" as const };
      const cmp = await this.gh(["api", `repos/${this.repo}/compare/${MAIN_BRANCH}...${DEV_BRANCH}`], 30_000);
      if (cmp.code !== 0) return { ...allowed, message: /\b404\b|not found/i.test(`${cmp.stderr}${cmp.stdout}`) ? m.noDevBranch(this.repo) : m.failed(lastLine(cmp)) };
      const j = JSON.parse(cmp.stdout) as { ahead_by?: number; behind_by?: number; commits?: Array<{ commit?: { message?: string } }> };
      const commits = (j.commits ?? [])
        .map((c) => (c.commit?.message ?? "").split("\n")[0]!.trim())
        .filter(Boolean)
        .reverse()
        .slice(0, MAX_COMMITS);
      return { ...allowed, ahead: j.ahead_by ?? 0, behind: j.behind_by ?? 0, commits };
    } catch (e) {
      return { ...base, message: m.failed(e instanceof Error ? e.message : String(e)) };
    }
  }
}
