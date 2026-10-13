import { useState, type ReactNode } from "react";
import { Collapse } from "@/components/ui/collapse";
import {
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  Copy,
  ExternalLink,
  FileText,
  FilePen,
  FilePlus,
  Globe,
  ListChecks,
  MessageCircleQuestion,
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
import { cn, formatDuration } from "@/lib/utils";
import { isChatWindow } from "@/lib/chat-windows";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { cardKey, useCardState } from "@/stores/card-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeToProject, TOOL_LABELS, toolDisplayName, toolSummary, type ChatItem, type TodoEntry } from "./chat-items";
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

type CardTone = "edit" | "command" | "read" | "agent" | "plain";

const TONE_ICON: Record<CardTone, string> = {
  edit: "bg-success-soft text-success",
  command: "bg-accent text-accent-fg",
  read: "bg-success-soft text-success",
  agent: "bg-claude-soft text-claude",
  plain: "bg-surface-3 text-muted",
};

function cardTone(name: string): CardTone {
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") return "edit";
  if (name === "Bash" || name === "PowerShell") return "command";
  if (name === "Read") return "read";
  if (name === "Task" || name === "Agent") return "agent";
  return "plain";
}

/** Card title in plain words: what happened, or what is happening while the tool runs. */
export function toolCardTitle(name: string, state: ToolState): string {
  if (state === "waiting") return "Wartet auf Freigabe";
  if (state === "blocked") return "Von FORGE blockiert";
  if (state === "denied") return "Abgelehnt";
  const running = state === "running";
  const failed = state === "error";
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return failed ? "Änderung fehlgeschlagen" : running ? "Ändert Code" : "Code geändert";
    case "Write":
      return failed ? "Datei nicht erstellt" : running ? "Erstellt Datei" : "Datei erstellt";
    case "Bash":
      return failed ? "Bash-Befehl fehlgeschlagen" : running ? "Bash-Befehl läuft" : "Bash-Befehl ausgeführt";
    case "PowerShell":
      return failed ? "PowerShell-Befehl fehlgeschlagen" : running ? "PowerShell-Befehl läuft" : "PowerShell-Befehl ausgeführt";
    case "Read":
      return failed ? "Datei nicht gelesen" : running ? "Liest Datei" : "Datei gelesen";
    case "Grep":
      return running ? "Durchsucht Code" : "Code durchsucht";
    case "Glob":
      return running ? "Sucht Dateien" : "Dateien gesucht";
    case "WebFetch":
      return running ? "Ruft Webseite ab" : "Webseite abgerufen";
    case "WebSearch":
      return running ? "Sucht im Web" : "Im Web gesucht";
    case "Task":
    case "Agent":
      return running ? "Subagent arbeitet" : "Subagent fertig";
    case "TodoWrite":
      return "Aufgaben aktualisiert";
    default:
      return failed ? `${TOOL_LABELS[name] ?? toolDisplayName(name)} fehlgeschlagen` : (TOOL_LABELS[name] ?? toolDisplayName(name));
  }
}

function seconds(from: string, to: string | undefined): string | null {
  if (!to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? "<1s" : formatDuration(ms);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 gap-1.5 bg-surface text-caption-lg"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error("Nicht kopiert", "Die Zwischenablage ist nicht erreichbar."),
        );
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Kopiert" : label}
    </Button>
  );
}

/**
 * A tool call as a card: icon, what happened in plain words, duration and the matching action on
 * the right; below it the change, the command with its output, or nothing for a plain read.
 * The chevron shows the raw input and result.
 */
export function ToolCard({ item, sessionId, sessionLive, projectDir }: { item: ToolItem; sessionId: string; sessionLive: boolean; projectDir: string }) {
  const [open, setOpen] = useCardState(cardKey(sessionId, item.key, "open"), false);
  const [more, setMore] = useCardState(cardKey(sessionId, item.key, "more"), false);
  const [outputOpen, setOutputOpen] = useCardState(cardKey(sessionId, item.key, "output"), true);
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

  const tone = cardTone(use.name);
  const failed = state === "error" || state === "blocked" || state === "denied";
  const diff = result?.isError ? null : cachedEditDiff(use.name, use.input);
  const stats = diff ? diffStats(diff) : null;
  const summary = toolSummary(use.name, use.input, projectDir);
  const duration = seconds(item.ts, item.doneTs);
  const isCommand = tone === "command";
  const command = isCommand && typeof use.input.command === "string" ? use.input.command : null;
  const filePath = typeof use.input.file_path === "string" ? use.input.file_path : null;
  const relPath = filePath ? relativeToProject(filePath, projectDir) : null;
  // Only files inside the project open in the Dateien tab; a chat window has no such tab.
  const canShowFile = !!relPath && relPath !== filePath && !isChatWindow();
  const output = result && (result.isError || showsOutput(use.name)) ? cleanToolOutput(result.content.text) : null;
  const outputSplit = output ? splitPreview(output, OUTPUT_PREVIEW_LINES) : null;
  const outputCut = !!outputSplit && (outputSplit.hidden > 0 || outputSplit.cut);

  const showFile = () => {
    const projectId = useUi.getState().activeProjectId;
    if (projectId && relPath) useUi.getState().openFile(projectId, relPath);
  };

  const action = diff?.length ? (
    <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 bg-surface text-caption-lg" onClick={() => setMore(!more)} aria-expanded={more}>
      {more ? "Diff einklappen" : "Diff anzeigen"} <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", more && "rotate-90")} />
    </Button>
  ) : use.name === "Read" && canShowFile ? (
    <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 bg-surface text-caption-lg" onClick={showFile}>
      In Datei anzeigen <ExternalLink className="h-3.5 w-3.5" />
    </Button>
  ) : null;

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 text-body",
        failed ? "border-danger/30 bg-danger-soft" : tone === "edit" && diff?.length ? "border-success/25 bg-success/5" : "border-border bg-surface",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&>svg]:h-4 [&>svg]:w-4", failed ? "bg-danger-soft text-danger" : TONE_ICON[tone], state === "running" && "animate-soft-pulse")}
          role="img"
          aria-label={STATE_DOT[state].label}
        >
          {toolIcon(use.name)}
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <span className={cn("shrink-0 font-semibold", failed ? "text-danger" : "text-fg")}>{toolCardTitle(use.name, state)}</span>
          {duration && <span className="shrink-0 text-small tabular-nums text-subtle">{duration}</span>}
          {!isCommand && summary && (
            <span className="min-w-0 truncate font-mono text-small text-muted" title={summary}>
              {summary}
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
        </div>
        {action}
        {!command && (
          <Button size="icon-sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Details ${open ? "ausblenden" : "anzeigen"}`} title={`Eingabe und Ergebnis ${open ? "ausblenden" : "anzeigen"}`}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </Button>
        )}
      </div>

      {command !== null && (
        <div className="mt-3 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-bg py-1.5 pl-3 pr-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-small text-fg" title={command}>
            {command}
          </code>
          <CopyButton text={command} label="Befehl kopieren" />
          <Button size="icon-sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Details ${open ? "ausblenden" : "anzeigen"}`} title={`Eingabe und Ergebnis ${open ? "ausblenden" : "anzeigen"}`}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          </Button>
        </div>
      )}

      {blocked && (
        <div className="mt-2 flex items-start gap-1.5 text-small text-danger">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {blocked.message} <span className="font-mono text-subtle">({blocked.rule})</span>
          </span>
        </div>
      )}

      {!open && diff?.length ? (
        <div className="mt-3 rounded-lg border border-border bg-bg px-2 py-1.5">
          <DiffPreview lines={diff} expanded={more} onToggle={() => setMore(!more)} truncated={!!use.inputTruncated} />
        </div>
      ) : null}

      {!open && output !== null && (
        <div className="mt-2 overflow-hidden rounded-lg border border-border bg-bg">
          <button
            type="button"
            onClick={() => setOutputOpen(!outputOpen)}
            aria-expanded={outputOpen}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-small text-muted hover:text-fg"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", outputOpen && "rotate-90")} />
            {result?.isError ? "Fehlermeldung" : "Ausgabe"}
            {outputCut && !more && <span className="text-subtle">(gekürzt)</span>}
          </button>
          <Collapse open={outputOpen}>
            <div className="border-t border-border px-3 py-2">
              <OutputPreview text={output} error={!!result?.isError} expanded={more} onToggle={() => setMore(!more)} empty={result?.isError ? "Fehler ohne Meldung" : "(keine Ausgabe)"} />
            </div>
          </Collapse>
        </div>
      )}

      <Collapse open={open}>
        <div className="mt-3 space-y-2">
          <Pre label="Eingabe" text={inputJson(use.input)} />
          {result && <Pre label={result.isError ? "Fehler" : "Ergebnis"} text={result.content.text || "(leer)"} truncated={result.content.truncated} error={result.isError} />}
        </div>
      </Collapse>

      {approval && (
        <div className="mt-3">
          <ApprovalBlock req={approval.req} resolved={approval.resolved} sessionId={sessionId} projectDir={projectDir} />
        </div>
      )}
    </div>
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
      <div className={cn("overflow-x-auto rounded-sm font-mono text-small leading-relaxed", expanded && "max-h-[32rem] overflow-y-auto")}>
        <div className="w-max min-w-full">
          {shown.map((l, i) =>
            l.kind === "gap" ? (
              <div key={i} className="my-1 border-t border-dashed border-border" />
            ) : (
              <div key={i} className={cn("flex whitespace-pre", DIFF_ROW[l.kind].row)}>
                <span aria-hidden className={cn("w-5 shrink-0 select-none text-center", DIFF_ROW[l.kind].mark)}>
                  {DIFF_ROW[l.kind].sign}
                </span>
                <span className={cn("pr-4", l.kind === "ctx" ? "text-muted" : "text-fg")}>{l.text || " "}</span>
              </div>
            ),
          )}
        </div>
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
