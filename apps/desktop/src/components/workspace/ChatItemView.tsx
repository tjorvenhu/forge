import { memo, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Copy, Info, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { contextItems, copyText } from "@/lib/context-menu";
import { clockTime, cn, formatDuration, formatTokens } from "@/lib/utils";
import { useThrottledValue } from "@/lib/timing-hooks";
import { isInterrupted } from "@/lib/working";
import { Button } from "@/components/ui/button";
import type { ChatItem, NoticeIcon } from "./chat-items";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ApprovalBlock, ToolCard } from "./ToolCard";
import { EVENT_ICON, EventCard, noticeIcon } from "./EventCard";
import { ChatRow, Dot, HoverTime } from "./ChatRow";
import { UserMessage } from "./UserMessage";
import { AutoContinueCard } from "./AutoContinueCard";
import { HandoffCard } from "./handoff";
import { UiCompareCard } from "./UiCompareCard";
import { t } from "@/i18n";

/**
 * Text updates while streaming. Only the last paragraph is parsed again (StreamingMarkdown), so this
 * can be short enough to read as continuous.
 */
const STREAM_RENDER_MS = 50;

/** Notices of what FORGE did itself; they get the highlighted box like the FORGE tool cards. */
const FORGE_NOTICES = new Set<NoticeIcon>(["commit", "push", "merge", "skip", "notify", "update"]);

const NOTICE_TONE ={ info: "text-muted", warning: "text-warning", danger: "text-danger", success: "text-success" } as const;

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
      return <ToolCard item={item} sessionId={sessionId} sessionLive={live} projectDir={projectDir} />;
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
        return <ToolCard item={tool} sessionId={sessionId} sessionLive={live} projectDir={projectDir} />;
      }
      return (
        <ChatRow
          className="text-body"
          markerClassName={item.resolved ? undefined : "mt-2.75"}
          marker={<Dot className={item.resolved ? (item.resolved.decision === "allow" ? "bg-success" : "border-[1.5px] border-danger") : "animate-soft-pulse bg-warning"} label={item.resolved ? undefined : t.chat.item.waitingForApproval} />}
        >
          <ApprovalBlock req={item.req} resolved={item.resolved} sessionId={sessionId} projectDir={projectDir} />
        </ChatRow>
      );
    case "blocked":
      return (
        <ChatRow className="text-body" marker={<ShieldAlert className={cn(EVENT_ICON, "text-danger")} />}>
          <span className="break-words">
            <span className="font-medium text-danger">{t.chat.item.blockedByForgePolicy}</span> <span className="text-muted">({item.body.toolName}): {item.body.message}</span>
          </span>
        </ChatRow>
      );
    case "result":
      return <ResultLine body={item.body} onRetry={onRetry} />;
    case "error":
      return (
        <ChatRow className="text-body" marker={<AlertTriangle className={cn(EVENT_ICON, "text-danger")} />}>
          <div className="flex items-baseline gap-3">
            <div className="min-w-0 flex-1 break-words text-danger">{item.message}</div>
            {item.retryable && onRetry && (
              <Button size="sm" variant="outline" className="-my-1" onClick={onRetry}>
                <RotateCcw className="h-3.5 w-3.5" /> {t.chat.item.resend}
              </Button>
            )}
          </div>
        </ChatRow>
      );
    case "notice":
      if (item.card)
        return (
          <EventCard
            icon={noticeIcon(item.card.icon)}
            tone={item.tone}
            title={item.card.title}
            refText={item.card.ref}
            detail={item.card.detail}
            ts={item.ts}
            highlight={FORGE_NOTICES.has(item.card.icon)}
          />
        );
      return (
        <ChatRow className={cn("text-body", NOTICE_TONE[item.tone])} marker={<Info className={EVENT_ICON} />}>
          <span className="break-words">{item.text}</span>
        </ChatRow>
      );
    case "check":
      return <CheckCard body={item.body} ts={item.ts} />;
    case "autoContinue":
      return <AutoContinueCard item={item} sessionId={sessionId} />;
    case "uiCompare":
      return <UiCompareCard item={item} sessionId={sessionId} />;
    case "handoff":
      return <HandoffCard body={item.body} ts={item.ts} sessionId={sessionId} />;
  }
});

function AssistantMessage({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  const text = useThrottledValue(item.text, item.streaming ? STREAM_RENDER_MS : 0);
  return (
    <ChatRow className="group relative text-ui leading-[1.65]" marker={<Dot className="bg-fg" />}>
      <div onContextMenu={contextItems(() => (item.streaming ? [] : [{ label: t.chat.item.copyAnswer, icon: <Copy className="h-3.5 w-3.5" />, hint: "Markdown", onSelect: () => copyText(item.text) }]))}>
        {item.streaming ? <StreamingMarkdown text={text} /> : <Markdown text={text} />}
        {item.streaming && <span className="animate-soft-pulse mt-1 inline-block h-3.5 w-1.5 bg-muted" aria-label={t.chat.item.writing} />}
      </div>
      {item.ts && <HoverTime time={clockTime(item.ts)} className="absolute right-0 top-0 bg-bg pl-2 leading-[1lh]" />}
    </ChatRow>
  );
}

function CheckCard({ body, ts }: { body: Extract<ChatItem, { kind: "check" }>["body"]; ts: string }) {
  return (
    <EventCard
      icon={body.ok ? <CheckCircle2 className={EVENT_ICON} /> : <XCircle className={EVENT_ICON} />}
      tone={body.ok ? "success" : "danger"}
      title={body.ok ? t.chat.item.testsPassed : t.chat.item.testsFailed}
      refText={body.command}
      detail={formatDuration(body.durationMs)}
      ts={ts}
      defaultOpen={!body.ok}
    >
      {body.output ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-small leading-relaxed text-muted wrap-anywhere">{body.output}</pre> : undefined}
    </EventCard>
  );
}

function ResultLine({ body, onRetry }: { body: Extract<ChatItem, { kind: "result" }>["body"]; onRetry?: () => void }) {
  const interrupted = isInterrupted(body);
  return (
    <ChatRow className="text-caption-lg">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-subtle">
        {body.isError ? (
          interrupted ? (
            <span className="text-warning">{t.chat.item.stopped}</span>
          ) : (
            <span className="text-danger">{t.chat.item.failed(body.text ?? body.subtype)}</span>
          )
        ) : (
          <span className="text-success">{t.chat.item.done}</span>
        )}
        {body.durationMs !== null && <Part>{formatDuration(body.durationMs)}</Part>}
        {/* A local command (/compact, /cost) reports 0 steps and 0 tokens; that only adds noise. */}
        {!!body.numTurns && (
          <Part>{t.chat.item.steps(body.numTurns)}</Part>
        )}
        {(!!body.inputTokens || !!body.outputTokens) && (
          <Part title={t.chat.item.tokensTitle}>{t.chat.item.tokens(formatTokens(body.inputTokens), formatTokens(body.outputTokens))}</Part>
        )}
        {body.isError && !interrupted && onRetry && (
          <Button size="sm" variant="ghost" className="-my-1 ml-1" onClick={onRetry}>
            <RotateCcw className="h-3 w-3" /> {t.chat.item.resend}
          </Button>
        )}
      </div>
    </ChatRow>
  );
}

/** One fact of the result line, separated from the previous by a small dot. */
function Part({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span aria-hidden className="h-0.5 w-0.5 rounded-full bg-subtle" />
      {children}
    </span>
  );
}
