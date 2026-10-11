import type { SessionEvent, SessionEventBody } from "@forge/protocol";

type Body<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>;

export type NoticeIcon = "checkpoint" | "commit" | "push" | "skip" | "rewind" | "compact" | "background" | "limit";

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type ChatItem =
  | { kind: "user"; key: string; seq: number; text: string; ts: string; uuid: string | null; attachments: Array<{ name: string; mediaType: string; size: number }>; remote: boolean }
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

/** Chat items of the persisted events only, without live deltas. */
export function buildEventItems(events: SessionEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolIdx = new Map<string, number>();
  const approvalIdx = new Map<string, { item: number; inTool: boolean }>();  const textIdx = new Map<string, number>();
  let lastTodo: number | null = null;

  for (const ev of events) {
    const b = ev.body;
    switch (b.type) {
      case "user.message":
        items.push({ kind: "user", key: `u${ev.seq}`, seq: ev.seq, text: b.text, ts: ev.ts, uuid: b.uuid ?? null, attachments: b.attachments ?? [], remote: b.source === "remote" });
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
      case "git.checkpoint":
        items.push({
          kind: "notice",
          key: `g${ev.seq}`,
          ts: ev.ts,
          text: `Checkpoint ${b.head ?? "ohne Commit"} ${b.branch ? `auf ${b.branch}` : "ohne Branch"} ·${b.changedFiles} geänderte Datei(en)`,
          tone: "info",
          card: {
            title: "Checkpoint erstellt",
            ref: b.branch ?? "ohne Branch",
            detail: `${b.head ? `${b.head} · ` : ""}${b.changedFiles} geänderte Datei(en)`,
            icon: "checkpoint",
          },
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
      case "rate_limit":
        if (b.status !== "allowed") {
          const when = b.resetsAt ? new Date(b.resetsAt * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : null;
          items.push({
            kind: "notice",
            key: `n${ev.seq}`,
            ts: ev.ts,
            text: `Nutzungslimit: ${b.status}${when ? `, zurückgesetzt um ${when}` : ""}`,
            tone: "warning",
            card: { title: "Nutzungslimit", ref: null, detail: `${b.status}${when ? ` · zurückgesetzt um ${when}` : ""}`, icon: "limit" },
          });
        }
        break;
      default:
        break;
    }
  }

  return items;
}

function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
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
