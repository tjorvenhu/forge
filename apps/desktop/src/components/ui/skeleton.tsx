import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A placeholder block in the shape of content that is still loading. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn("animate-shimmer rounded-md bg-surface-2", className)} style={style} aria-hidden />;
}

/** Wraps skeleton blocks so tests and screen readers find them as one loading region. */
export function SkeletonRegion({ label = "Lädt", className, style, children }: { label?: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className={className} style={style} role="status" aria-label={label}>
      {children}
    </div>
  );
}

/** Varied widths so placeholder lines read like text and not like a bar chart. */
const lineWidth = (i: number, base = 45, spread = 40) => `${base + ((i * 37) % spread)}%`;

/** Rows of a list (sessions, files, git changes) while they load. */
export function ListSkeleton({ rows = 5, className, label }: { rows?: number; className?: string; label?: string }) {
  return (
    <SkeletonRegion label={label} className={cn("flex flex-col gap-2 p-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
          <Skeleton className="h-3 rounded-sm" style={{ width: lineWidth(i) }} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Paragraph lines, e.g. a summary or a description in a dialog. */
export function TextSkeleton({ lines = 3, className, label }: { lines?: number; className?: string; label?: string }) {
  return (
    <SkeletonRegion label={label} className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-3 rounded-sm" style={{ width: i === lines - 1 ? "40%" : lineWidth(i, 70, 30) }} />
      ))}
    </SkeletonRegion>
  );
}

/** One card: icon and title line, a short body, a footer bar. Matches project and agent cards. */
export function CardSkeleton({ className, body = 1, footer = true }: { className?: string; body?: number; footer?: boolean }) {
  return (
    <div className={cn("flex flex-col rounded-xl border border-border bg-surface", className)}>
      <div className="flex items-center gap-3 px-4 pb-2.5 pt-4">
        <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton className="h-3.5 w-2/5" />
          <Skeleton className="h-2.5 w-3/5" />
        </div>
      </div>
      {body > 0 && (
        <div className="flex flex-col gap-1.5 px-4 pb-3">
          {Array.from({ length: body }, (_, i) => (
            <Skeleton key={i} className="h-2.5" style={{ width: lineWidth(i, 50, 35) }} />
          ))}
        </div>
      )}
      {footer && (
        <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-2">
          <Skeleton className="h-2.5 w-1/2" />
          <Skeleton className="h-5 w-5 rounded" />
        </div>
      )}
    </div>
  );
}

/** A responsive card grid; `min` is the same minimum card width the real grid uses. */
export function CardGridSkeleton({
  count = 6,
  min = 300,
  gap = "gap-3",
  body,
  footer,
  className,
  cardClassName,
  label,
}: {
  count?: number;
  min?: number;
  gap?: string;
  body?: number;
  footer?: boolean;
  className?: string;
  cardClassName?: string;
  label?: string;
}) {
  return (
    <SkeletonRegion label={label} className={cn("grid", gap, className)} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} body={body} footer={footer} className={cardClassName} />
      ))}
    </SkeletonRegion>
  );
}

/** A table with its real header row, so only the body swaps when the data arrives. */
export function TableSkeleton({ columns, rows = 6, className, label }: { columns: ReactNode[]; rows?: number; className?: string; label?: string }) {
  return (
    <SkeletonRegion label={label} className={cn("overflow-hidden rounded-xl border border-border", className)}>
      <table className="w-full text-body">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            {columns.map((c, i) => (
              <th key={i} className="px-4 py-2 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="bg-surface">
              {columns.map((_, c) => (
                <td key={c} className="h-12.5 px-4 py-2">
                  {c === 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <Skeleton className="h-3" style={{ width: lineWidth(r, 55, 35) }} />
                      <Skeleton className="h-2 w-2/5" />
                    </div>
                  ) : (
                    <Skeleton className="h-3" style={{ width: lineWidth(r + c, 40, 45) }} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </SkeletonRegion>
  );
}

/** Rows of a settings form: label and hint on the left, a control on the right. */
export function FormRowsSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide-y divide-border", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-6 px-4 py-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5" style={{ width: lineWidth(i, 20, 20) }} />
            <Skeleton className="h-2.5" style={{ width: lineWidth(i, 45, 30) }} />
          </div>
          <Skeleton className="h-8 w-48 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A settings group (header with title and description, then form rows) or several of them. */
export function FormSkeleton({ groups = 1, rows = 3, className, label }: { groups?: number; rows?: number; className?: string; label?: string }) {
  return (
    <SkeletonRegion label={label} className={cn("flex flex-col gap-6", className)}>
      {Array.from({ length: groups }, (_, g) => (
        <section key={g} className="overflow-hidden rounded-xl border border-border bg-surface">
          <header className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-2/3" />
          </header>
          <FormRowsSkeleton rows={rows} />
        </section>
      ))}
    </SkeletonRegion>
  );
}

/** Lines of code with a line-number gutter; fills its parent. */
export function CodeSkeleton({ lines = 14, gutter = true, className, label }: { lines?: number; gutter?: boolean; className?: string; label?: string }) {
  return (
    <SkeletonRegion label={label} className={cn("flex flex-col gap-2 overflow-hidden py-3", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex h-3 items-center gap-3 pr-3">
          {gutter && <Skeleton className="ml-3 h-2.5 w-5 shrink-0 rounded-sm opacity-60" />}
          <Skeleton className="h-2.5 rounded-sm" style={{ width: lineWidth(i, 20, 65), marginLeft: `${((i * 3) % 4) * 12}px` }} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** A text editor box in its final size; pass the editor's height via className. */
export function EditorSkeleton({ className, label = "Lädt Editor" }: { className?: string; label?: string }) {
  return (
    <div className={cn("h-full min-h-24 w-full overflow-hidden rounded-md border border-border bg-surface", className)}>
      <CodeSkeleton label={label} lines={12} className="h-full" />
    </div>
  );
}

/** Rows of key and value, as in info dialogs and status lists. */
export function KeyValueSkeleton({ rows = 4, className, label }: { rows?: number; className?: string; label?: string }) {
  return (
    <SkeletonRegion label={label} className={cn("flex flex-col gap-3", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Skeleton className="h-3" style={{ width: lineWidth(i, 20, 20) }} />
          <Skeleton className="h-3" style={{ width: lineWidth(i + 1, 15, 25) }} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** A chat thread while its history loads: a prompt, an answer, a tool line. */
export function ChatSkeleton() {
  return (
    <SkeletonRegion label="Lädt Verlauf" className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-7 px-6 pt-6">
      {[0, 1].map((n) => (
        <div key={n} className="flex flex-col gap-3">
          <Skeleton className="-mx-3 h-11 w-[min(70%,40rem)]" />
          <div className="flex flex-col gap-2 pl-8">
            <Skeleton className="h-3 w-[85%]" />
            <Skeleton className="h-3 w-[70%]" />
            <Skeleton className="h-3 w-[40%]" />
          </div>
          <Skeleton className="ml-8 h-6 w-64" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** The composer box in its resting size (two text rows and the toolbar), so the thread above does not jump. */
export function ComposerSkeleton() {
  return (
    <div className="relative w-full shrink-0 px-6 pb-5 pt-2" aria-hidden>
      <div className="rounded-2xl border border-border bg-surface">
        <div className="h-14.5 px-5 pt-4">
          <Skeleton className="mt-1 h-3 w-56" />
        </div>
        <div className="flex items-center gap-2 px-4 pb-3.5 pt-2">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
          <div className="flex-1" />
          <Skeleton className="h-8 w-28 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/** Thread and composer together, for places that show the whole chat column before it is ready. */
export function ChatColumnSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatSkeleton />
      </div>
      <ComposerSkeleton />
    </div>
  );
}
