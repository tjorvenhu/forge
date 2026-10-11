import { useRef, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import type { SessionStatus } from "@forge/protocol";
import { call, useLiveSessions } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { isBusy } from "@/lib/working";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";

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
  const listRef = useRef<HTMLDivElement>(null);
  const sessions = sortTabs(live.data ?? []);
  if (sessions.length < 2) return null;

  const activeIndex = sessions.findIndex((s) => s.projectId === projectId && s.id === activeSession);
  // Roving tabindex: one tab in the tab order, arrow keys move between tabs.
  const focusIndex = activeIndex < 0 ? 0 : activeIndex;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const s = sessions[i]!;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openProject(s.projectId, s.id);
      return;
    }
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? sessions.length - 1 : step ? (i + step + sessions.length) % sessions.length : -1;
    if (target < 0) return;
    e.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };

  return (
    <div ref={listRef} className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-sidebar px-2" role="tablist" aria-label="Aktive Sessions">
      {sessions.map((s, i) => {
        const active = i === activeIndex;
        const busy = isBusy(s.status) || s.background.length > 0;
        const title = s.title ?? "Ohne Titel";
        return (
          <div
            key={s.id}
            className={cn(
              "group flex h-8 min-w-0 max-w-60 shrink-0 items-center rounded-t-md border border-b-0 pr-1 text-xs",
              active ? "border-border bg-bg text-fg" : "border-transparent text-muted hover:bg-surface-3 hover:text-fg",
            )}
          >
            <button
              role="tab"
              aria-selected={active}
              tabIndex={i === focusIndex ? 0 : -1}
              onClick={() => openProject(s.projectId, s.id)}
              onKeyDown={(e) => onTabKey(e, i)}
              title={`${s.projectName}: ${title} (${STATUS_LABEL[s.status] ?? s.status}${s.background.length ? `, ${s.background.length} im Hintergrund` : ""}). Strg+Tab wechselt zur nächsten Session.`}
              className="flex h-full min-w-0 cursor-default select-none items-center gap-2 pl-2.5 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  s.status === "waiting_approval" ? "bg-warning" : s.status === "error" ? "bg-danger" : busy ? "animate-soft-pulse bg-accent" : "bg-subtle",
                )}
              />
              {s.projectId !== projectId && <span className="shrink-0 text-subtle">{s.projectName}:</span>}
              <span className="truncate">{title}</span>
            </button>
            {!busy && (
              <Button
                size="icon-sm"
                variant="ghost"
                className="h-5 w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`Claude-Prozess von ${title} beenden`}
                title="Beenden. Die Session bleibt fortsetzbar."
                onClick={() => call("sessions.close", { sessionId: s.id }).catch((err: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(err)))}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
