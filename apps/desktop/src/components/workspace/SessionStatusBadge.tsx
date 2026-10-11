import type { SessionStatus } from "@forge/protocol";
import { Badge } from "@/components/ui/misc";

const MAP: Record<SessionStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  starting: { label: "Startet", tone: "accent" },
  running: { label: "Arbeitet", tone: "accent" },
  idle: { label: "Bereit", tone: "success" },
  waiting_approval: { label: "Freigabe nötig", tone: "warning" },
  stopping: { label: "Stoppt", tone: "warning" },
  stopped: { label: "Beendet", tone: "neutral" },
  error: { label: "Fehler", tone: "danger" },
  interrupted: { label: "Unterbrochen", tone: "neutral" },
};

/** An idle session without a live process can still be resumed but isn't "ready" right now. */
const paused = (status: SessionStatus, live?: boolean) => status === "idle" && live === false;

/** A session that stopped at the usage limit and continues on its own once it resets. */
const waitingForLimit = (status: SessionStatus, autoContinueAt?: string | null): autoContinueAt is string =>
  !!autoContinueAt && status !== "running" && status !== "starting" && status !== "waiting_approval";

export function sessionStatusLabel(status: SessionStatus, live?: boolean, autoContinueAt?: string | null): string {
  if (waitingForLimit(status, autoContinueAt)) {
    return `Weiter um ${new Date(autoContinueAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return paused(status, live) ? "Pausiert" : MAP[status].label;
}

export function SessionStatusBadge({ status, live, autoContinueAt }: { status: SessionStatus; live?: boolean; autoContinueAt?: string | null }) {
  const label = sessionStatusLabel(status, live, autoContinueAt);
  return (
    <Badge tone={waitingForLimit(status, autoContinueAt) ? "warning" : paused(status, live) ? "neutral" : MAP[status].tone}>
      {(status === "running" || status === "starting") && <span className="animate-soft-pulse h-1.5 w-1.5 rounded-full bg-accent" />}
      {label}
    </Badge>
  );
}
