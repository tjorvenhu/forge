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
import { useUi } from "@/stores/ui";
import { cardKey, useCardState } from "@/stores/card-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TOOL_LABELS, toolDisplayName, toolSummary, type ChatItem, type TodoEntry } from "./chat-items";
import { PlanCard, QuestionCard } from "./InteractiveCards";
import { ChatRow, Dot, Guide } from "./ChatRow";
import { cachedEditDiff, cleanToolOutput, countLines, diffStats, inputJson, splitPreview, type DiffLine } from "./tool-view";

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
  running: { className: "animate-soft-pulse bg-accent", label: "läuft" },
  ok: { className: "bg-success", label: "erfolgreich" },
  error: { className: "bg-danger", label: "Fehler" },
  blocked: { className: "bg-danger", label: "blockiert" },
  waiting: { className: "animate-soft-pulse bg-warning", label: "wartet auf Freigabe" },
  denied: { className: "border-[1.5px] border-danger", label: "abgelehnt" },
  unknown: { className: "border-[1.5px] border-subtle", label: "ohne Ergebnis" },
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

  const diff = result?.isError ? null : cachedEditDiff(use.name, use.input);
  const stats = diff ? diffStats(diff) : null;
  const summary = toolSummary(use.name, use.input, projectDir);
  const label = TOOL_LABELS[use.name];
  const preview = open ? null : diff?.length ? (
    <DiffPreview lines={diff} expanded={more} onToggle={() => setMore(!more)} truncated={!!use.inputTruncated} />
  ) : result && (result.isError || showsOutput(use.name)) ? (
    <OutputPreview text={cleanToolOutput(result.content.text)} error={result.isError} expanded={more} onToggle={() => setMore(!more)} empty={result.isError ? "Fehler ohne Meldung" : "(keine Ausgabe)"} />
  ) : null;

  return (
    <ChatRow className="text-body" marker={<StateDot state={state} />}>
      <button
        type="button"
        className="group/tool flex w-full min-w-0 items-baseline gap-2 text-left transition-opacity duration-75 active:opacity-70"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={label ? `${label}: Details ${open ? "ausblenden" : "anzeigen"}` : `Details ${open ? "ausblenden" : "anzeigen"}`}
      >
        <span className="shrink-0 font-semibold text-fg">{toolDisplayName(use.name)}</span>
        {summary && <span className="min-w-0 truncate font-mono text-small text-muted">{summary}</span>}
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
            "ml-auto h-3.5 w-3.5 shrink-0 self-center text-subtle transition group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100",
            open ? "rotate-90 opacity-100" : "opacity-0",
          )}
        />
      </button>
      {blocked && (
        <Guide className="mt-1">
          <div className="flex items-start gap-1.5 text-small text-danger">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              Von der FORGE-Policy blockiert: {blocked.message} <span className="font-mono text-subtle">({blocked.rule})</span>
            </span>
          </div>
        </Guide>
      )}
      <Collapse open={open}>
        <Guide className="mt-1.5 space-y-2 pb-1">
          <Pre label="Eingabe" text={inputJson(use.input)} />
          {result && <Pre label={result.isError ? "Fehler" : "Ergebnis"} text={result.content.text || "(leer)"} truncated={result.content.truncated} error={result.isError} />}
        </Guide>
      </Collapse>
      {preview && <Guide className="mt-1">{preview}</Guide>}
      <TaskLink item={item} sessionId={sessionId} title={summary} />
      {approval &&
        (approval.resolved ? (
          <Guide className="mt-1">
            <ApprovalBlock req={approval.req} resolved={approval.resolved} sessionId={sessionId} projectDir={projectDir} />
          </Guide>
        ) : (
          <div className="mt-2">
            <ApprovalBlock req={approval.req} resolved={null} sessionId={sessionId} projectDir={projectDir} />
          </div>
        ))}
    </ChatRow>
  );
}

/** Task id in the CLI's answer to a command started in the background ("... with ID: b2kzcbhw6"). */
const BACKGROUND_ID_RE = /in background with ID:\s*([A-Za-z0-9_-]+)/;

/** Opens the own history of a subagent, or the output of a command that runs in the background. */
function TaskLink({ item, sessionId, title }: { item: ToolItem; sessionId: string; title: string }) {
  const openTask = useUi((s) => s.openTask);
  const { use, result } = item;
  if (use.name === "Agent" || use.name === "Task")
    return (
      <Guide className="mt-1">
        <button type="button" className="flex items-center gap-1.5 text-small text-accent hover:underline" onClick={() => openTask({ kind: "agent", sessionId, toolUseId: use.toolUseId, title: title || "Subagent" })}>
          <MessagesSquare className="h-3.5 w-3.5" /> Verlauf des Subagenten
        </button>
      </Guide>
    );
  const taskId = use.input.run_in_background === true && result && !result.isError ? BACKGROUND_ID_RE.exec(result.content.text)?.[1] : undefined;
  if (!taskId) return null;
  return (
    <Guide className="mt-1">
      <button
        type="button"
        className="flex items-center gap-1.5 text-small text-accent hover:underline"
        onClick={() => openTask({ kind: "shell", sessionId, taskId, toolUseId: use.toolUseId, title: title || "Befehl im Hintergrund" })}
      >
        <SquareTerminal className="h-3.5 w-3.5" /> Ausgabe ansehen
      </button>
    </Guide>
  );
}

/** Tools whose output says something on its own; a Read's file content or a todo confirmation does not. */
function showsOutput(name: string): boolean {
  return name !== "Read" && name !== "TodoWrite" && name !== "Edit" && name !== "MultiEdit" && name !== "Write" && name !== "NotebookEdit";
}

function lineCount(n: number): string {
  return n === 1 ? "1 Zeile" : `${n} Zeilen`;
}

function MoreToggle({ expanded, hidden, onToggle }: { expanded: boolean; hidden: number; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className="mt-0.5 text-caption-lg text-subtle hover:text-fg">
      {expanded ? "Weniger anzeigen" : hidden > 0 ? `+${hidden} ${hidden === 1 ? "Zeile" : "Zeilen"}` : "Ganz anzeigen"}
    </button>
  );
}

function OutputPreview({ text, error, expanded, onToggle, empty }: { text: string; error: boolean; expanded: boolean; onToggle: () => void; empty: string }) {
  if (!text) return <div className="text-small italic text-subtle">{empty}</div>;
  const { lines, hidden, cut } = splitPreview(text, expanded ? Infinity : OUTPUT_PREVIEW_LINES);
  return (
    <div>
      <pre className={cn("whitespace-pre-wrap font-mono text-small leading-relaxed wrap-anywhere", error ? "text-danger" : "text-muted", expanded && "max-h-96 overflow-y-auto")}>{lines.join("\n")}</pre>
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
      {truncated && (expanded || hidden === 0) && <div className="mt-0.5 text-caption text-subtle">Inhalt gekürzt gespeichert.</div>}
    </div>
  );
}

function Pre({ label, text, truncated, error }: { label: string; text: string; truncated?: boolean; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-caption font-medium uppercase tracking-wide text-subtle">{label}</div>
      <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface p-2 font-mono text-caption-lg", error ? "text-danger" : "text-muted")}>{text}</pre>
      {truncated && <div className="mt-1 text-caption text-subtle">Gekürzt auf 20.000 Zeichen.</div>}
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
      toast.error("Antwort nicht übermittelt", errorMessage(e));
    },
  });
  const locked = respond.isPending || sent;

  if (!resolved && answer) {
    return (
      <div className="flex animate-fade-in items-center gap-1.5 text-small text-muted">
        {answer.decision === "allow" ? <Check className="h-3.5 w-3.5 shrink-0 text-success" /> : <X className="h-3.5 w-3.5 shrink-0 text-danger" />}
        <span className="min-w-0 break-words">{answer.decision === "allow" ? (answer.scope === "session" ? "Für diese Session erlaubt" : "Einmal erlaubt") : "Abgelehnt"}</span>
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
              ? "Für diese Session erlaubt"
              : "Einmal erlaubt"
            : resolved.source === "abort"
              ? "Abgebrochen"
              : `Abgelehnt${resolved.message ? `: ${resolved.message}` : ""}`}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-l-2 border-warning/40 border-l-warning bg-warning-soft px-3 py-2.5" role="group" aria-label="Freigabeanfrage">
      <div className="flex items-start gap-2 text-body">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{req.title ?? approvalTitle(req.toolName)}</div>
          {req.description && <div className="text-xs text-muted">{req.description}</div>}
          {req.outsideProject && <div className="mt-1 text-xs font-medium text-danger">Achtung: Schreibzugriff außerhalb des Projektordners.</div>}
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg/60 p-2 font-mono text-caption-lg text-fg/90">
            {toolSummary(req.toolName, req.input, projectDir) || JSON.stringify(req.input, null, 2)}
          </pre>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Begründung bei Ablehnung (optional)" className="h-7 max-w-64 text-xs" disabled={locked} />
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => respond.mutate({ decision: "deny", scope: "once" })} disabled={locked}>
          Ablehnen
        </Button>
        {req.allowSessionScope && (
          <Button size="sm" variant="secondary" onClick={() => respond.mutate({ decision: "allow", scope: "session" })} disabled={locked}>
            Für Session erlauben
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => respond.mutate({ decision: "allow", scope: "once" })} loading={respond.isPending} disabled={sent}>
          Erlauben
        </Button>
      </div>
    </div>
  );
}

const APPROVAL_TITLES: Record<string, string> = {
  Write: "Claude möchte eine Datei anlegen",
  Edit: "Claude möchte eine Datei bearbeiten",
  MultiEdit: "Claude möchte eine Datei bearbeiten",
  NotebookEdit: "Claude möchte ein Notebook bearbeiten",
  Bash: "Claude möchte einen Befehl ausführen",
  PowerShell: "Claude möchte einen PowerShell-Befehl ausführen",
  WebFetch: "Claude möchte eine Webseite abrufen",
  WebSearch: "Claude möchte im Web suchen",
};

function approvalTitle(toolName: string) {
  return APPROVAL_TITLES[toolName] ?? `Claude möchte das Tool ${toolName} verwenden`;
}

function TodoBox({ status }: { status: TodoEntry["status"] }) {
  if (status === "completed")
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-success" role="img" aria-label="erledigt">
        <Check className="h-2.5 w-2.5 text-bg" strokeWidth={3.5} />
      </span>
    );
  if (status === "in_progress")
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border-[1.5px] border-accent" role="img" aria-label="in Arbeit">
        <span className="animate-soft-pulse h-1.5 w-1.5 rounded-[1px] bg-accent" />
      </span>
    );
  return <span className="block h-3.5 w-3.5 rounded-sm border-[1.5px] border-border-strong" role="img" aria-label="offen" />;
}

function TodoCard({ todos }: { todos: TodoEntry[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <ChatRow className="text-body" marker={<Dot className={done === todos.length ? "bg-success" : "bg-accent"} />}>
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-fg">Aufgaben</span>
        <span className="text-small tabular-nums text-subtle">
          {done}/{todos.length} erledigt
        </span>
      </div>
      <Guide className="mt-1">
        <ul className="space-y-0.5">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="flex h-[1lh] shrink-0 items-center">
                <TodoBox status={t.status} />
              </span>
              <span className={cn("min-w-0 break-words", t.status === "completed" && "text-subtle line-through decoration-subtle/60", t.status === "in_progress" && "font-medium text-fg")}>
                {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ul>
      </Guide>
    </ChatRow>
  );
}
