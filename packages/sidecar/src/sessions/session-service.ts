import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SDKControlInitializeResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  ForgeError,
  type ExternalSession,
  type PermissionMode,
  type RuntimeInfo,
  type ServerEvent,
  type Session,
  type SessionEventBody,
  type SessionStatus,
} from "@forge/protocol";
import type { ApprovalDecision, ApprovalRequest, ClaudeRuntime, RuntimeSession, SessionSink } from "../claude/runtime.js";
import { Normalizer } from "../claude/normalize.js";
import { locateClaude, sessionEnv } from "../claude/environment.js";
import type { Db, SessionRecord } from "../persistence/db.js";
import type { GitEngine } from "../git/git.js";
import { checkToolUse, writesOutsideProject } from "../policy/guard.js";
import { effectivePermissionMode, PROFILES, resolveProfile, type ProfileConfig } from "../policy/profiles.js";
import { redact } from "../policy/redact.js";
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
}

const MODE_RANK: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };

export class SessionService {
  private live = new Map<string, LiveSession>();
  private initCache: SDKControlInitializeResponse | null = null;
  private cliCapabilities: string[] = [];
  /** from the latest system/init; null until a session has started */
  private mcpServers: Array<{ name: string; status: string }> | null = null;

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

  async start(params: {
    projectId: string;
    prompt: string;
    model?: string | null;
    planOnly?: boolean;
    resumeClaudeSessionId?: string;
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
    const permissionMode = effectivePermissionMode(profile, params.planOnly === true);
    const rec: SessionRecord = {
      id: randomUUID(),
      projectId: project.id,
      claudeSessionId: params.resumeClaudeSessionId ?? null,
      cwd: project.path,
      title: titleFrom(params.prompt),
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
    this.record(rec.id, { type: "user.message", text: params.prompt });
    if (others > 0) {
      this.record(rec.id, {
        type: "status",
        status: "starting",
        detail: `Achtung: ${others} weitere Session(s) arbeiten gerade im selben Projektordner.`,
      });
    }
    this.attach(rec, profile, claudePath, settings.stripApiKey, params.resumeClaudeSessionId ?? null, params.prompt);
    return this.get(rec.id);
  }

  /** Continues a stored session (also after an app restart) with a new prompt. */
  async resume(sessionId: string, prompt: string): Promise<Session> {
    const rec = this.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    if (this.live.has(sessionId)) return this.send(sessionId, prompt);
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
    this.db.updateSession(sessionId, { status: "starting", lastError: null, permissionMode });
    this.record(sessionId, { type: "user.message", text: prompt });
    // The session keeps its original cwd even if the project moved; path assignment stays stable.
    this.attach({ ...rec, permissionMode, profile: profile.id }, profile, claudePath, settings.stripApiKey, rec.claudeSessionId, prompt);
    return this.get(sessionId);
  }

  private attach(
    rec: SessionRecord,
    profile: ProfileConfig,
    claudePath: string,
    stripApiKey: boolean,
    resume: string | null,
    prompt: string,
  ) {
    const live: LiveSession = {
      rt: null as unknown as RuntimeSession,
      normalizer: new Normalizer(),
      pending: new Map(),
      profile,
      projectDir: rec.cwd,
      interrupting: false,
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
          disallowedTools: profile.disallowedTools,
          env: sessionEnv(stripApiKey),
          claudePath,
          firstPrompt: prompt,
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
    this.setStatus(rec.id, "running");
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
            const failed = body.isError && !wasInterrupt;
            this.setStatus(id, "idle", wasInterrupt ? "Gestoppt" : null, { lastError: failed ? body.text ?? body.subtype : null });
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
      signal.addEventListener("abort", () => finish({ behavior: "deny", message: "Abgebrochen" }, "abort", "once"), { once: true });
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

  async send(sessionId: string, text: string): Promise<Session> {
    const live = this.live.get(sessionId);
    if (!live) return this.resume(sessionId, text);
    if (live.pending.size > 0) throw new ForgeError("SESSION_BUSY", "Erst die offene Freigabeanfrage beantworten.");
    this.record(sessionId, { type: "user.message", text });
    live.rt.sendMessage(text);
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

  /** Imports the transcript of a session started outside FORGE so the timeline is complete. */
  private async importHistory(sessionId: string, claudeSessionId: string, dir: string) {
    try {
      const msgs = await this.runtime.sessionHistory(claudeSessionId, dir);
      const n = new Normalizer();
      for (const m of msgs) {
        const mm = m as Record<string, unknown>;
        if (mm.type === "user") {
          const content = (mm.message as Record<string, unknown> | undefined)?.content;
          if (typeof content === "string") this.record(sessionId, { type: "user.message", text: content });
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
