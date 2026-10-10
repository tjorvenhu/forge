import { useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardList,
  FileText,
  FilePen,
  FilePlus,
  Globe,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  Search,
  ShieldAlert,
  ShieldQuestion,
  SquareTerminal,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { TOOL_LABELS, toolSummary, type ChatItem } from "./chat-items";
import { PlanCard, QuestionCard } from "./InteractiveCards";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type ApprovalItem = Extract<ChatItem, { kind: "approval" }>;

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

export function ToolCard({ item, sessionId, sessionLive, projectDir }: { item: ToolItem; sessionId: string; sessionLive: boolean; projectDir: string }) {
  const [open, setOpen] = useState(false);
  const { use, result, approval, blocked } = item;
  const pendingApproval = approval && !approval.resolved;
  const running = !result && !blocked && !pendingApproval && sessionLive;
  const state: "running" | "ok" | "error" | "blocked" | "waiting" | "denied" | "unknown" = blocked
    ? "blocked"
    : pendingApproval
      ? "waiting"
      : approval?.resolved?.decision === "deny"
        ? "denied"
        : result
          ? result.isError
            ? "error"
            : "ok"
          : running
            ? "running"
            : "unknown";

  if (item.todos && !item.superseded) return <TodoCard todos={item.todos} />;
  if (use.name === "AskUserQuestion" && !blocked) return <QuestionCard item={item} sessionId={sessionId} />;
  if (use.name === "ExitPlanMode" && !blocked) return <PlanCard item={item} sessionId={sessionId} />;

  return (
    <div className={cn("rounded-lg border bg-surface", pendingApproval ? "border-warning/50" : blocked ? "border-danger/40" : "border-border")}>
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
        <span className="text-muted">{toolIcon(use.name)}</span>
        <span className="shrink-0 text-[13px] font-medium">{TOOL_LABELS[use.name] ?? use.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{toolSummary(use.name, use.input, projectDir)}</span>
        {use.parentToolUseId && <Badge>Subagent</Badge>}
        <StateIcon state={state} />
      </button>
      {blocked && (
        <div className="flex items-start gap-2 border-t border-danger/30 bg-danger-soft px-3 py-2 text-xs">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          <span>
            Von der FORGE-Policy blockiert: {blocked.message} <span className="font-mono text-subtle">({blocked.rule})</span>
          </span>
        </div>
      )}
      {approval && <ApprovalBlock req={approval.req} resolved={approval.resolved} sessionId={sessionId} projectDir={projectDir} />}
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          <Pre label="Eingabe" text={JSON.stringify(use.input, null, 2)} />
          {result && <Pre label={result.isError ? "Fehler" : "Ergebnis"} text={result.content.text || "(leer)"} truncated={result.content.truncated} error={result.isError} />}
        </div>
      )}
    </div>
  );
}

function StateIcon({ state }: { state: string }) {
  switch (state) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" aria-label="läuft" />;
    case "ok":
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-label="erfolgreich" />;
    case "error":
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="Fehler" />;
    case "blocked":
      return <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="blockiert" />;
    case "waiting":
      return <ShieldQuestion className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="wartet auf Freigabe" />;
    case "denied":
      return <X className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="abgelehnt" />;
    default:
      return <Circle className="h-3.5 w-3.5 shrink-0 text-subtle" aria-label="ohne Ergebnis" />;
  }
}

function Pre({ label, text, truncated, error }: { label: string; text: string; truncated?: boolean; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">{label}</div>
      <pre className={cn("max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg p-2 font-mono text-[11.5px]", error ? "text-danger" : "text-muted")}>{text}</pre>
      {truncated && <div className="mt-1 text-[11px] text-subtle">Gekürzt auf 20.000 Zeichen.</div>}
    </div>
  );
}

export function ApprovalBlock({ req, resolved, sessionId, projectDir }: { req: ApprovalItem["req"]; resolved: ApprovalItem["resolved"]; sessionId: string; projectDir?: string }) {
  const [reason, setReason] = useState("");
  const respond = useMutation({
    mutationFn: (p: { decision: "allow" | "deny"; scope: "once" | "session" }) =>
      call("sessions.respondApproval", { sessionId, requestId: req.requestId, decision: p.decision, scope: p.scope, message: reason || undefined }),
    onError: (e) => toast.error("Antwort nicht übermittelt", errorMessage(e)),
  });

  if (resolved) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted">
        {resolved.decision === "allow" ? <Check className="h-3.5 w-3.5 text-success" /> : <X className="h-3.5 w-3.5 text-danger" />}
        {resolved.decision === "allow"
          ? resolved.scope === "session"
            ? "Für diese Session erlaubt"
            : "Einmal erlaubt"
          : resolved.source === "abort"
            ? "Abgebrochen"
            : `Abgelehnt${resolved.message ? `: ${resolved.message}` : ""}`}
      </div>
    );
  }

  return (
    <div className="border-t border-warning/40 bg-warning-soft px-3 py-2.5" role="group" aria-label="Freigabeanfrage">
      <div className="flex items-start gap-2 text-[13px]">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{req.title ?? approvalTitle(req.toolName)}</div>
          {req.description && <div className="text-xs text-muted">{req.description}</div>}
          {req.outsideProject && <div className="mt-1 text-xs font-medium text-danger">Achtung: Schreibzugriff außerhalb des Projektordners.</div>}
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-bg/60 p-2 font-mono text-[11.5px] text-fg/90">
            {toolSummary(req.toolName, req.input, projectDir) || JSON.stringify(req.input, null, 2)}
          </pre>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Begründung bei Ablehnung (optional)" className="h-7 max-w-64 text-xs" />
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => respond.mutate({ decision: "deny", scope: "once" })} disabled={respond.isPending} autoFocus>
          Ablehnen
        </Button>
        {req.allowSessionScope && (
          <Button size="sm" variant="secondary" onClick={() => respond.mutate({ decision: "allow", scope: "session" })} disabled={respond.isPending}>
            Für Session erlauben
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => respond.mutate({ decision: "allow", scope: "once" })} loading={respond.isPending}>
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

function TodoCard({ todos }: { todos: Array<{ content: string; status: string; activeForm?: string }> }) {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <ListChecks className="h-3.5 w-3.5" /> Aufgaben {done}/{todos.length}
      </div>
      <ul className="space-y-1.5">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            {t.status === "completed" ? (
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-success">
                <Check className="h-3 w-3 text-bg" strokeWidth={3} />
              </span>
            ) : t.status === "in_progress" ? (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
            ) : (
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
            )}
            <span className={cn(t.status === "completed" && "text-muted", t.status === "in_progress" && "font-medium")}>
              {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
