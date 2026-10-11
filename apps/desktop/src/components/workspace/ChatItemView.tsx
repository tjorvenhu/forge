import { memo } from "react";
import { AlertTriangle, CheckCircle2, Clock, Info, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { clockTime, cn, formatDuration, formatTokens } from "@/lib/utils";
import { useThrottledValue } from "@/lib/timing-hooks";
import { isInterrupted } from "@/lib/working";
import { Button } from "@/components/ui/button";
import type { ChatItem } from "./chat-items";
import { AutoCommitCard, PlanCard, QuestionCard } from "./InteractiveCards";
import { Markdown } from "./Markdown";
import { ApprovalBlock, ToolCard } from "./ToolCard";
import { EventCard, noticeIcon } from "./EventCard";
import { ClaudeMark } from "./ClaudeMark";
import { UserMessage } from "./UserMessage";

/** Re-parsing the markdown on every delta is the expensive part of streaming; a few updates per second read the same. */
const STREAM_RENDER_MS = 100;

interface ItemViewProps {
  item: ChatItem;
  sessionId: string;
  live: boolean;
  projectDir: string;
  onRetry?: () => void;
}

/** One row of the chat. Memoized: items keep their identity while unchanged, so a new event only renders new rows. */
export const ItemView = memo(function ItemView({ item, sessionId, live, projectDir, onRetry }: ItemViewProps) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} sessionId={sessionId} />;
    case "assistant":
      return <AssistantMessage item={item} />;
    case "tool":
      return (
        <div className="pl-12">
          <ToolCard item={item} sessionId={sessionId} sessionLive={live} projectDir={projectDir} />
        </div>
      );
    case "approval":
      if (item.req.toolName === "AskUserQuestion" || item.req.toolName === "ExitPlanMode") {
        // The approval came without a preceding tool event; show the same card as usual.
        const tool: Extract<ChatItem, { kind: "tool" }> = {
          kind: "tool",
          key: item.key,
          ts: item.ts,
          use: { type: "tool.use", toolUseId: item.req.toolUseId, name: item.req.toolName, input: item.req.input, parentToolUseId: null },
          result: null,
          approval: { req: item.req, resolved: item.resolved },
          blocked: null,
          todos: null,
          superseded: false,
        };
        return <div className="pl-12">{item.req.toolName === "AskUserQuestion" ? <QuestionCard item={tool} sessionId={sessionId} /> : <PlanCard item={tool} sessionId={sessionId} />}</div>;
      }
      return (
        <div className="ml-12 overflow-hidden rounded-xl border border-warning/50">
          <ApprovalBlock req={item.req} resolved={item.resolved} sessionId={sessionId} projectDir={projectDir} />
        </div>
      );
    case "autocommit":
      return (
        <div className="pl-12">
          <AutoCommitCard item={item} sessionId={sessionId} />
        </div>
      );
    case "blocked":
      return (
        <div className="ml-12 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-body">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 text-danger" /> Von der FORGE-Policy blockiert ({item.body.toolName}): {item.body.message}
        </div>
      );
    case "result":
      return <ResultLine body={item.body} onRetry={onRetry} />;
    case "error":
      return (
        <div className="ml-12 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-body-lg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1 break-words">{item.message}</div>
          {item.retryable && onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" /> Erneut senden
            </Button>
          )}
        </div>
      );
    case "notice":
      if (item.card)
        return <EventCard icon={noticeIcon(item.card.icon)} tone={item.tone} title={item.card.title} refText={item.card.ref} detail={item.card.detail} ts={item.ts} />;
      return (
        <div
          className={cn(
            "ml-12 flex items-center gap-2 text-small-lg",
            item.tone === "warning" ? "text-warning" : item.tone === "danger" ? "text-danger" : item.tone === "success" ? "text-success" : "text-muted",
          )}
        >
          <Info className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{item.text}</span>
        </div>
      );
    case "check":
      return <CheckCard body={item.body} ts={item.ts} />;
  }
});

function AssistantMessage({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  const text = useThrottledValue(item.text, item.streaming ? STREAM_RENDER_MS : 0);
  return (
    <div className="flex gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-claude-soft">
        <ClaudeMark size={20} />
      </div>
      <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <Markdown text={text} />
            {item.streaming && <span className="animate-soft-pulse ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent" aria-label="schreibt" />}
          </div>
          {item.ts && <span className="shrink-0 pt-0.5 text-caption-lg text-subtle">{clockTime(item.ts)}</span>}
        </div>
      </div>
    </div>
  );
}

function CheckCard({ body, ts }: { body: Extract<ChatItem, { kind: "check" }>["body"]; ts: string }) {
  return (
    <EventCard
      icon={body.ok ? <CheckCircle2 className="h-4.5 w-4.5" /> : <XCircle className="h-4.5 w-4.5" />}
      tone={body.ok ? "success" : "danger"}
      title={body.ok ? "Tests erfolgreich" : "Tests fehlgeschlagen"}
      refText={body.command}
      detail={formatDuration(body.durationMs)}
      ts={ts}
      defaultOpen={!body.ok}
    >
      {body.output ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-bg p-3 font-mono text-caption-lg text-muted">{body.output}</pre> : undefined}
    </EventCard>
  );
}

function ResultLine({ body, onRetry }: { body: Extract<ChatItem, { kind: "result" }>["body"]; onRetry?: () => void }) {
  const interrupted = isInterrupted(body);
  return (
    <div className="ml-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-1 text-caption-lg text-subtle">
      {body.isError ? (
        interrupted ? (
          <span className="text-warning">Gestoppt</span>
        ) : (
          <span className="text-danger">Fehlgeschlagen: {body.text ?? body.subtype}</span>
        )
      ) : (
        <span className="text-success">Fertig</span>
      )}
      {body.durationMs !== null && (
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" /> {formatDuration(body.durationMs)}
        </span>
      )}
      {body.numTurns !== null && <span>{body.numTurns} {body.numTurns === 1 ? "Schritt" : "Schritte"}</span>}
      {(body.inputTokens !== null || body.outputTokens !== null) && (
        <span title="Laut Claude Code gemeldete Tokens dieses Durchlaufs (ohne Cache-Lesezugriffe)">
          Tokens: {formatTokens(body.inputTokens)} rein, {formatTokens(body.outputTokens)} raus
        </span>
      )}
      {body.isError && !interrupted && onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RotateCcw className="h-3 w-3" /> Erneut senden
        </Button>
      )}
    </div>
  );
}
