import { AlertTriangle, CirclePlay, Timer, TimerOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useRpcMutation, useSession } from "@/lib/queries";
import { limitTime } from "@/lib/rate-limit";
import { Button } from "@/components/ui/button";
import type { AutoContinueItem } from "./chat-items";
import { EventCard } from "./EventCard";

const ICON = "h-4.5 w-4.5";

/** What FORGE does after a usage limit: the planned continuation (cancellable), and what came of it. */
export function AutoContinueCard({ item, sessionId }: { item: AutoContinueItem; sessionId: string }) {
  const qc = useQueryClient();
  const { data: session } = useSession(sessionId);
  const cancel = useRpcMutation("sessions.cancelAutoContinue", {
    errorTitle: "Abbrechen fehlgeschlagen",
    onSuccess: (s) => qc.setQueryData(keys.session(s.id), s),
  });
  const b = item.body;
  const pending = item.open && !!session?.autoContinueAt;
  const attempt = b.attempt && b.attempt > 1 ? ` (${b.attempt}. automatischer Versuch)` : "";

  if (b.state === "scheduled") {
    const at = (pending ? session?.autoContinueAt : null) ?? b.scheduledFor;
    const detail = b.resetKnown === false
      ? "Zeitpunkt des Resets unbekannt. FORGE prüft alle 15 Minuten und macht danach automatisch weiter."
      : pending && at
        ? `FORGE macht um ${limitTime(at)} automatisch weiter.${attempt}`
        : at
          ? `Automatisches Weitermachen war für ${limitTime(at)} geplant.`
          : "";
    return (
      <EventCard
        icon={<Timer className={ICON} />}
        tone="warning"
        title="Nutzungslimit erreicht"
        detail={detail}
        ts={item.ts}
        action={
          pending ? (
            <Button size="sm" variant="outline" onClick={() => cancel.mutate({ sessionId })} loading={cancel.isPending}>
              <TimerOff className="h-3.5 w-3.5" /> Nicht automatisch weitermachen
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (b.state === "resumed") {
    return <EventCard icon={<CirclePlay className={ICON} />} tone="success" title={`Automatisch fortgesetzt um ${limitTime(item.ts)}`} detail={`Das Nutzungslimit ist zurückgesetzt.${attempt}`} ts={item.ts} />;
  }
  if (b.state === "cancelled") {
    return <EventCard icon={<TimerOff className={ICON} />} tone="info" title="Kein automatisches Weitermachen" detail={b.message ?? undefined} ts={item.ts} />;
  }
  return (
    <EventCard
      icon={<AlertTriangle className={ICON} />}
      tone={b.state === "failed" ? "danger" : "warning"}
      title={b.state === "failed" ? "Automatisches Weitermachen fehlgeschlagen" : "Automatisches Weitermachen beendet"}
      detail={b.message ?? undefined}
      ts={item.ts}
    />
  );
}
