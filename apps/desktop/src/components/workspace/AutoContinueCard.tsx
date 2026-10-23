import { AlertTriangle, CirclePlay, Timer, TimerOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useRpcMutation, useSession } from "@/lib/queries";
import { limitTime } from "@/lib/rate-limit";
import { Button } from "@/components/ui/button";
import type { AutoContinueItem } from "./chat-items";
import { EVENT_ICON as ICON, EventCard } from "./EventCard";
import { t } from "@/i18n";

/** What FORGE does after a usage limit: the planned continuation (cancellable), and what came of it. */
export function AutoContinueCard({ item, sessionId }: { item: AutoContinueItem; sessionId: string }) {
  const qc = useQueryClient();
  const { data: session } = useSession(sessionId);
  const cancel = useRpcMutation("sessions.cancelAutoContinue", {
    errorTitle: t.chat.autoContinue.cancelFailed,
    onSuccess: (s) => qc.setQueryData(keys.session(s.id), s),
  });
  const b = item.body;
  const pending = item.open && !!session?.autoContinueAt;
  const attempt = b.attempt && b.attempt > 1 ? t.chat.autoContinue.attempt(b.attempt) : "";

  if (b.state === "scheduled") {
    const at = (pending ? session?.autoContinueAt : null) ?? b.scheduledFor;
    const detail = b.resetKnown === false
      ? t.chat.autoContinue.resetUnknown
      : pending && at
        ? t.chat.autoContinue.continuesAt(limitTime(at), attempt)
        : at
          ? t.chat.autoContinue.wasPlannedFor(limitTime(at))
          : "";
    return (
      <EventCard
        icon={<Timer className={ICON} />}
        tone="danger"
        title={t.chat.autoContinue.limitReached}
        detail={detail}
        ts={item.ts}
        highlight
        action={
          pending ? (
            <Button size="sm" variant="outline" onClick={() => cancel.mutate({ sessionId })} loading={cancel.isPending}>
              <TimerOff className="h-3.5 w-3.5" /> {t.chat.autoContinue.dontContinue}
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (b.state === "resumed") {
    return <EventCard icon={<CirclePlay className={ICON} />} tone="success" title={t.chat.autoContinue.resumedAt(limitTime(item.ts))} detail={t.chat.autoContinue.limitReset(attempt)} ts={item.ts} />;
  }
  if (b.state === "cancelled") {
    return <EventCard icon={<TimerOff className={ICON} />} tone="info" title={t.chat.autoContinue.cancelled} detail={b.message ?? undefined} ts={item.ts} />;
  }
  return (
    <EventCard
      icon={<AlertTriangle className={ICON} />}
      tone={b.state === "failed" ? "danger" : "warning"}
      title={b.state === "failed" ? t.chat.autoContinue.failed : t.chat.autoContinue.ended}
      detail={b.message ?? undefined}
      ts={item.ts}
    />
  );
}
