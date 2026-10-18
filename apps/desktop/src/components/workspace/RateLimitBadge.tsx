import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useRateLimit, useUsage } from "@/lib/queries";
import { activeRateLimit, limitDateTime, limitLabel, limitTime } from "@/lib/rate-limit";
import { relativeTime } from "@/lib/utils";
import { Badge, Tooltip } from "@/components/ui/misc";
import { t } from "@/i18n";

/** setTimeout fires immediately for delays above 2^31-1 ms; later resets are rechecked after this. */
const MAX_TIMER_MS = 2_000_000_000;

/**
 * Account-wide plan limit, shown as long as it applies: close to the limit, or reached. `autoContinueAt`
 * of the shown session replaces the reset time, since that is when work goes on. The details open on
 * hover and also on click, so they can be read without holding the mouse still.
 */
export function RateLimitBadge({ autoContinueAt }: { autoContinueAt: string | null }) {
  const { data } = useRateLimit();
  const usage = useUsage();
  const [now, setNow] = useState(() => Date.now());
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const state = activeRateLimit(data, now, usage.data);
  const resetsAt = state?.resetsAt ?? null;

  // The badge has to go when the reset time passes, even if Claude Code reports nothing new.
  useEffect(() => {
    if (!resetsAt) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(MAX_TIMER_MS, Math.max(0, Date.parse(resetsAt) - Date.now()) + 1000));
    return () => clearTimeout(t);
  }, [resetsAt]);

  if (!state) return null;
  const reached = state.status === "reached";
  const goOn = reached ? (autoContinueAt ?? resetsAt) : resetsAt;
  const text = reached ? t.chat.rateLimit.reached(goOn ? limitTime(goOn, now) : null) : t.chat.rateLimit.nearly(resetsAt ? limitTime(resetsAt, now) : null);
  return (
    <span role="status">
      <Tooltip
        open={pinned || hovered}
        onOpenChange={setHovered}
        content={
          <div className="space-y-1 py-0.5">
            <div className="font-medium">
              {t.chat.rateLimit.title(limitLabel(state.limitType), reached, state.utilization)}
            </div>
            <div className="text-muted">
              {resetsAt ? t.chat.rateLimit.resets(relativeTime(resetsAt, now), limitDateTime(resetsAt)) : t.chat.rateLimit.noResetTime}
            </div>
            {reached && autoContinueAt && <div className="text-muted">{t.chat.rateLimit.autoContinue(limitDateTime(autoContinueAt))}</div>}
          </div>
        }
      >
        <button
          type="button"
          className="rounded"
          aria-expanded={pinned}
          onClick={() => setPinned((p) => !p)}
          onBlur={() => setPinned(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPinned(false);
          }}
        >
          <Badge tone={reached ? "danger" : "warning"}>
            <AlertTriangle className="h-3 w-3" /> {text}
          </Badge>
        </button>
      </Tooltip>
    </span>
  );
}
