import type { BackgroundTask } from "@forge/protocol";
import type { AutoContinue } from "./auto-continue.js";
import type { ContextRecovery } from "./context-recovery.js";
import { isAuthFailure, pruneSeenUuids, type LiveSession } from "./live-session.js";
import type { PermissionModes } from "./permission-mode.js";
import type { RateLimitTracker } from "./rate-limit.js";
import type { RemoteBridge } from "./remote-bridge.js";
import type { RuntimeCatalog } from "./runtime-catalog.js";
import type { SessionCore } from "./session-core.js";
import type { TurnAutomation } from "./turn-automation.js";
import type { TurnDispatch } from "./turns.js";

export interface StreamParts {
  automation: TurnAutomation;
  remote: RemoteBridge;
  turns: TurnDispatch;
  modes: PermissionModes;
  catalog: RuntimeCatalog;
  autoContinue: AutoContinue;
  limits: RateLimitTracker;
  recovery: ContextRecovery;
}

/** Turns the CLI's message stream into timeline events and session state (status, context, background tasks). */
export class SessionStream {
  private readonly automation: TurnAutomation;
  private readonly remote: RemoteBridge;
  private readonly turns: TurnDispatch;
  private readonly modes: PermissionModes;
  private readonly catalog: RuntimeCatalog;
  private readonly autoContinue: AutoContinue;
  private readonly limits: RateLimitTracker;
  private readonly recovery: ContextRecovery;
  /** sessions whose current turn got an answer the API refused for the sign-in */
  private readonly authFailed = new WeakSet<LiveSession>();

  constructor(
    private readonly core: SessionCore,
    parts: StreamParts,
  ) {
    this.automation = parts.automation;
    this.remote = parts.remote;
    this.turns = parts.turns;
    this.modes = parts.modes;
    this.catalog = parts.catalog;
    this.autoContinue = parts.autoContinue;
    this.limits = parts.limits;
    this.recovery = parts.recovery;
  }

  handle(id: string, live: LiveSession, msg: unknown) {
    // A process that was replaced or shut down must not write into the session any more.
    if (this.core.live.get(id) !== live) return;
    const m = msg as Record<string, unknown>;
    if (m.type === "system" && m.subtype === "init") this.catalog.noteSystemInit(m);
    if (m.type === "system" && m.subtype === "status" && typeof m.permissionMode === "string") this.modes.sync(id, m.permissionMode);
    if (this.remote.handleInput(id, live, m)) return;
    if (m.type === "system" && m.subtype === "background_tasks_changed") {
      this.syncBackgroundTasks(id, live, m.tasks);
      return;
    }
    if (m.type === "system" && (m.subtype === "task_started" || m.subtype === "task_progress" || m.subtype === "task_notification")) this.trackTask(id, live, m);
    // A finished background task makes the CLI start a turn on its own, without a user message.
    // A subagent in the background goes on talking after its starter's turn ended; that is not a turn.
    const turnOutput = !m.parent_tool_use_id && (m.type === "assistant" || (m.type === "stream_event" && (m.event as Record<string, unknown> | undefined)?.type === "message_start"));
    if (turnOutput && this.core.db.getSession(id)?.status === "idle") this.turns.markRunning(id, live);
    if (m.type === "assistant" && !m.parent_tool_use_id && m.error === "authentication_failed") this.authFailed.add(live);
    for (const body of live.normalizer.normalize(msg)) {
      this.core.record(id, body);
      if (body.type === "session.init") {
        this.core.publish(
          this.core.db.updateSession(id, {
            claudeSessionId: body.claudeSessionId,
            model: body.model,
            apiKeySource: body.apiKeySource,
          }),
        );
      } else if (body.type === "context.compacted") {
        this.refreshContext(id, live);
      } else if (body.type === "rate_limit") {
        this.limits.note(body);
        this.autoContinue.noteRateLimit(id, body);
      } else if (body.type === "turn.result") {
        this.refreshContext(id, live);
        const wasInterrupt = live.interrupting;
        live.interrupting = false;
        live.turnActive = false;
        this.remote.endTurn(id, live);
        pruneSeenUuids(live.seenUuids);
        const failed = body.isError && !wasInterrupt;
        const authFailed = this.authFailed.delete(live) || (body.isError && isAuthFailure(body.text ?? ""));
        if (authFailed && !wasInterrupt) this.core.emit({ event: "claude.authRequired", payload: { sessionId: id } });
        live.subagents.clear();
        this.core.setStatus(id, "idle", wasInterrupt ? "Gestoppt" : null, { lastError: failed ? (body.text ?? body.subtype) : null });
        if (!wasInterrupt && !body.isError) this.automation.schedule(id);
        this.autoContinue.onTurnResult(id, body, wasInterrupt);
        this.recovery.onTurnResult(id, body, wasInterrupt);
      }
    }
  }

  private refreshContext(id: string, live: LiveSession) {
    this.automation.track(
      live.rt.contextUsage().then((context) => {
        if (this.core.live.get(id) !== live) return;
        live.context = context;
        this.core.db.setSessionContext(id, context);
        this.core.publish(this.core.db.getSession(id));
      }),
    );
  }

  /**
   * Subagents of the turn and the progress of every task. task_progress comes after each tool call
   * of a subagent and with a model-written summary about every 30 s; the session is published only
   * when something visible changed.
   */
  private trackTask(id: string, live: LiveSession, m: Record<string, unknown>) {
    const taskId = typeof m.task_id === "string" ? m.task_id : null;
    if (!taskId) return;
    const s = (v: unknown) => (typeof v === "string" && v ? v : null);
    let changed = false;
    if (m.subtype === "task_started") {
      const call = live.normalizer.taskCall(m);
      const toolUseId = call.toolUseId;
      if (toolUseId) {
        live.taskToolUse.set(taskId, toolUseId);
        const bg = live.background.get(taskId);
        if (bg && bg.toolUseId !== toolUseId) {
          live.background.set(taskId, { ...bg, toolUseId });
          this.core.publish(this.core.db.getSession(id));
        }
      }
      // Backgrounded work is listed by background_tasks_changed; foreground subagents only here.
      const isAgent = m.task_type === "local_agent" || typeof m.subagent_type === "string";
      if (m.is_backgrounded === true || !isAgent || call.resumed) return;
      live.subagents.set(taskId, {
        taskId,
        toolUseId,
        description: s(m.description) ?? "Subagent",
        agentType: s(m.subagent_type),
        summary: null,
        lastTool: null,
        toolUses: 0,
        startedAt: new Date().toISOString(),
      });
      changed = true;
    } else if (m.subtype === "task_progress") {
      const usage = (m.usage ?? {}) as Record<string, unknown>;
      const summary = s(m.summary);
      const agent = live.subagents.get(taskId);
      if (agent) {
        const next = { ...agent, summary: summary ?? agent.summary, lastTool: s(m.last_tool_name) ?? agent.lastTool, toolUses: typeof usage.tool_uses === "number" ? usage.tool_uses : agent.toolUses };
        changed = next.summary !== agent.summary || next.lastTool !== agent.lastTool || next.toolUses !== agent.toolUses;
        live.subagents.set(taskId, next);
      }
      const bg = live.background.get(taskId);
      if (bg && summary && summary !== bg.summary) {
        live.background.set(taskId, { ...bg, summary });
        changed = true;
      }
    } else {
      live.taskToolUse.delete(taskId);
      changed = live.subagents.delete(taskId);
    }
    if (changed) this.core.publish(this.core.db.getSession(id));
  }

  /** The CLI sends the full list on every change; start times are kept for tasks already known. */
  private syncBackgroundTasks(id: string, live: LiveSession, raw: unknown) {
    const next = new Map<string, BackgroundTask>();
    for (const t of Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []) {
      const taskId = typeof t.task_id === "string" ? t.task_id : null;
      if (!taskId) continue;
      next.set(taskId, {
        taskId,
        description: typeof t.description === "string" && t.description ? t.description : "Hintergrundaufgabe",
        taskType: typeof t.task_type === "string" ? t.task_type : "unknown",
        toolUseId: live.taskToolUse.get(taskId) ?? null,
        startedAt: live.background.get(taskId)?.startedAt ?? new Date().toISOString(),
        summary: live.background.get(taskId)?.summary ?? null,
      });
    }
    live.background = next;
    this.core.publish(this.core.db.getSession(id));
  }
}
