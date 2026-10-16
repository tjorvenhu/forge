import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./skeleton";

export type MeterTone = "ok" | "warn" | "danger";

/** Plan windows warn later than the context window, like the bars in the sidebar. */
export const usageTone = (pct: number): MeterTone => (pct >= 95 ? "danger" : pct >= 80 ? "warn" : "ok");

/** A labelled bar with percent and an optional detail line (usage windows, context window). */
export function Meter({ label, value, detail, toneOf }: { label: string; value: number; detail?: ReactNode; toneOf: (pct: number) => MeterTone }) {
  const pct = Math.max(0, Math.round(value));
  const tone = toneOf(pct);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-body">
        <span>{label}</span>
        <span className={cn("tabular-nums", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-muted")}>{pct} % genutzt</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.min(100, pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn("h-full rounded-full", tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {detail && <div className="mt-1 text-caption text-subtle">{detail}</div>}
    </div>
  );
}

export function MeterSkeleton({ detail = true, lines = 1 }: { detail?: boolean; lines?: number }) {
  return (
    <div>
      <div className="mb-1 flex h-5 items-center justify-between gap-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-2 rounded-full" />
      {detail && Array.from({ length: lines }, (_, i) => <Skeleton key={i} className={cn("mt-1.5 h-2.5", i ? "w-2/5" : "w-3/5")} />)}
    </div>
  );
}
