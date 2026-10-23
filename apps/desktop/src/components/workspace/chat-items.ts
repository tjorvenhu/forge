import { isIdleClosedDetail, isUsageLimitText, type SessionEvent, type SessionEventBody, type TaskMessageRef } from "@forge/protocol";
import { pathInside } from "@/lib/platform";
import { limitLabel, limitTime } from "@/lib/rate-limit";
import { t } from "@/i18n";

type Body<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>;

export type NoticeIcon = "commit" | "push" | "merge" | "skip" | "rewind" | "compact" | "background" | "limit" | "notify" | "update";

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type ChatItem =
  | { kind: "user"; key: string; seq: number; text: string; ts: string; uuid: string | null; attachments: Array<{ name: string; mediaType: string; size: number }>; remote: boolean; auto: boolean; edited: boolean; task: TaskMessageRef | null }
  | { kind: "assistant"; key: string; seq: number | null; text: string; streaming: boolean; ts: string | null }
  | {
      kind: "tool";
      key: string;
      ts: string;
      use: Body<"tool.use">;
      result: Body<"tool.result"> | null;
      approval: { req: Body<"approval.request">; resolved: Body<"approval.resolved"> | null } | null;
      blocked: Body<"policy.blocked"> | null;
      /** for TodoWrite: parsed list; superseded lists are rendered compact */
      todos: TodoEntry[] | null;
      superseded: boolean;
      /** event numbers of the call and its result, so a search hit lands on this card */
      seqs?: number[];
    }
  | { kind: "approval"; key: string; ts: string; req: Body<"approval.request">; resolved: Body<"approval.resolved"> | null }  | { kind: "blocked"; key: string; ts: string; body: Body<"policy.blocked"> }
  | { kind: "result"; key: string; ts: string; body: Body<"turn.result"> }
  | { kind: "error"; key: string; ts: string; message: string; retryable: boolean }
  | {
      kind: "notice";
      key: string;
      ts: string;
      text: string;
      tone: "info" | "warning" | "success" | "danger";
      /** shown as an event card when set: title, a highlighted reference (hash, branch) and a detail line */
      card?: { title: string; ref: string | null; detail: string; icon: NoticeIcon };
    }
  | { kind: "check"; key: string; ts: string; body: Body<"check.result"> }
  /** before/after screenshots of the web app around a turn that changed UI files */
  | { kind: "uiCompare"; key: string; ts: string; body: Body<"ui.compare"> }
  /** a long session went on in a new one, or this one continues an older one */
  | { kind: "handoff"; key: string; ts: string; body: Body<"session.handoff"> }
  | AutoContinueItem;

/** Automatic continuation after a usage limit; `open`: no later message or step replaced this plan. */
export type AutoContinueItem = { kind: "autoContinue"; key: string; ts: string; body: Body<"auto_continue">; open: boolean };

function parseTodos(input: Record<string, unknown>): TodoEntry[] | null {
  const raw = input.todos;
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      content: typeof t.content === "string" ? t.content : "",
      status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
      activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
    }));
}

/**
 * Folds the persisted event log plus live text deltas into renderable chat items.
 * Pure function: same input, same output.
 */
export function buildChatItems(events: SessionEvent[], streaming: Record<string, string>): ChatItem[] {
  return appendStreaming(buildEventItems(events), streaming);
}

/** Live text deltas as assistant items after the event items; texts that arrived in final form are skipped. */
export function appendStreaming(items: ChatItem[], streaming: Record<string, string>): ChatItem[] {
  const live = Object.entries(streaming).filter(([, text]) => !!text);
  if (!live.length) return items;
  const final = new Set(items.filter((i) => i.kind === "assistant").map((i) => i.key));
  const extra: ChatItem[] = live
    .filter(([key]) => !final.has(`a${key}`))
    .map(([key, text]) => ({ kind: "assistant", key: `a${key}`, seq: null, text, streaming: true, ts: null }));
  return extra.length ? [...items, ...extra] : items;
}

function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (depth === 0 || typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => sameValue(ra[k], rb[k], depth - 1));
}

/**
 * Keeps the previous object for every item whose content did not change, so memoized rows skip
 * rendering when a new event arrives. Returns `prev` itself when nothing changed.
 */
export function reuseStableItems(prev: readonly ChatItem[], next: ChatItem[]): ChatItem[] {
  if (!prev.length) return next;
  const byKey = new Map(prev.map((i) => [i.key, i]));
  let changed = prev.length !== next.length;
  const out = next.map((item, i) => {
    const old = byKey.get(item.key);
    // Items hold event bodies (stable references) plus small wrapper objects and arrays built per pass.
    const keep = old && sameValue(old, item, 3) ? old : item;
    if (keep !== prev[i]) changed = true;
    return keep;
  });
  return changed ? out : (prev as ChatItem[]);
}

/**
 * The fold behind the chat items, event by event. Kept as state so new events at the end only cost
 * their own work instead of a pass over the whole history.
 *
 * `thread` picks whose events become items: null is the main chat, a tool use id the subagent working
 * for that Agent/Task call. A subagent's approvals also show in the main chat, so it never waits
 * unnoticed.
 */
function itemFolder(thread: string | null = null) {
  const items: ChatItem[] = [];
  const toolIdx = new Map<string, number>();
  /** tool use id -> the Agent call whose subagent made it (null: main chat), for all threads */
  const threadOf = new Map<string, string | null>();
  const approvalIdx = new Map<string, { item: number; inTool: boolean }>();
  const textIdx = new Map<string, number>();
  let lastTodo: number | null = null;
  /** the "limit reached" notice of the current turn; replaced by the plan card when one follows */
  let limitNotice: number | null = null;
  /** Claude's limit message and the failed turn end of the current turn; the plan card replaces them too */
  let limitText: number | null = null;
  let limitResult: number | null = null;
  /** the plan card that is still the latest word on the automatic continuation */
  let openPlan: number | null = null;
  const dropped = new Set<number>();
  /** seq of the event that created each item, for cutting the chat off at an edited prompt */
  const startSeq: number[] = [];
  /** the next prompt replaces an edited one */
  let editedNext = false;

  /** Forgets every item from `index` on, with all references into them. */
  const truncate = (index: number) => {
    items.length = index;
    startSeq.length = index;
    for (const m of [toolIdx, textIdx]) for (const [k, i] of m) if (i >= index) m.delete(k);
    for (const [k, r] of approvalIdx) if (r.item >= index) approvalIdx.delete(k);
    for (const i of dropped) if (i >= index) dropped.delete(i);
    if (lastTodo !== null && lastTodo >= index) lastTodo = null;
    if (limitNotice !== null && limitNotice >= index) limitNotice = null;
    if (limitText !== null && limitText >= index) limitText = null;
    if (limitResult !== null && limitResult >= index) limitResult = null;
    if (openPlan !== null && openPlan >= index) openPlan = null;
  };

  return {
    add(ev: SessionEvent) {
      fold(ev);
      while (startSeq.length < items.length) startSeq.push(ev.seq);
    },
    result(): ChatItem[] {
      return dropped.size ? items.filter((_, i) => !dropped.has(i)) : items.slice();
    },
  };

  function fold(ev: SessionEvent) {
    const b = ev.body;
    if (b.type === "tool.use") threadOf.set(b.toolUseId, b.parentToolUseId ?? null);
    // A resolution only touches an approval this thread registered.
    // A message written to a subagent shows in the main chat and in the subagent's own history.
    const toThisAgent = thread !== null && b.type === "user.message" && b.task?.kind === "agent" && b.task.toolUseId === thread;
    if (b.type !== "approval.resolved" && !toThisAgent && eventThread(b, threadOf) !== thread) {
      if (thread === null && b.type === "approval.request") {
        approvalIdx.set(b.requestId, { item: items.length, inTool: false });
        items.push({ kind: "approval", key: `p${b.requestId}`, ts: ev.ts, req: b, resolved: null });
      }
      return;
    }
    switch (b.type) {
      case "user.message":
        // Older FORGE versions stored Claude Code's own notifications as prompts; the background task card covers them.
        if (isInjectedUserText(b.text)) break;
        if (b.source !== "auto" && openPlan !== null) {
          items[openPlan] = { ...(items[openPlan] as AutoContinueItem), open: false };
          openPlan = null;
        }
        limitNotice = limitText = limitResult = null;
        items.push({
          kind: "user",
          key: `u${ev.seq}`,
          seq: ev.seq,
          text: b.text,
          ts: ev.ts,
          uuid: b.uuid ?? null,
          attachments: b.attachments ?? [],
          remote: b.source === "remote",
          auto: b.source === "auto",
          edited: editedNext,
          task: b.task ?? null,
        });
        editedNext = false;
        break;
      case "assistant.text": {
        const key = `${b.messageId}:${b.index}`;
        const existing = textIdx.get(key);
        const item: ChatItem = { kind: "assistant", key: `a${key}`, seq: ev.seq, text: b.text, streaming: false, ts: ev.ts };
        if (existing !== undefined) items[existing] = item;
        else {
          textIdx.set(key, items.length);
          items.push(item);
        }
        if (thread === null && isUsageLimitText(b.text)) limitText = existing ?? items.length - 1;
        break;
      }
      case "tool.use": {
        const todos = b.name === "TodoWrite" ? parseTodos(b.input) : null;
        if (todos && lastTodo !== null) {
          const prev = items[lastTodo];
          if (prev?.kind === "tool") items[lastTodo] = { ...prev, superseded: true };
        }
        toolIdx.set(b.toolUseId, items.length);
        if (todos) lastTodo = items.length;
        items.push({ kind: "tool", key: `t${b.toolUseId || ev.seq}`, ts: ev.ts, use: b, result: null, approval: null, blocked: null, todos, superseded: false, seqs: [ev.seq] });
        break;
      }
      case "tool.result": {
        const i = toolIdx.get(b.toolUseId);
        const it = i !== undefined ? items[i] : undefined;
        if (it?.kind === "tool") items[i!] = { ...it, result: b, seqs: [...(it.seqs ?? []), ev.seq] };
        break;
      }
      case "approval.request": {
        const i = toolIdx.get(b.toolUseId);
        const it = i !== undefined ? items[i] : undefined;
        if (it?.kind === "tool") {
          items[i!] = { ...it, approval: { req: b, resolved: null } };
          approvalIdx.set(b.requestId, { item: i!, inTool: true });
        } else {
          approvalIdx.set(b.requestId, { item: items.length, inTool: false });
          items.push({ kind: "approval", key: `p${b.requestId}`, ts: ev.ts, req: b, resolved: null });
        }
        break;
      }
      case "approval.resolved": {
        const ref = approvalIdx.get(b.requestId);
        if (!ref) break;
        const it = items[ref.item];
        if (it?.kind === "tool" && it.approval) items[ref.item] = { ...it, approval: { ...it.approval, resolved: b } };
        else if (it?.kind === "approval") items[ref.item] = { ...it, resolved: b };
        break;
      }
      case "policy.blocked": {
        const i = b.toolUseId ? toolIdx.get(b.toolUseId) : undefined;
        const it = i !== undefined ? items[i] : undefined;
        if (it?.kind === "tool") items[i!] = { ...it, blocked: b };
        else items.push({ kind: "blocked", key: `b${ev.seq}`, ts: ev.ts, body: b });
        break;
      }
      case "check.result":
        items.push({ kind: "check", key: `c${ev.seq}`, ts: ev.ts, body: b });
        break;
      case "ui.compare":
        items.push({ kind: "uiCompare", key: `v${b.compareId}`, ts: ev.ts, body: b });
        break;
      case "session.handoff":
        items.push({ kind: "handoff", key: `h${ev.seq}`, ts: ev.ts, body: b });
        break;
      case "notify":
        items.push({
          kind: "notice",
          key: `y${ev.seq}`,
          ts: ev.ts,
          text: b.message,
          tone: b.urgent ? "warning" : "info",
          card: { title: b.urgent ? t.chat.events.notifyUrgent : t.chat.events.notify, ref: null, detail: b.message, icon: "notify" },
        });
        break;
      case "automation": {
        // auto-test left out because nothing that can affect tests changed: information, no warning
        const testSkip = b.action === "skip" ? /^(Tests übersprungen|Tests nicht erneut ausgeführt):\s*/.exec(b.message) : null;
        items.push({
          kind: "notice",
          key: `m${ev.seq}`,
          ts: ev.ts,
          text:
            b.action === "commit" && b.ok
              ? t.chat.events.autoCommitText(b.hash?.slice(0, 7) ?? "", b.message, b.files.length)
              : b.action === "push" && b.ok
                ? t.chat.events.autoPushText(b.message)
                : b.message,
          // A merge that is not ok hit conflicts the agent now resolves: a warning, not a failure.
          tone: b.action === "merge" ? (b.ok ? "success" : "warning") : b.action === "wait" || (testSkip && b.ok) ? "info" : !b.ok ? "danger" : b.action === "skip" ? "warning" : "success",
          card: testSkip
            ? { title: testSkip[1]!, ref: null, detail: b.message.slice(testSkip[0].length), icon: "skip" }
            : b.action === "commit"
              ? { title: b.ok ? t.chat.events.autoCommit : t.chat.events.autoCommitFailed, ref: b.ok ? (b.hash?.slice(0, 7) ?? null) : null, detail: b.ok ? t.chat.events.commitDetail(b.message, b.files.length) : b.message, icon: "commit" }
              : b.action === "push"
                ? { title: b.ok ? t.chat.events.autoPush : t.chat.events.autoPushFailed, ref: null, detail: b.message, icon: "push" }
                : b.action === "merge"
                  ? { title: b.ok ? t.chat.events.merged : t.chat.events.mergeConflicts, ref: null, detail: b.message.replace(/^(?:Automatisch zusammengeführt|Merged automatically):\s*/, ""), icon: "merge" }
                  : b.action === "wait"
                    ? { title: t.chat.events.waitingForMerge, ref: null, detail: b.message.replace(/^(?:Wartet aufs Zusammenführen|Waiting to merge):\s*/, ""), icon: "merge" }
                    : {
                        title: t.chat.events.automationSkipped,
                        ref: null,
                        // both languages: stored events keep the language they were written in
                        detail: b.message.replace(/^(Auto-(Commit|Push) übersprungen|Nicht automatisch zusammengeführt|Auto-(commit|push) skipped|Not merged automatically):\s*/, ""),
                        icon: "skip",
                      },
        });
        break;
      }
      case "files.rewound":
        items.push({
          kind: "notice",
          key: `w${ev.seq}`,
          ts: ev.ts,
          text: b.filesChanged.length ? t.chat.events.rewoundText(b.filesChanged.length) : t.chat.events.rewoundNone,
          tone: "info",
          card: { title: t.chat.events.filesRewound, ref: null, detail: b.filesChanged.length ? t.chat.events.rewoundDetail(b.filesChanged.length) : t.chat.events.noFilesChanged, icon: "rewind" },
        });
        break;
      case "turn.result":
        limitResult = b.isError ? items.length : null;
        // only the message the turn ended with; an earlier one that merely mentions a limit stays
        if (!b.isError || (limitText !== null && limitText < items.length - (limitNotice === items.length - 1 ? 2 : 1))) limitText = null;
        items.push({ kind: "result", key: `r${ev.seq}`, ts: ev.ts, body: b });
        break;
      case "context.compacted": {
        const title = b.trigger === "auto" ? t.chat.events.compactedAuto : t.chat.events.compacted;
        const tokens = b.preTokens !== null ? t.chat.events.compactTokens(formatK(b.preTokens), b.postTokens !== null ? formatK(b.postTokens) : null) : null;
        items.push({
          kind: "notice",
          key: `k${ev.seq}`,
          ts: ev.ts,
          text: t.chat.events.compactText(title, tokens),
          tone: "info",
          card: { title, ref: null, detail: t.chat.events.compactDetail(tokens), icon: "compact" },
        });
        break;
      }
      case "error":
        items.push({ kind: "error", key: `e${ev.seq}`, ts: ev.ts, message: b.message, retryable: b.retryable });
        break;
      case "background.task": {
        const text =
          b.state === "started"
            ? t.chat.events.backgroundStartedText(b.description)
            : b.state === "completed"
              ? t.chat.events.backgroundCompletedText(b.description)
              : b.state === "failed"
                ? t.chat.events.backgroundFailedText(b.description)
                : t.chat.events.backgroundStoppedText(b.description);
        const tone = b.state === "completed" ? "success" : b.state === "failed" ? "danger" : b.state === "stopped" ? "warning" : "info";
        const title =
          b.state === "started" ? t.chat.events.backgroundStarted : b.state === "completed" ? t.chat.events.backgroundCompleted : b.state === "failed" ? t.chat.events.backgroundFailed : t.chat.events.backgroundStopped;
        items.push({
          kind: "notice",
          key: `n${ev.seq}`,
          ts: ev.ts,
          text,
          tone,
          card: { title, ref: null, detail: b.state === "started" ? t.chat.events.backgroundStartedDetail(b.description) : b.description, icon: "background" },
        });
        break;
      }
      case "app.updated": {
        const versions = b.from && b.to && b.from !== b.to ? `${b.from} → ${b.to} · ` : "";
        const detail = t.chat.events.updateDetail(versions);
        // Same version: the update did not go through and the old FORGE came back.
        const title = b.from !== b.to ? t.chat.events.updated : t.chat.events.restarted;
        items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: `${title}: ${detail}`, tone: "info", card: { title, ref: null, detail, icon: "update" } });
        break;
      }
      case "status":
        if (b.detail && b.detail.startsWith("Achtung")) items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: b.detail, tone: "warning" });
        else if (b.status === "stopped" && isIdleClosedDetail(b.detail)) items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: b.detail, tone: "info" });
        break;
      // Warnings ("allowed_warning") arrive with every request near the limit; the composer shows them
      // permanently instead. Only a real stop belongs in the chat.
      case "rate_limit":
        if (b.status === "rejected" && !b.overageInUse) {
          const when = b.resetsAt ? limitTime(new Date(b.resetsAt * 1000).toISOString(), Date.parse(ev.ts)) : null;
          const detail = t.chat.events.limitDetail(limitLabel(b.limitType), when);
          limitNotice = items.length;
          items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: t.chat.events.limitText(detail), tone: "warning", card: { title: t.chat.autoContinue.limitReached, ref: null, detail, icon: "limit" } });
        }
        break;
      case "auto_continue":
        if (openPlan !== null) items[openPlan] = { ...(items[openPlan] as AutoContinueItem), open: false };
        openPlan = null;
        // The plan card says the limit was reached; the notice, Claude's limit message and the failed
        // turn end right before it would only repeat that.
        if (b.state === "scheduled") for (const i of [limitNotice, limitText, limitResult]) if (i !== null) dropped.add(i);
        limitNotice = limitText = limitResult = null;
        if (b.state === "scheduled") openPlan = items.length;
        items.push({ kind: "autoContinue", key: `l${ev.seq}`, ts: ev.ts, body: b, open: b.state === "scheduled" });
        break;
      case "message.edited": {
        // Claude no longer sees the old prompt and what followed it; the edited one takes its place.
        const from = startSeq.findIndex((s) => s >= b.fromSeq);
        if (from >= 0) truncate(from);
        editedNext = true;
        break;
      }
      default:
        break;
    }
  }
}

/** Thread of an event: the Agent/Task call whose subagent produced it, null for the main chat. */
function eventThread(b: SessionEventBody, threadOf: ReadonlyMap<string, string | null>): string | null {
  switch (b.type) {
    case "tool.use":
    case "assistant.text":
      return b.parentToolUseId ?? null;
    case "tool.result":
    case "approval.request":
      return threadOf.get(b.toolUseId) ?? null;
    case "policy.blocked":
      return b.toolUseId ? (threadOf.get(b.toolUseId) ?? null) : null;
    default:
      return null;
  }
}

/** Chat items of the persisted events only, without live deltas; `thread` as in itemFolder. */
export function buildEventItems(events: SessionEvent[], thread: string | null = null): ChatItem[] {
  const f = itemFolder(thread);
  for (const ev of events) f.add(ev);
  return f.result();
}

/**
 * buildEventItems for a buffer that mostly grows at the end (live events): continues from the
 * events it has seen and starts over when the start changed (older pages, reload).
 */
export class IncrementalItems {
  private f: ReturnType<typeof itemFolder>;
  private count = 0;
  private firstSeq: number | null = null;
  private lastSeq: number | null = null;

  constructor(private readonly thread: string | null = null) {
    this.f = itemFolder(thread);
  }

  build(events: readonly SessionEvent[]): ChatItem[] {
    const continues = this.count > 0 && events.length >= this.count && events[0]?.seq === this.firstSeq && events[this.count - 1]?.seq === this.lastSeq;
    if (!continues) {
      this.f = itemFolder(this.thread);
      this.count = 0;
    }
    for (let i = this.count; i < events.length; i++) this.f.add(events[i]!);
    this.count = events.length;
    this.firstSeq = events[0]?.seq ?? null;
    this.lastSeq = events.at(-1)?.seq ?? null;
    return this.f.result();
  }
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

const INJECTED_PREFIXES = ["<task-notification>", "<system-reminder>", "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"];

/** A slash command like "/compact" or "/model opus"; "/home/x geht nicht" is a path, not a command. */
export function isSlashCommand(text: string): boolean {
  return /^\/[\w:.-]+(\s|$)/.test(text.trim());
}

/** Text Claude Code injects as a user turn (task notifications, reminders, output of local commands), not something the user typed. */
export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

/** Vertical gap before a chat row: a new turn stands apart, one-line rows in a row stack tightly. */
export type RowSpacing = "first" | "turn" | "block" | "tight";

function isCompactRow(item: ChatItem): boolean {
  switch (item.kind) {
    case "tool":
      return !(item.todos && !item.superseded) && item.use.name !== "AskUserQuestion" && item.use.name !== "ExitPlanMode" && !(item.approval && !item.approval.resolved);
    case "blocked":
    case "notice":
    case "check":
    case "autoContinue":
      return true;
    default:
      return false;
  }
}

export function rowSpacing(prev: ChatItem | undefined, item: ChatItem): RowSpacing {
  if (!prev) return "first";
  if (item.kind === "user") return "turn";
  if (item.kind === "result") return "tight";
  if (isCompactRow(prev) && isCompactRow(item)) return "tight";
  return "block";
}

/** Index of the item that shows the event with this seq (search hits), or of the nearest one before it. */
export function itemIndexForSeq(items: ChatItem[], seq: number): number {
  const tool = items.findIndex((it) => it.kind === "tool" && it.seqs?.includes(seq));
  if (tool >= 0) return tool;
  let best = -1;
  let bestSeq = -1;
  items.forEach((it, i) => {
    const s = it.kind === "user" || it.kind === "assistant" ? it.seq : null;
    if (s !== null && s <= seq && s > bestSeq) {
      best = i;
      bestSeq = s;
    }
  });
  return best;
}

/** The last user prompt, for "retry". */
export function lastUserPrompt(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const b = events[i]!.body;
    if (b.type === "user.message" && !isInjectedUserText(b.text)) return b.text;
  }
  return null;
}

/** Shows paths inside the project relative to it; everything else unchanged. */
export function relativeToProject(p: string, projectDir?: string): string {
  if (!projectDir || !p) return p;
  return pathInside(p, projectDir) || p;
}

/** Short one-line summary of a tool call for cards and the activity feed. */
export function toolSummary(name: string, input: Record<string, unknown>, projectDir?: string): string {
  const s = (k: string) => (typeof input[k] === "string" ? relativeToProject(input[k] as string, projectDir) : "");
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return s("file_path") || s("notebook_path");
    case "Bash":
    case "PowerShell":
      return s("command");
    case "Glob":
      return s("pattern");
    case "Grep":
      return `${s("pattern")}${s("path") ? ` in ${s("path")}` : ""}`;
    case "WebFetch":
      return s("url");
    case "WebSearch":
      return s("query");
    case "Task":
    case "Agent":
      return s("description") || s("subagent_type");
    case "TodoWrite":
      return t.chat.events.todoUpdated;
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? (input.questions as Array<{ question?: unknown }>) : [];
      return typeof qs[0]?.question === "string" ? qs[0].question : "";
    }
    case "ExitPlanMode":
      return t.chat.cards.planForApproval;
    default:
      return Object.values(input).find((v): v is string => typeof v === "string")?.slice(0, 120) ?? "";
  }
}

/** Tool name as Claude Code shows it; MCP tools ("mcp__server__tool") as "server: tool". */
export function toolDisplayName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2]}` : name;
}

export const TOOL_LABELS: Record<string, string> = t.chat.toolLabels;

/** The first entry after one of your messages (or at the very top) opens Claude's answer. */
export function startsAnswer(prev: ChatItem | undefined, item: ChatItem): boolean {
  return item.kind !== "user" && (!prev || prev.kind === "user");
}
