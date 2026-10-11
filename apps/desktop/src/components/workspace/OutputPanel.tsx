import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { useSessionEvents } from "@/stores/session-events";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import type { SessionEvent } from "@forge/protocol";

const NO_EVENTS: SessionEvent[] = [];

/** Raw, persisted event log of the active session (the "Claude-Ausgabe" panel). */
export function OutputPanel({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) {
  const sessionId = useUi((s) => s.activeSession[projectId] ?? null);
  const toggle = useUi((s) => s.toggleBottomPanel);
  const events = useSessionEvents((s) => (sessionId ? s.buffers[sessionId]?.events : undefined)) ?? NO_EVENTS;
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
      {!sessionId ? (
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
