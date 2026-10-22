import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import type { SessionUsage, SessionUsageWindow } from "@forge/protocol";
import { keys, useSessionUsage } from "@/lib/queries";
import { contextItems } from "@/lib/context-menu";
import { errorMessage } from "@/lib/rpc";
import { formatTokens } from "@/lib/utils";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner, Tooltip } from "@/components/ui/misc";
import { usageTone } from "@/components/ui/meter";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { useSessionUsageDialog } from "@/stores/session-usage";
import { resetText, usageItems } from "./UsageWindows";
import { cn } from "@/lib/utils";
import { locale, t } from "@/i18n";

const percent = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 });

/**
 * Next to the context meter: the session's estimated share of the first usage window (5 hours), or its
 * tokens without a plan. Hovering lists every window, a click opens the details.
 */
export function SessionUsageMeter({ sessionId, title }: { sessionId: string; title: string | null }) {
  const qc = useQueryClient();
  const q = useSessionUsage(sessionId);
  const open = () => useSessionUsageDialog.getState().open(sessionId, title);
  if (!q.data) return q.isPending ? <Skeleton className="h-7 w-14 shrink-0 rounded-md" /> : null;
  const u = q.data;
  if (u.totalTokens === 0) return null;
  const first = u.windows[0];
  const m = t.usage.session;
  return (
    <Tooltip
      content={
        <div className="space-y-1 py-0.5">
          <div className="font-medium">{m.tooltipHead(formatTokens(u.totalTokens))}</div>
          {u.windows.map((w) => (
            <div key={w.key} className="text-muted">
              {m.tooltipWindow(w.label, percent(w.share))}
            </div>
          ))}
          <div className="pt-1 text-subtle">{m.tooltipHint}</div>
        </div>
      }
    >
      <button
        type="button"
        onClick={open}
        onContextMenu={contextItems(() => [{ label: m.open, icon: <Gauge className="h-3.5 w-3.5" />, onSelect: open }, ...usageItems(qc)])}
        aria-label={first ? m.meterAria(percent(first.share), first.label) : m.tooltipHead(formatTokens(u.totalTokens))}
        className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Gauge className="h-3.5 w-3.5" />
        <span className="whitespace-nowrap tabular-nums">{first ? m.meterLabel(percent(first.share)) : formatTokens(u.totalTokens)}</span>
      </button>
    </Tooltip>
  );
}

/** Tokens of the session by kind and its share of every usage window; in the dialog and in /usage. */
export function SessionUsageDetails({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const q = useSessionUsage(sessionId);
  // Opening is a request for the current numbers.
  useEffect(() => void qc.invalidateQueries({ queryKey: keys.sessionUsage(sessionId) }), [qc, sessionId]);
  if (q.isError && !q.data) return <ErrorBanner>{`${t.usage.session.failed}: ${errorMessage(q.error)}`}</ErrorBanner>;
  if (!q.data) return <SessionUsageSkeleton />;
  return <UsageBreakdown u={q.data} />;
}

function UsageBreakdown({ u }: { u: SessionUsage }) {
  const m = t.usage.session;
  if (u.totalTokens === 0) return <div className="text-body text-muted">{m.none}</div>;
  const rows: Array<[string, number]> = [
    [m.input, u.inputTokens],
    [m.output, u.outputTokens],
    [m.cacheRead, u.cacheReadTokens],
    [m.cacheWrite, u.cacheWriteTokens],
  ];
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-body">{m.total}</span>
          <span className="text-title tabular-nums">{formatTokens(u.totalTokens)}</span>
        </div>
        <div className="text-caption text-subtle">{m.turns(u.turns)}</div>
        <div className="mt-2 divide-y divide-border">
          {rows.map(([label, n]) => (
            <div key={label} className="flex h-8 items-center justify-between gap-4 text-body">
              <span className="text-muted">{label}</span>
              <span className="tabular-nums">{formatTokens(n)}</span>
            </div>
          ))}
        </div>
        {u.costUsd > 0 && <div className="mt-1 text-caption text-subtle">{m.apiValue(u.costUsd.toLocaleString(locale, { style: "currency", currency: "USD" }))}</div>}
      </div>
      {u.windows.length > 0 ? (
        <div className="space-y-3">
          <div className="text-caption font-medium uppercase tracking-wide text-subtle">{m.windowsTitle}</div>
          {u.windows.map((w) => (
            <WindowShare key={w.key} w={w} />
          ))}
          <p className="text-caption text-subtle">{m.estimate}</p>
        </div>
      ) : (
        u.planError && <p className="text-caption text-subtle">{m.noPlan(u.planError)}</p>
      )}
    </div>
  );
}

/** The session's part (solid) inside what the whole window used (light). */
function WindowShare({ w }: { w: SessionUsageWindow }) {
  const m = t.usage.session;
  const tone = usageTone(Math.round(w.utilization));
  const reset = resetText(w.resetsAt);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-body">
        <span>{w.label}</span>
        <span className="tabular-nums text-muted">{m.windowShare(percent(w.share))}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={w.share} aria-valuemin={0} aria-valuemax={100} aria-label={m.meterAria(percent(w.share), w.label)}>
        <div className={cn("absolute inset-y-0 left-0 rounded-full", tone === "danger" ? "bg-danger/25" : tone === "warn" ? "bg-warning/25" : "bg-accent/25")} style={{ width: `${Math.min(100, w.utilization)}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${Math.min(100, w.share)}%` }} />
      </div>
      <div className="mt-1 text-caption text-subtle">
        <div>{m.windowDetail(formatTokens(w.tokens), Math.round(w.utilization))}</div>
        {reset && <div>{reset}</div>}
      </div>
    </div>
  );
}

function SessionUsageSkeleton() {
  return (
    <SkeletonRegion label={t.usage.session.loading} className="space-y-4">
      <div>
        <div className="flex h-6 items-center justify-between gap-3">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-4 w-16" />
        </div>
        <Skeleton className="mt-1 h-2.5 w-20" />
        <div className="mt-2 divide-y divide-border">
          {[40, 30, 50, 45].map((w) => (
            <div key={w} className="flex h-8 items-center justify-between gap-4">
              <Skeleton className="h-3" style={{ width: `${w}%` }} />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-2.5 w-32" />
        {[0, 1].map((i) => (
          <div key={i}>
            <div className="mb-1 flex h-5 items-center justify-between gap-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-14" />
            </div>
            <Skeleton className="h-2 rounded-full" />
            <Skeleton className="mt-1.5 h-2.5 w-3/5" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Mounted once per window (App, chat window): the dialog the store asks for. */
export function SessionUsageDialogHost() {
  const { shown, sessionId, title, close } = useSessionUsageDialog();
  return (
    <Dialog open={shown} onOpenChange={(o) => !o && close()} title={t.usage.session.title} description={title ?? undefined}>
      {sessionId && <SessionUsageDetails sessionId={sessionId} />}
    </Dialog>
  );
}
