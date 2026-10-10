import { X } from "lucide-react";
import type { SessionStatus } from "@forge/protocol";
import { call, useLiveSessions } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";

const BUSY: SessionStatus[] = ["starting", "running", "stopping", "waiting_approval"];

const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  starting: "startet",
  running: "arbeitet",
  stopping: "stoppt",
  waiting_approval: "wartet auf Freigabe",
  idle: "bereit",
  error: "Fehler",
};

/** Stable tab order: oldest first, so tabs do not jump around while sessions update. */
export function sortTabs<T extends { createdAt: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Quick switch between sessions that have a running Claude process. Shown from two sessions on. */
export function SessionTabs({ projectId }: { projectId: string }) {
  const live = useLiveSessions();
  const activeSession = useUi((s) => s.activeSession[projectId] ?? null);
  const openProject = useUi((s) => s.openProject);
  const sessions = sortTabs(live.data ?? []);
  if (sessions.length < 2) return null;

  return (
    <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-sidebar px-2" role="tablist" aria-label="Aktive Sessions">
      {sessions.map((s) => {
        const active = s.projectId === projectId && s.id === activeSession;
        const busy = BUSY.includes(s.status);
        return (
          <div
            key={s.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => openProject(s.projectId, s.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openProject(s.projectId, s.id)}
            title={`${s.projectName}: ${s.title ?? "Ohne Titel"} (${STATUS_LABEL[s.status] ?? s.status}). Strg+Tab wechselt zur nächsten Session.`}
            className={cn(
              "group flex h-8 min-w-0 max-w-60 shrink-0 cursor-default select-none items-center gap-2 rounded-t-md border border-b-0 px-2.5 text-xs",
              active ? "border-border bg-bg text-fg" : "border-transparent text-muted hover:bg-surface-3 hover:text-fg",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                s.status === "waiting_approval" ? "bg-warning" : s.status === "error" ? "bg-danger" : busy ? "animate-soft-pulse bg-accent" : "bg-subtle",
              )}
            />
            {s.projectId !== projectId && <span className="shrink-0 text-subtle">{s.projectName}:</span>}
            <span className="truncate">{s.title ?? "Ohne Titel"}</span>
            {!busy && (
              <button
                className="-mr-1 rounded p-0.5 text-subtle opacity-0 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                aria-label="Claude-Prozess dieser Session beenden"
                title="Beenden. Die Session bleibt fortsetzbar."
                onClick={(e) => {
                  e.stopPropagation();
                  call("sessions.close", { sessionId: s.id }).catch((err: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(err)));
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
