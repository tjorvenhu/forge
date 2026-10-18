import type { SessionEventBody } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import { tr } from "../i18n/index.js";
import { asData } from "./tools.js";

/** longest command or plan handed to the conversation partner in details */
const DETAILS_MAX = 4000;

/** Session text for Claude: marked as data, and a cut is said, not hidden. */
export function excerptData(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  const p = tr().phone.pending;
  if (!t) return p.noText;
  return t.length > max ? p.cut(asData(t.slice(0, max)), t.length) : asData(t);
}

/** The last thing Claude said in a session (result text, else last answer). */
export function lastAnswer(db: Db, sessionId: string): string {
  const events = db.listEvents(sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const b = events[i]!.body;
    if (b.type === "turn.result" && b.text && !b.isError) return b.text;
    if (b.type === "assistant.text" && !b.parentToolUseId && b.text.trim()) return b.text;
  }
  return "";
}

export type ApprovalRequest = Extract<SessionEventBody, { type: "approval.request" }>;

export function openRequest(db: Db, sessionId: string): ApprovalRequest | null {
  const open = new Map<string, ApprovalRequest>();
  for (const e of db.listEvents(sessionId)) {
    if (e.body.type === "approval.request") open.set(e.body.requestId, e.body);
    else if (e.body.type === "approval.resolved") open.delete(e.body.requestId);
  }
  return [...open.values()].at(-1) ?? null;
}

export function questionTexts(input: Record<string, unknown>): string[] {
  return Array.isArray(input.questions) ? (input.questions as Array<{ question?: unknown }>).flatMap((q) => (typeof q.question === "string" ? [q.question] : [])) : [];
}

export function requestSubject(req: ApprovalRequest): string {
  return typeof req.input.command === "string" ? req.input.command : typeof req.input.file_path === "string" ? req.input.file_path : "";
}

/** What a session waits for, for Claude. `short` (status) names the kind only; details has the full text. */
export function pendingText(db: Db, sessionId: string, short = false): string {
  const p = tr().phone.pending;
  const req = openRequest(db, sessionId);
  if (!req) return p.nothing;
  if (req.toolName === "AskUserQuestion") {
    if (short) return p.questionShort;
    const qs = Array.isArray(req.input.questions) ? (req.input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }>) : [];
    return p.question(asData(qs.map((q) => p.questionOptions(q.question ?? "", (q.options ?? []).map((o) => o.label).join(", "))).join(" ")));
  }
  if (req.toolName === "ExitPlanMode") {
    if (short) return p.planShort;
    const plan = typeof req.input.plan === "string" ? req.input.plan : "";
    return p.plan(excerptData(plan, DETAILS_MAX));
  }
  if (short) return p.approvalShort(req.toolName);
  const subject = requestSubject(req);
  return p.approval(req.toolName, subject ? excerptData(subject, DETAILS_MAX) : "");
}
