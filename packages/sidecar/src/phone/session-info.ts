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

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

function wordScore(q: string, t: string): number {
  if (q === t) return 1;
  if (Math.min(q.length, t.length) >= 3 && (t.startsWith(q) || q.startsWith(t))) return 0.9;
  const allowed = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
  return allowed && editDistance(q, t) <= allowed ? 0.8 : 0;
}

/**
 * How well a spoken name fits a title, 0 to 1. Speech recognition splits, joins and misspells words
 * ("Nebenstelle LEDs" for "Nebenstellen-LED", "Ultrafink" for "Ultrathink"), so words count when they
 * are close, and the name may also match the title with its spaces removed.
 */
export function nameScore(spoken: string, title: string): number {
  const q = words(spoken);
  const t = words(title);
  if (!q.length || !t.length) return 0;
  const joined = q.join("");
  if (joined.length >= 5 && t.join("").includes(joined)) return 1;
  // Joined title words catch a name the recognizer wrote as one word ("Homecloud" for "Home Cloud").
  const pairs = t.slice(1).map((w, i) => t[i] + w);
  const total = q.reduce((sum, w) => sum + Math.max(...[...t, ...pairs].map((x) => wordScore(w, x))), 0);
  return total / q.length;
}

/** The one candidate a spoken name means, or null when none fits well or several fit equally. */
export function bestByName<T>(spoken: string, items: readonly T[], text: (item: T) => string): { best: T | null; close: T[] } {
  const scored = items.map((item) => ({ item, score: nameScore(spoken, text(item)) })).filter((x) => x.score >= 0.6);
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return { best: null, close: [] };
  const close = scored.filter((x) => x.score >= top.score - 0.1).map((x) => x.item);
  return { best: close.length === 1 ? top.item : null, close };
}

export type ApprovalRequest =Extract<SessionEventBody, { type: "approval.request" }>;

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
