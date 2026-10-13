import { useState, type ReactNode } from "react";
import { Collapse } from "@/components/ui/collapse";
import { BellRing, ChevronRight, GitCommitHorizontal, GitMerge, Hourglass, Shrink, SkipForward, Undo2, Upload, Gauge } from "lucide-react";
import { clockTime, cn } from "@/lib/utils";
import type { NoticeIcon } from "./chat-items";
import { ChatRow, Guide, HoverTime } from "./ChatRow";
import { FORGE_ICON_TONE, FORGE_MARKER_OFFSET, ForgeHighlight, ForgeLabel, type ForgeTone } from "./forge-highlight";

type Tone = "info" | "warning" | "success" | "danger";

const TONE: Record<Tone, string> = {
  info: "text-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** Done is FORGE orange like the other FORGE cards; only problems keep their own colour. */
const HIGHLIGHT_TONE: Record<Tone, ForgeTone> = { info: "accent", success: "accent", warning: "warning", danger: "danger" };

/** Size of the gutter icons of event rows. */
export const EVENT_ICON = "h-3.5 w-3.5";

const ICONS: Record<NoticeIcon, ReactNode> = {
  commit: <GitCommitHorizontal className={EVENT_ICON} />,
  push: <Upload className={EVENT_ICON} />,
  merge: <GitMerge className={EVENT_ICON} />,
  skip: <SkipForward className={EVENT_ICON} />,
  rewind: <Undo2 className={EVENT_ICON} />,
  compact: <Shrink className={EVENT_ICON} />,
  background: <Hourglass className={EVENT_ICON} />,
  limit: <Gauge className={EVENT_ICON} />,
  notify: <BellRing className={EVENT_ICON} />,
};

export function noticeIcon(icon: NoticeIcon): ReactNode {
  return ICONS[icon];
}

/**
 * One event in the chat (auto-commit, tests, rewind …) as a single line: icon in the gutter, title,
 * an optional highlighted reference and a muted detail. With `children` it expands to show details.
 */
export function EventCard({
  icon,
  tone,
  title,
  refText,
  detail,
  ts,
  children,
  defaultOpen = false,
  action,
  highlight = false,
}: {
  icon: ReactNode;
  tone: Tone;
  title: string;
  refText?: string | null;
  detail?: string;
  ts: string;
  children?: ReactNode;
  defaultOpen?: boolean;
  /** a button shown after the text, e.g. to cancel what the card announces */
  action?: ReactNode;
  /** something FORGE did itself (auto-commit, push, notification): the box of the FORGE tool cards */
  highlight?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!children;
  const text = (
    <span className="min-w-0">
      <span className="font-medium text-fg">{title}</span>
      {refText && <span className="ml-2 font-mono text-small text-accent">{refText}</span>}
      {detail && <span className="ml-2 text-muted">{detail}</span>}
    </span>
  );
  const forgeTone = HIGHLIGHT_TONE[tone];
  const content = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        {expandable ? (
          <button type="button" className="group/ev flex min-w-0 flex-1 items-start gap-1.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
            {text}
            <span className="flex h-[1lh] shrink-0 items-center">
              <ChevronRight className={cn("h-3.5 w-3.5 text-subtle transition-transform group-hover/ev:text-fg", open && "rotate-90")} />
            </span>
          </button>
        ) : (
          <div className="min-w-0 flex-1 break-words">{text}</div>
        )}
        {highlight && <ForgeLabel />}
        {action && <div className="-my-1 shrink-0">{action}</div>}
        <HoverTime time={clockTime(ts)} />
      </div>
      {expandable && (
        <Collapse open={open}>
          <Guide className="mt-1.5">{children}</Guide>
        </Collapse>
      )}
    </>
  );
  return (
    <ChatRow
      className="group text-body"
      markerClassName={highlight ? FORGE_MARKER_OFFSET : undefined}
      marker={<span className={highlight ? FORGE_ICON_TONE[forgeTone] : TONE[tone]}>{icon}</span>}
    >
      {highlight ? <ForgeHighlight tone={forgeTone}>{content}</ForgeHighlight> : content}
    </ChatRow>
  );
}
