import type { SessionEvent, SessionEventBody } from "@forge/protocol";

type Body<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>;

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type ChatItem =
  | { kind: "user"; key: string; text: string; ts: string; uuid: string | null; attachments: Array<{ name: string; mediaType: string; size: number }>; remote: boolean }
  | { kind: "assistant"; key: string; text: string; streaming: boolean; ts: string | null }
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
  | { kind: "approval"; key: string; ts: string; req: Body<"approval.request">; resolved: Body<"approval.resolved"> | null }
  | { kind: "blocked"; key: string; ts: string; body: Body<"policy.blocked"> }
  | { kind: "result"; key: string; ts: string; body: Body<"turn.result"> }
  | { kind: "error"; key: string; ts: string; message: string; retryable: boolean }
  | { kind: "notice"; key: string; ts: string; text: string; tone: "info" | "warning" | "success" | "danger" }
  | { kind: "check"; key: string; ts: string; body: Body<"check.result"> };

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
  const items: ChatItem[] = [];
  const toolIdx = new Map<string, number>();
  const approvalIdx = new Map<string, { item: number; inTool: boolean }>();
  const textIdx = new Map<string, number>();
  let lastTodo: number | null = null;

  for (const ev of events) {
    const b = ev.body;
    switch (b.type) {
      case "user.message":
        items.push({ kind: "user", key: `u${ev.seq}`, text: b.text, ts: ev.ts, uuid: b.uuid ?? null, attachments: b.attachments ?? [], remote: b.source === "remote" });
        break;
      case "assistant.text": {
        const key = `${b.messageId}:${b.index}`;
        const existing = textIdx.get(key);
        const item: ChatItem = { kind: "assistant", key: `a${key}`, text: b.text, streaming: false, ts: ev.ts };
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
      case "git.checkpoint":
        items.push({
          kind: "notice",
          key: `g${ev.seq}`,
          ts: ev.ts,
          text: `Checkpoint ${b.head ?? "ohne Commit"} auf ${b.branch ?? "detached"} · ${b.changedFiles} geänderte Datei(en)`,
          tone: "info",
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
        });
        break;
      case "files.rewound":
        items.push({
          kind: "notice",
          key: `w${ev.seq}`,
          ts: ev.ts,
          text: b.filesChanged.length ? `Dateien zurückgesetzt: ${b.filesChanged.length} Datei(en)` : "Zurückgesetzt, keine Dateien geändert",
          tone: "info",
        });
        break;
      case "turn.result":
        items.push({ kind: "result", key: `r${ev.seq}`, ts: ev.ts, body: b });
        break;
      case "error":
        items.push({ kind: "error", key: `e${ev.seq}`, ts: ev.ts, message: b.message, retryable: b.retryable });
        break;
      case "status":
        if (b.detail && b.detail.startsWith("Achtung")) items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: b.detail, tone: "warning" });
        break;
      case "rate_limit":
        if (b.status !== "allowed") {
          const when = b.resetsAt ? new Date(b.resetsAt * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : null;
          items.push({ kind: "notice", key: `n${ev.seq}`, ts: ev.ts, text: `Nutzungslimit: ${b.status}${when ? `, zurückgesetzt um ${when}` : ""}`, tone: "warning" });
        }
        break;
      default:
        break;
    }
  }

  for (const [key, text] of Object.entries(streaming)) {
    if (textIdx.has(key) || !text) continue;
    items.push({ kind: "assistant", key: `a${key}`, text, streaming: true, ts: null });
  }
  return items;
}

/** The last user prompt, for "retry". */
export function lastUserPrompt(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const b = events[i]!.body;
    if (b.type === "user.message") return b.text;
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
    default:
      return Object.values(input).find((v): v is string => typeof v === "string")?.slice(0, 120) ?? "";
  }
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
};
