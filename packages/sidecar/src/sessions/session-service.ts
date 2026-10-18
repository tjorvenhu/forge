import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  Attachment,
  ContextUsage,
  EffortLevel,
  ExternalSession,
  KnowledgeEntry,
  PermissionMode,
  PlanUsage,
  RateLimitState,
  RemoteState,
  RuntimeInfo,
  ServerEvent,
  Session,
  SlashCommand,
} from "@forge/protocol";
import { ForgeError, idleClosedDetail } from "@forge/protocol";
import { transcriptImages, transcriptToolImages } from "../claude/attachments.js";
import type { ClaudeRuntime } from "../claude/runtime.js";
import { UploadStore } from "../claude/uploads.js";
import { describeUsage, limitWarning } from "../claude/usage.js";
import { ContextRecovery } from "./context-recovery.js";
import { findTask, TASK_EVENT_TYPES, taskNote, type TaskQuery } from "./task-message.js";
import { IdleClose } from "./idle-close.js";
import { HISTORY_PAGE_LIMIT, type Db } from "../persistence/db.js";
import type { GitEngine } from "../git/git.js";
import type { KnowledgeOverlap } from "../knowledge/knowledge.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { ApprovalGate } from "./approvals.js";
import { AutoContinue } from "./auto-continue.js";
import { ClaudeAssist } from "./claude-assist.js";
import { SessionLifecycle, type StartParams } from "./lifecycle.js";
import { BUSY } from "./live-session.js";
import { AgentRegistry, forgeSessionTools, type DailyReportText, type ProjectToolDeps } from "./forge-tools.js";
import { WorktreeService } from "../automation/worktrees.js";
import type { WorktreeSetup } from "../automation/worktree-setup.js";
import type { AgentFinisher } from "../automation/agent-finish.js";
import { AgentAutoMerge } from "../automation/agent-auto-merge.js";
import { pruneSubagentWorktrees } from "../automation/subagent-worktrees.js";
import { UiCompareService, type UiCompareDeps } from "../preview/ui-compare.js";
import { PermissionModes } from "./permission-mode.js";
import { RateLimitTracker } from "./rate-limit.js";
import { RemoteBridge } from "./remote-bridge.js";
import { RuntimeCatalog } from "./runtime-catalog.js";
import { SessionCore } from "./session-core.js";
import { SessionStream } from "./stream.js";
import { TitleRefresh } from "./titles.js";
import { TurnAutomation } from "./turn-automation.js";
import { TurnDispatch, type MessageSource } from "./turns.js";
import { UpdateResume } from "./update-resume.js";
import { tr } from "../i18n/index.js";

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
  private readonly worktrees: WorktreeService;
  private readonly idle: IdleClose;
  /** the session a phone call is about; set by app.ts once the phone exists */
  private callFocus: () => string | null = () => null;
  /** every message that reached a session, from FORGE or the Claude app (template learning) */
  private messageSeen: (source?: string) => void = () => {};
  /** knowledge and dev tools; set by app.ts once those services exist */
  private projectDeps: ProjectToolDeps | null = null;
  /** merges or discards agents; set by app.ts, it needs this service itself */
  private agentFinisher: AgentFinisher | null = null;
  /** merges finished agents in projects with auto-merge; built with the finisher */
  private agentAutoMerge: AgentAutoMerge | null = null;
  /** before/after screenshots around turns that change UI files; set by app.ts once the preview exists */
  private uiCompare: UiCompareService | null = null;
  /** the daily report as text for the tool daily_report; set by app.ts, the report needs this service */
  private dailyReport: DailyReportText | null = null;

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    git: GitEngine,
    private readonly runtime: ClaudeRuntime,
    emit: (e: ServerEvent) => void,
    /** wall clock; tests move it to simulate waiting and sleep */
    now: () => number = Date.now,
    /** where long texts and large attachments go for Claude to read; app.ts puts it into the data folder */
    uploads: UploadStore = new UploadStore(path.join(os.tmpdir(), "forge-uploads")),
  ) {
    const core = (this.core = new SessionCore(db, emit));
    const worktrees = (this.worktrees = new WorktreeService(git, projects));
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
      turnDone: async (id, testsOk) => {
        await this.agentAutoMerge?.turnDone(id, testsOk);
        await this.pruneSubagents(git, id);
      },
      turnStarted: (id) => this.uiCompare?.turnStarted(id),
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
        this.messageSeen("remote");
      },
    });
    this.titles = new TitleRefresh(core, runtime, this.assist, this.remote, now);
    this.turns = new TurnDispatch(core, this.automation, this.remote, {
      resume: (id, text, attachments, source, task) => this.lifecycle.resume(id, text, attachments, source, task),
      userMessage: (id, text, source) => {
        this.titles.note(id, text, source);
        this.messageSeen(source);
      },
      spill: (name, data) => uploads.write(name, data),
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
    this.idle = new IdleClose(
      {
        minutes: () => db.getSettings().idleCloseMinutes,
        liveIds: () => [...core.live.keys()],
        inUse: (id) => this.inUse(id),
        close: (id) => this.lifecycle.close(id, idleClosedDetail()),
      },
      now,
    );
    core.onRecord = (id, body) => {
      this.idle.touch(id);
      if (body.type === "user.message" && body.source !== "auto") this.autoContinue.userInput(id);
      if (body.type === "tool.use") this.uiCompare?.toolUsed(id, body.name, body.input);
      else if (body.type === "turn.result") this.uiCompare?.turnEnded(id);
      else if (body.type === "status" && (body.status === "stopped" || body.status === "error")) this.uiCompare?.drop(id);
    };
    const stream = new SessionStream(core, {
      automation: this.automation,
      remote: this.remote,
      turns: this.turns,
      modes: this.modes,
      catalog: this.catalog,
      autoContinue: this.autoContinue,
      limits: this.limits,
      recovery: new ContextRecovery(core, this.turns, (p) => this.automation.track(p)),
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
          report: this.dailyReport,
          usage: async () => describeUsage(await this.catalog.planUsage(false), this.limits.state()),
          limitWarning: async () => limitWarning(await this.catalog.planUsage(false)),
        }),
    });
  }

  /** Knowledge and dev tools for sessions started from now on. */
  useProjectTools(deps: ProjectToolDeps) {
    this.projectDeps = deps;
  }

  /** Agents started from sessions (start_agent) get their worktree prepared like the main folder. */
  useWorktreeSetup(setup: WorktreeSetup) {
    this.worktrees.useSetup(setup);
  }

  /** Before/after screenshots of the web app around turns that change UI files. */
  useUiCompare(deps: Omit<UiCompareDeps, "enabled" | "session" | "record" | "emit" | "track">): UiCompareService {
    const core = this.core;
    this.uiCompare = new UiCompareService({
      ...deps,
      enabled: () => this.db.getSettings().uiCompare,
      session: (id) => this.db.getSession(id),
      record: core.record.bind(core),
      emit: core.emit,
      track: (p) => this.automation.track(p),
    });
    return this.uiCompare;
  }

  /** The tool daily_report for sessions started from now on. */
  useDailyReport(report: DailyReportText) {
    this.dailyReport = report;
  }

  private readonly pruning = new Set<string>();

  /** After a turn in a main project: Claude Code subagent worktrees whose work is merged go away. */
  private async pruneSubagents(git: GitEngine, sessionId: string) {
    const rec = this.db.getSession(sessionId);
    const project = rec ? this.projects.all().find((p) => p.id === rec.projectId) : null;
    if (!project?.exists || !project.gitEnabled || project.parentId || this.pruning.has(project.id)) return;
    this.pruning.add(project.id);
    try {
      await pruneSubagentWorktrees(git, project.path);
    } catch {
      // Tidying up only; the next turn tries again.
    } finally {
      this.pruning.delete(project.id);
    }
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

  summarizeDailyReport(prompt: string, cwd: string) {
    return this.assist.summarizeDailyReport(prompt, cwd);
  }

  suggestPullRequest(projectId: string) {
    return this.assist.suggestPullRequest(projectId);
  }

  draftKnowledgeMerge(projectId: string, entries: KnowledgeEntry[]) {
    return this.assist.mergeKnowledge(projectId, entries);
  }

  planKnowledgeMerge(projectId: string, entries: KnowledgeEntry[], pairs: KnowledgeOverlap[]) {
    return this.assist.planKnowledgeMerge(projectId, entries, pairs);
  }

  draftKnowledgeFix(projectId: string, ctx: Parameters<ClaudeAssist["fixKnowledge"]>[1]) {
    return this.assist.fixKnowledge(projectId, ctx);
  }

  // ---------- lifecycle

  start(params: StartParams): Promise<Session> {
    return this.lifecycle.start(params);
  }

  resume(sessionId: string, prompt: string | null, attachments: Attachment[] = []): Promise<Session> {
    return this.lifecycle.resume(sessionId, prompt, attachments);
  }

  send(sessionId: string, text: string, attachments: Attachment[] = [], source?: MessageSource): Promise<Session> {
    return this.turns.send(sessionId, text, attachments, source);
  }

  stop(sessionId: string): Promise<Session> {
    this.autoContinue.cancel(sessionId, tr().core.sessions.autoContinueStopped);
    return this.lifecycle.stop(sessionId);
  }

  // ---------- automatic continuation after a usage limit

  cancelAutoContinue(sessionId: string): Session {
    this.get(sessionId);
    this.autoContinue.cancel(sessionId, tr().core.sessions.autoContinueCancelled);
    return this.get(sessionId);
  }

  /** Switching the setting off drops all pending plans right away instead of at the next check. */
  settingsChanged() {
    if (!this.db.getSettings().autoContinueAfterLimit) this.autoContinue.cancelAll(tr().core.sessions.autoContinueOff);
  }

  /** Starts the periodic checks (due continuations, passed limit resets, idle processes); the app calls this once. */
  startBackgroundChecks() {
    this.autoContinue.start(() => this.limits.tick());
    this.idle.start();
  }

  /** Ends the processes of idle sessions now; the periodic check calls the same. Returns their ids. */
  checkIdle(): string[] {
    return this.idle.check();
  }

  /** Hears of every message that reached a session; source "auto" for FORGE's own. */
  useMessageListener(listener: (source?: string) => void) {
    this.messageSeen = listener;
  }

  /** The phone tells which session a running call is about; its process stays open meanwhile. */
  useCallFocus(focus: () => string | null) {
    this.callFocus = focus;
  }

  /** Something still needs the session's process, so the idle check leaves it open. */
  private inUse(id: string): boolean {
    const live = this.core.live.get(id);
    if (!live || live.closing) return true;
    if (live.turnActive || live.pending.size > 0 || live.background.size > 0 || live.subagents.size > 0) return true;
    if ([...BUSY, "stopping"].includes(this.db.getSession(id)?.status ?? "stopped")) return true;
    if (this.automation.isBusy(id) || this.lifecycle.isAttaching(id) || this.turns.isSending(id)) return true;
    if (this.db.getAutoContinue(id)?.dueAt) return true;
    if (this.callFocus() === id) return true;
    // A session waits for the parallel agents it started; their results reach it as messages.
    return this.db.listSessionChildren(id).some((c) => {
      const child = this.core.live.get(c);
      return !!child && (child.turnActive || child.background.size > 0 || BUSY.includes(this.db.getSession(c)?.status ?? "stopped"));
    });
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
    this.uiCompare?.drop(sessionId);
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
    this.idle.stop();
    this.titles.shutdown();
    this.agentAutoMerge?.dispose();
    this.lifecycle.shutdown(forUpdate ? tr().core.sessions.forgeUpdating : undefined);
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
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", tr().core.sessions.notActive);
    if (this.db.getSession(sessionId)?.status === "running") throw new ForgeError("SESSION_BUSY", tr().core.sessions.stopBeforeReset);
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
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", tr().core.sessions.notFound);
    const ev = this.db.getEvent(sessionId, seq);
    const body = ev?.body;
    if (body?.type === "tool.result" && body.toolUseId) {
      if (!rec.claudeSessionId) throw new ForgeError("NOT_FOUND", tr().core.sessions.imageNotYet);
      const images = transcriptToolImages(await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd), body.toolUseId);
      if (!images) throw new ForgeError("NOT_FOUND", tr().core.sessions.imageMissing);
      return images;
    }
    if (body?.type !== "user.message" || !body.uuid) throw new ForgeError("VALIDATION", tr().core.sessions.noAttachments);
    if (!rec.claudeSessionId) throw new ForgeError("NOT_FOUND", tr().core.sessions.imageNotYet);
    const images = transcriptImages(await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd), body.uuid);
    if (!images) throw new ForgeError("NOT_FOUND", tr().core.sessions.imageMissing);
    return images;
  }

  /** Stops one background task or subagent of a running session. */
  async stopTask(sessionId: string, taskId: string) {
    const live = this.core.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", tr().core.sessions.notActive);
    await live.rt.stopTask(taskId);
    return { ok: true };
  }

  /**
   * A message to a background task (subagent or command), running or ended. It goes to the session
   * like any message, with a note naming the task; sent mid-turn it joins the turn or waits as usual.
   */
  async messageTask(sessionId: string, q: TaskQuery, text: string): Promise<Session> {
    if (!q.taskId && !q.toolUseId) throw new ForgeError("VALIDATION", tr().core.sessions.whichTask);
    this.get(sessionId);
    const target = findTask(this.core.db.listEventsOfTypes(sessionId, TASK_EVENT_TYPES), this.core.live.get(sessionId) ?? null, q);
    if (!target) throw new ForgeError("NOT_FOUND", tr().core.sessions.taskNotFound);
    return this.turns.send(sessionId, text, [], undefined, { ref: target.ref, note: taskNote(target) });
  }

  /** What a background command printed so far (its last 8 KiB). */
  async taskOutput(sessionId: string, taskId: string) {
    const live = this.core.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", tr().core.sessions.notActive);
    return live.rt.taskOutput(taskId);
  }

  /** Moves running foreground work into the background, so the turn goes on (Ctrl+B in the terminal). */
  async toBackground(sessionId: string, toolUseId?: string) {
    const live = this.core.live.get(sessionId);
    if (!live) throw new ForgeError("SESSION_NOT_FOUND", tr().core.sessions.notActive);
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
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", tr().core.sessions.notFound);
    if (BUSY.includes(rec.status)) throw new ForgeError("SESSION_BUSY", tr().core.sessions.stopBeforeFork);
    if (!rec.claudeSessionId) throw new ForgeError("VALIDATION", tr().core.sessions.noClaudeHistory);
    let prompt: string | null = null;
    let promptUuid: string | null = null;
    /** undefined: copy everything; null: nothing before the prompt */
    let upTo: string | null | undefined;
    if (opts.beforeSeq !== undefined) {
      const ev = this.db.getEvent(sessionId, opts.beforeSeq);
      if (ev?.body.type !== "user.message" || !ev.body.uuid) throw new ForgeError("VALIDATION", tr().core.sessions.cannotForkHere);
      prompt = ev.body.text;
      promptUuid = ev.body.uuid;
      const messages = (await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd)) as Array<{ uuid?: unknown }>;
      const i = messages.findIndex((m) => m.uuid === promptUuid);
      if (i < 0) throw new ForgeError("VALIDATION", tr().core.sessions.messageGoneClear);
      upTo = i > 0 ? String(messages[i - 1]!.uuid) : null;
    }
    let filesChanged: string[] | null = null;
    if (opts.rewindFiles && promptUuid) {
      const r = await this.rewind(sessionId, promptUuid, false);
      filesChanged = r.canRewind ? r.filesChanged : [];
    }
    if (upTo === null) return { session: null, prompt, filesChanged };
    const title = tr().core.sessions.forkTitle(rec.title ?? "Session");
    const claudeSessionId = await this.runtime.forkTranscript(rec.claudeSessionId, rec.cwd, upTo ?? null, title);
    const now = new Date().toISOString();
    const branch = { ...rec, id: randomUUID(), claudeSessionId, title, status: "stopped" as const, apiKeySource: null, createdAt: now, updatedAt: now, lastError: null };
    this.db.insertSession(branch);
    this.db.copyEvents(sessionId, branch.id, opts.beforeSeq);
    this.core.publish(branch);
    return { session: this.get(branch.id), prompt, filesChanged };
  }

  /**
   * An edited prompt: a running turn stops, Claude's conversation goes back to before the prompt and
   * goes on with `text` in the same session. The timeline keeps the old part; the chat hides it.
   */
  async edit(sessionId: string, seq: number, text: string): Promise<Session> {
    const rec = this.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", tr().core.sessions.notFound);
    const ev = this.db.getEvent(sessionId, seq);
    if (ev?.body.type !== "user.message" || ev.body.source === "auto") throw new ForgeError("VALIDATION", tr().core.sessions.cannotEdit);
    if (!text.trim()) throw new ForgeError("VALIDATION", tr().core.sessions.messageEmpty);
    /** the transcript entry before the prompt; null: the prompt was the first, the conversation starts over */
    let resumeAt: string | null = null;
    if (rec.claudeSessionId) {
      const uuid = ev.body.uuid;
      const messages = (await this.runtime.sessionHistory(rec.claudeSessionId, rec.cwd)) as Array<{ uuid?: unknown }>;
      const i = uuid ? messages.findIndex((m) => m.uuid === uuid) : -1;
      if (i < 0) throw new ForgeError("VALIDATION", tr().core.sessions.messageGoneCompact);
      resumeAt = i > 0 ? String(messages[i - 1]!.uuid) : null;
    }
    return this.lifecycle.restartAt(sessionId, resumeAt, text, () => this.core.record(sessionId, { type: "message.edited", fromSeq: seq }));
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
    const text = enabled ? tr().core.sessions.gitOn : tr().core.sessions.gitOff;
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
