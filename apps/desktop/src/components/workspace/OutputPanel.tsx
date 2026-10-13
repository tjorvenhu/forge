import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { useSessionHistory, useSessions } from "@/lib/queries";
import { splitActive, useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import type { SessionEvent } from "@forge/protocol";

const NO_EVENTS: SessionEvent[] = [];

/** Raw, persisted event log of the active session (the "Claude-Ausgabe" panel). */
export function OutputPanel({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) {
  const active = useUi((s) => s.activeSession[projectId] ?? null);
  // Until the session list is there, the chat has not picked the project's last session yet.
  const sessionsLoading = useSessions(projectId).isLoading;
  const picking = useUi((s) => !(projectId in s.activeSession)) && sessionsLoading;
  const toggle = useUi((s) => s.toggleBottomPanel);
  // The panel is open on every tab, also when no chat has loaded this history yet.
  const { sessionId } = splitActive(active);
  const { buffer, error } = useSessionHistory(sessionId);
  const events = buffer?.events ?? NO_EVENTS;
  const loading = picking || (!!sessionId && !buffer?.loaded && !error);
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: events.length, getScrollElement: () => scrollRef.current, estimateSize: () => 18, overscan: 20 });

  return (
    <div className={embedded ? "flex h-full flex-col" : "flex h-56 shrink-0 flex-col border-t border-border bg-bg"}>
      <div className={embedded ? "hidden" : "flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs"}>
        <span className="font-medium">Claude-Ausgabe</span>
        <span className="text-subtle">{events.length} Events</span>
        <div className="flex-1" />
        <button onClick={() => toggle(false)} className="rounded p-0.5 text-subtle hover:text-fg" aria-label="Panel schließen">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {loading ? (
        <SkeletonRegion label="Lädt Ausgabe" className="min-h-0 flex-1 overflow-hidden">
          {[60, 35, 75, 45, 55, 30, 68, 40].map((w, i) => (
            <div key={i} className="flex h-4.5 items-center gap-3 px-3">
              <Skeleton className="h-2.5 w-12 shrink-0 rounded-sm" />
              <Skeleton className="h-2.5 w-6 shrink-0 rounded-sm" />
              <Skeleton className="h-2.5 w-24 shrink-0 rounded-sm" />
              <Skeleton className="h-2.5 rounded-sm" style={{ width: `${w}%` }} />
            </div>
          ))}
        </SkeletonRegion>
      ) : !active ? (
        <div className="p-3 text-xs text-subtle">Keine Session ausgewählt.</div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto font-mono text-caption leading-4.5">
          <div className="relative" style={{ height: v.getTotalSize() }}>
            {v.getVirtualItems().map((row) => {
              const e = events[row.index]!;
              const { type, ...rest } = e.body;
              return (
                <div key={row.index} className="absolute left-0 right-0 flex gap-3 whitespace-nowrap px-3" style={{ transform: `translateY(${row.start}px)`, height: 18 }}>
                  <span className="text-subtle">{new Date(e.ts).toLocaleTimeString("de-DE")}</span>
                  <span className="w-6 text-right text-subtle">{e.seq}</span>
                  <span className={cn("w-32 shrink-0", type === "error" || type === "policy.blocked" ? "text-danger" : type.startsWith("approval") ? "text-warning" : "text-accent")}>
                    {type}
                  </span>
                  <span className="truncate text-muted">{JSON.stringify(rest).slice(0, 400)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
