import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  ForgeError,
  type Attachment,
  type SlashCommand,
  type ExternalSession,
  type PermissionMode,
  type PlanUsage,
  type RemoteSession,
  type RemoteState,
  type RuntimeInfo,
  type ServerEvent,
  type Session,
  type SessionEventBody,
  type SessionStatus,
} from "@forge/protocol";
import type { ApprovalDecision, ApprovalRequest, ClaudeRuntime, OutgoingMessage, RuntimeSession, SessionSink } from "../claude/runtime.js";
import { buildAttachmentBlocks } from "../claude/attachments.js";
import { Normalizer } from "../claude/normalize.js";
import { locateClaude, sessionEnv } from "../claude/environment.js";
import type { Db, SessionRecord } from "../persistence/db.js";
import { isArtifactPath, isSensitiveFile, type GitEngine } from "../git/git.js";
import { runUserCommand } from "../util/shell.js";
import { buildCommitPrompt, cleanCommitMessage } from "../git/commit-message.js";
import { checkToolUse, writesOutsideProject } from "../policy/guard.js";
import { effectivePermissionMode, PROFILES, resolveProfile, type ProfileConfig } from "../policy/profiles.js";
import { redact, redactText } from "../policy/redact.js";
import type { ProjectManager } from "../projects/project-manager.js";

interface PendingApproval {
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

interface LiveSession {
  rt: RuntimeSession;
  normalizer: Normalizer;
  pending: Map<string, PendingApproval>;
  profile: ProfileConfig;
  projectDir: string;
  /** set by stop(); a result after an interrupt is not an error */
  interrupting: boolean;
  /** user message ids already in the timeline (own sends, imports, echoes) */
  seenUuids: Set<string>;
  /** a turn started by a message from the Claude app (Remote Control) */
  remoteTurn: { sawMessage: boolean } | null;
}

/** Title of a session that was opened empty for the Claude app; replaced by the first message. */
const REMOTE_PLACEHOLDER_TITLE = "Remote-Session";

/** Small, fast model: commit messages need speed more than depth. */
const COMMIT_MESSAGE_MODEL = "haiku";

const MODE_RANK: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };

export class SessionService {
  private live = new Map<string, LiveSession>();
  private initCache: SDKControlInitializeResponse | null = null;
  private cliCapabilities: string[] = [];
  /** from the latest system/init; null until a session has started */
  private mcpServers: Array<{ name: string; status: string }> | null = null;
  private usageCache: { at: number; value: PlanUsage } | null = null;

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    private readonly git: GitEngine,
    private readonly runtime: ClaudeRuntime,
    private readonly emit: (e: ServerEvent) => void,
  ) {}

  // ---------- queries

  private toSession(r: SessionRecord): Session {
    return { ...r, live: this.live.has(r.id) };
  }

  get(id: string): Session {
    const r = this.db.getSession(id);
    if (!r) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    return this.toSession(r);
  }

  async list(projectId: string): Promise<{ sessions: Session[]; external: ExternalSession[] }> {
    const project = this.projects.get(projectId);
    const sessions = this.db.listSessions(projectId).map((r) => this.toSession(r));
    let external: ExternalSession[] = [];
    if (project.exists) {
      const known = new Set(sessions.map((s) => s.claudeSessionId).filter(Boolean));
      try {
        external = (await this.runtime.listSessions(project.path)).filter((e) => !known.has(e.claudeSessionId));
      } catch {
        external = [];
      }
    }
    return { sessions, external };
  }

  listAll(query?: string, status?: string) {
    return this.db.listAllSessions(query, status).map((r) => ({ ...this.toSession(r), projectName: r.projectName }));
  }

  events(id: string, afterSeq?: number) {
    this.get(id);
    return this.db.listEvents(id, afterSeq);
  }

  capabilities() {
    return this.runtime.capabilities(this.initCache, this.cliCapabilities);
  }

  /** Drafts a commit message for the selected (or all) changed files with a one-shot Claude call. */
  async suggestCommitMessage(projectId: string, paths?: string[]) {
    const project = this.projects.requireExisting(projectId);
    const settings = this.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden.");
    const status = await this.git.status(project.path);
    const wanted = paths?.length ? new Set(paths) : null;
    const files = status.files.filter((f) => !wanted || wanted.has(f.path));
    if (!files.length) throw new ForgeError("VALIDATION", "Keine Änderungen für eine Commit-Nachricht.");
    const skipped = files.filter((f) => isSensitiveFile(f.path)).map((f) => f.path);
    const diffs = [];
    for (const f of files) {
      if (skipped.includes(f.path)) continue;
      diffs.push(await this.git.diff(project.path, f.path, f.staged && !f.unstaged));
    }
    const recent = (await this.git.log(project.path, 15)).map((c) => c.subject);
    const model = COMMIT_MESSAGE_MODEL;
    const raw = await this.runtime.complete(buildCommitPrompt(diffs, recent, skipped), {
      cwd: project.path,
      env: sessionEnv(settings.stripApiKey),
      claudePath,
      model,
    });
    const message = cleanCommitMessage(raw);
    if (!message) throw new ForgeError("CLAUDE_RUNTIME", "Claude hat keine Commit-Nachricht geliefert.");
    return { message, model, skipped };
  }

  /**
   * Short summary of a session for "where was I?", built only from the recorded transcript
   * (prompts, answers, tool calls, results). The UI labels it as generated by Claude.
   */
  async summarize(sessionId: string) {
    const rec = this.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    const settings = this.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden.");
    const lines: string[] = [];
    for (const e of this.db.listEvents(sessionId)) {
      const b = e.body;
      if (b.type === "user.message") lines.push(`NUTZER: ${b.text}`);
      else if (b.type === "assistant.text") lines.push(`CLAUDE: ${b.text}`);
      else if (b.type === "tool.use") lines.push(`TOOL ${b.name}: ${JSON.stringify(b.input).slice(0, 200)}`);
      else if (b.type === "turn.result") lines.push(`ERGEBNIS: ${b.isError ? "Fehler" : "fertig"}`);
      else if (b.type === "automation" && b.action === "commit" && b.ok) lines.push(`COMMIT: ${b.message}`);
      else if (b.type === "check.result") lines.push(`TESTS: ${b.ok ? "grün" : "rot"}`);
    }
    if (!lines.length) throw new ForgeError("VALIDATION", "Die Session hat noch keinen Verlauf.");
    const transcript = redactText(lines.join("\n")).slice(-30_000);
    const prompt = [
      "Fasse diese Claude-Code-Session für den Wiedereinstieg zusammen. Deutsch, höchstens 6 Stichpunkte:",
      "was das Ziel war, was erledigt ist, was offen ist, worauf als Nächstes zu achten ist.",
      "Nur Fakten aus dem Verlauf, nichts erfinden.",
      "",
      transcript,
    ].join("\n");
    const summary = await this.runtime.complete(prompt, { cwd: rec.cwd, env: sessionEnv(settings.stripApiKey), claudePath, model: COMMIT_MESSAGE_MODEL });
    return { summary: summary.trim(), model: COMMIT_MESSAGE_MODEL };
  }

  /** Drafts PR title and body from the branch's commits and diff against the default branch. */
  async suggestPullRequest(projectId: string) {
    const project = this.projects.requireExisting(projectId);
    const settings = this.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden.");
    const head = await this.git.currentBranch(project.path);
    if (!head) throw new ForgeError("GIT_FAILED", "Kein Branch ausgecheckt.");
    const base = await this.git.defaultBranch(project.path);
    const { commits, diff } = await this.git.rangeSummary(project.path, base);
    if (!commits.length) throw new ForgeError("VALIDATION", `Keine Commits gegenüber ${base}. Erst committen.`);
    const prompt = [
      "Schreibe Titel und Beschreibung für einen GitHub Pull Request.",
      "Format exakt:",
      "TITEL: <eine Zeile, höchstens 72 Zeichen>",
      "BESCHREIBUNG:",
      "<Markdown: kurze Zusammenfassung, dann Abschnitt '## Änderungen' mit Stichpunkten, dann '## Test' mit dem, was geprüft werden sollte>",
      "Nur beschreiben, was in Commits und Diff steht. Nichts erfinden. Sprache: wie die Commits.",
      "",
      `Branch: ${head} -> ${base}`,
      "Commits:",
      ...commits.map((c) => `- ${c}`),
      "",
      "Diff (gekürzt):",
      redactText(diff),
    ].join("\n");
    const raw = await this.runtime.complete(prompt, { cwd: project.path, env: sessionEnv(settings.stripApiKey), claudePath, model: COMMIT_MESSAGE_MODEL });
    const title = /TITEL:\s*(.+)/.exec(raw)?.[1]?.trim() ?? commits[0]!;
    const body = raw.split(/BESCHREIBUNG:\s*/)[1]?.trim() ?? raw.trim();
    return { title: title.slice(0, 256), body, base, head };
  }

  /** Plan usage, cached for a minute so frequent UI refreshes do not spawn a CLI each time. */
  async planUsage(refresh: boolean): Promise<PlanUsage> {
    if (!refresh && this.usageCache && Date.now() - this.usageCache.at < 60_000) return this.usageCache.value;
    const settings = this.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    const unavailable = (error: string): PlanUsage => ({ available: false, subscriptionType: null, windows: [], fetchedAt: new Date().toISOString(), error });
    if (!claudePath) return unavailable("Claude Code nicht gefunden");
    try {
      const value = await this.runtime.planUsage({ cwd: process.cwd(), env: sessionEnv(settings.stripApiKey), claudePath });
      this.usageCache = { at: Date.now(), value };
      return value;
    } catch (e) {
      return unavailable(e instanceof Error ? e.message.slice(0, 300) : String(e));
    }
  }

  async runtimeInfo(): Promise<RuntimeInfo | null> {
    if (!this.initCache) {
      const settings = this.db.getSettings();
      const claudePath = locateClaude(settings.claudePath);
      if (!claudePath) return null;
      try {
        this.initCache = await this.runtime.probe({ cwd: process.cwd(), env: sessionEnv(settings.stripApiKey), claudePath });
      } catch {
        return null;
      }
    }
    return { ...toRuntimeInfo(this.initCache), mcpServers: this.mcpServers ?? [] };
  }

  // ---------- lifecycle

  private setStatus(id: string, status: SessionStatus, detail: string | null = null, extra: Partial<SessionRecord> = {}) {
    const rec = this.db.updateSession(id, { status, ...extra });
    this.record(id, { type: "status", status, detail });
    if (rec) this.emit({ event: "session.updated", payload: this.toSession(rec) });
  }

  /** Persists (redacted) and broadcasts one event. Deltas are broadcast only. */
  private record(id: string, body: SessionEventBody) {
    if (body.type === "assistant.delta") {
      this.emit({ event: "session.event", payload: { seq: 0, sessionId: id, ts: new Date().toISOString(), body } });
      return;
    }
    const ev = this.db.appendEvent(id, redact(body));
    this.emit({ event: "session.event", payload: ev });
  }

  // ---------- turn automation (project tags)

  /** Files already changed before a turn; auto-commit never takes those (foreign dirty state). */
  private turnBaseline = new Map<string, Set<string>>();
  private turnWaiters = new Map<string, Array<(error: string | null) => void>>();
  private background = new Set<Promise<unknown>>();

  private track(p: Promise<unknown>) {
    const done = p.catch(() => {}).finally(() => this.background.delete(done));
    this.background.add(done);
  }

  /** Waits for post-turn work (tests, auto-commit) to finish; used on shutdown and in tests. */
  async drain() {
    while (this.background.size) await Promise.all([...this.background]);
  }

  /** Resolves when the current turn of the session finished (null) or failed (message). */
  waitForTurn(sessionId: string): Promise<string | null> {
    return new Promise((resolve) => {
      const list = this.turnWaiters.get(sessionId) ?? [];
      list.push(resolve);
      this.turnWaiters.set(sessionId, list);
    });
  }

  private settleTurn(sessionId: string, error: string | null) {
    const list = this.turnWaiters.get(sessionId);
    if (!list) return;
    this.turnWaiters.delete(sessionId);
    list.forEach((r) => r(error));
  }

  private async captureBaseline(sessionId: string, cwd: string) {
    try {
      const st = await this.git.status(cwd);
      this.turnBaseline.set(sessionId, new Set(st.files.map((f) => f.path)));
    } catch {
      this.turnBaseline.set(sessionId, new Set());
    }
  }

  /** Runs after every successful turn: git checkpoint, then tag behaviour (auto-test, auto-commit, auto-push). */
  private async afterTurn(sessionId: string) {
    const rec = this.db.getSession(sessionId);
    if (!rec) return;
    const project = this.projects.get(rec.projectId);
    const cwd = rec.cwd;
    let status;
    try {
      status = await this.git.status(cwd);
    } catch {
      return; // not a git repository: nothing to automate
    }
    const head = (await this.git.exec(cwd, ["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
    this.record(sessionId, { type: "git.checkpoint", head, branch: status.summary.branch, changedFiles: status.files.length });

    const tags = new Set(project.tags);
    const settings = this.db.getSettings();
    let testsOk = true;
    if (tags.has("auto-test") && project.testCommand) {
      this.record(sessionId, { type: "status", status: "idle", detail: `Tests laufen: ${project.testCommand}` });
      const r = await runUserCommand(project.testCommand, cwd, sessionEnv(settings.stripApiKey));
      testsOk = r.exitCode === 0 && !r.timedOut;
      this.record(sessionId, { type: "check.result", command: project.testCommand, ok: testsOk, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output });
    }

    if (!tags.has("auto-commit")) return;
    if (tags.has("review-required")) {
      this.record(sessionId, { type: "automation", action: "skip", ok: true, message: "Auto-Commit übersprungen: review-required verlangt eine Prüfung im Git-Bereich.", hash: null, files: [] });
      return;
    }
    if (!testsOk) {
      this.record(sessionId, { type: "automation", action: "skip", ok: false, message: "Auto-Commit übersprungen: Tests sind fehlgeschlagen.", hash: null, files: [] });
      return;
    }
    const baseline = this.turnBaseline.get(sessionId) ?? new Set<string>();
    const files = status.files
      .filter((f) => !baseline.has(f.path) && f.kind !== "conflicted" && !isSensitiveFile(f.path) && !isArtifactPath(f.path))
      .map((f) => f.path);
    if (!files.length) return;
    try {
      const { message } = await this.suggestCommitMessage(project.id, files);
      const r = await this.git.commit(cwd, message, files, false);
      this.record(sessionId, { type: "automation", action: "commit", ok: true, message: r.summary, hash: r.hash, files });
      this.emit({ event: "project.updated", payload: { projectId: project.id } });
      if (tags.has("auto-push")) {
        const branch = status.summary.branch;
        if (!branch || branch === "main" || branch === "master") {
          this.record(sessionId, { type: "automation", action: "skip", ok: true, message: `Auto-Push übersprungen: ${branch ?? "detached"} ist geschützt.`, hash: null, files: [] });
        } else {
          await this.git.push(cwd, false);
          this.record(sessionId, { type: "automation", action: "push", ok: true, message: `Gepusht: ${branch}`, hash: r.hash, files: [] });
        }
      }
    } catch (e) {
      this.record(sessionId, { type: "automation", action: "commit", ok: false, message: e instanceof Error ? e.message : String(e), hash: null, files });
    }
  }

  /** Builds the outgoing turn (text + attachment blocks + id) and records it in the timeline. */
  private async prepareTurn(sessionId: string, text: string, attachments: Attachment[]): Promise<OutgoingMessage> {
    const cwd = this.db.getSession(sessionId)?.cwd;
    if (cwd) await this.captureBaseline(sessionId, cwd);
    const { blocks, meta } = attachments.length ? await buildAttachmentBlocks(attachments) : { blocks: [], meta: [] };
    const uuid = randomUUID();
    this.live.get(sessionId)?.seenUuids.add(uuid);
    this.record(sessionId, { type: "user.message", text, uuid, ...(meta.length ? { attachments: meta } : {}) });
    this.titleFromFirstMessage(sessionId, text);
    return { text, blocks, uuid };
  }

  async start(params: {
    projectId: string;
    prompt: string;
    model?: string | null;
    planOnly?: boolean;
    resumeClaudeSessionId?: string;
    attachments?: Attachment[];
    /** run in another directory of the project (git worktree) */
    cwd?: string;
  }): Promise<Session> {
    const project = this.projects.requireExisting(params.projectId);
    const settings = this.db.getSettings();
    const profile = resolveProfile(project.profile, {
      autonomousUnlocked: settings.autonomousUnlocked,
      projectConfirmed: project.autonomousConfirmed,
    });
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden. Pfad in den Einstellungen prüfen.");

    const now = new Date().toISOString();
    const model = params.model ?? project.defaultModel ?? settings.defaultModel ?? null;
    const planOnly = params.planOnly ?? project.tags.includes("plan-first");
    const permissionMode = effectivePermissionMode(profile, planOnly);
    const rec: SessionRecord = {
      id: randomUUID(),
      projectId: project.id,
      claudeSessionId: params.resumeClaudeSessionId ?? null,
      cwd: params.cwd ?? project.path,
      title: titleFrom(params.prompt) || REMOTE_PLACEHOLDER_TITLE,
      model,
      profile: profile.id,
      permissionMode,
      status: "starting",
      apiKeySource: null,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.db.insertSession(rec);

    if (params.resumeClaudeSessionId) await this.importHistory(rec.id, params.resumeClaudeSessionId, project.path);

    // Idle sessions keep their CLI process but do not touch files; only busy ones can collide.
    const busy: SessionStatus[] = ["starting", "running", "waiting_approval"];
    const others = [...this.live.entries()].filter(
      ([id, l]) => l.projectDir === project.path && busy.includes(this.db.getSession(id)?.status ?? "stopped"),
    ).length;
    let first: OutgoingMessage | null;
    try {
      first = params.prompt ? await this.prepareTurn(rec.id, params.prompt, params.attachments ?? []) : null;
    } catch (e) {
      this.db.updateSession(rec.id, { status: "error", lastError: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    if (others > 0) {
      this.record(rec.id, {
        type: "status",
        status: "starting",
        detail: `Achtung: ${others} weitere Session(s) arbeiten gerade im selben Projektordner.`,
      });
    }
    this.attach(rec, profile, claudePath, settings.stripApiKey, params.resumeClaudeSessionId ?? null, first);
    return this.get(rec.id);
  }

  /** Continues a stored session (also after an app restart) with a new prompt. */
  async resume(sessionId: string, prompt: string | null, attachments: Attachment[] = []): Promise<Session> {
    const rec = this.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    if (this.live.has(sessionId)) return prompt === null ? this.get(sessionId) : this.send(sessionId, prompt, attachments);
    if (!rec.claudeSessionId) {
      throw new ForgeError("CLAUDE_RUNTIME", "Diese Session hat keine Claude-Session-ID und kann nicht fortgesetzt werden.");
    }
    if (!existsSync(rec.cwd)) throw new ForgeError("PATH_NOT_ACCESSIBLE", `Arbeitsverzeichnis existiert nicht mehr: ${rec.cwd}`);
    const project = this.projects.requireExisting(rec.projectId);
    const settings = this.db.getSettings();
    const profile = resolveProfile(project.profile, {
      autonomousUnlocked: settings.autonomousUnlocked,
      projectConfirmed: project.autonomousConfirmed,
    });
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden.");
    const permissionMode = rec.permissionMode === "plan" ? "plan" : profile.permissionMode;
    const first = prompt === null ? null : await this.prepareTurn(sessionId, prompt, attachments);
    this.db.updateSession(sessionId, { status: "starting", lastError: null, permissionMode });
    // The session keeps its original cwd even if the project moved; path assignment stays stable.
    this.attach({ ...rec, permissionMode, profile: profile.id }, profile, claudePath, settings.stripApiKey, rec.claudeSessionId, first);
    return this.get(sessionId);
  }

  /** Restores the files Claude changed after the given message (SDK file checkpointing). */
  async rewind(sessionId: string, messageUuid: string, dryRun: boolean) {
    if (!this.live.has(sessionId)) await this.resume(sessionId, null);
    const live = this.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", "Session ist nicht aktiv.");
    if (this.db.getSession(sessionId)?.status === "running") throw new ForgeError("SESSION_BUSY", "Erst stoppen, dann zurücksetzen.");
    const r = await live.rt.rewindFiles(messageUuid, dryRun);
    if (!dryRun && r.canRewind) this.record(sessionId, { type: "files.rewound", toMessageUuid: messageUuid, filesChanged: r.filesChanged });
    if (!dryRun) {
      const rec = this.db.getSession(sessionId);
      if (rec) this.emit({ event: "project.updated", payload: { projectId: rec.projectId } });
    }
    return r;
  }

  private commandCache = new Map<string, { at: number; value: SlashCommand[] }>();

  /** Slash commands for a project; from the live session when there is one, else a short probe. */
  async commands(projectId: string | undefined): Promise<SlashCommand[]> {
    const dir = projectId ? this.projects.requireExisting(projectId).path : process.cwd();
    const liveOne = [...this.live.values()].find((l) => l.projectDir === dir);
    if (liveOne) {
      try {
        return await liveOne.rt.supportedCommands();
      } catch {
        /* fall back to probe */
      }
    }
    const cached = this.commandCache.get(dir);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const settings = this.db.getSettings();
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) return [];
    const value = await this.runtime.commands({ cwd: dir, env: sessionEnv(settings.stripApiKey), claudePath });
    this.commandCache.set(dir, { at: Date.now(), value });
    return value;
  }

  private attach(
    rec: SessionRecord,
    profile: ProfileConfig,
    claudePath: string,
    stripApiKey: boolean,
    resume: string | null,
    first: OutgoingMessage | null,
  ) {
    const live: LiveSession = {
      rt: null as unknown as RuntimeSession,
      normalizer: new Normalizer(),
      pending: new Map(),
      profile,
      projectDir: rec.cwd,
      interrupting: false,
      seenUuids: new Set(this.db.listEvents(rec.id).flatMap((e) => (e.body.type === "user.message" && e.body.uuid ? [e.body.uuid] : []))),
      remoteTurn: null,
    };
    this.live.set(rec.id, live);
    const sink = this.sinkFor(rec.id, live);
    try {
      live.rt = this.runtime.startSession(
        {
          cwd: rec.cwd,
          model: rec.model,
          permissionMode: rec.permissionMode,
          resume,
          // no-network tag: web tools off regardless of profile
          disallowedTools: [...new Set([...profile.disallowedTools, ...(this.projects.get(rec.projectId).tags.includes("no-network") ? ["WebFetch", "WebSearch"] : [])])],
          env: sessionEnv(stripApiKey),
          claudePath,
          firstMessage: first,
        },
        sink,
      );
    } catch (e) {
      this.live.delete(rec.id);
      const msg = e instanceof Error ? e.message : String(e);
      this.record(rec.id, { type: "error", message: msg, retryable: true });
      this.setStatus(rec.id, "error", msg, { lastError: msg });
      throw new ForgeError("CLAUDE_RUNTIME", msg);
    }
    this.setStatus(rec.id, first ? "running" : "idle");
    if (this.remote.has(rec.projectId)) void this.bridge(rec.id);
    live.rt
      .initialization()
      .then((init) => {
        this.initCache = init;
      })
      .catch(() => {});
  }

  private sinkFor(id: string, live: LiveSession): SessionSink {
    return {
      onMessage: (msg) => {
        const m = msg as Record<string, unknown>;
        if (m.type === "system" && m.subtype === "init") {
          if (Array.isArray(m.capabilities)) this.cliCapabilities = m.capabilities.filter((c): c is string => typeof c === "string");
          if (Array.isArray(m.mcp_servers)) {
            this.mcpServers = m.mcp_servers.map((s: { name?: unknown; status?: unknown }) => ({
              name: String(s.name ?? ""),
              status: String(s.status ?? "unknown"),
            }));
          }
        }
        if (this.handleRemoteInput(id, live, m)) return;
        for (const body of live.normalizer.normalize(msg)) {
          this.record(id, body);
          if (body.type === "session.init") {
            const rec = this.db.updateSession(id, {
              claudeSessionId: body.claudeSessionId,
              model: body.model,
              apiKeySource: body.apiKeySource,
            });
            if (rec) this.emit({ event: "session.updated", payload: this.toSession(rec) });
          } else if (body.type === "turn.result") {
            const wasInterrupt = live.interrupting;
            live.interrupting = false;
            if (live.remoteTurn && !live.remoteTurn.sawMessage) void this.syncRemoteMessages(id, live);
            live.remoteTurn = null;
            const failed = body.isError && !wasInterrupt;
            this.setStatus(id, "idle", wasInterrupt ? "Gestoppt" : null, { lastError: failed ? body.text ?? body.subtype : null });
            const ok = !wasInterrupt && !body.isError;
            this.track((ok ? this.afterTurn(id) : Promise.resolve()).finally(() => this.settleTurn(id, ok ? null : body.text ?? (wasInterrupt ? "Gestoppt" : body.subtype))));
          }
        }
      },
      onApproval: (req, signal) => this.requestApproval(id, live, req, signal),
      preToolUse: async (toolName, input, toolUseId) => {
        const branch = await this.currentBranch(live.projectDir);
        const v = checkToolUse(toolName, input, {
          projectDir: live.projectDir,
          confineWritesToProject: live.profile.confineWritesToProject,
          currentBranch: branch,
        });
        if (v) {
          this.record(id, { type: "policy.blocked", toolUseId, toolName, rule: v.rule, message: v.message });
          this.db.recordApproval({
            sessionId: id,
            requestId: toolUseId ?? randomUUID(),
            toolName,
            input: redact(input),
            decision: "deny",
            scope: "once",
            source: "policy",
            reason: v.rule,
          });
        }
        return v;
      },
      onEnd: (error) => {
        this.dropRemoteSession(id);
        this.settleTurn(id, error ? describeRuntimeError(error) : "Session beendet");
        for (const p of live.pending.values()) p.resolve({ behavior: "deny", message: "Session beendet" });
        live.pending.clear();
        this.live.delete(id);
        if (error) {
          const msg = describeRuntimeError(error);
          this.record(id, { type: "error", message: msg, retryable: true });
          this.setStatus(id, "error", msg, { lastError: msg });
        } else {
          this.setStatus(id, "stopped");
        }
      },
    };
  }

  private async currentBranch(dir: string): Promise<string | null> {
    try {
      const r = await this.git.exec(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  private requestApproval(id: string, live: LiveSession, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const allowSessionScope = live.profile.allowSessionScope && !req.suppressAlwaysAllow;
    this.record(id, {
      type: "approval.request",
      requestId: req.requestId,
      toolUseId: req.toolUseId,
      toolName: req.toolName,
      input: req.input,
      title: req.title,
      description: req.description,
      reason: req.reason,
      allowSessionScope,
      outsideProject: writesOutsideProject(req.toolName, req.input, live.projectDir),
    });
    this.setStatus(id, "waiting_approval", req.title ?? req.toolName);
    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (d: ApprovalDecision, source: "user" | "abort", scope: "once" | "session") => {
        if (!live.pending.delete(req.requestId)) return;
        this.record(id, {
          type: "approval.resolved",
          requestId: req.requestId,
          decision: d.behavior,
          scope,
          source,
          message: d.behavior === "deny" ? d.message : null,
        });
        this.db.recordApproval({
          sessionId: id,
          requestId: req.requestId,
          toolName: req.toolName,
          input: redact(req.input),
          decision: d.behavior,
          scope,
          source,
          reason: d.behavior === "deny" ? d.message : null,
        });
        if (this.live.has(id) && live.pending.size === 0) this.setStatus(id, "running");
        resolve(d);
      };
      live.pending.set(req.requestId, {
        req,
        resolve: (d) => finish(d, "user", d.behavior === "allow" ? d.scope : "once"),
      });
      // With Remote Control the prompt may also have been answered in the Claude app.
      const aborted = this.remote.has(this.db.getSession(id)?.projectId ?? "") ? "In der Claude-App beantwortet oder abgebrochen" : "Abgebrochen";
      signal.addEventListener("abort", () => finish({ behavior: "deny", message: aborted }, "abort", "once"), { once: true });
    });
  }

  respondApproval(sessionId: string, requestId: string, decision: "allow" | "deny", scope: "once" | "session", message?: string) {
    const live = this.live.get(sessionId);
    const p = live?.pending.get(requestId);
    if (!live || !p) throw new ForgeError("NOT_FOUND", "Diese Freigabeanfrage ist nicht mehr offen.");
    if (scope === "session" && !(live.profile.allowSessionScope && !p.req.suppressAlwaysAllow)) {
      throw new ForgeError("POLICY_DENIED", "Für dieses Profil oder dieses Tool ist keine Freigabe für die ganze Session erlaubt.");
    }
    p.resolve(decision === "allow" ? { behavior: "allow", scope } : { behavior: "deny", message: message || "Vom Nutzer abgelehnt" });
    return { ok: true };
  }

  async send(sessionId: string, text: string, attachments: Attachment[] = []): Promise<Session> {
    const live = this.live.get(sessionId);
    if (!live) return this.resume(sessionId, text, attachments);
    if (live.pending.size > 0) throw new ForgeError("SESSION_BUSY", "Erst die offene Freigabeanfrage beantworten.");
    live.rt.sendMessage(await this.prepareTurn(sessionId, text, attachments));
    this.setStatus(sessionId, "running");
    return this.get(sessionId);
  }

  async stop(sessionId: string): Promise<Session> {
    const live = this.live.get(sessionId);
    if (!live) return this.get(sessionId);
    live.interrupting = true;
    for (const p of [...live.pending.values()]) p.resolve({ behavior: "deny", message: "Gestoppt" });
    this.setStatus(sessionId, "stopping");
    try {
      await live.rt.interrupt();
    } catch (e) {
      // If interrupt fails the process is in a bad state: end it so the UI is never stuck.
      live.rt.close();
      this.record(sessionId, { type: "error", message: `Stop fehlgeschlagen, Session beendet: ${describeRuntimeError(e)}`, retryable: false });
    }
    return this.get(sessionId);
  }

  /** Ends all open sessions of the given projects and waits until their CLI processes are gone. */
  async closeProject(projectIds: string[]) {
    const ids = new Set(projectIds);
    const open = () => [...this.live.keys()].filter((id) => ids.has(this.db.getSession(id)?.projectId ?? ""));
    for (const id of ids) if (this.remote.has(id)) await this.remoteStop(id);
    for (const id of open()) this.live.get(id)?.rt.close();
    for (let i = 0; i < 50 && open().length; i++) await new Promise((r) => setTimeout(r, 100));
  }

  close(sessionId: string): Session {
    const live = this.live.get(sessionId);
    if (live) live.rt.close();
    return this.get(sessionId);
  }

  async setModel(sessionId: string, model: string): Promise<Session> {
    const live = this.live.get(sessionId);
    if (live) await live.rt.setModel(model);
    const rec = this.db.updateSession(sessionId, { model });
    if (rec) this.emit({ event: "session.updated", payload: this.toSession(rec) });
    return this.get(sessionId);
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<Session> {
    const rec = this.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    const profile = PROFILES[rec.profile];
    if (MODE_RANK[mode] > MODE_RANK[profile.permissionMode]) {
      throw new ForgeError("POLICY_DENIED", `Das Profil ${profile.label} erlaubt den Modus ${mode} nicht.`);
    }
    const live = this.live.get(sessionId);
    if (live) await live.rt.setPermissionMode(mode);
    const updated = this.db.updateSession(sessionId, { permissionMode: mode });
    if (updated) this.emit({ event: "session.updated", payload: this.toSession(updated) });
    return this.get(sessionId);
  }

  // ---------- Remote Control (Claude app / claude.ai)

  /** projectId → bridged sessions; a project is in the map while Remote is switched on */
  private remote = new Map<string, Map<string, RemoteSession>>();

  remoteState(projectId: string): RemoteState {
    const sessions = this.remote.get(projectId);
    return { enabled: !!sessions, sessions: sessions ? [...sessions.values()] : [] };
  }

  private emitRemote(projectId: string) {
    this.emit({ event: "remote.updated", payload: { projectId, state: this.remoteState(projectId) } });
  }

  private setRemoteSession(sessionId: string, patch: Partial<RemoteSession>) {
    const rec = this.db.getSession(sessionId);
    const map = rec && this.remote.get(rec.projectId);
    if (!rec || !map) return;
    const cur: RemoteSession = map.get(sessionId) ?? { sessionId, title: rec.title ?? "", url: null, state: "connecting", message: null };
    map.set(sessionId, { ...cur, title: rec.title ?? "", ...patch });
    this.emitRemote(rec.projectId);
  }

  private dropRemoteSession(sessionId: string) {
    const rec = this.db.getSession(sessionId);
    const map = rec && this.remote.get(rec.projectId);
    if (rec && map?.delete(sessionId)) this.emitRemote(rec.projectId);
  }

  /**
   * Switches Remote Control on for a project: every open FORGE session of the project is connected to
   * the Claude app, so messages show up on both sides and FORGE's approvals and policy keep applying.
   * Without an open session FORGE opens an empty one that can be started from the phone.
   */
  async remoteStart(projectId: string): Promise<RemoteState> {
    this.projects.requireExisting(projectId);
    if (!this.remote.has(projectId)) this.remote.set(projectId, new Map());
    const open = [...this.live.keys()].filter((id) => this.db.getSession(id)?.projectId === projectId);
    if (open.length) await Promise.all(open.map((id) => this.bridge(id)));
    else await this.start({ projectId, prompt: "" });
    return this.remoteState(projectId);
  }

  async remoteStop(projectId: string): Promise<RemoteState> {
    const map = this.remote.get(projectId);
    this.remote.delete(projectId);
    for (const id of map?.keys() ?? []) {
      await this.live
        .get(id)
        ?.rt.setRemoteControl(false, "")
        .catch(() => {});
    }
    this.emitRemote(projectId);
    return this.remoteState(projectId);
  }

  private async bridge(sessionId: string) {
    const live = this.live.get(sessionId);
    const rec = this.db.getSession(sessionId);
    if (!live || !rec) return;
    const project = this.projects.get(rec.projectId);
    this.setRemoteSession(sessionId, { state: "connecting", message: null });
    const name = rec.title === REMOTE_PLACEHOLDER_TITLE ? `FORGE · ${project.name}` : `FORGE · ${project.name} · ${rec.title}`;
    try {
      const url = await live.rt.setRemoteControl(true, name.slice(0, 120));
      if (!this.remote.has(rec.projectId)) {
        // switched off while connecting
        await live.rt.setRemoteControl(false, name).catch(() => {});
        return;
      }
      this.setRemoteSession(sessionId, { url });
    } catch (e) {
      this.setRemoteSession(sessionId, { state: "error", message: describeRuntimeError(e) });
    }
  }

  /**
   * Remote Control input: the bridge status, a turn started by a message from the Claude app and the
   * echo of that message. Returns true when the message is fully handled here.
   */
  private handleRemoteInput(id: string, live: LiveSession, m: Record<string, unknown>): boolean {
    if (m.type === "system" && m.subtype === "bridge_state") {
      const state = typeof m.state === "string" ? m.state : "";
      if (state === "connected") this.setRemoteSession(id, { state: "connected", message: null });
      else if (state === "failed" || state === "error") this.setRemoteSession(id, { state: "error", message: typeof m.error === "string" ? m.error : null });
      else if (state === "disconnected" || state === "reconnecting") this.setRemoteSession(id, { state: "connecting" });
      return true;
    }
    if (m.type === "command_lifecycle") {
      if (m.state === "started" && typeof m.command_uuid === "string" && !live.seenUuids.has(m.command_uuid)) {
        live.remoteTurn = { sawMessage: false };
        const rec = this.db.getSession(id);
        if (rec) void this.captureBaseline(id, rec.cwd);
        if (rec?.status === "idle") this.setStatus(id, "running");
      }
      return true;
    }
    if (m.type === "user" && m.isReplay === true) {
      const uuid = typeof m.uuid === "string" ? m.uuid : null;
      if (!uuid || live.seenUuids.has(uuid) || m.isSynthetic === true) return true;
      const parsed = remoteUserContent((m.message as Record<string, unknown> | undefined)?.content);
      if (parsed) this.recordRemoteMessage(id, live, uuid, parsed);
      return true;
    }
    return false;
  }

  private recordRemoteMessage(id: string, live: LiveSession, uuid: string, msg: RemoteUserContent) {
    live.seenUuids.add(uuid);
    if (live.remoteTurn) live.remoteTurn.sawMessage = true;
    const attachments = msg.images.map((img, i) => ({ name: `Bild ${i + 1}`, mediaType: img.mediaType, size: img.size }));
    this.record(id, { type: "user.message", text: msg.text, uuid, source: "remote", ...(attachments.length ? { attachments } : {}) });
    this.titleFromFirstMessage(id, msg.text);
  }

  /** An empty session opened for the Claude app takes its title from the first message, from either side. */
  private titleFromFirstMessage(id: string, text: string) {
    const rec = this.db.getSession(id);
    if (rec?.title !== REMOTE_PLACEHOLDER_TITLE || !text.trim()) return;
    const updated = this.db.updateSession(id, { title: titleFrom(text) });
    if (updated) this.emit({ event: "session.updated", payload: this.toSession(updated) });
    this.setRemoteSession(id, {});
  }

  /** Fallback when the CLI did not echo a message from the Claude app: read it from the transcript. */
  private async syncRemoteMessages(id: string, live: LiveSession) {
    const rec = this.db.getSession(id);
    if (!rec?.claudeSessionId) return;
    try {
      const msgs = (await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd)) as Array<Record<string, unknown>>;
      const users = msgs.filter((m) => m.type === "user" && typeof m.uuid === "string");
      const lastSeen = users.map((m) => live.seenUuids.has(m.uuid as string)).lastIndexOf(true);
      for (const m of users.slice(lastSeen + 1)) {
        const parsed = remoteUserContent((m.message as Record<string, unknown> | undefined)?.content);
        if (parsed) this.recordRemoteMessage(id, live, m.uuid as string, parsed);
      }
    } catch {
      /* transcript not readable: the answer is still in the timeline */
    }
  }

  /** Imports the transcript of a session started outside FORGE so the timeline is complete. */
  private async importHistory(sessionId: string, claudeSessionId: string, dir: string) {
    try {
      const msgs = await this.runtime.sessionHistory(claudeSessionId, dir);
      const n = new Normalizer();
      for (const m of msgs) {
        const mm = m as Record<string, unknown>;
        if (mm.type === "user") {
          const content = (mm.message as Record<string, unknown> | undefined)?.content;
          if (typeof content === "string") this.record(sessionId, { type: "user.message", text: content, ...(typeof mm.uuid === "string" ? { uuid: mm.uuid } : {}) });
        }
        for (const body of n.normalize(m)) if (body.type !== "assistant.delta") this.record(sessionId, body);
      }
    } catch (e) {
      this.record(sessionId, { type: "error", message: `Verlauf konnte nicht importiert werden: ${describeRuntimeError(e)}`, retryable: false });
    }
  }

  shutdown() {
    for (const [id, l] of this.live) {
      try {
        l.rt.close();
      } catch {
        /* process may already be gone */
      }
      this.db.updateSession(id, { status: "stopped" });
    }
    this.live.clear();
  }
}

interface RemoteUserContent {
  text: string;
  images: Array<{ mediaType: string; size: number }>;
}

/** Text and images of a message typed in the Claude app; null for tool results and empty content. */
function remoteUserContent(content: unknown): RemoteUserContent | null {
  if (typeof content === "string") return content.trim() ? { text: content, images: [] } : null;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  const images: RemoteUserContent["images"] = [];
  for (const b of content as Array<Record<string, unknown> | null>) {
    if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b?.type === "image") {
      const src = (b.source ?? {}) as Record<string, unknown>;
      const data = typeof src.data === "string" ? src.data : "";
      images.push({ mediaType: typeof src.media_type === "string" ? src.media_type : "image", size: Math.floor((data.length * 3) / 4) });
    } else if (b?.type === "tool_result") return null;
  }
  const text = texts.join("\n");
  return text.trim() || images.length ? { text, images } : null;
}

function titleFrom(prompt: string): string {
  const first = prompt.trim().split(/\r?\n/)[0] ?? "";
  return first.length > 80 ? first.slice(0, 77) + "…" : first;
}

function describeRuntimeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not logged in|please run \/login|invalid api key|authentication/i.test(msg)) {
    return "Claude Code ist nicht angemeldet oder die Anmeldung ist ungültig. Im Terminal `claude auth login` ausführen.";
  }
  if (/ENOENT|failed to launch/i.test(msg)) return "Claude Code CLI konnte nicht gestartet werden. Pfad in den Einstellungen prüfen.";
  return msg.slice(0, 2000);
}

function toRuntimeInfo(init: SDKControlInitializeResponse): RuntimeInfo {
  return {
    models: (init.models ?? []).map((m) => ({ value: m.value, displayName: m.displayName, description: m.description })),
    commands: (init.commands ?? []).map((c) => ({ name: c.name, description: c.description })),
    agents: (init.agents ?? []).map((a) => ({ name: a.name, description: a.description })),
    mcpServers: [],
    account: { subscriptionType: init.account?.subscriptionType ?? null, apiProvider: init.account?.apiProvider ?? null },
  };
}
