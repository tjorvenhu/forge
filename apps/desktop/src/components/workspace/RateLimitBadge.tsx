import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useRateLimit } from "@/lib/queries";
import { activeRateLimit, limitDateTime, limitLabel, limitTime } from "@/lib/rate-limit";
import { Badge, Tooltip } from "@/components/ui/misc";

/** setTimeout fires immediately for delays above 2^31-1 ms; later resets are rechecked after this. */
const MAX_TIMER_MS = 2_000_000_000;

/**
 * Account-wide plan limit, shown as long as it applies: close to the limit, or reached. `autoContinueAt`
 * of the shown session replaces the reset time, since that is when work goes on.
 */
export function RateLimitBadge({ autoContinueAt }: { autoContinueAt: string | null }) {
  const { data } = useRateLimit();
  const [now, setNow] = useState(() => Date.now());
  const state = activeRateLimit(data, now);
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
  const text = reached ? `Limit erreicht${goOn ? ` · weiter um ${limitTime(goOn, now)}` : ""}` : `Limit fast erreicht${resetsAt ? ` · Reset ${limitTime(resetsAt, now)}` : ""}`;
  return (
    <Tooltip
      content={
        <div className="space-y-1 py-0.5">
          <div className="font-medium">
            {limitLabel(state.limitType)} {reached ? "erreicht" : "fast erreicht"}
            {state.utilization !== null ? ` (${state.utilization} % genutzt)` : ""}
          </div>
          {resetsAt && <div className="text-muted">Zurückgesetzt am {limitDateTime(resetsAt)}</div>}
          {reached && autoContinueAt && <div className="text-muted">FORGE macht diese Session am {limitDateTime(autoContinueAt)} automatisch weiter.</div>}
        </div>
      }
    >
      <span role="status" aria-label={text}>
        <Badge tone={reached ? "danger" : "warning"}>
          <AlertTriangle className="h-3 w-3" /> {text}
        </Badge>
      </span>
    </Tooltip>
  );
}
