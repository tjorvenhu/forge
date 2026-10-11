import { useState, type ReactNode } from "react";
import { ChevronRight, DatabaseBackup, GitCommitHorizontal, Hourglass, Shrink, SkipForward, Undo2, Upload, Gauge } from "lucide-react";
import { clockTime, cn } from "@/lib/utils";
import type { NoticeIcon } from "./chat-items";

type Tone = "info" | "warning" | "success" | "danger";

const TILE: Record<Tone, string> = {
  info: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

const ICONS: Record<NoticeIcon, ReactNode> = {
  checkpoint: <DatabaseBackup className="h-[18px] w-[18px]" />,
  commit: <GitCommitHorizontal className="h-[18px] w-[18px]" />,
  push: <Upload className="h-[18px] w-[18px]" />,
  skip: <SkipForward className="h-[18px] w-[18px]" />,
  rewind: <Undo2 className="h-[18px] w-[18px]" />,
  compact: <Shrink className="h-[18px] w-[18px]" />,
  background: <Hourglass className="h-[18px] w-[18px]" />,
  limit: <Gauge className="h-[18px] w-[18px]" />,
};

export function noticeIcon(icon: NoticeIcon): ReactNode {
  return ICONS[icon];
}

/**
 * One event in the chat (checkpoint, auto-commit, tests …): icon tile, title, a line with an
 * optional highlighted reference, time. With `children` it expands to show details.
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
}: {
  icon: ReactNode;
  tone: Tone;
  title: string;
  refText?: string | null;
  detail?: string;
  ts: string;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!children;
  const head = (
    <>
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", TILE[tone])}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{title}</span>
        {(refText || detail) && (
          <span className="block truncate text-[12.5px] text-muted">
            {refText && <span className="font-mono text-accent">{refText}</span>}
            {refText && detail ? " · " : ""}
            {detail}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[11.5px] text-subtle">{clockTime(ts)}</span>
      {expandable && <ChevronRight className={cn("h-4 w-4 shrink-0 text-subtle transition-transform", open && "rotate-90")} />}
    </>
  );
  return (
    <div className="ml-12 overflow-hidden rounded-xl border border-border bg-surface">
      {expandable ? (
        <button className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2" onClick={() => setOpen(!open)} aria-expanded={open}>
          {head}
        </button>
      ) : (
        <div className="flex items-center gap-3 px-3.5 py-2.5">{head}</div>
      )}
      {expandable && open && <div className="border-t border-border">{children}</div>}
    </div>
  );
}
