import type { BackgroundTask } from "@forge/protocol";
import type { AutoContinue } from "./auto-continue.js";
import { pruneSeenUuids, type LiveSession } from "./live-session.js";
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
    // A finished background task makes the CLI start a turn on its own, without a user message.
    const turnOutput = m.type === "assistant" || (m.type === "stream_event" && (m.event as Record<string, unknown> | undefined)?.type === "message_start");
    if (turnOutput && this.core.db.getSession(id)?.status === "idle") this.turns.markRunning(id, live);
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
        this.core.setStatus(id, "idle", wasInterrupt ? "Gestoppt" : null, { lastError: failed ? (body.text ?? body.subtype) : null });
        if (!wasInterrupt && !body.isError) this.automation.schedule(id);
        this.autoContinue.onTurnResult(id, body, wasInterrupt);
      }
    }
  }

  private refreshContext(id: string, live: LiveSession) {
    this.automation.track(
      live.rt.contextUsage().then((context) => {
        if (this.core.live.get(id) !== live) return;
        live.context = context;
        this.core.publish(this.core.db.getSession(id));
      }),
    );
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
        startedAt: live.background.get(taskId)?.startedAt ?? new Date().toISOString(),
      });
    }
    live.background = next;
    this.core.publish(this.core.db.getSession(id));
  }
}
