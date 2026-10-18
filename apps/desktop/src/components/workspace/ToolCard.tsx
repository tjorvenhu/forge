import type { ReactNode } from "react";
import { Collapse } from "@/components/ui/collapse";
import {
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  FileText,
  FilePen,
  FilePlus,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  MessagesSquare,
  Search,
  ShieldAlert,
  ShieldQuestion,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi, type TaskView } from "@/stores/ui";
import { contextItems } from "@/lib/context-menu";
import { cardKey, useCardState } from "@/stores/card-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TOOL_LABELS, toolDisplayName, toolSummary, type ChatItem, type TodoEntry } from "./chat-items";
import { PlanCard, QuestionCard } from "./InteractiveCards";
import { ForgeToolCard } from "./ForgeToolCard";
import { forgeToolName, forgeToolView, previewShot } from "./forge-tool";
import { PreviewShot } from "./PreviewShot";
import { ChatRow, Dot, Guide } from "./ChatRow";
import { cachedEditDiff, cleanToolOutput, countLines, diffStats, inputJson, splitPreview, type DiffLine } from "./tool-view";
import { FileLink, LinkedText } from "./file-links";
import { taskMenu } from "./WorkingIndicator";
import { t } from "@/i18n";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;
type ToolState = "running" | "ok" | "error" | "blocked" | "waiting" | "denied" | "unknown";

/** Lines of tool output and of a diff shown before "+N Zeilen". */
const OUTPUT_PREVIEW_LINES = 4;
const DIFF_PREVIEW_LINES = 8;

const ICONS: Record<string, ReactNode> = {
  Read: <FileText className="h-3.5 w-3.5" />,
  Write: <FilePlus className="h-3.5 w-3.5" />,
  Edit: <FilePen className="h-3.5 w-3.5" />,
  MultiEdit: <FilePen className="h-3.5 w-3.5" />,
  Bash: <SquareTerminal className="h-3.5 w-3.5" />,
  PowerShell: <SquareTerminal className="h-3.5 w-3.5" />,
  Glob: <Search className="h-3.5 w-3.5" />,
  Grep: <Search className="h-3.5 w-3.5" />,
  WebFetch: <Globe className="h-3.5 w-3.5" />,
  WebSearch: <Globe className="h-3.5 w-3.5" />,
  Task: <Bot className="h-3.5 w-3.5" />,
  Agent: <Bot className="h-3.5 w-3.5" />,
  TodoWrite: <ListChecks className="h-3.5 w-3.5" />,
  AskUserQuestion: <MessageCircleQuestion className="h-3.5 w-3.5" />,
  ExitPlanMode: <ClipboardList className="h-3.5 w-3.5" />,
};

export function toolIcon(name: string) {
  return ICONS[name] ?? <Wrench className="h-3.5 w-3.5" />;
}

const STATE_DOT: Record<ToolState, { className: string; label: string }> = {
  running: { className: "animate-soft-pulse bg-accent", label: t.chat.tool.state.running },
  ok: { className: "bg-success", label: t.chat.tool.state.ok },
  error: { className: "bg-danger", label: t.chat.tool.state.error },
  blocked: { className: "bg-danger", label: t.chat.tool.state.blocked },
  waiting: { className: "animate-soft-pulse bg-warning", label: t.chat.tool.state.waiting },
  denied: { className: "border-[1.5px] border-danger", label: t.chat.tool.state.denied },
  unknown: { className: "border-[1.5px] border-subtle", label: t.chat.tool.state.unknown },
};

function StateDot({ state }: { state: ToolState }) {
  const d = STATE_DOT[state];
  return <Dot className={d.className} label={d.label} />;
}

function toolState(item: ToolItem, sessionLive: boolean): ToolState {
  const { result, approval, blocked } = item;
  if (blocked) return "blocked";
  if (approval && !approval.resolved) return "waiting";
  if (approval?.resolved?.decision === "deny") return "denied";
  if (result) return result.isError ? "error" : "ok";
  return sessionLive ? "running" : "unknown";
}

/** A tool call as one line (status dot, name, argument), with a short preview of its output or change below. */
export function ToolCard({ item, sessionId, sessionLive, projectDir }: { item: ToolItem; sessionId: string; sessionLive: boolean; projectDir: string }) {
  const [open, setOpen] = useCardState(cardKey(sessionId, item.key, "open"), false);
  const [more, setMore] = useCardState(cardKey(sessionId, item.key, "more"), false);
  const { use, result, approval, blocked } = item;
  const state = toolState(item, sessionLive);

  if (item.todos && !item.superseded) return <TodoCard todos={item.todos} />;
  if ((use.name === "AskUserQuestion" || use.name === "ExitPlanMode") && !blocked)
    return (
      // The card header has 8px padding and a border above its first line.
      <ChatRow className="text-body" markerClassName="mt-2.25" marker={<StateDot state={state} />}>
        {use.name === "AskUserQuestion" ? <QuestionCard item={item} sessionId={sessionId} /> : <PlanCard item={item} sessionId={sessionId} />}
      </ChatRow>
    );

  const blockedNote = blocked && (
    <Guide className="mt-1">
      <div className="flex items-start gap-1.5 text-small text-danger">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {t.chat.tool.blockedByPolicy} {blocked.message} <span className="font-mono text-subtle">({blocked.rule})</span>
        </span>
      </div>
    </Guide>
  );
  const approvalNote =
    approval &&
    (approval.resolved ? (
      <Guide className="mt-1">
        <ApprovalBlock req={approval.req} resolved={approval.resolved} sessionId={sessionId} projectDir={projectDir} />
      </Guide>
    ) : (
      <div className="mt-2">
        <ApprovalBlock req={approval.req} resolved={null} sessionId={sessionId} projectDir={projectDir} />
      </div>
    ));
  const details = (
    <>
      <Pre label={t.chat.tool.input} text={inputJson(use.input)} />
      {result && <Pre label={result.isError ? t.chat.task.error : t.chat.task.result} text={result.content.text || t.chat.task.empty} truncated={result.content.truncated} error={result.isError} />}
    </>
  );

  const forgeTool = forgeToolName(use.name);
  if (forgeTool) {
    const view = forgeToolView(forgeTool, use.input, result ? { text: result.content.text, isError: result.isError } : null);
    if (view.hidden && !blocked && !approval) return null;
    const tone = state === "error" || state === "blocked" || state === "denied" ? "danger" : state === "waiting" ? "warning" : view.tone;
    const shot = result && !result.isError ? previewShot(forgeTool, result.content.text) : null;
    const resultSeq = item.seqs?.at(-1);
    return (
      <ForgeToolCard
        sessionId={sessionId}
        itemKey={item.key}
        view={view}
        tone={tone}
        stateLabel={STATE_DOT[state].label}
        pending={state === "running" || state === "waiting"}
        details={details}
        preview={shot && resultSeq !== undefined ? <PreviewShot sessionId={sessionId} seq={resultSeq} size={shot} /> : null}
      >
        {blockedNote}
        {approvalNote}
      </ForgeToolCard>
    );
  }

  const diff = result?.isError ? null : cachedEditDiff(use.name, use.input);
  const stats = diff ? diffStats(diff) : null;
  const summary = toolSummary(use.name, use.input, projectDir);
  const label = TOOL_LABELS[use.name];
  const preview = open ? null : diff?.length ? (
    <DiffPreview lines={diff} expanded={more} onToggle={() => setMore(!more)} truncated={!!use.inputTruncated} />
  ) : result && (result.isError || showsOutput(use.name)) ? (
    <OutputPreview text={cleanToolOutput(result.content.text)} error={result.isError} expanded={more} onToggle={() => setMore(!more)} empty={result.isError ? t.chat.tool.errorWithoutMessage : t.chat.tool.noOutput} />
  ) : null;

  return (
    <ChatRow className="text-body" marker={<StateDot state={state} />}>
      {/* The whole row toggles the details: the button lies under it; file paths in the row sit above it and open the file. */}
      <div className="group/tool relative flex w-full min-w-0 items-baseline gap-2 text-left transition-opacity duration-75 has-[>button:active]:opacity-70">
        <button
          type="button"
          className="absolute inset-0 rounded-sm"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${toolDisplayName(use.name)}${summary ? ` ${summary}` : ""}`}
          title={label ? `${label}: ${open ? t.chat.details.hide : t.chat.details.show}` : open ? t.chat.details.hide : t.chat.details.show}
        />
        <span className="shrink-0 font-semibold text-fg">{toolDisplayName(use.name)}</span>
        {summary && (
          <span className="min-w-0 truncate font-mono text-small text-muted">
            <ToolTarget name={use.name} input={use.input} summary={summary} />
          </span>
        )}
        {use.name === "Read" && result && !result.isError && <span className="shrink-0 text-small text-subtle">({lineCount(countLines(result.content.text))})</span>}
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span className="shrink-0 font-mono text-caption-lg">
            {stats.add > 0 && <span className="text-success">+{stats.add}</span>}
            {stats.add > 0 && stats.del > 0 && " "}
            {stats.del > 0 && <span className="text-danger">-{stats.del}</span>}
          </span>
        )}
        <ChevronRight
          aria-hidden
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 self-center text-subtle transition group-hover/tool:opacity-100 group-has-[>button:focus-visible]/tool:opacity-100",
            open ? "rotate-90 opacity-100" : "opacity-0",
          )}
        />
      </div>
      {blockedNote}
      <Collapse open={open}>
        <Guide className="mt-1.5 space-y-2 pb-1">{details}</Guide>
      </Collapse>
      {preview && <Guide className="mt-1">{preview}</Guide>}
      <TaskLink item={item} sessionId={sessionId} title={summary} />
      {approvalNote}
    </ChatRow>
  );
}

/** Task id in the CLI's answer to a command started in the background ("... with ID: b2kzcbhw6"). */
const BACKGROUND_ID_RE = /in background with ID:\s*([A-Za-z0-9_-]+)/;

/** Opens the own history of a subagent, or the output of a command that runs in the background. */
function TaskLink({ item, sessionId, title }: { item: ToolItem; sessionId: string; title: string }) {
  const openTask = useUi((s) => s.openTask);
  const { use, result } = item;
  if (use.name === "Agent" || use.name === "Task") {
    const task: TaskView = { kind: "agent", sessionId, toolUseId: use.toolUseId, title: title || t.chat.tool.subagent };
    return (
      <Guide className="mt-1">
        <button type="button" className="flex items-center gap-1.5 text-small text-accent hover:underline" onClick={() => openTask(task)} onContextMenu={contextItems(() => taskMenu(task))}>
          <MessagesSquare className="h-3.5 w-3.5" /> {t.chat.task.agentDescription}
        </button>
      </Guide>
    );
  }
  const taskId = use.input.run_in_background === true && result && !result.isError ? BACKGROUND_ID_RE.exec(result.content.text)?.[1] : undefined;
  if (!taskId) return null;
  const task: TaskView = { kind: "shell", sessionId, taskId, toolUseId: use.toolUseId, title: title || t.chat.tool.backgroundCommand };
  return (
    <Guide className="mt-1">
      <button type="button" className="flex items-center gap-1.5 text-small text-accent hover:underline" onClick={() => openTask(task)} onContextMenu={contextItems(() => taskMenu(task))}>
        <SquareTerminal className="h-3.5 w-3.5" /> {t.chat.tool.viewOutput}
      </button>
    </Guide>
  );
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** Above the row's toggle button, so a click opens the file instead of the details. */
const ABOVE_ROW = "relative z-10";

/** The summary of a tool call with its paths as links: the file of Read/Write/Edit (Read at its offset), paths in a command or pattern. */
function ToolTarget({ name, input, summary }: { name: string; input: Record<string, unknown>; summary: string }) {
  const raw = FILE_TOOLS.has(name) ? (typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null) : null;
  if (raw) {
    const line = name === "Read" && typeof input.offset === "number" && input.offset > 0 ? input.offset : null;
    return (
      <FileLink fileRef={{ path: raw.replace(/\\/g, "/"), line, bare: false, isFile: true }} className={ABOVE_ROW}>
        {summary}
      </FileLink>
    );
  }
  return <LinkedText text={summary} linkClassName={ABOVE_ROW} />;
}

/** Tools whose output says something on its own; a Read's file content or a todo confirmation does not. */
function showsOutput(name: string): boolean {
  return name !== "Read" && name !== "TodoWrite" && name !== "Edit" && name !== "MultiEdit" && name !== "Write" && name !== "NotebookEdit";
}

function lineCount(n: number): string {
  return t.chat.tool.lines(n);
}

function MoreToggle({ expanded, hidden, onToggle }: { expanded: boolean; hidden: number; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className="mt-0.5 text-caption-lg text-subtle hover:text-fg">
      {expanded ? t.chat.tool.showLess : hidden > 0 ? `+${t.chat.tool.lines(hidden)}` : t.chat.tool.showAll}
    </button>
  );
}

function OutputPreview({ text, error, expanded, onToggle, empty }: { text: string; error: boolean; expanded: boolean; onToggle: () => void; empty: string }) {
  if (!text) return <div className="text-small italic text-subtle">{empty}</div>;
  const { lines, hidden, cut } = splitPreview(text, expanded ? Infinity : OUTPUT_PREVIEW_LINES);
  return (
    <div>
      <pre className={cn("whitespace-pre-wrap font-mono text-small leading-relaxed wrap-anywhere", error ? "text-danger" : "text-muted", expanded && "max-h-96 overflow-y-auto")}>
        <LinkedText text={lines.join("\n")} />
      </pre>
      {(expanded || hidden > 0 || cut) && <MoreToggle expanded={expanded} hidden={hidden} onToggle={onToggle} />}
    </div>
  );
}

const DIFF_ROW: Record<Exclude<DiffLine["kind"], "gap">, { row: string; sign: string; mark: string }> = {
  add: { row: "bg-diff-add", sign: "+", mark: "text-success" },
  del: { row: "bg-diff-del", sign: "-", mark: "text-danger" },
  ctx: { row: "", sign: "", mark: "" },
};

function DiffPreview({ lines, expanded, onToggle, truncated }: { lines: DiffLine[]; expanded: boolean; onToggle: () => void; truncated: boolean }) {
  const shown = expanded ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  return (
    <div>
      {/* Long lines wrap: a horizontal scrollbar in a chat card hides the end of the line. */}
      <div className={cn("rounded-sm font-mono text-small leading-relaxed", expanded && "max-h-[32rem] overflow-y-auto")}>
        {shown.map((l, i) =>
          l.kind === "gap" ? (
            <div key={i} className="my-1 border-t border-dashed border-border" />
          ) : (
            <div key={i} className={cn("flex", DIFF_ROW[l.kind].row)}>
              <span aria-hidden className={cn("w-5 shrink-0 select-none text-center", DIFF_ROW[l.kind].mark)}>
                {DIFF_ROW[l.kind].sign}
              </span>
              <span className={cn("min-w-0 flex-1 whitespace-pre-wrap pr-4 wrap-anywhere", l.kind === "ctx" ? "text-muted" : "text-fg")}>{l.text || " "}</span>
            </div>
          ),
        )}
      </div>
      {(expanded ? lines.length > DIFF_PREVIEW_LINES : hidden > 0) && <MoreToggle expanded={expanded} hidden={hidden} onToggle={onToggle} />}
      {truncated && (expanded || hidden === 0) && <div className="mt-0.5 text-caption text-subtle">{t.chat.tool.storedTruncated}</div>}
    </div>
  );
}

function Pre({ label, text, truncated, error }: { label: string; text: string; truncated?: boolean; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-caption font-medium uppercase tracking-wide text-subtle">{label}</div>
      <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface p-2 font-mono text-caption-lg", error ? "text-danger" : "text-muted")}>
        <LinkedText text={text} />
      </pre>
      {truncated && <div className="mt-1 text-caption text-subtle">{t.chat.tool.truncatedTo}</div>}
    </div>
  );
}

export function ApprovalBlock({ req, resolved, sessionId, projectDir }: { req: ApprovalItem["req"]; resolved: ApprovalItem["resolved"]; sessionId: string; projectDir?: string }) {
  const [reason, setReason] = useCardState(cardKey(sessionId, req.requestId, "reason"), "");
  // Stays set until approval.resolved arrives, also across remounts, so a second click cannot answer twice.
  const [sent, setSent] = useCardState(cardKey(sessionId, req.requestId, "sent"), false);
  // The choice shows at once; the request card comes back only if the answer could not be sent.
  const [answer, setAnswer] = useCardState<{ decision: "allow" | "deny"; scope: "once" | "session" } | null>(cardKey(sessionId, req.requestId, "answer"), null);
  const respond = useMutation({
    mutationFn: (p: { decision: "allow" | "deny"; scope: "once" | "session" }) =>
      call("sessions.respondApproval", { sessionId, requestId: req.requestId, decision: p.decision, scope: p.scope, message: reason || undefined }),
    onMutate: (p) => setAnswer(p),
    onSuccess: () => setSent(true),
    onError: (e) => {
      setAnswer(null);
      toast.error(t.chat.cards.answerNotSent, errorMessage(e));
    },
  });
  const locked = respond.isPending || sent;

  if (!resolved && answer) {
    return (
      <div className="flex animate-fade-in items-center gap-1.5 text-small text-muted">
        {answer.decision === "allow" ? <Check className="h-3.5 w-3.5 shrink-0 text-success" /> : <X className="h-3.5 w-3.5 shrink-0 text-danger" />}
        <span className="min-w-0 break-words">{answer.decision === "allow" ? (answer.scope === "session" ? t.chat.tool.allowedForSession : t.chat.tool.allowedOnce) : t.chat.tool.denied}</span>
        <span className="animate-soft-pulse text-subtle">…</span>
      </div>
    );
  }

  if (resolved) {
    return (
      <div className="flex items-center gap-1.5 text-small text-muted">
        {resolved.decision === "allow" ? <Check className="h-3.5 w-3.5 shrink-0 text-success" /> : <X className="h-3.5 w-3.5 shrink-0 text-danger" />}
        <span className="min-w-0 break-words">
          {resolved.decision === "allow"
            ? resolved.scope === "session"
              ? t.chat.tool.allowedForSession
              : t.chat.tool.allowedOnce
            : resolved.source === "abort"
              ? t.chat.cards.aborted
              : t.chat.tool.deniedWith(resolved.message)}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-l-2 border-warning/40 border-l-warning bg-warning-soft px-3 py-2.5" role="group" aria-label={t.chat.tool.approvalRequest}>
      <div className="flex items-start gap-2 text-body">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{req.title ?? approvalTitle(req.toolName)}</div>
          {req.description && <div className="text-xs text-muted">{req.description}</div>}
          {req.outsideProject && <div className="mt-1 text-xs font-medium text-danger">{t.chat.tool.outsideProject}</div>}
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg/60 p-2 font-mono text-caption-lg text-fg/90">
            <LinkedText text={toolSummary(req.toolName, req.input, projectDir) || JSON.stringify(req.input, null, 2)} />
          </pre>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t.chat.tool.reasonPlaceholder} className="h-7 max-w-64 text-xs" disabled={locked} />
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => respond.mutate({ decision: "deny", scope: "once" })} disabled={locked}>
          {t.chat.tool.deny}
        </Button>
        {req.allowSessionScope && (
          <Button size="sm" variant="secondary" onClick={() => respond.mutate({ decision: "allow", scope: "session" })} disabled={locked}>
            {t.chat.tool.allowSession}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => respond.mutate({ decision: "allow", scope: "once" })} loading={respond.isPending} disabled={sent}>
          {t.chat.tool.allow}
        </Button>
      </div>
    </div>
  );
}

const APPROVAL_TITLES: Record<string, string> = t.chat.tool.approvalTitles;

function approvalTitle(toolName: string) {
  return APPROVAL_TITLES[toolName] ?? t.chat.tool.approvalTitle(toolName);
}

function TodoBox({ status }: { status: TodoEntry["status"] }) {
  if (status === "completed")
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-success" role="img" aria-label={t.chat.tool.todo.completed}>
        <Check className="h-2.5 w-2.5 text-bg" strokeWidth={3.5} />
      </span>
    );
  if (status === "in_progress")
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border-[1.5px] border-accent" role="img" aria-label={t.chat.tool.todo.inProgress}>
        <span className="animate-soft-pulse h-1.5 w-1.5 rounded-[1px] bg-accent" />
      </span>
    );
  return <span className="block h-3.5 w-3.5 rounded-sm border-[1.5px] border-border-strong" role="img" aria-label={t.chat.tool.todo.pending} />;
}

function TodoCard({ todos }: { todos: TodoEntry[] }) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <ChatRow className="text-body" marker={<Dot className={done === todos.length ? "bg-success" : "bg-accent"} />}>
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-fg">{t.chat.tool.todo.title}</span>
        <span className="text-small tabular-nums text-subtle">
          {t.chat.tool.todo.done(done, todos.length)}
        </span>
      </div>
      <Guide className="mt-1">
        <ul className="space-y-0.5">
          {todos.map((todo, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="flex h-[1lh] shrink-0 items-center">
                <TodoBox status={todo.status} />
              </span>
              <span className={cn("min-w-0 break-words", todo.status === "completed" && "text-subtle line-through decoration-subtle/60", todo.status === "in_progress" && "font-medium text-fg")}>
                {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
              </span>
            </li>
          ))}
        </ul>
      </Guide>
    </ChatRow>
  );
}
