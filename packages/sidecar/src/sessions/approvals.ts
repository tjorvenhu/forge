import { randomUUID } from "node:crypto";
import os from "node:os";
import { ForgeError, type PermissionMode } from "@forge/protocol";
import type { ApprovalDecision, ApprovalRequest } from "../claude/runtime.js";
import { truncateInput } from "../claude/normalize.js";
import type { GitEngine } from "../git/git.js";
import { checkToolUse, claudePlansDir, needsBranch, writesOutsideProject, type GuardViolation } from "../policy/guard.js";
import { blockedTools, NO_NETWORK_TAG } from "../policy/profiles.js";
import { redact } from "../policy/redact.js";
import type { LiveSession } from "./live-session.js";
import type { SessionCore } from "./session-core.js";
import { tr } from "../i18n/index.js";
import { isTeamCheckCommand } from "../teams/team-checks.js";

/** Tools that ask the user something instead of doing something; answered in their own cards. */
const QUESTION_TOOL = "AskUserQuestion";
const PLAN_TOOL = "ExitPlanMode";
const INTERACTIVE_TOOLS = new Set([QUESTION_TOOL, PLAN_TOOL]);

const guardError = (): GuardViolation => ({ rule: "guard-error", message: tr().core.sessions.guardError });

export interface ApprovalHost {
  /** reason recorded when the CLI aborts an open prompt */
  abortReason(sessionId: string): string;
  /** an accepted plan moved the session out of plan mode */
  syncPermissionMode(sessionId: string, mode: PermissionMode): void;
  /** current tags of the session's project */
  projectTags(sessionId: string): readonly string[];
}

/** Denies every open prompt of a process (stop, end, shutdown). */
export function denyPending(live: LiveSession, message: string) {
  for (const p of [...live.pending.values()]) p.resolve({ behavior: "deny", message });
}

/**
 * FORGE's side of tool permissions: the hard policy check before every tool call (PreToolUse hook)
 * and the approval prompts of the CLI, answered in the UI or on the phone. Every decision is written
 * to the approvals audit table.
 */
export class ApprovalGate {
  constructor(
    private readonly core: SessionCore,
    private readonly git: GitEngine,
    private readonly host: ApprovalHost,
  ) {}

  async guard(id: string, live: LiveSession, toolName: string, input: Record<string, unknown>, toolUseId: string | null): Promise<GuardViolation | null> {
    // Decide first; logging comes after and must never turn a deny into an allow.
    let v: GuardViolation | null;
    try {
      v =
        this.blockedTool(id, live, toolName) ??
        checkToolUse(toolName, input, {
          projectDir: live.projectDir,
          confineWritesToProject: live.profile.confineWritesToProject,
          // only a push needs the branch; looking it up on every tool call would spawn git each time
          currentBranch: needsBranch(toolName, input) ? await this.currentBranch(live.projectDir) : null,
          home: os.homedir(),
          extraWriteDirs: [claudePlansDir()],
          disabledRules: new Set(this.core.db.getSettings().disabledPolicyRules),
        });
    } catch {
      v = guardError();
    }
    if (v) {
      try {
        this.core.record(id, { type: "policy.blocked", toolUseId, toolName, rule: v.rule, message: v.message });
        this.core.db.recordApproval({
          sessionId: id,
          requestId: toolUseId ?? randomUUID(),
          toolName,
          input: redact(truncateInput(input).input),
          decision: "deny",
          scope: "once",
          source: "policy",
          reason: v.rule,
        });
      } catch {
        /* the deny stands even if it could not be logged */
      }
    }
    return v;
  }

  request(id: string, live: LiveSession, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.teamCheck(id, live, req)) return Promise.resolve({ behavior: "allow", scope: "once" });
    const allowSessionScope = live.profile.allowSessionScope && !req.suppressAlwaysAllow && !INTERACTIVE_TOOLS.has(req.toolName);
    const { input, truncated } = truncateInput(req.input);
    this.core.record(id, {
      type: "approval.request",
      requestId: req.requestId,
      toolUseId: req.toolUseId,
      toolName: req.toolName,
      input,
      title: req.title,
      description: req.description,
      reason: req.reason,
      allowSessionScope,
      outsideProject: writesOutsideProject(req.toolName, req.input, live.projectDir, os.homedir(), [claudePlansDir()]),
      ...(truncated ? { inputTruncated: true } : {}),
    });
    this.core.setStatus(id, "waiting_approval", req.title ?? req.toolName);
    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (d: ApprovalDecision, source: "user" | "abort", scope: "once" | "session") => {
        if (!live.pending.delete(req.requestId)) return;
        try {
          this.core.record(id, {
            type: "approval.resolved",
            requestId: req.requestId,
            decision: d.behavior,
            scope,
            source,
            message: d.behavior === "deny" ? d.message : null,
            ...(d.behavior === "allow" && isAnswers(d.updatedInput?.answers) ? { answers: d.updatedInput.answers } : {}),
          });
          this.core.db.recordApproval({
            sessionId: id,
            requestId: req.requestId,
            toolName: req.toolName,
            input: redact(input),
            decision: d.behavior,
            scope,
            source,
            reason: d.behavior === "deny" ? d.message : null,
          });
          if (this.core.live.get(id) === live && live.pending.size === 0) this.core.setStatus(id, "running");
        } finally {
          // The CLI waits for this answer; a failed log write must not leave it hanging.
          resolve(d);
        }
      };
      live.pending.set(req.requestId, {
        req,
        resolve: (d) => finish(d, "user", d.behavior === "allow" ? d.scope : "once"),
      });
      // With Remote Control the prompt may also have been answered in the Claude app.
      signal.addEventListener("abort", () => finish({ behavior: "deny", message: this.host.abortReason(id) }, "abort", "once"), { once: true });
    });
  }

  /**
   * Agent teams in Balanced: tests, lint, type checks and reading commands run without a prompt
   * (teams/team-checks.ts); with several members at work every test run would stall the team.
   * Logged like every decision. Safe keeps asking.
   */
  private teamCheck(id: string, live: LiveSession, req: ApprovalRequest): boolean {
    if (req.toolName !== "Bash" || live.profile.id !== "balanced" || typeof req.input.command !== "string") return false;
    const rec = this.core.db.getSession(id);
    if (!rec?.team || !isTeamCheckCommand(req.input.command, this.core.db.getProject(rec.projectId)?.testCommand ?? null)) return false;
    try {
      this.core.db.recordApproval({ sessionId: id, requestId: req.requestId, toolName: req.toolName, input: redact(truncateInput(req.input).input), decision: "allow", scope: "once", source: "policy", reason: "team-check" });
    } catch {
      /* the check stands even if it could not be logged */
    }
    return true;
  }

  respond(sessionId: string, requestId: string, decision: "allow" | "deny", scope: "once" | "session", message?: string, answers?: Record<string, string>) {
    const live = this.core.live.get(sessionId);
    const p = live?.pending.get(requestId);
    if (!live || !p) throw new ForgeError("NOT_FOUND", tr().core.sessions.approvalGone);
    const tool = p.req.toolName;
    if (decision === "deny") {
      const m = tr().core.sessions;
      const fallback = tool === QUESTION_TOOL ? m.questionDeclined : tool === PLAN_TOOL ? m.planDeclined : m.deniedByUser;
      p.resolve({ behavior: "deny", message: message?.trim() || fallback });
      return { ok: true };
    }
    if (tool === QUESTION_TOOL) {
      const given = Object.fromEntries(Object.entries(answers ?? {}).filter(([, v]) => v.trim()));
      if (!Object.keys(given).length) throw new ForgeError("VALIDATION", tr().core.sessions.answerOne);
      p.resolve({ behavior: "allow", scope: "once", updatedInput: { ...p.req.input, answers: given } });
      return { ok: true };
    }
    if (tool === PLAN_TOOL) {
      // Accepting the plan leaves plan mode for the mode of the project's profile, like the CLI dialog.
      const mode = live.profile.permissionMode;
      p.resolve({ behavior: "allow", scope: "once", mode });
      this.host.syncPermissionMode(sessionId, mode);
      return { ok: true };
    }
    if (scope === "session" && !(live.profile.allowSessionScope && !p.req.suppressAlwaysAllow)) {
      throw new ForgeError("POLICY_DENIED", tr().core.sessions.noSessionScope);
    }
    p.resolve({ behavior: "allow", scope });
    return { ok: true };
  }

  /** disallowedTools is fixed at process start; a later stricter profile or a new no-network tag is enforced here. */
  private blockedTool(id: string, live: LiveSession, toolName: string): GuardViolation | null {
    if (live.profile.disallowedTools.includes(toolName)) return { rule: "profile-tool", message: tr().core.sessions.profileForbidsTool(live.profile.label, toolName) };
    if (blockedTools(live.profile, this.host.projectTags(id)).includes(toolName)) return { rule: "no-network", message: tr().core.sessions.tagForbidsTool(NO_NETWORK_TAG, toolName) };
    return null;
  }

  private async currentBranch(dir: string): Promise<string | null> {
    try {
      const r = await this.git.exec(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return r.code === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  }
}

function isAnswers(v: unknown): v is Record<string, string> {
  return !!v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string");
}
