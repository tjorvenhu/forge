import type { SessionEvent, SessionEventBody } from "@forge/protocol";
import { limitLabel, limitTime } from "@/lib/rate-limit";

type Body<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>;

export type NoticeIcon = "commit" | "push" | "skip" | "rewind" | "compact" | "background" | "limit" | "notify";

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type ChatItem =
  | { kind: "user"; key: string; seq: number; text: string; ts: string; uuid: string | null; attachments: Array<{ name: string; mediaType: string; size: number }>; remote: boolean; auto: boolean }
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
 */
function itemFolder() {
  const items: ChatItem[] = [];
  const toolIdx = new Map<string, number>();
  const approvalIdx = new Map<string, { item: number; inTool: boolean }>();  const textIdx = new Map<string, number>();
  let lastTodo: number | null = null;
  /** the "limit reached" notice of the current turn; replaced by the plan card when one follows */
  let limitNotice: number | null = null;
  /** the plan card that is still the latest word on the automatic continuation */
  let openPlan: number | null = null;
  const dropped = new Set<number>();

  return {
    add(ev: SessionEvent) {
      const b = ev.body;
      switch (b.type) {
        case "user.message":
          // Older FORGE versions stored Claude Code's own notifications as prompts; the background task card covers them.
          if (isInjectedUserText(b.text)) break;
          if (b.source !== "auto" && openPlan !== null) {
            items[openPlan] = { ...(items[openPlan] as AutoContinueItem), open: false };
            openPlan = null;
          }
          limitNotice = null;
          items.push({ kind: "user", key: `u${ev.seq}`, seq: ev.seq, text: b.text, ts: ev.ts, uuid: b.uuid ?? null, attachments: b.attachments ?? [], remote: b.source === "remote", auto: b.source === "auto" });
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
          items.push({ kind: "tool", key: `t${b.toolUseId || ev.seq}`, ts: ev.ts, use: b, result: null, approval: null, blocked: null, todos, superseded: false });
          break;
        }
        case "tool.result": {
          const i = toolIdx.get(b.toolUseId);
          const it = i !== undefined ? items[i] : undefined;
          if (it?.kind === "tool") items[i!] = { ...it, result: b };
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
        case "notify":
          items.push({
            kind: "notice",
            key: `y${ev.seq}`,
            ts: ev.ts,
            text: b.message,
            tone: b.urgent ? "warning" : "info",
            card: { title: b.urgent ? "Claude braucht dich" : "Claude meldet sich", ref: null, detail: b.message, icon: "notify" },
          });
          break;
        case "automation":
          items.push({
            kind: "notice",
            key: `m${ev.seq}`,
            ts: ev.ts,
            text:
              b.action === "commit" && b.ok
                ? `Auto-Commit ${b.hash?.slice(0, 7) ?? ""}: ${b.message} (${b.files.length} Datei(en))`
                : b.action === "push" && b.ok
                  ? `Auto-Push: ${b.message}`
                  : b.message,
            tone: !b.ok ? "danger" : b.action === "skip" ? "warning" : "success",
            card:
              b.action === "commit"
                ? { title: b.ok ? "Auto-Commit" : "Auto-Commit fehlgeschlagen", ref: b.ok ? (b.hash?.slice(0, 7) ?? null) : null, detail: b.ok ? `${b.message} · ${b.files.length} Datei(en)` : b.message, icon: "commit" }
                : b.action === "push"
                  ? { title: b.ok ? "Auto-Push" : "Auto-Push fehlgeschlagen", ref: null, detail: b.message, icon: "push" }
                  : { title: "Automatik übersprungen", ref: null, detail: b.message.replace(/^Auto-(Commit|Push) übersprungen:\s*/, ""), icon: "skip" },
          });
          break;
        case "files.rewound":
          items.push({
            kind: "notice",
            key: `w${ev.seq}`,
            ts: ev.ts,
            text: b.filesChanged.length ? `Dateien zurückgesetzt: ${b.filesChanged.length} Datei(en)` : "Zurückgesetzt, keine Dateien geändert",
            tone: "info",
            card: { title: "Dateien zurückgesetzt", ref: null, detail: b.filesChanged.length ? `${b.filesChanged.length} Datei(en) auf den früheren Stand` : "Keine Dateien geändert", icon: "rewind" },
          });
          break;
        case "turn.result":
          items.push({ kind: "result", key: `r${ev.seq}`, ts: ev.ts, body: b });
          break;
        case "context.compacted":
          items.push({
            kind: "notice",
            key: `k${ev.seq}`,
            ts: ev.ts,
            text: `${b.trigger === "auto" ? "Kontext automatisch komprimiert" : "Kontext komprimiert"}${b.preTokens !== null ? `: vorher ${formatK(b.preTokens)}${b.postTokens !== null ? `, nachher ${formatK(b.postTokens)}` : ""} Tokens` : ""}. Claude arbeitet mit einer Zusammenfassung des bisherigen Verlaufs weiter.`,
            tone: "info",
            card: {
              title: b.trigger === "auto" ? "Kontext automatisch komprimiert" : "Kontext komprimiert",
              ref: null,
              detail: b.preTokens !== null ? `vorher ${formatK(b.preTokens)}${b.postTokens !== null ? `, nachher ${formatK(b.postTokens)}` : ""} Tokens · Claude arbeitet mit einer Zusammenfassung weiter` : "Claude arbeitet mit einer Zusammenfassung weiter",
              icon: "compact",
            },
          });
          break;
        case "error":
          items.push({ kind: "error", key: `e${ev.seq}`, ts: ev.ts, message: b.message, retryable: b.retryable });
          break;
        case "background.task": {
          const text =
            b.state === "started"
              ? `Läuft im Hintergrund: ${b.description}. Claude meldet sich, wenn die Aufgabe fertig ist.`
              : b.state === "completed"
                ? `Hintergrundaufgabe fertig: ${b.description}`
                : b.state === "failed"
                  ? `Hintergrundaufgabe fehlgeschlagen: ${b.description}`
                  : `Hintergrundaufgabe beendet: ${b.description}`;
          const tone = b.state === "completed" ? "success" : b.state === "failed" ? "danger" : b.state === "stopped" ? "warning" : "info";
          const title =
            b.state === "started" ? "Läuft im Hintergrund" : b.state === "completed" ? "Hintergrundaufgabe fertig" : b.state === "failed" ? "Hintergrundaufgabe fehlgeschlagen" : "Hintergrundaufgabe beendet";
          items.push({
            kind: "notice",
            key: `n${ev.seq}`,
            ts: ev.ts,
            text,
            tone,
            card: { title, ref: null, detail: b.state === "started" ? `${b.description} · Claude meldet sich, wenn sie fertig ist` : b.description, icon: "background" },
          });
          break;
        }
        case "status":
          if (b.detail && b.detail.startsWith("Achtung")) items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: b.detail, tone: "warning" });
          break;
        // Warnings ("allowed_warning") arrive with every request near the limit; the composer shows them
        // permanently instead. Only a real stop belongs in the chat.
        case "rate_limit":
          if (b.status === "rejected" && !b.overageInUse) {
            const when = b.resetsAt ? limitTime(new Date(b.resetsAt * 1000).toISOString(), Date.parse(ev.ts)) : null;
            const detail = `${limitLabel(b.limitType)}${when ? ` · zurückgesetzt um ${when}` : ""}`;
            limitNotice = items.length;
            items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: `Nutzungslimit erreicht: ${detail}`, tone: "warning", card: { title: "Nutzungslimit erreicht", ref: null, detail, icon: "limit" } });
          }
          break;
        case "auto_continue":
          if (openPlan !== null) items[openPlan] = { ...(items[openPlan] as AutoContinueItem), open: false };
          openPlan = null;
          // The plan card says the limit was reached; the plain notice right before it would repeat that.
          if (b.state === "scheduled" && limitNotice !== null) dropped.add(limitNotice);
          limitNotice = null;
          if (b.state === "scheduled") openPlan = items.length;
          items.push({ kind: "autoContinue", key: `l${ev.seq}`, ts: ev.ts, body: b, open: b.state === "scheduled" });
          break;
        default:
          break;
      }
    },
    result(): ChatItem[] {
      return dropped.size ? items.filter((_, i) => !dropped.has(i)) : items.slice();
    },
  };
}

/** Chat items of the persisted events only, without live deltas. */
export function buildEventItems(events: SessionEvent[]): ChatItem[] {
  const f = itemFolder();
  for (const ev of events) f.add(ev);
  return f.result();
}

/**
 * buildEventItems for a buffer that mostly grows at the end (live events): continues from the
 * events it has seen and starts over when the start changed (older pages, reload).
 */
export class IncrementalItems {
  private f = itemFolder();
  private count = 0;
  private firstSeq: number | null = null;
  private lastSeq: number | null = null;

  build(events: readonly SessionEvent[]): ChatItem[] {
    const continues = this.count > 0 && events.length >= this.count && events[0]?.seq === this.firstSeq && events[this.count - 1]?.seq === this.lastSeq;
    if (!continues) {
      this.f = itemFolder();
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

const INJECTED_PREFIXES = ["<task-notification>", "<system-reminder>"];

/** Text Claude Code injects as a user turn (task notifications, reminders), not something the user typed. */
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
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = norm(p);
  const dir = norm(projectDir);
  return file.toLowerCase().startsWith(dir.toLowerCase() + "/") ? file.slice(dir.length + 1) : p;
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
      return "Aufgabenliste aktualisiert";
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? (input.questions as Array<{ question?: unknown }>) : [];
      return typeof qs[0]?.question === "string" ? qs[0].question : "";
    }
    case "ExitPlanMode":
      return "Plan zur Freigabe";
    default:
      return Object.values(input).find((v): v is string => typeof v === "string")?.slice(0, 120) ?? "";
  }
}

/** Tool name as Claude Code shows it; MCP tools ("mcp__server__tool") as "server: tool". */
export function toolDisplayName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2]}` : name;
}

export const TOOL_LABELS: Record<string, string> = {
  Read: "Lesen",
  Write: "Erstellen",
  Edit: "Bearbeiten",
  MultiEdit: "Bearbeiten",
  NotebookEdit: "Notebook bearbeiten",
  Bash: "Terminal",
  PowerShell: "PowerShell",
  Glob: "Dateien suchen",
  Grep: "Durchsuchen",
  WebFetch: "Web abrufen",
  WebSearch: "Websuche",
  Task: "Subagent",
  Agent: "Subagent",
  TodoWrite: "Aufgaben",
  AskUserQuestion: "Rückfrage",
  ExitPlanMode: "Plan",
};

/** The first entry after one of your messages (or at the very top) opens Claude's answer. */
export function startsAnswer(prev: ChatItem | undefined, item: ChatItem): boolean {
  return item.kind !== "user" && (!prev || prev.kind === "user");
}
