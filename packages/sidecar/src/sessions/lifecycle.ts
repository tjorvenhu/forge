import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { ForgeError, type Attachment, type EffortLevel, type Session } from "@forge/protocol";
import { fallbackFor, type ClaudeRuntime, type OutgoingMessage, type RuntimeSession, type SessionSink, type SessionTool } from "../claude/runtime.js";
import { Normalizer } from "../claude/normalize.js";
import { locateClaude, sessionEnv } from "../claude/environment.js";
import type { SessionRecord } from "../persistence/db.js";
import { blockedTools, effectivePermissionMode, resolveProfile, type ProfileConfig } from "../policy/profiles.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { denyPending, type ApprovalGate } from "./approvals.js";
import { BUSY, closeLive, describeRuntimeError, endLive, REMOTE_PLACEHOLDER_TITLE, titleFrom, type LiveSession } from "./live-session.js";
import type { RemoteBridge } from "./remote-bridge.js";
import type { RuntimeCatalog } from "./runtime-catalog.js";
import type { SessionCore } from "./session-core.js";
import type { SessionStream } from "./stream.js";
import type { TurnAutomation } from "./turn-automation.js";
import type { BuiltTurn, MessageSource, TurnDispatch } from "./turns.js";

export interface StartParams {
  projectId: string;
  prompt: string;
  model?: string | null;
  effort?: EffortLevel | null;
  planOnly?: boolean;
  resumeClaudeSessionId?: string;
  attachments?: Attachment[];
  source?: MessageSource;
}

export interface LifecycleParts {
  automation: TurnAutomation;
  remote: RemoteBridge;
  turns: TurnDispatch;
  approvals: ApprovalGate;
  stream: SessionStream;
  catalog: RuntimeCatalog;
  /** FORGE tools and start context for a session's CLI */
  sessionTools?: (rec: SessionRecord) => { tools: SessionTool[]; context: string } | null;
}

/** Starting, resuming, stopping and ending the CLI process of a session. */
export class SessionLifecycle {
  /** start/resume in progress per session; a second resume or send waits for it instead of starting another CLI */
  private attaching = new Map<string, Promise<unknown>>();
  private readonly automation: TurnAutomation;
  private readonly remote: RemoteBridge;
  private readonly turns: TurnDispatch;
  private readonly approvals: ApprovalGate;
  private readonly stream: SessionStream;
  private readonly catalog: RuntimeCatalog;
  private readonly sessionTools: LifecycleParts["sessionTools"];

  constructor(
    private readonly core: SessionCore,
    private readonly projects: ProjectManager,
    private readonly runtime: ClaudeRuntime,
    parts: LifecycleParts,
  ) {
    this.automation = parts.automation;
    this.remote = parts.remote;
    this.turns = parts.turns;
    this.approvals = parts.approvals;
    this.stream = parts.stream;
    this.catalog = parts.catalog;
    this.sessionTools = parts.sessionTools;
  }

  /** Runs `job` as the one start/resume of the session; others wait for it in resume(). */
  private async exclusive<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const p = job();
    this.attaching.set(sessionId, p);
    try {
      return await p;
    } finally {
      if (this.attaching.get(sessionId) === p) this.attaching.delete(sessionId);
    }
  }

  async start(params: StartParams): Promise<Session> {
    const { db } = this.core;
    const project = this.projects.requireExisting(params.projectId);
    const settings = db.getSettings();
    const profile = resolveProfile(project.profile, project.tags);
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
      cwd: project.path,
      title: titleFrom(params.prompt) || REMOTE_PLACEHOLDER_TITLE,
      model,
      effort: params.effort ?? project.defaultEffort ?? settings.defaultEffort ?? null,
      profile: profile.id,
      permissionMode,
      status: "starting",
      apiKeySource: null,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    db.insertSession(rec);

    await this.exclusive(rec.id, async () => {
      if (params.resumeClaudeSessionId) await this.importHistory(rec.id, params.resumeClaudeSessionId, project.path);
      // Idle sessions keep their CLI process but do not touch files; only busy ones can collide.
      const others = [...this.core.live.entries()].filter(([id, l]) => l.projectDir === project.path && BUSY.includes(db.getSession(id)?.status ?? "stopped")).length;
      let first: BuiltTurn | null;
      try {
        first = params.prompt ? await this.turns.build(rec.id, params.prompt, params.attachments ?? [], true, params.source) : null;
      } catch (e) {
        db.updateSession(rec.id, { status: "error", lastError: e instanceof Error ? e.message : String(e) });
        throw e;
      }
      if (first) this.turns.record(rec.id, first);
      if (others > 0) {
        this.core.record(rec.id, { type: "status", status: "starting", detail: `Achtung: ${others} weitere Session(s) arbeiten gerade im selben Projektordner.` });
      }
      this.attach(rec, profile, claudePath, settings.stripApiKey, params.resumeClaudeSessionId ?? null, first?.msg ?? null);
    });
    return this.core.get(rec.id);
  }

  /** Continues a stored session (also after an app restart) with a new prompt. */
  async resume(sessionId: string, prompt: string | null, attachments: Attachment[] = [], source?: MessageSource): Promise<Session> {
    // A start/resume of this session is in flight (double Enter, UI and phone): wait for it, then send to it.
    for (let p = this.attaching.get(sessionId); p; p = this.attaching.get(sessionId)) await p.catch(() => {});
    if (this.core.live.has(sessionId)) return prompt === null ? this.core.get(sessionId) : this.turns.send(sessionId, prompt, attachments, source);
    const { db } = this.core;
    const rec = db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    if (!rec.claudeSessionId) {
      throw new ForgeError("CLAUDE_RUNTIME", "Diese Session hat keine Claude-Session-ID und kann nicht fortgesetzt werden.");
    }
    if (!existsSync(rec.cwd)) throw new ForgeError("PATH_NOT_ACCESSIBLE", `Arbeitsverzeichnis existiert nicht mehr: ${rec.cwd}`);
    const project = this.projects.requireExisting(rec.projectId);
    const settings = db.getSettings();
    const profile = resolveProfile(project.profile, project.tags);
    const claudePath = locateClaude(settings.claudePath);
    if (!claudePath) throw new ForgeError("CLAUDE_NOT_INSTALLED", "Claude Code CLI wurde nicht gefunden.");
    const permissionMode = rec.permissionMode === "plan" ? "plan" : profile.permissionMode;
    const claudeSessionId = rec.claudeSessionId;
    await this.exclusive(sessionId, async () => {
      const hold = this.automation.isBusy(sessionId);
      const first = prompt === null ? null : await this.turns.build(sessionId, prompt, attachments, !hold, source);
      if (first) this.turns.record(sessionId, first);
      db.updateSession(sessionId, { status: "starting", lastError: null, permissionMode });
      // The session keeps its original cwd even if the project moved; path assignment stays stable.
      const live = this.attach({ ...rec, permissionMode, profile: profile.id }, profile, claudePath, settings.stripApiKey, claudeSessionId, hold || !first ? null : this.turns.withNote(sessionId, first.msg));
      if (first && hold) this.turns.hold(sessionId, live, first.msg);
    });
    return this.core.get(sessionId);
  }

  private attach(rec: SessionRecord, profile: ProfileConfig, claudePath: string, stripApiKey: boolean, resume: string | null, first: OutgoingMessage | null): LiveSession {
    let markEnded = () => {};
    const ended = new Promise<void>((r) => (markEnded = r));
    const live: LiveSession = {
      rt: null as unknown as RuntimeSession,
      normalizer: new Normalizer(),
      pending: new Map(),
      profile,
      projectDir: rec.cwd,
      interrupting: false,
      closing: false,
      turnActive: !!first,
      ended,
      markEnded,
      seenUuids: new Set(this.core.db.listUserMessageUuids(rec.id)),
      remoteTurn: null,
      background: new Map(),
      subagents: new Map(),
      taskToolUse: new Map(),
      context: null,
    };
    this.core.live.set(rec.id, live);
    const sink = this.sinkFor(rec.id, live);
    let extra: { tools: SessionTool[]; context: string } | null;
    try {
      extra = this.sessionTools?.(rec) ?? null;
    } catch (e) {
      // Without FORGE tools the session still works as a plain Claude Code session; the timeline says why.
      extra = null;
      this.core.record(rec.id, { type: "status", status: "starting", detail: `FORGE-Werkzeuge nicht verfügbar: ${e instanceof Error ? e.message : String(e)}` });
    }
    try {
      live.rt = this.runtime.startSession(
        {
          cwd: rec.cwd,
          model: rec.model,
          effort: rec.effort,
          permissionMode: rec.permissionMode,
          resume,
          disallowedTools: blockedTools(profile, this.projects.get(rec.projectId).tags),
          env: sessionEnv(stripApiKey),
          claudePath,
          firstMessage: first,
          fallbackModel: fallbackFor(rec.model),
          tools: extra?.tools,
          context: extra?.context ?? null,
        },
        sink,
      );
    } catch (e) {
      if (this.core.live.get(rec.id) === live) this.core.live.delete(rec.id);
      const msg = e instanceof Error ? e.message : String(e);
      this.core.record(rec.id, { type: "error", message: msg, retryable: true });
      this.core.setStatus(rec.id, "error", msg, { lastError: msg });
      throw new ForgeError("CLAUDE_RUNTIME", msg);
    }
    if (first) this.automation.noteTurnStart(rec.id);
    this.core.setStatus(rec.id, first ? "running" : "idle");
    if (this.remote.enabled()) void this.remote.bridge(rec.id);
    live.rt
      .initialization()
      .then((init) => this.catalog.noteInitialization(init))
      .catch(() => {});
    return live;
  }

  private sinkFor(id: string, live: LiveSession): SessionSink {
    return {
      onMessage: (msg) => this.stream.handle(id, live, msg),
      onApproval: (req, signal) => this.approvals.request(id, live, req, signal),
      preToolUse: (toolName, input, toolUseId) => this.approvals.guard(id, live, toolName, input, toolUseId),
      onEnd: (error) => this.onEnd(id, live, error),
    };
  }

  private onEnd(id: string, live: LiveSession, error: Error | null) {
    live.markEnded();
    const current = this.core.live.get(id) === live;
    if (current) this.core.live.delete(id);
    denyPending(live, "Session beendet");
    live.pending.clear();
    // Replaced by a newer process or shut down: the session's state belongs to someone else now.
    if (!current) return;
    this.remote.drop(id);
    this.automation.dropHeld(id, "Session beendet");
    if (error) {
      const msg = describeRuntimeError(error);
      this.core.record(id, { type: "error", message: msg, retryable: true });
      this.core.setStatus(id, "error", msg, { lastError: msg });
    } else {
      this.core.setStatus(id, "stopped");
    }
  }

  async stop(sessionId: string): Promise<Session> {
    const live = this.core.live.get(sessionId);
    const status = this.core.db.getSession(sessionId)?.status;
    // Idle: no turn to stop and no result would follow; "stopping" would stick.
    if (!live || !status || !BUSY.includes(status)) return this.core.get(sessionId);
    const dropped = this.automation.dropHeld(sessionId, "Gestoppt");
    if (!live.turnActive) {
      if (dropped || status !== "idle") this.core.setStatus(sessionId, "idle", "Gestoppt");
      return this.core.get(sessionId);
    }
    live.interrupting = true;
    denyPending(live, "Gestoppt");
    this.core.setStatus(sessionId, "stopping");
    try {
      await live.rt.interrupt();
      // The turn may have ended just before the interrupt: no result follows, so the flag must not leak into the next turn.
      if (!live.turnActive && live.interrupting) {
        live.interrupting = false;
        if (this.core.live.get(sessionId) === live && this.core.db.getSession(sessionId)?.status === "stopping") this.core.setStatus(sessionId, "idle", "Gestoppt");
      }
    } catch (e) {
      // If interrupt fails the process is in a bad state: end it so the UI is never stuck.
      closeLive(live);
      this.core.record(sessionId, { type: "error", message: `Stop fehlgeschlagen, Session beendet: ${describeRuntimeError(e)}`, retryable: false });
    }
    return this.core.get(sessionId);
  }

  close(sessionId: string): Session {
    const live = this.core.live.get(sessionId);
    if (live) closeLive(live);
    return this.core.get(sessionId);
  }

  /** Ends all open sessions of the given projects and waits until their CLI processes are gone. */
  async closeProject(projectIds: string[]) {
    const ids = new Set(projectIds);
    const open = [...this.core.live].filter(([id]) => ids.has(this.core.db.getSession(id)?.projectId ?? ""));
    for (const [id] of open) this.remote.drop(id);
    // A worktree must not be removed while a claude.exe still works in it.
    await Promise.all(open.map(([, l]) => endLive(l)));
  }

  /**
   * Removes a session from FORGE: ends its process, deletes the timeline and, if asked, the CLI
   * transcript. Without the transcript deletion it shows up again as a terminal session.
   * The approval audit log is kept.
   */
  async delete(sessionId: string, deleteTranscript: boolean) {
    const rec = this.core.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    const live = this.core.live.get(sessionId);
    if (live) {
      this.remote.drop(sessionId);
      await endLive(live);
      // Deleting the row while the process still reports would break its event writes.
      if (this.core.live.has(sessionId)) throw new ForgeError("SESSION_BUSY", "Die Session ließ sich nicht beenden. Bitte erneut versuchen.");
    }
    let transcriptDeleted = false;
    if (deleteTranscript && rec.claudeSessionId) {
      try {
        await this.runtime.deleteTranscript(rec.claudeSessionId, rec.cwd);
        transcriptDeleted = true;
      } catch (e) {
        if (!/not found/i.test(e instanceof Error ? e.message : String(e))) {
          throw new ForgeError("CLAUDE_RUNTIME", `Transkript nicht gelöscht: ${describeRuntimeError(e)}`);
        }
      }
    }
    this.automation.forget(sessionId);
    return { deleted: this.core.db.deleteSession(sessionId), transcriptDeleted };
  }

  /**
   * Ends all CLI processes. The sessions become "interrupted" like after a crash, so they show up as
   * resumable after the next start. Open approvals are denied while the DB is still open.
   */
  shutdown(reason = "FORGE wird beendet") {
    const entries = [...this.core.live];
    this.core.live.clear();
    for (const [id, l] of entries) {
      l.closing = true;
      denyPending(l, reason);
      try {
        l.rt.close();
      } catch {
        /* process may already be gone */
      }
      this.core.db.updateSession(id, { status: "interrupted" });
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
          if (typeof content === "string") this.core.record(sessionId, { type: "user.message", text: content, ...(typeof mm.uuid === "string" ? { uuid: mm.uuid } : {}) });
        }
        for (const body of n.normalize(m)) if (body.type !== "assistant.delta") this.core.record(sessionId, body);
      }
    } catch (e) {
      this.core.record(sessionId, { type: "error", message: `Verlauf konnte nicht importiert werden: ${describeRuntimeError(e)}`, retryable: false });
    }
  }
}
