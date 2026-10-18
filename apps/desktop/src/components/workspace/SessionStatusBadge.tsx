import type { SessionStatus } from "@forge/protocol";
import { Badge } from "@/components/ui/misc";
import { locale, t } from "@/i18n";

const MAP: Record<SessionStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  starting: { label: t.chat.status.starting, tone: "accent" },
  running: { label: t.chat.status.running, tone: "accent" },
  idle: { label: t.chat.status.idle, tone: "success" },
  waiting_approval: { label: t.chat.status.waitingApproval, tone: "warning" },
  stopping: { label: t.chat.status.stopping, tone: "warning" },
  stopped: { label: t.chat.status.stopped, tone: "neutral" },
  error: { label: t.chat.status.error, tone: "danger" },
  interrupted: { label: t.chat.status.interrupted, tone: "neutral" },
};

/** An idle session without a live process can still be resumed but isn't "ready" right now. */
const paused = (status: SessionStatus, live?: boolean) => status === "idle" && live === false;

/** A session that stopped at the usage limit and continues on its own once it resets. */
const waitingForLimit = (status: SessionStatus, autoContinueAt?: string | null): autoContinueAt is string =>
  !!autoContinueAt && status !== "running" && status !== "starting" && status !== "waiting_approval";

export function sessionStatusLabel(status: SessionStatus, live?: boolean, autoContinueAt?: string | null): string {
  if (waitingForLimit(status, autoContinueAt)) {
    return t.chat.status.continuesAt(new Date(autoContinueAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
  }
  return paused(status, live) ? t.chat.status.paused : MAP[status].label;
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
