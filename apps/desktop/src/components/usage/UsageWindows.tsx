import type { QueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, TrendingUp } from "lucide-react";
import type { PlanUsage, UsageWindow } from "@forge/protocol";
import type { MenuItem } from "@/components/ui/dropdown";
import { refreshUsage, useUsage } from "@/lib/queries";
import { limitTime } from "@/lib/rate-limit";
import { Meter, MeterSkeleton, usageTone } from "@/components/ui/meter";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { forecastLabel, forecastSentence, windowsRunningOut } from "@/lib/usage-forecast";
import { relativeTime } from "@/lib/utils";
import { locale, t } from "@/i18n";

export const resetText = (iso: string | null) => {
  if (!iso) return undefined;
  const date = new Date(iso).toLocaleString(locale, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (Date.parse(iso) <= Date.now() ? t.usage.resetPast : t.usage.resetFuture)(relativeTime(iso), date);
};

function WindowDetail({ w }: { w: UsageWindow }) {
  const reset = resetText(w.resetsAt);
  const label = forecastLabel(w);
  return (
    <>
      {reset && <div>{reset}</div>}
      <div className={label?.limit ? "text-warning" : undefined}>{forecastSentence(w)}</div>
    </>
  );
}

/**
 * Every window of the plan usage with its reset and the limit forecast, followed by when it was read.
 * Shared by Settings → Claude Code and /usage.
 */
export function UsageWindows({ usage }: { usage: PlanUsage }) {
  return (
    <div className="space-y-4">
      {usage.windows.map((w) => (
        <Meter key={w.key} label={w.label} value={w.utilization} detail={<WindowDetail w={w} />} toneOf={usageTone} />
      ))}
      <div className="text-caption text-subtle">{t.usage.fetched(relativeTime(usage.fetchedAt))}</div>
    </div>
  );
}

/** `plan`: with the line of the plan name above the windows, as in /usage. */
export function UsageWindowsSkeleton({ windows = 2, plan = false }: { windows?: number; plan?: boolean }) {
  return (
    <SkeletonRegion label={t.usage.skeletonLabel} className="space-y-4">
      {plan && <Skeleton className="h-3 w-24" />}
      {Array.from({ length: windows }, (_, i) => (
        <MeterSkeleton key={i} lines={2} />
      ))}
      <Skeleton className="h-2.5 w-28" />
    </SkeletonRegion>
  );
}

/**
 * Notice before more work starts (a parallel agent): which windows run full before their reset at the
 * current pace. Only informs; nothing without such a forecast.
 */
export function LimitForecastWarning() {
  const usage = useUsage();
  const full = windowsRunningOut(usage.data);
  if (!full.length) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t.usage.forecastWarning.title}</div>
        <div className="text-xs text-muted">
          {t.usage.forecastWarning.detail(full.map((w) => t.usage.forecastWarning.window(w.label, forecastLabel(w)!.text, w.resetsAt ? limitTime(w.resetsAt) : null)).join(". "))}
        </div>
      </div>
    </div>
  );
}

/** Menu entries on a usage display: read the numbers now, and open the forecast in the settings. */
export function usageItems(qc: QueryClient, openForecast?: () => void): MenuItem[] {
  const items: MenuItem[] = [{ label: t.usage.refresh, icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: () => void refreshUsage(qc) }];
  if (openForecast) items.push({ label: t.usage.viewForecast, icon: <TrendingUp className="h-3.5 w-3.5" />, onSelect: openForecast });
  return items;
}

/** Why there are no numbers: the error from Claude Code, or no plan. */
export function usageUnavailableText(usage: PlanUsage): string {
  return usage.error ?? t.usage.unavailable;
}
