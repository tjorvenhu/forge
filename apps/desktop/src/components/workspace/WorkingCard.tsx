import { useEffect, useMemo, useState } from "react";
import { Square } from "lucide-react";
import type { Project } from "@forge/protocol";
import { useSession } from "@/lib/queries";
import { isWorking } from "@/lib/working";
import { useSessionEvents } from "@/stores/session-events";
import { splitActive, useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ClaudeMark } from "./ClaudeMark";
import { TOOL_LABELS, toolSummary } from "./chat-items";
import { formatElapsed, pickPhrase, turnStartedAt } from "./working";
import { stopSession } from "./useSendMessage";

/** "Claude arbeitet" at the bottom of the side panel while the active session runs, with stop. */
export function WorkingCard({ project }: { project: Project }) {
  const sessionId = useUi((s) => s.activeSession[project.id] ?? null);
  const session = useSession(splitActive(sessionId).sessionId).data;
  const events = useSessionEvents((s) => (sessionId ? s.buffers[sessionId]?.events : undefined));
  const working = isWorking(session?.status);
  const startedAt = useMemo(() => (working ? (turnStartedAt(events ?? []) ?? session?.updatedAt ?? null) : null), [working, events, session?.updatedAt]);
  const lastTool = useMemo(() => {
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
      const b = events![i]!.body;
      if (b.type === "user.message") return null;
      if (b.type === "tool.use") return `${TOOL_LABELS[b.name] ?? b.name}: ${toolSummary(b.name, b.input, project.path)}`;
    }
    return null;
  }, [events, project.path]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  if (!session || !working || !startedAt) return null;
  const elapsed = now - new Date(startedAt).getTime();
  return (
    <div className="m-3 rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-claude-soft">
          <ClaudeMark size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium">{session.status === "stopping" ? "Claude stoppt …" : "Claude arbeitet"}</div>
          <div className="truncate text-small text-muted" title={lastTool ?? undefined}>
            {lastTool ?? `${pickPhrase(startedAt, elapsed)} …`}
          </div>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Stoppen"
          title="Stoppen (Esc im Eingabefeld)"
          disabled={session.status === "stopping"}
          onClick={() => void stopSession(session.id)}
        >
          <Square className="h-3 w-3 fill-current" />
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
          <div className="animate-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-accent" />
        </div>
        <span className="text-caption tabular-nums text-subtle">{formatElapsed(elapsed)}</span>
      </div>
    </div>
  );
}
