import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** A placeholder block in the shape of content that is still loading. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn("animate-shimmer rounded-md bg-surface-2", className)} style={style} aria-hidden />;
}

/** Rows of a list (sessions, files, git changes) while they load. */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 p-3", className)} role="status" aria-label="Lädt">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5">
          <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
          <Skeleton className="h-3 rounded-sm" style={{ width: `${45 + ((i * 37) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** A chat thread while its history loads: a prompt, an answer, a tool line. */
export function ChatSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-7 px-6 pt-6" role="status" aria-label="Verlauf lädt">
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
    </div>
  );
}
