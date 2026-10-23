"use client";

import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  ArrowUpCircle,
  BellRing,
  Check,
  ChevronRight,
  Copy,
  FileText,
  GitCommitHorizontal,
  GitMerge,
  Gauge,
  Hourglass,
  ShieldAlert,
  ShieldQuestion,
  Shrink,
  SkipForward,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { buildChatItems, relativeTo, rowSpacing, startsAnswer, toolDisplayName, toolSummary, type Approval, type ChatItem, type NoticeKind, type TodoEntry } from "@/lib/crew-web/chat-items";
import type { CrewMessages } from "@/lib/crew-web/messages";
import { cachedEditDiff, cleanToolOutput, countLines, diffStats, inputJson, splitPreview, type DiffLine } from "@/lib/crew-web/tool-view";
import { ClaudeMark, MemberAvatar } from "./avatar";

/**
 * A member's session as FORGE's chat shows it (apps/desktop/src/components/workspace: ChatPanel,
 * ChatItemView, ToolCard, ChatRow): a narrow gutter with avatar, Claude's mark or a status dot, the
 * content beside it. Read-only: approvals are given in FORGE.
 */

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type ToolState = "running" | "ok" | "error" | "blocked" | "waiting" | "denied" | "unknown";

const OUTPUT_PREVIEW_LINES = 4;
const DIFF_PREVIEW_LINES = 8;

interface ChatCtx {
  m: CrewMessages["chat"];
  live: boolean;
  cwd: string | null;
  user: ReactNode;
}

const Ctx = createContext<ChatCtx | null>(null);
const useChat = () => useContext(Ctx)!;

/** Claude's mark replaces the marker of the first row of an answer (not of rows nested in it). */
const LeadMarker = createContext<ReactNode>(null);

export function SessionChat({
  events,
  m,
  live,
  working,
  cwd,
  member,
}: {
  events: readonly unknown[];
  m: CrewMessages["chat"];
  live: boolean;
  /** the member's presence says the session works right now */
  working: "working" | "waiting" | null;
  cwd: string | null;
  member: { name: string; color: string; avatar: string | null };
}) {
  const items = useMemo(() => buildChatItems(events), [events]);
  const ctx = useMemo<ChatCtx>(
    () => ({ m, live, cwd, user: <MemberAvatar name={member.name} color={member.color} avatar={member.avatar} size={22} label={member.name} /> }),
    [m, live, cwd, member.name, member.color, member.avatar],
  );
  const last = items.at(-1);
  return (
    <Ctx.Provider value={ctx}>
      <div className="fc-thread">
        {items.map((item, i) => (
          <div key={item.key} className={`fc-row fc-gap-${rowSpacing(items[i - 1], item)}`}>
            <LeadMarker.Provider value={startsAnswer(items[i - 1], item) ? <ClaudeMark size={20} /> : null}>
              <ItemView item={item} />
            </LeadMarker.Provider>
          </div>
        ))}
        {working && last?.kind !== "result" && (
          <div className={`fc-row fc-gap-${last ? "block" : "first"}`}>
            <ChatRow marker={<ClaudeMark size={18} className="fc-spin" />}>
              <span className="fc-working">
                {working === "waiting" ? m.waiting : m.working}
                <span className="fc-dots" aria-hidden>
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </span>
            </ChatRow>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

// ---------- layout primitives (ChatRow.tsx)

function ChatRow({ marker, children, className, markerClassName }: { marker?: ReactNode; children: ReactNode; className?: string; markerClassName?: string }) {
  const lead = useContext(LeadMarker);
  return (
    <div className={`fc-chatrow ${className ?? ""}`}>
      <span className={`fc-gutter ${markerClassName ?? ""}`}>{lead ?? marker}</span>
      <div className="fc-content">
        <LeadMarker.Provider value={null}>{children}</LeadMarker.Provider>
      </div>
    </div>
  );
}

function Dot({ className, label }: { className: string; label?: string }) {
  return <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={`fc-dot ${className}`} />;
}

function Guide({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`fc-guide ${className ?? ""}`}>{children}</div>;
}

// ---------- rows (ChatItemView.tsx)

const ItemView = memo(function ItemView({ item }: { item: ChatItem }) {
  const { m, user } = useChat();
  switch (item.kind) {
    case "user":
      return (
        <ChatRow className="fc-text-ui" marker={user}>
          <div className="fc-pre">{item.text}</div>
          {(item.attachments.length > 0 || item.auto || item.remote) && (
            <div className="fc-meta">
              {item.attachments.map((a, i) => (
                <span key={i} className="fc-chip">
                  <FileText aria-hidden /> {a}
                </span>
              ))}
              {item.auto && <span>{m.auto}</span>}
              {item.remote && <span>{m.fromPhone}</span>}
            </div>
          )}
        </ChatRow>
      );
    case "assistant":
      if (!item.text.trim()) return null;
      return (
        <ChatRow className="fc-text-ui" marker={<Dot className="fc-dot-fg" />}>
          <Markdown text={item.text} />
        </ChatRow>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return (
        <ChatRow
          className="fc-text-body"
          markerClassName={item.approval.resolved ? undefined : "fc-marker-box"}
          marker={<Dot className={item.approval.resolved ? (item.approval.resolved.decision === "allow" ? "fc-dot-ok" : "fc-dot-denied") : "fc-dot-waiting"} />}
        >
          <ApprovalBlock approval={item.approval} />
        </ChatRow>
      );
    case "result":
      return <ResultLine item={item} />;
    case "error":
      return (
        <ChatRow className="fc-text-body" marker={<AlertTriangle className="fc-icon fc-danger" />}>
          <div className="fc-danger fc-break">{item.message}</div>
        </ChatRow>
      );
    case "notice":
      return <NoticeRow item={item} />;
  }
});

const NOTICE_ICON: Record<NoticeKind, ReactNode> = {
  compact: <Shrink className="fc-icon" />,
  compactAuto: <Shrink className="fc-icon" />,
  background: <Hourglass className="fc-icon" />,
  notify: <BellRing className="fc-icon" />,
  notifyUrgent: <BellRing className="fc-icon" />,
  commit: <GitCommitHorizontal className="fc-icon" />,
  push: <Upload className="fc-icon" />,
  merge: <GitMerge className="fc-icon" />,
  skip: <SkipForward className="fc-icon" />,
  rewind: <Undo2 className="fc-icon" />,
  limit: <Gauge className="fc-icon" />,
  update: <ArrowUpCircle className="fc-icon" />,
  info: <ShieldAlert className="fc-icon" />,
};

/** What FORGE did itself gets the highlighted box, as in FORGE (EventCard with highlight). */
const FORGE_NOTICES = new Set<NoticeKind>(["commit", "push", "merge", "skip", "notify", "notifyUrgent", "update"]);

function NoticeRow({ item }: { item: Extract<ChatItem, { kind: "notice" }> }) {
  const { m } = useChat();
  const n = m.notice;
  const failed = item.title === "failed";
  const title: string =
    item.notice === "background"
      ? (n.background[item.title ?? ""] ?? n.background.started!)
      : item.notice === "commit"
        ? failed ? n.commitFailed : n.commit
        : item.notice === "push"
          ? failed ? n.pushFailed : n.push
          : item.notice === "merge"
            ? item.tone === "success" ? n.merge : n.mergeConflicts
            : item.notice === "rewind"
              ? n.rewind(item.detail)
              : item.notice === "info"
                ? n.blocked
                : n[item.notice];
  const detail = item.notice === "rewind" ? "" : item.detail;
  const highlight = FORGE_NOTICES.has(item.notice);
  const tone = highlight ? (item.tone === "danger" ? "danger" : item.tone === "warning" ? "warning" : "accent") : item.tone;
  const content = (
    <div className="fc-event">
      <span className="fc-event-title">{title}</span>
      {item.ref && <span className="fc-event-ref">{item.ref}</span>}
      {detail && <span className="fc-muted">{detail}</span>}
      {highlight && <span className="fc-forge-label">FORGE</span>}
    </div>
  );
  return (
    <ChatRow className="fc-text-body" markerClassName={highlight ? "fc-marker-box" : undefined} marker={<span className={`fc-tone-${tone}`}>{NOTICE_ICON[item.notice]}</span>}>
      {highlight ? <div className={`fc-forge fc-forge-${tone}`}>{content}</div> : content}
    </ChatRow>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function formatTokens(n: number | null): string {
  if (n === null) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function ResultLine({ item }: { item: Extract<ChatItem, { kind: "result" }> }) {
  const { m } = useChat();
  return (
    <ChatRow className="fc-text-caption-lg">
      <div className="fc-result">
        {item.isError ? item.interrupted ? <span className="fc-warning">{m.stopped}</span> : <span className="fc-danger">{m.failed(item.text ?? item.subtype)}</span> : <span className="fc-success">{m.done}</span>}
        {item.durationMs !== null && <Part>{formatDuration(item.durationMs)}</Part>}
        {!!item.numTurns && <Part>{m.steps(item.numTurns)}</Part>}
        {(!!item.inputTokens || !!item.outputTokens) && <Part>{m.tokens(formatTokens(item.inputTokens), formatTokens(item.outputTokens))}</Part>}
      </div>
    </ChatRow>
  );
}

function Part({ children }: { children: ReactNode }) {
  return (
    <span className="fc-part">
      <span aria-hidden className="fc-part-dot" />
      {children}
    </span>
  );
}

// ---------- tool calls (ToolCard.tsx)

const STATE_DOT: Record<ToolState, string> = {
  running: "fc-dot-running",
  ok: "fc-dot-ok",
  error: "fc-dot-error",
  blocked: "fc-dot-error",
  waiting: "fc-dot-waiting",
  denied: "fc-dot-denied",
  unknown: "fc-dot-unknown",
};

function toolState(item: ToolItem, live: boolean): ToolState {
  if (item.blocked) return "blocked";
  if (item.approval && !item.approval.resolved) return "waiting";
  if (item.approval?.resolved?.decision === "deny") return "denied";
  if (item.result) return item.result.isError ? "error" : "ok";
  return live ? "running" : "unknown";
}

/** Tools whose output says something on its own; a Read's file content or a todo confirmation does not. */
const showsOutput = (name: string) => !["Read", "TodoWrite", "Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name);

function ToolCard({ item }: { item: ToolItem }) {
  const { m, live, cwd } = useChat();
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const { use, result, approval, blocked } = item;
  const state = toolState(item, live);
  if (item.todos && !item.superseded) return <TodoCard todos={item.todos} />;

  const diff = result?.isError ? null : cachedEditDiff(use.name, use.input);
  const stats = diff ? diffStats(diff) : null;
  const raw = toolSummary(use.name, use.input);
  const summary = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"].includes(use.name) ? relativeTo(raw, cwd) : raw;
  const preview = open ? null : diff?.length ? (
    <DiffPreview lines={diff} expanded={more} onToggle={() => setMore(!more)} truncated={use.inputTruncated} />
  ) : result && (result.isError || showsOutput(use.name)) ? (
    <OutputPreview text={cleanToolOutput(result.text)} error={result.isError} expanded={more} onToggle={() => setMore(!more)} empty={result.isError ? m.errorWithoutMessage : m.noOutput} />
  ) : null;

  return (
    <ChatRow className="fc-text-body" marker={<Dot className={STATE_DOT[state]} label={m.state[state]} />}>
      <button type="button" className="fc-tool" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? m.hideDetails : m.showDetails}>
        <span className="fc-tool-name">{toolDisplayName(use.name)}</span>
        {summary && <span className="fc-tool-summary">{summary}</span>}
        {use.name === "Read" && result && !result.isError && <span className="fc-subtle fc-text-small">({m.lines(countLines(result.text))})</span>}
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span className="fc-stats">
            {stats.add > 0 && <span className="fc-success">+{stats.add}</span>}
            {stats.add > 0 && stats.del > 0 && " "}
            {stats.del > 0 && <span className="fc-danger">-{stats.del}</span>}
          </span>
        )}
        <ChevronRight aria-hidden className={open ? "fc-chevron fc-chevron-open" : "fc-chevron"} />
      </button>
      {blocked && (
        <Guide className="fc-mt-1">
          <div className="fc-blocked">
            <ShieldAlert aria-hidden /> {m.blockedByPolicy} {blocked}
          </div>
        </Guide>
      )}
      {open && (
        <Guide className="fc-mt-15 fc-details">
          <Pre label={m.input} text={inputJson(use.input)} />
          {result && <Pre label={result.isError ? m.error : m.result} text={result.text || m.empty} truncated={result.truncated} error={result.isError} />}
        </Guide>
      )}
      {preview && <Guide className="fc-mt-1">{preview}</Guide>}
      {approval && (approval.resolved ? <Guide className="fc-mt-1"><ApprovalBlock approval={approval} /></Guide> : <div className="fc-mt-2"><ApprovalBlock approval={approval} /></div>)}
    </ChatRow>
  );
}

function MoreToggle({ expanded, hidden, onToggle }: { expanded: boolean; hidden: number; onToggle: () => void }) {
  const { m } = useChat();
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className="fc-more">
      {expanded ? m.showLess : hidden > 0 ? `+${m.lines(hidden)}` : m.showAll}
    </button>
  );
}

function OutputPreview({ text, error, expanded, onToggle, empty }: { text: string; error: boolean; expanded: boolean; onToggle: () => void; empty: string }) {
  if (!text) return <div className="fc-empty-output">{empty}</div>;
  const { lines, hidden, cut } = splitPreview(text, expanded ? Infinity : OUTPUT_PREVIEW_LINES);
  return (
    <div>
      <pre className={`fc-output ${error ? "fc-danger" : ""} ${expanded ? "fc-output-open" : ""}`}>{lines.join("\n")}</pre>
      {(expanded || hidden > 0 || cut) && <MoreToggle expanded={expanded} hidden={hidden} onToggle={onToggle} />}
    </div>
  );
}

function DiffPreview({ lines, expanded, onToggle, truncated }: { lines: DiffLine[]; expanded: boolean; onToggle: () => void; truncated: boolean }) {
  const { m } = useChat();
  const shown = expanded ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  return (
    <div>
      <div className={`fc-diff ${expanded ? "fc-diff-open" : ""}`}>
        {shown.map((l, i) =>
          l.kind === "gap" ? (
            <div key={i} className="fc-diff-gap" />
          ) : (
            <div key={i} className={`fc-diff-line fc-diff-${l.kind}`}>
              <span aria-hidden className="fc-diff-sign">
                {l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}
              </span>
              <span className="fc-diff-text">{l.text || " "}</span>
            </div>
          ),
        )}
      </div>
      {(expanded ? lines.length > DIFF_PREVIEW_LINES : hidden > 0) && <MoreToggle expanded={expanded} hidden={hidden} onToggle={onToggle} />}
      {truncated && (expanded || hidden === 0) && <div className="fc-caption fc-subtle">{m.storedTruncated}</div>}
    </div>
  );
}

function Pre({ label, text, truncated, error }: { label: string; text: string; truncated?: boolean; error?: boolean }) {
  const { m } = useChat();
  return (
    <div>
      <div className="fc-pre-label">{label}</div>
      <pre className={`fc-pre-box ${error ? "fc-danger" : ""}`}>{text}</pre>
      {truncated && <div className="fc-caption fc-subtle">{m.truncated}</div>}
    </div>
  );
}

function ApprovalBlock({ approval }: { approval: Approval }) {
  const { m, cwd } = useChat();
  const r = approval.resolved;
  if (r) {
    return (
      <div className="fc-approved">
        {r.decision === "allow" ? <Check className="fc-success" aria-hidden /> : <X className="fc-danger" aria-hidden />}
        <span className="fc-break">{r.decision === "allow" ? (r.scope === "session" ? m.allowedForSession : m.allowedOnce) : r.source === "abort" ? m.aborted : m.deniedWith(r.message)}</span>
      </div>
    );
  }
  const summary = toolSummary(approval.toolName, approval.input);
  return (
    <div className="fc-approval" role="group">
      <ShieldQuestion className="fc-warning" aria-hidden />
      <div className="fc-content">
        <div className="fc-strong">{approval.title ?? m.approvalTitle(approval.toolName)}</div>
        <pre className="fc-approval-input">{relativeTo(summary, cwd) || JSON.stringify(approval.input, null, 2)}</pre>
        <div className="fc-caption fc-muted">{m.approvalWaiting}</div>
      </div>
    </div>
  );
}

function TodoBox({ status }: { status: TodoEntry["status"] }) {
  if (status === "completed")
    return (
      <span className="fc-todo fc-todo-done">
        <Check strokeWidth={3.5} />
      </span>
    );
  if (status === "in_progress")
    return (
      <span className="fc-todo fc-todo-doing">
        <span />
      </span>
    );
  return <span className="fc-todo" />;
}

function TodoCard({ todos }: { todos: TodoEntry[] }) {
  const { m } = useChat();
  const done = todos.filter((x) => x.status === "completed").length;
  return (
    <ChatRow className="fc-text-body" marker={<Dot className={done === todos.length ? "fc-dot-ok" : "fc-dot-accent"} />}>
      <div className="fc-todo-head">
        <span className="fc-tool-name">{m.todoTitle}</span>
        <span className="fc-subtle fc-text-small">{m.todoDone(done, todos.length)}</span>
      </div>
      <Guide className="fc-mt-1">
        <ul className="fc-todos">
          {todos.map((x, i) => (
            <li key={i} className={`fc-todo-item fc-todo-${x.status}`}>
              <span className="fc-todo-box">
                <TodoBox status={x.status} />
              </span>
              <span>{x.status === "in_progress" && x.activeForm ? x.activeForm : x.content}</span>
            </li>
          ))}
        </ul>
      </Guide>
    </ChatRow>
  );
}

// ---------- markdown (Markdown.tsx)

const PLUGINS = [remarkGfm];

function CodeBlock({ children }: { children?: ReactNode }) {
  const { m } = useChat();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <div className="code-block">
      <pre ref={ref}>{children}</pre>
      <button
        type="button"
        className="fc-copy"
        aria-label={copied ? m.codeCopied : m.copyCode}
        title={m.copyCode}
        onClick={() => void navigator.clipboard?.writeText(ref.current?.textContent ?? "").then(() => setCopied(true), () => {})}
      >
        {copied ? <Check className="fc-success" /> : <Copy />}
      </button>
    </div>
  );
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  // Only web links lead somewhere; paths on the member's computer stay text.
  return href && /^https?:\/\//i.test(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ) : (
    <span className="fc-link-text">{children}</span>
  );
}

const COMPONENTS = { a: Link, pre: CodeBlock };

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown fc-break">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
