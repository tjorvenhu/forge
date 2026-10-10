import { useMemo } from "react";
import { Activity, ShieldAlert, ShieldQuestion } from "lucide-react";
import { useSessionEvents } from "@/stores/session-events";
import { useUi } from "@/stores/ui";
import { relativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/ui/misc";
import { TOOL_LABELS, toolSummary } from "./chat-items";
import { toolIcon } from "./ToolCard";

/** Tool activity of the active session, newest first. Derived from real events only. */
export function ActivityFeed({ projectId, projectDir }: { projectId: string; projectDir: string }) {
  const sessionId = useUi((s) => s.activeSession[projectId] ?? null);
  const events = useSessionEvents((s) => (sessionId ? s.buffers[sessionId]?.events : undefined));
  const rows = useMemo(() => {
    const out: Array<{ key: string; icon: React.ReactNode; title: string; detail: string; ts: string; tone?: string }> = [];
    for (const e of events ?? []) {
      const b = e.body;
      if (b.type === "tool.use") out.push({ key: `t${e.seq}`, icon: toolIcon(b.name), title: TOOL_LABELS[b.name] ?? b.name, detail: toolSummary(b.name, b.input, projectDir), ts: e.ts });
      else if (b.type === "approval.request")
        out.push({ key: `a${e.seq}`, icon: <ShieldQuestion className="h-3.5 w-3.5" />, title: "Freigabe angefragt", detail: b.toolName, ts: e.ts, tone: "text-warning" });
      else if (b.type === "policy.blocked")
        out.push({ key: `b${e.seq}`, icon: <ShieldAlert className="h-3.5 w-3.5" />, title: "Von Policy blockiert", detail: b.message, ts: e.ts, tone: "text-danger" });
    }
    return out.reverse().slice(0, 200);
  }, [events, projectDir]);

  if (!sessionId || !rows.length)
    return (
      <EmptyState icon={<Activity className="h-8 w-8" />} title="Noch keine Aktivität">
        Tool-Aufrufe der aktiven Session erscheinen hier.
      </EmptyState>
    );
  return (
    <ul className="h-full divide-y divide-border overflow-y-auto">
      {rows.map((r) => (
        <li key={r.key} className="flex items-start gap-2.5 px-3 py-2">
          <span className={r.tone ?? "text-muted"}>{r.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px]">{r.title}</div>
            <div className="truncate font-mono text-[11px] text-subtle" title={r.detail}>
              {r.detail}
            </div>
          </div>
          <span className="shrink-0 text-[11px] text-subtle">{relativeTime(r.ts)}</span>
        </li>
      ))}
    </ul>
  );
}
