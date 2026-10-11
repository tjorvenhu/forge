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

/** Status line at the bottom of the side panel while the active session runs: phrase, last tool, time, stop. */
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
  const stopping = session.status === "stopping";
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border pl-3.5 pr-2 text-small">
      <span className="flex shrink-0 motion-safe:animate-spin-slow">
        <ClaudeMark size={13} />
      </span>
      <span className="shrink-0 font-medium text-claude">{stopping ? "Claude stoppt …" : `${pickPhrase(startedAt, elapsed)} …`}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-caption-lg text-muted" title={lastTool ?? undefined}>
        {lastTool}
      </span>
      <span className="shrink-0 text-caption tabular-nums text-subtle">{formatElapsed(elapsed)}</span>
      <Button size="icon-sm" variant="ghost" aria-label="Stoppen" title="Stoppen (Esc im Eingabefeld)" disabled={stopping} onClick={() => void stopSession(session.id)}>
        <Square className="h-3 w-3 fill-current" />
      </Button>
    </div>
  );
}
