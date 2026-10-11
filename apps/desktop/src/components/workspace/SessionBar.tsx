import { useState } from "react";
import { ChevronDown, History, Hourglass, MessageSquarePlus, Power, ShieldAlert, Terminal, Trash2 } from "lucide-react";
import type { ExternalSession, Project, Session } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { EXTERNAL_PREFIX } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, Tooltip } from "@/components/ui/misc";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { SummaryButton } from "./SummaryButton";
import { DeleteSessionDialog } from "./DeleteSessionDialog";

/** Header of the chat: session picker, status, and actions for the shown session. */
export function SessionBar({
  project,
  session,
  external,
  sessions,
  externals,
  onSelect,
}: {
  project: Project;
  session: Session | null;
  external: ExternalSession | null;
  sessions: Session[];
  externals: ExternalSession[];
  onSelect: (id: string | null) => void;
}) {
  const title = session?.title ?? (external ? external.summary : "Neue Session");
  // Captured when the dialog opens: the shown session may change behind it (Strg+Tab, a notification).
  const [deleting, setDeleting] = useState<Session | null>(null);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      <DropdownMenu
        align="start"
        header={sessions.length || externals.length ? "Sessions in diesem Projekt" : "Noch keine Sessions"}
        trigger={
          <button className="flex min-w-0 max-w-105 items-center gap-1.5 rounded-md px-2 py-1 text-body hover:bg-surface-3" aria-label="Session wählen">
            <History className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="truncate">{title}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
          </button>
        }
        items={[
          { label: "Neue Session", icon: <MessageSquarePlus className="h-3.5 w-3.5" />, onSelect: () => onSelect(null), hint: "Strg+N" },
          ...sessions.slice(0, 30).map((s) => ({
            label: s.title ?? "Ohne Titel",
            hint: relativeTime(s.updatedAt),
            icon: <span className={cn("h-1.5 w-1.5 rounded-full", s.live ? "bg-accent" : "bg-subtle")} />,
            onSelect: () => onSelect(s.id),
          })),
          ...externals.slice(0, 15).map((e) => ({
            label: e.summary,
            hint: "Terminal",
            icon: <Terminal className="h-3.5 w-3.5 text-muted" />,
            onSelect: () => onSelect(EXTERNAL_PREFIX + e.claudeSessionId),
          })),
        ]}
      />
      {session && <SessionStatusBadge status={session.status} live={session.live} />}
      {!!session?.background.length && (
        <Tooltip content={session.background.map((t) => t.description).join(", ")}>
          <span>
            <Badge tone="accent">
              <Hourglass className="h-3 w-3" /> {session.background.length} im Hintergrund
            </Badge>
          </span>
        </Tooltip>
      )}
      {session?.permissionMode === "plan" && <Badge tone="accent">Nur planen</Badge>}
      {session?.permissionMode === "bypassPermissions" && (
        <Badge tone="danger">
          <ShieldAlert className="h-3 w-3" /> Bypass
        </Badge>
      )}
      <div className="flex-1" />
      {session?.apiKeySource && session.apiKeySource !== "none" && (
        <Badge tone="warning" className="max-w-56 truncate">
          Auth: {session.apiKeySource}
        </Badge>
      )}
      {session && session.cwd !== project.path && (
        <Badge tone="warning" className="max-w-64 truncate">
          cwd: {session.cwd}
        </Badge>
      )}
      {session && <SummaryButton sessionId={session.id} title={session.title} size="icon-sm" />}
      {session?.live && (session.status === "idle" || session.status === "error") && (
        <Button
          size="sm"
          variant="ghost"
          title={
            session.background.length
              ? "Claude-Prozess beenden. Bricht auch die Aufgaben im Hintergrund ab. Die Session bleibt fortsetzbar."
              : "Claude-Prozess dieser Session beenden. Sie bleibt fortsetzbar."
          }
          onClick={() => call("sessions.close", { sessionId: session.id }).catch((e: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(e)))}
        >
          <Power className="h-3.5 w-3.5" /> Beenden
        </Button>
      )}
      {session && (
        <Tooltip content="Session löschen">
          <Button size="icon-sm" variant="ghost" aria-label="Session löschen" className="hover:text-danger" onClick={() => setDeleting(session)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      )}
      <Button size="sm" variant="ghost" onClick={() => onSelect(null)} title="Neue Session (Strg+N)">
        <MessageSquarePlus className="h-3.5 w-3.5" /> Neu
      </Button>
      <DeleteSessionDialog session={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}
