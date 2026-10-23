/**
 * Rows of a member's session in the live view, folded from its events like FORGE's chat
 * (apps/desktop/src/components/workspace/chat-items.ts, main conversation only). A copy carries the
 * event bodies without number and time, so rows are keyed by position.
 */

type Obj = Record<string, unknown>;

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ToolUse {
  toolUseId: string;
  name: string;
  input: Obj;
  inputTruncated: boolean;
}

export interface ToolResult {
  isError: boolean;
  text: string;
  truncated: boolean;
}

export interface Approval {
  toolName: string;
  title: string | null;
  input: Obj;
  resolved: { decision: "allow" | "deny"; scope: "once" | "session"; source: string; message: string | null } | null;
}

export type NoticeKind = "compact" | "compactAuto" | "background" | "notify" | "notifyUrgent" | "commit" | "push" | "merge" | "skip" | "rewind" | "limit" | "update" | "info";

export type ChatItem =
  | { kind: "user"; key: string; text: string; auto: boolean; remote: boolean; attachments: string[] }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tool"; key: string; use: ToolUse; result: ToolResult | null; approval: Approval | null; blocked: string | null; todos: TodoEntry[] | null; superseded: boolean }
  | { kind: "approval"; key: string; approval: Approval }
  | { kind: "result"; key: string; isError: boolean; interrupted: boolean; text: string | null; subtype: string; durationMs: number | null; numTurns: number | null; inputTokens: number | null; outputTokens: number | null }
  | { kind: "error"; key: string; message: string }
  | { kind: "notice"; key: string; notice: NoticeKind; tone: "info" | "warning" | "success" | "danger"; title: string | null; detail: string; ref: string | null };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

const INJECTED_PREFIXES = ["<task-notification>", "<system-reminder>", "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"];
const isInjected = (text: string) => INJECTED_PREFIXES.some((p) => text.trimStart().startsWith(p));

function parseTodos(input: Obj): TodoEntry[] | null {
  if (!Array.isArray(input.todos)) return null;
  return input.todos
    .filter((t): t is Obj => !!t && typeof t === "object")
    .map((t) => ({
      content: str(t.content),
      status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
      activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
    }));
}

function resultText(content: unknown): { text: string; truncated: boolean } {
  if (typeof content === "string") return { text: content, truncated: false };
  const c = obj(content);
  return { text: str(c.text), truncated: c.truncated === true };
}

/** The rows of the main conversation; events of subagents stay out, as in FORGE's chat. */
export function buildChatItems(events: readonly unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolIdx = new Map<string, number>();
  const threadOf = new Map<string, string | null>();
  const approvalIdx = new Map<string, number>();
  const textIdx = new Map<string, number>();
  let lastTodo: number | null = null;

  const threadOfEvent = (b: Obj): string | null => {
    switch (b.type) {
      case "tool.use":
      case "assistant.text":
        return typeof b.parentToolUseId === "string" ? b.parentToolUseId : null;
      case "tool.result":
      case "approval.request":
        return threadOf.get(str(b.toolUseId)) ?? null;
      case "policy.blocked":
        return typeof b.toolUseId === "string" ? (threadOf.get(b.toolUseId) ?? null) : null;
      default:
        return null;
    }
  };

  events.forEach((raw, n) => {
    const b = obj(raw);
    if (b.type === "tool.use") threadOf.set(str(b.toolUseId), typeof b.parentToolUseId === "string" ? b.parentToolUseId : null);
    if (b.type !== "approval.resolved" && threadOfEvent(b) !== null) {
      // A subagent's approval also shows in the main chat, so it never waits unnoticed.
      if (b.type === "approval.request") {
        approvalIdx.set(str(b.requestId), items.length);
        items.push({ kind: "approval", key: `p${n}`, approval: { toolName: str(b.toolName), title: typeof b.title === "string" ? b.title : null, input: obj(b.input), resolved: null } });
      }
      return;
    }
    switch (b.type) {
      case "user.message": {
        const text = str(b.text);
        if (isInjected(text)) break;
        const attachments = Array.isArray(b.attachments) ? b.attachments.map((a) => str(obj(a).name)).filter(Boolean) : [];
        items.push({ kind: "user", key: `u${n}`, text, auto: b.source === "auto", remote: b.source === "remote", attachments });
        break;
      }
      case "assistant.text": {
        const id = `${str(b.messageId)}:${String(b.index)}`;
        const item: ChatItem = { kind: "assistant", key: `a${id}`, text: str(b.text) };
        const at = textIdx.get(id);
        if (at !== undefined) items[at] = item;
        else {
          textIdx.set(id, items.length);
          items.push(item);
        }
        break;
      }
      case "tool.use": {
        const name = str(b.name);
        const input = obj(b.input);
        const todos = name === "TodoWrite" ? parseTodos(input) : null;
        if (todos && lastTodo !== null) {
          const prev = items[lastTodo];
          if (prev?.kind === "tool") items[lastTodo] = { ...prev, superseded: true };
        }
        toolIdx.set(str(b.toolUseId), items.length);
        if (todos) lastTodo = items.length;
        items.push({ kind: "tool", key: `t${str(b.toolUseId) || n}`, use: { toolUseId: str(b.toolUseId), name, input, inputTruncated: b.inputTruncated === true }, result: null, approval: null, blocked: null, todos, superseded: false });
        break;
      }
      case "tool.result": {
        const i = toolIdx.get(str(b.toolUseId));
        const it = i !== undefined ? items[i] : undefined;
        if (it?.kind === "tool") items[i!] = { ...it, result: { isError: b.isError === true, ...resultText(b.content) } };
        break;
      }
      case "approval.request": {
        const approval: Approval = { toolName: str(b.toolName), title: typeof b.title === "string" ? b.title : null, input: obj(b.input), resolved: null };
        const i = toolIdx.get(str(b.toolUseId));
        const it = i !== undefined ? items[i] : undefined;
        if (it?.kind === "tool") {
          items[i!] = { ...it, approval };
          approvalIdx.set(str(b.requestId), i!);
        } else {
          approvalIdx.set(str(b.requestId), items.length);
          items.push({ kind: "approval", key: `p${n}`, approval });
        }
        break;
      }
      case "approval.resolved": {
        const i = approvalIdx.get(str(b.requestId));
        const it = i !== undefined ? items[i] : undefined;
        const resolved = { decision: b.decision === "allow" ? ("allow" as const) : ("deny" as const), scope: b.scope === "session" ? ("session" as const) : ("once" as const), source: str(b.source), message: typeof b.message === "string" ? b.message : null };
        if (it?.kind === "tool" && it.approval) items[i!] = { ...it, approval: { ...it.approval, resolved } };
        else if (it?.kind === "approval") items[i!] = { ...it, approval: { ...it.approval, resolved } };
        break;
      }
      case "policy.blocked": {
        const i = typeof b.toolUseId === "string" ? toolIdx.get(b.toolUseId) : undefined;
        const it = i !== undefined ? items[i] : undefined;
        if (it?.kind === "tool") items[i!] = { ...it, blocked: str(b.message) };
        else items.push({ kind: "notice", key: `b${n}`, notice: "info", tone: "danger", title: null, detail: `${str(b.toolName)}: ${str(b.message)}`, ref: null });
        break;
      }
      case "turn.result":
        items.push({
          kind: "result",
          key: `r${n}`,
          isError: b.isError === true,
          interrupted: b.interrupted === true,
          text: typeof b.text === "string" ? b.text : null,
          subtype: str(b.subtype),
          durationMs: num(b.durationMs),
          numTurns: num(b.numTurns),
          inputTokens: num(b.inputTokens),
          outputTokens: num(b.outputTokens),
        });
        break;
      case "error":
        items.push({ kind: "error", key: `e${n}`, message: str(b.message) });
        break;
      case "context.compacted":
        items.push({ kind: "notice", key: `k${n}`, notice: b.trigger === "auto" ? "compactAuto" : "compact", tone: "info", title: null, detail: "", ref: null });
        break;
      case "notify":
        items.push({ kind: "notice", key: `y${n}`, notice: b.urgent ? "notifyUrgent" : "notify", tone: b.urgent ? "warning" : "info", title: null, detail: str(b.message), ref: null });
        break;
      case "background.task": {
        const state = str(b.state);
        items.push({
          kind: "notice",
          key: `g${n}`,
          notice: "background",
          tone: state === "completed" ? "success" : state === "failed" ? "danger" : state === "stopped" ? "warning" : "info",
          title: state,
          detail: str(b.description),
          ref: null,
        });
        break;
      }
      case "automation": {
        const action = str(b.action);
        const ok = b.ok === true;
        const notice: NoticeKind = action === "commit" || action === "push" || action === "merge" ? action : "skip";
        items.push({
          kind: "notice",
          key: `m${n}`,
          notice,
          tone: action === "merge" ? (ok ? "success" : "warning") : action === "wait" ? "info" : !ok ? "danger" : action === "skip" ? "warning" : "success",
          title: ok ? "ok" : "failed",
          detail: str(b.message),
          ref: action === "commit" && ok && typeof b.hash === "string" ? b.hash.slice(0, 7) : null,
        });
        break;
      }
      case "files.rewound":
        items.push({ kind: "notice", key: `w${n}`, notice: "rewind", tone: "info", title: null, detail: String(Array.isArray(b.filesChanged) ? b.filesChanged.length : 0), ref: null });
        break;
      case "rate_limit":
        if (b.status === "rejected" && !b.overageInUse) items.push({ kind: "notice", key: `l${n}`, notice: "limit", tone: "warning", title: null, detail: "", ref: null });
        break;
      case "app.updated":
        items.push({ kind: "notice", key: `n${n}`, notice: "update", tone: "info", title: null, detail: [b.from, b.to].filter((x) => typeof x === "string").join(" → "), ref: null });
        break;
      default:
        break;
    }
  });
  return items;
}

/** The first row after one of the user's messages (or at the very top) opens Claude's answer: it gets Claude's mark. */
export function startsAnswer(prev: ChatItem | undefined, item: ChatItem): boolean {
  return item.kind !== "user" && (!prev || prev.kind === "user");
}

export type RowSpacing = "first" | "turn" | "block" | "tight";

function isCompactRow(item: ChatItem): boolean {
  if (item.kind === "tool") return !(item.todos && !item.superseded) && !(item.approval && !item.approval.resolved);
  return item.kind === "notice";
}

/** Gap before a row, as in FORGE: a new turn stands apart, one-line rows in a row stack tightly. */
export function rowSpacing(prev: ChatItem | undefined, item: ChatItem): RowSpacing {
  if (!prev) return "first";
  if (item.kind === "user") return "turn";
  if (item.kind === "result") return "tight";
  if (isCompactRow(prev) && isCompactRow(item)) return "tight";
  return "block";
}

/** Short one-line summary of a tool call, as FORGE shows it next to the tool name. */
export function toolSummary(name: string, input: Obj): string {
  const s = (k: string) => str(input[k]);
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
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? (input.questions as Obj[]) : [];
      return str(qs[0]?.question);
    }
    default:
      return Object.values(input).find((v): v is string => typeof v === "string")?.slice(0, 120) ?? "";
  }
}

/** Tool name as Claude Code shows it; MCP tools ("mcp__server__tool") as "server: tool". */
export function toolDisplayName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]}: ${m[2]}` : name;
}

/** A path inside the session's folder relative to it (as FORGE shows it), everything else unchanged. */
export function relativeTo(p: string, cwd: string | null): string {
  if (!cwd || !p) return p;
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(cwd);
  const path = norm(p);
  const windows = /^[a-z]:\//i.test(base);
  const inside = windows ? path.toLowerCase().startsWith(`${base.toLowerCase()}/`) : path.startsWith(`${base}/`);
  return inside ? path.slice(base.length + 1) : p;
}
