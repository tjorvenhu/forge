import type {
  Attachment,
  ContextUsage,
  EffortLevel,
  ExternalSession,
  PermissionMode,
  PlanUsage,
  RemoteState,
  RuntimeInfo,
  ServerEvent,
  Session,
  SlashCommand,
} from "@forge/protocol";
import { ForgeError } from "@forge/protocol";
import type { ClaudeRuntime } from "../claude/runtime.js";
import type { Db } from "../persistence/db.js";
import type { GitEngine } from "../git/git.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { ApprovalGate } from "./approvals.js";
import { ClaudeAssist } from "./claude-assist.js";
import { SessionLifecycle, type StartParams } from "./lifecycle.js";
import { PermissionModes } from "./permission-mode.js";
import { RemoteBridge } from "./remote-bridge.js";
import { RuntimeCatalog } from "./runtime-catalog.js";
import { SessionCore } from "./session-core.js";
import { SessionStream } from "./stream.js";
import { TurnAutomation } from "./turn-automation.js";
import { TurnDispatch } from "./turns.js";

/** Entry point for everything session related; wires the session modules and keeps the public API in one place. */
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

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    git: GitEngine,
    private readonly runtime: ClaudeRuntime,
    emit: (e: ServerEvent) => void,
  ) {
    const core = (this.core = new SessionCore(db, emit));
    const record = core.record.bind(core);
    this.assist = new ClaudeAssist(db, projects, git, runtime);
    this.catalog = new RuntimeCatalog(core, projects, runtime);
    this.automation = new TurnAutomation(db, projects, git, {
      record,
      emit,
      suggestCommitMessage: (projectId, paths) => this.assist.suggestCommitMessage(projectId, paths),
    });
    this.remote = new RemoteBridge(db, projects, runtime, {
      live: (id) => core.live.get(id),
      liveIds: () => [...core.live.keys()],
      record,
      emit,
      turnStarted: (id, live, fromRemote) => this.turns.cliTurnStarted(id, live, fromRemote),
      titleFromFirstMessage: (id, text) => this.turns.titleFromFirstMessage(id, text),
      startEmpty: (projectId) => this.start({ projectId, prompt: "" }),
    });
    this.turns = new TurnDispatch(core, this.automation, this.remote, {
      resume: (id, text, attachments) => this.lifecycle.resume(id, text, attachments),
    });
    this.modes = new PermissionModes(core, projects);
    this.approvals = new ApprovalGate(core, git, {
      abortReason: (id) => this.remote.abortReason(id),
      syncPermissionMode: (id, mode) => this.modes.sync(id, mode),
    });
    const stream = new SessionStream(core, { automation: this.automation, remote: this.remote, turns: this.turns, modes: this.modes, catalog: this.catalog });
    this.lifecycle = new SessionLifecycle(core, projects, runtime, {
      automation: this.automation,
      remote: this.remote,
      turns: this.turns,
      approvals: this.approvals,
      stream,
      catalog: this.catalog,
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
        external = (await this.runtime.listSessions(project.path)).filter((e) => !known.has(e.claudeSessionId));
      } catch {
        external = [];
      }
    }
    return { sessions, external };
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
    return this.db.listEvents(id, afterSeq, { beforeSeq });
  }

  /** Current context usage of a running session; null when no process runs. */
  async contextUsage(sessionId: string): Promise<ContextUsage | null> {
    const live = this.core.live.get(sessionId);
    if (!live) return null;
    try {
      live.context = await live.rt.contextUsage();
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
    return this.lifecycle.stop(sessionId);
  }

  close(sessionId: string): Session {
    return this.lifecycle.close(sessionId);
  }

  closeProject(projectIds: string[]) {
    return this.lifecycle.closeProject(projectIds);
  }

  delete(sessionId: string, deleteTranscript: boolean) {
    return this.lifecycle.delete(sessionId, deleteTranscript);
  }

  shutdown() {
    this.lifecycle.shutdown();
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

  // ---------- approvals

  respondApproval(sessionId: string, requestId: string, decision: "allow" | "deny", scope: "once" | "session", message?: string, answers?: Record<string, string>) {
    return this.approvals.respond(sessionId, requestId, decision, scope, message, answers);
  }

  // ---------- Remote Control (Claude app / claude.ai)

  remoteState(projectId: string): RemoteState {
    return this.remote.state(projectId);
  }

  remoteStart(projectId: string): Promise<RemoteState> {
    return this.remote.start(projectId);
  }

  remoteStop(projectId: string): Promise<RemoteState> {
    return this.remote.stop(projectId);
  }

  // ---------- turn automation

  confirmAutoCommit(sessionId: string, requestId: string, commit: boolean) {
    return this.automation.confirm(sessionId, requestId, commit);
  }
}
