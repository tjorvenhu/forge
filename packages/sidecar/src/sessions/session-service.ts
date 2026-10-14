import { randomUUID } from "node:crypto";
import type {
  Attachment,
  ContextUsage,
  EffortLevel,
  ExternalSession,
  PermissionMode,
  PlanUsage,
  RateLimitState,
  RemoteState,
  RuntimeInfo,
  ServerEvent,
  Session,
  SlashCommand,
} from "@forge/protocol";
import { ForgeError } from "@forge/protocol";
import { transcriptImages } from "../claude/attachments.js";
import type { ClaudeRuntime } from "../claude/runtime.js";
import { HISTORY_PAGE_LIMIT, type Db } from "../persistence/db.js";
import type { GitEngine } from "../git/git.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { ApprovalGate } from "./approvals.js";
import { AutoContinue } from "./auto-continue.js";
import { ClaudeAssist } from "./claude-assist.js";
import { SessionLifecycle, type StartParams } from "./lifecycle.js";
import { BUSY } from "./live-session.js";
import { AgentRegistry, forgeSessionTools, type ProjectToolDeps } from "./forge-tools.js";
import { WorktreeService } from "../automation/worktrees.js";
import type { AgentFinisher } from "../automation/agent-finish.js";
import { AgentAutoMerge } from "../automation/agent-auto-merge.js";
import { PermissionModes } from "./permission-mode.js";
import { RateLimitTracker } from "./rate-limit.js";
import { RemoteBridge } from "./remote-bridge.js";
import { RuntimeCatalog } from "./runtime-catalog.js";
import { SessionCore } from "./session-core.js";
import { SessionStream } from "./stream.js";
import { TitleRefresh } from "./titles.js";
import { TurnAutomation } from "./turn-automation.js";
import { TurnDispatch } from "./turns.js";
import { UpdateResume } from "./update-resume.js";

/** Entry point for everything session related; wires the session modules and keeps the public API in one place. */
/** how long a scan of terminal transcripts is reused */
const EXTERNAL_CACHE_MS = 20_000;

export class SessionService {
  private readonly core: SessionCore;
  private readonly assist: ClaudeAssist;
  private readonly catalog: RuntimeCatalog;
  private readonly automation: TurnAutomation;
  private readonly remote: RemoteBridge;
  private readonly turns: TurnDispatch;
  private readonly modes: PermissionModes;
  private readonly approvals: ApprovalGate;
  private readonly lifecycle: SessionLifecycle;
  private readonly autoContinue: AutoContinue;
  private readonly updateResume: UpdateResume;
  private readonly limits: RateLimitTracker;
  private readonly titles: TitleRefresh;
  private readonly agents: AgentRegistry;
  /** knowledge and dev tools; set by app.ts once those services exist */
  private projectDeps: ProjectToolDeps | null = null;
  /** merges or discards agents; set by app.ts, it needs this service itself */
  private agentFinisher: AgentFinisher | null = null;
  /** merges finished agents in projects with auto-merge; built with the finisher */
  private agentAutoMerge: AgentAutoMerge | null = null;

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    git: GitEngine,
    private readonly runtime: ClaudeRuntime,
    emit: (e: ServerEvent) => void,
    /** wall clock; tests move it to simulate waiting and sleep */
    now: () => number = Date.now,
  ) {
    const core = (this.core = new SessionCore(db, emit));
    const worktrees = new WorktreeService(git, projects);
    this.agents = new AgentRegistry(db);
    const record = core.record.bind(core);
    this.limits = new RateLimitTracker(emit, now);
    this.assist = new ClaudeAssist(db, projects, git, runtime);
    this.catalog = new RuntimeCatalog(core, projects, runtime, now);
    this.automation = new TurnAutomation(db, projects, git, {
      record,
      emit,
      suggestCommitMessage: (projectId, paths) => this.assist.suggestCommitMessage(projectId, paths),
      testEnv: (projectId) => this.projectDeps?.dev.testCommandEnv(projectId) ?? {},
      turnDone: async (id, testsOk) => this.agentAutoMerge?.turnDone(id, testsOk),
    });
    this.remote = new RemoteBridge(db, projects, runtime, {
      live: (id) => core.live.get(id),
      liveIds: () => [...core.live.keys()],
      record,
      emit,
      turnStarted: (id, live, fromRemote) => this.turns.cliTurnStarted(id, live, fromRemote),
      userMessage: (id, text) => {
        this.turns.titleFromFirstMessage(id, text);
        this.titles.note(id, text, "remote");
      },
    });
    this.titles = new TitleRefresh(core, runtime, this.assist, this.remote, now);
    this.turns = new TurnDispatch(core, this.automation, this.remote, {
      resume: (id, text, attachments, source) => this.lifecycle.resume(id, text, attachments, source),
      userMessage: (id, text, source) => this.titles.note(id, text, source),
    });
    this.modes = new PermissionModes(core, projects, { reopen: (id) => this.lifecycle.resume(id, null) });
    this.approvals = new ApprovalGate(core, git, {
      abortReason: (id) => this.remote.abortReason(id),
      syncPermissionMode: (id, mode) => this.modes.sync(id, mode),
      projectTags: (id) => {
        const rec = db.getSession(id);
        return (rec && db.getProject(rec.projectId)?.tags) ?? [];
      },
    });
    this.autoContinue = new AutoContinue(
      db,
      {
        record,
        publish: (id) => core.publish(db.getSession(id)),
        enabled: () => db.getSettings().autoContinueAfterLimit,
        planUsage: () => this.catalog.planUsage(true),
        isBusy: (id) => [...BUSY, "stopping"].includes(db.getSession(id)?.status ?? "stopped"),
        send: (id, text) => this.lifecycle.resume(id, text, [], "auto"),
        track: (p) => this.automation.track(p),
      },
      now,
    );
    this.updateResume = new UpdateResume(
      db,
      {
        live: () =>
          [...core.live].map(([id, l]) => ({ id, working: l.turnActive || l.background.size > 0 || l.subagents.size > 0 })),
        isLive: (id) => core.live.has(id),
        record,
        resume: (id, prompt) => this.lifecycle.resume(id, prompt, [], prompt === null ? undefined : "auto"),
        track: (p) => this.automation.track(p),
        version: process.env.FORGE_APP_VERSION ?? null,
      },
      now,
    );
    // User messages arrive from FORGE, the phone and the Claude app; each one ends a pending plan.
    core.onRecord = (id, body) => {
      if (body.type === "user.message" && body.source !== "auto") this.autoContinue.userInput(id);
    };
    const stream = new SessionStream(core, {
      automation: this.automation,
      remote: this.remote,
      turns: this.turns,
      modes: this.modes,
      catalog: this.catalog,
      autoContinue: this.autoContinue,
      limits: this.limits,
    });
    this.lifecycle = new SessionLifecycle(core, projects, runtime, {
      automation: this.automation,
      remote: this.remote,
      turns: this.turns,
      approvals: this.approvals,
      stream,
      catalog: this.catalog,
      sessionTools: (rec) =>
        forgeSessionTools(rec, {
          db,
          projects,
          worktrees,
          agents: this.agents,
          start: (p) => this.start(p),
          send: (id, text) => this.send(id, text),
          record,
          emit,
          project: this.projectDeps,
          finisher: this.agentFinisher,
        }),
    });
  }

  /** Knowledge and dev tools for sessions started from now on. */
  useProjectTools(deps: ProjectToolDeps) {
    this.projectDeps = deps;
  }

  /** finish_agent for sessions started from now on, and auto-merge of finished agents. */
  useAgentFinisher(finisher: AgentFinisher) {
    this.agentFinisher = finisher;
    const core = this.core;
    this.agentAutoMerge = new AgentAutoMerge({
      db: this.db,
      projects: this.projects,
      finisher,
      record: core.record.bind(core),
      emit: core.emit,
      parentOf: (id) => {
        const rec = this.db.getSession(id);
        return rec ? this.agents.parent(rec) : null;
      },
      hasBackground: (id) => (core.live.get(id)?.background.size ?? 0) > 0,
    });
  }

  // ---------- queries

  get(id: string): Session {
    return this.core.get(id);
  }

  async list(projectId: string): Promise<{ sessions: Session[]; external: ExternalSession[] }> {
    const project = this.projects.get(projectId);
    const sessions = this.db.listSessions(projectId).map((r) => this.core.toSession(r));
    let external: ExternalSession[] = [];
    if (project.exists) {
      const known = new Set(sessions.map((s) => s.claudeSessionId).filter(Boolean));
      try {
        external = (await this.externalSessions(project.path)).filter((e) => !known.has(e.claudeSessionId));
      } catch {
        external = [];
      }
    }
    return { sessions, external };
  }

  /** Transcript scans per project folder, briefly cached: the list is asked for often, the files change rarely. */
  private readonly externalCache = new Map<string, { at: number; list: Promise<ExternalSession[]> }>();

  private externalSessions(dir: string): Promise<ExternalSession[]> {
    const hit = this.externalCache.get(dir);
    if (hit && Date.now() - hit.at < EXTERNAL_CACHE_MS) return hit.list;
    const list = this.runtime.listSessions(dir);
    this.externalCache.set(dir, { at: Date.now(), list });
    list.catch(() => this.externalCache.delete(dir));
    return list;
  }

  listAll(query?: string, status?: string) {
    return this.db.listAllSessions(query, status).map((r) => ({ ...this.core.toSession(r), projectName: r.projectName }));
  }

  /** Sessions with a running CLI process, across all projects (for the session tabs). */
  listLive() {
    return [...this.core.live.keys()].flatMap((id) => {
      const rec = this.db.getSession(id);
      return rec ? [{ ...this.core.toSession(rec), projectName: this.projects.get(rec.projectId).name }] : [];
    });
  }

  /** The newest events after afterSeq; older ones are paged with beforeSeq. */
  events(id: string, afterSeq?: number, beforeSeq?: number) {
    this.get(id);
    return this.db.listEvents(id, afterSeq, { beforeSeq, limit: HISTORY_PAGE_LIMIT });
  }

  /** Current context usage of a running session; without a process the last value measured. */
  async contextUsage(sessionId: string): Promise<ContextUsage | null> {
    const live = this.core.live.get(sessionId);
    if (!live) return this.db.getSessionContext(sessionId);
    try {
      live.context = await live.rt.contextUsage();
      this.db.setSessionContext(sessionId, live.context);
    } catch {
      /* keep the last known value */
    }
    return live.context;
  }

  // ---------- Claude Code runtime

  capabilities() {
    return this.catalog.capabilities();
  }

  planUsage(refresh: boolean): Promise<PlanUsage> {
    return this.catalog.planUsage(refresh);
  }

  runtimeInfo(): Promise<RuntimeInfo | null> {
    return this.catalog.runtimeInfo();
  }

  invalidateRuntimeInfo() {
    this.catalog.invalidate();
  }

  refreshClaudeLogin() {
    return this.catalog.refreshLogin();
  }

  commands(projectId: string | undefined): Promise<SlashCommand[]> {
    return this.catalog.commands(projectId);
  }

  suggestCommitMessage(projectId: string, paths?: string[]) {
    return this.assist.suggestCommitMessage(projectId, paths);
  }

  summarize(sessionId: string) {
    return this.assist.summarize(sessionId);
  }

  suggestPullRequest(projectId: string) {
    return this.assist.suggestPullRequest(projectId);
  }

  // ---------- lifecycle

  start(params: StartParams): Promise<Session> {
    return this.lifecycle.start(params);
  }

  resume(sessionId: string, prompt: string | null, attachments: Attachment[] = []): Promise<Session> {
    return this.lifecycle.resume(sessionId, prompt, attachments);
  }

  send(sessionId: string, text: string, attachments: Attachment[] = []): Promise<Session> {
    return this.turns.send(sessionId, text, attachments);
  }

  stop(sessionId: string): Promise<Session> {
    this.autoContinue.cancel(sessionId, "Session gestoppt.");
    return this.lifecycle.stop(sessionId);
  }

  // ---------- automatic continuation after a usage limit

  cancelAutoContinue(sessionId: string): Session {
    this.get(sessionId);
    this.autoContinue.cancel(sessionId, "Du hast das automatische Weitermachen abgebrochen.");
    return this.get(sessionId);
  }

  /** Switching the setting off drops all pending plans right away instead of at the next check. */
  settingsChanged() {
    if (!this.db.getSettings().autoContinueAfterLimit) this.autoContinue.cancelAll("Automatisches Weitermachen ist in den Einstellungen ausgeschaltet.");
  }

  /** Starts the periodic checks (due continuations, passed limit resets); the app calls this once. */
  startBackgroundChecks() {
    this.autoContinue.start(() => this.limits.tick());
  }

  /** Runs due continuations now; the periodic check calls the same. */
  checkAutoContinue() {
    return this.autoContinue.check();
  }

  rateLimit(): RateLimitState {
    return this.limits.state();
  }

  close(sessionId: string): Session {
    return this.lifecycle.close(sessionId);
  }

  closeProject(projectIds: string[]) {
    return this.lifecycle.closeProject(projectIds);
  }

  delete(sessionId: string, deleteTranscript: boolean) {
    // A deleted transcript must not come back as a terminal session from the cache.
    this.externalCache.clear();
    this.autoContinue.forget(sessionId);
    this.titles.forget(sessionId);
    return this.lifecycle.delete(sessionId, deleteTranscript);
  }

  /** Deletes every session. In parallel, because each live one may wait about 10 s for its process to end. */
  async deleteAll(deleteTranscript: boolean) {
    const ids = this.db.listSessionIds();
    const results = await Promise.allSettled(ids.map((id) => this.delete(id, deleteTranscript)));
    const deleted = ids.filter((_, i) => results[i]!.status === "fulfilled");
    const reason = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason as unknown;
    const error = reason === undefined ? null : reason instanceof Error ? reason.message : String(reason);
    return { deleted, failed: ids.length - deleted.length, error };
  }

  shutdown() {
    const forUpdate = this.updateResume.noteShutdown();
    this.updateResume.stop();
    this.autoContinue.stop();
    this.titles.shutdown();
    this.agentAutoMerge?.dispose();
    this.lifecycle.shutdown(forUpdate ? "FORGE wird aktualisiert" : undefined);
  }

  // ---------- restart for an update

  /** The desktop shell ends FORGE for an update next (or, with false, does not after all). */
  prepareUpdateRestart(on: boolean) {
    return this.updateResume.prepare(on);
  }

  /** Opens the sessions noted at the restart for an update; `holds` keeps them back while another step follows. */
  resumeAfterUpdate(holds?: () => boolean) {
    this.updateResume.start(holds);
  }

  /** Waits for post-turn work (tests, auto-commit) and other background work; used on shutdown and in tests. */
  drain() {
    return this.automation.drain();
  }

  /** Restores the files Claude changed after the given message (SDK file checkpointing). */
  async rewind(sessionId: string, messageUuid: string, dryRun: boolean) {
    if (!this.core.live.has(sessionId)) await this.resume(sessionId, null);
    const live = this.core.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", "Session ist nicht aktiv.");
    if (this.db.getSession(sessionId)?.status === "running") throw new ForgeError("SESSION_BUSY", "Erst stoppen, dann zurücksetzen.");
    const r = await live.rt.rewindFiles(messageUuid, dryRun);
    if (!dryRun && r.canRewind) this.core.record(sessionId, { type: "files.rewound", toMessageUuid: messageUuid, filesChanged: r.filesChanged });
    if (!dryRun) {
      const rec = this.db.getSession(sessionId);
      if (rec) this.core.emit({ event: "project.updated", payload: { projectId: rec.projectId } });
    }
    return r;
  }

  /**
   * FORGE keeps only name and size of attachments; the image data lives in the Claude Code transcript.
   * NOT_FOUND right after sending is normal: the CLI writes the message a moment later.
   */
  async images(sessionId: string, seq: number) {
    const rec = this.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    const ev = this.db.getEvent(sessionId, seq);
    if (ev?.body.type !== "user.message" || !ev.body.uuid) throw new ForgeError("VALIDATION", "Keine Nachricht mit Anhängen.");
    if (!rec.claudeSessionId) throw new ForgeError("NOT_FOUND", "Bild noch nicht im Verlauf.");
    const images = transcriptImages(await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd), ev.body.uuid);
    if (!images) throw new ForgeError("NOT_FOUND", "Bild nicht im Verlauf von Claude Code.");
    return images;
  }

  /** Stops one background task or subagent of a running session. */
  async stopTask(sessionId: string, taskId: string) {
    const live = this.core.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", "Session ist nicht aktiv.");
    await live.rt.stopTask(taskId);
    return { ok: true };
  }

  /** What a background command printed so far (its last 8 KiB). */
  async taskOutput(sessionId: string, taskId: string) {
    const live = this.core.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", "Session ist nicht aktiv.");
    return live.rt.taskOutput(taskId);
  }

  /** Moves running foreground work into the background, so the turn goes on (Ctrl+B in the terminal). */
  async toBackground(sessionId: string, toolUseId?: string) {
    const live = this.core.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", "Session ist nicht aktiv.");
    return { moved: await live.rt.toBackground(toolUseId) };
  }

  /**
   * A branch of the conversation: a new session with the history before `beforeSeq` (a prompt of the
   * user), or the whole history without it. The original stays as it is. With `rewindFiles` the
   * files go back to the state before that prompt first (forked transcripts carry no checkpoints).
   * Branching before the very first prompt is a fresh session: `session` is null then.
   */
  async fork(sessionId: string, opts: { beforeSeq?: number; rewindFiles?: boolean }): Promise<{ session: Session | null; prompt: string | null; filesChanged: string[] | null }> {
    const rec = this.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    if (BUSY.includes(rec.status)) throw new ForgeError("SESSION_BUSY", "Claude arbeitet noch. Erst stoppen, dann verzweigen.");
    if (!rec.claudeSessionId) throw new ForgeError("VALIDATION", "Diese Session hat noch keinen Verlauf bei Claude Code.");
    let prompt: string | null = null;
    let promptUuid: string | null = null;
    /** undefined: copy everything; null: nothing before the prompt */
    let upTo: string | null | undefined;
    if (opts.beforeSeq !== undefined) {
      const ev = this.db.getEvent(sessionId, opts.beforeSeq);
      if (ev?.body.type !== "user.message" || !ev.body.uuid) throw new ForgeError("VALIDATION", "An dieser Nachricht lässt sich nicht verzweigen.");
      prompt = ev.body.text;
      promptUuid = ev.body.uuid;
      const messages = (await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd)) as Array<{ uuid?: unknown }>;
      const i = messages.findIndex((m) => m.uuid === promptUuid);
      if (i < 0) throw new ForgeError("VALIDATION", "Die Nachricht steht nicht mehr im Verlauf von Claude Code (zum Beispiel nach /clear).");
      upTo = i > 0 ? String(messages[i - 1]!.uuid) : null;
    }
    let filesChanged: string[] | null = null;
    if (opts.rewindFiles && promptUuid) {
      const r = await this.rewind(sessionId, promptUuid, false);
      filesChanged = r.canRewind ? r.filesChanged : [];
    }
    if (upTo === null) return { session: null, prompt, filesChanged };
    const title = `${rec.title ?? "Session"} (Zweig)`;
    const claudeSessionId = await this.runtime.forkTranscript(rec.claudeSessionId, rec.cwd, upTo ?? null, title);
    const now = new Date().toISOString();
    const branch = { ...rec, id: randomUUID(), claudeSessionId, title, status: "stopped" as const, apiKeySource: null, createdAt: now, updatedAt: now, lastError: null };
    this.db.insertSession(branch);
    this.db.copyEvents(sessionId, branch.id, opts.beforeSeq);
    this.core.publish(branch);
    return { session: this.get(branch.id), prompt, filesChanged };
  }

  // ---------- settings of a session

  async setModel(sessionId: string, model: string): Promise<Session> {
    const live = this.core.live.get(sessionId);
    if (live) await live.rt.setModel(model);
    this.core.publish(this.db.updateSession(sessionId, { model }));
    return this.get(sessionId);
  }

  async setEffort(sessionId: string, effort: EffortLevel | null): Promise<Session> {
    const live = this.core.live.get(sessionId);
    if (live) await live.rt.setEffort(effort);
    this.core.publish(this.db.updateSession(sessionId, { effort }));
    return this.get(sessionId);
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<Session> {
    await this.modes.set(sessionId, mode);
    return this.get(sessionId);
  }

  /** Applies the project's current profile to its open sessions, also in the middle of a turn. */
  applyProjectProfile(projectId: string) {
    return this.modes.applyProjectProfile(projectId);
  }

  /** Running sessions of the project hear with their next message that git was switched on or off. */
  projectGitChanged(projectId: string, enabled: boolean) {
    const text = enabled
      ? "Der Nutzer hat Git für dieses Projekt in FORGE wieder eingeschaltet. git-Befehle sind wieder erlaubt. Parallele Agenten (start_agent) gibt es erst in einer neuen Session."
      : "Der Nutzer hat Git für dieses Projekt in FORGE ausgeschaltet. Führe ab jetzt keine git-Befehle mehr aus (kein git init, status, add, commit, branch, checkout, push), lege kein Repository an und schlage keine Commits, Branches oder Pull Requests vor. Starte keine parallelen Agenten (start_agent).";
    for (const id of this.core.live.keys()) {
      if (this.db.getSession(id)?.projectId === projectId) this.automation.hint(id, text);
    }
  }

  // ---------- approvals

  respondApproval(sessionId: string, requestId: string, decision: "allow" | "deny", scope: "once" | "session", message?: string, answers?: Record<string, string>) {
    return this.approvals.respond(sessionId, requestId, decision, scope, message, answers);
  }

  // ---------- Remote Control (Claude app / claude.ai), global for all running sessions

  remoteState(): RemoteState {
    return this.remote.state();
  }

  remoteStart(): Promise<RemoteState> {
    return this.remote.start();
  }

  remoteStop(): Promise<RemoteState> {
    return this.remote.stop();
  }
}
