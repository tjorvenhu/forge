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

export function SessionStatusBadge({ status, live }: { status: SessionStatus; live?: boolean }) {
  const m = MAP[status];
  // An idle session without a live process can still be resumed but isn't "ready" right now.
  const label = status === "idle" && live === false ? "Pausiert" : m.label;
  return (
    <Badge tone={status === "idle" && live === false ? "neutral" : m.tone}>
      {(status === "running" || status === "starting") && <span className="animate-soft-pulse h-1.5 w-1.5 rounded-full bg-accent" />}
      {label}
    </Badge>
  );
}
