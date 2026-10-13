import { useState } from "react";
import { ChevronDown, Columns2, History, Hourglass, Maximize2, MessageSquarePlus, Power, ShieldAlert, SquareArrowOutDownLeft, SquareArrowOutUpRight, Terminal, Trash2, X } from "lucide-react";
import type { ExternalSession, Project, Session } from "@forge/protocol";
import { openChatWindow, reattachChatWindow } from "@/lib/chat-windows";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { EXTERNAL_PREFIX, useUi, type SplitPane } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, Tooltip } from "@/components/ui/misc";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { SummaryButton } from "./SummaryButton";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { useSplitLayout } from "./chat-slot";

/** Header of the chat: session picker, status, and actions for the shown session. */
export function SessionBar({
  project,
  session,
  external,
  sessions,
  externals,
  onSelect,
  detached = false,
  inChatWindow = false,
  pane,
  shownElsewhere,
}: {
  project: Project;
  session: Session | null;
  external: ExternalSession | null;
  sessions: Session[];
  externals: ExternalSession[];
  onSelect: (id: string | null) => void;
  /** the bar of a chat window: project and title instead of the session picker */
  detached?: boolean;
  /** the session is shown in a chat window (bar of the main window) */
  inChatWindow?: boolean;
  /** the bar of a further chat of the split view */
  pane?: SplitPane;
  /** sessions another chat of the split view shows; not offered in the picker */
  shownElsewhere?: ReadonlySet<string>;
}) {
  const title = session?.title ?? (external ? external.summary : "Neue Session");
  // Captured when the dialog opens: the shown session may change behind it (Strg+Tab, a notification).
  const [deleting, setDeleting] = useState<Session | null>(null);
  const split = useSplitLayout();
  // Several chats side by side: buttons without labels, so the title keeps some room.
  const compact = !!pane || (split?.shown ?? 1) > 1;
  const taken = (id: string) => shownElsewhere?.has(id) ?? false;
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      {detached ? (
        <div className="flex min-w-0 items-center gap-2 text-body">
          <ProjectIcon id={project.parentId ?? project.id} name={project.name} size={20} className="rounded-md" />
          <span className="max-w-40 shrink-0 truncate text-muted">{project.name}</span>
          <span className="truncate">{title}</span>
        </div>
      ) : (
        <>
        {pane && (
          <span title={project.name} className="shrink-0">
            <ProjectIcon id={project.parentId ?? project.id} name={project.name} size={20} className="rounded-md" />
          </span>
        )}
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
            { label: "Neue Session", icon: <MessageSquarePlus className="h-3.5 w-3.5" />, onSelect: () => onSelect(null), hint: pane ? undefined : "Strg+N" },
            ...sessions.slice(0, 30).map((s) => ({
              label: s.title ?? "Ohne Titel",
              hint: taken(s.id) ? "daneben offen" : relativeTime(s.updatedAt),
              disabled: taken(s.id),
              icon: <span className={cn("h-1.5 w-1.5 rounded-full", s.live ? "bg-accent" : "bg-subtle")} />,
              onSelect: () => onSelect(s.id),
            })),
            ...externals.slice(0, 15).map((e) => ({
              label: e.summary,
              hint: taken(EXTERNAL_PREFIX + e.claudeSessionId) ? "daneben offen" : "Terminal",
              disabled: taken(EXTERNAL_PREFIX + e.claudeSessionId),
              icon: <Terminal className="h-3.5 w-3.5 text-muted" />,
              onSelect: () => onSelect(EXTERNAL_PREFIX + e.claudeSessionId),
            })),
          ]}
        />
        </>
      )}
      {session && <SessionStatusBadge status={session.status} live={session.live} autoContinueAt={session.autoContinueAt} />}
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
          size={compact ? "icon-sm" : "sm"}
          variant="ghost"
          aria-label="Beenden"
          title={
            session.background.length
              ? "Claude-Prozess beenden. Bricht auch die Aufgaben im Hintergrund ab. Die Session bleibt fortsetzbar."
              : "Claude-Prozess dieser Session beenden. Sie bleibt fortsetzbar."
          }
          onClick={() => call("sessions.close", { sessionId: session.id }).catch((e: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(e)))}
        >
          <Power className="h-3.5 w-3.5" />
          {!compact && " Beenden"}
        </Button>
      )}
      {detached ? (
        <Button size="sm" variant="ghost" onClick={() => void reattachChatWindow()} title="Ins Hauptfenster zurückholen. Schließt dieses Fenster.">
          <SquareArrowOutDownLeft className="h-3.5 w-3.5" /> Zurückholen
        </Button>
      ) : (
        <>
          {session && !inChatWindow && (
            <Tooltip content="In eigenem Fenster öffnen">
              <Button size="icon-sm" variant="ghost" aria-label="In eigenem Fenster öffnen" onClick={() => void openChatWindow(project.id, session.id, session.title)}>
                <SquareArrowOutUpRight className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          {session && (
            <Tooltip content="Session löschen">
              <Button size="icon-sm" variant="ghost" aria-label="Session löschen" className="hover:text-danger" onClick={() => setDeleting(session)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          <Button size={compact ? "icon-sm" : "sm"} variant="ghost" aria-label="Neue Session" onClick={() => onSelect(null)} title={pane ? "Neue Session in diesem Bereich" : "Neue Session (Strg+N)"}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {!compact && " Neu"}
          </Button>
          {pane ? <PaneActions pane={pane} /> : split && <AddPaneButton shown={split.shown} capacity={split.capacity} />}
          <DeleteSessionDialog session={deleting} onClose={() => setDeleting(null)} />
        </>
      )}
    </div>
  );
}

/** Opens a further chat next to the others, as long as the area has room for it. */
function AddPaneButton({ shown, capacity }: { shown: number; capacity: number }) {
  const add = useUi((s) => s.addSplitPane);
  const full = shown >= capacity;
  const hint = !full
    ? `Weiteren Chat daneben öffnen\n${shown} von ${capacity} Plätzen belegt. Wie viele passen, hängt von der Fenstergröße ab.`
    : capacity > 1
      ? `Kein Platz für einen weiteren Chat\nIn das Fenster passen gerade ${capacity}.`
      : "Kein Platz für einen zweiten Chat\nVergrößere das Fenster oder blende Seitenleiste und untere Leiste aus.";
  return (
    <Tooltip content={<span className="whitespace-pre-line">{hint}</span>}>
      <span>
        <Button size="icon-sm" variant="ghost" aria-label="Chat daneben öffnen" disabled={full} onClick={() => add()}>
          <Columns2 className="h-3.5 w-3.5" />
        </Button>
      </span>
    </Tooltip>
  );
}

/** Swap with the main chat, or close the pane; the session itself keeps running. */
function PaneActions({ pane }: { pane: SplitPane }) {
  const promote = useUi((s) => s.promoteSplitPane);
  const close = useUi((s) => s.closeSplitPane);
  return (
    <>
      <Tooltip content="Zum Hauptchat machen. Kopfzeile, Seitenleiste und Reiter gehören dann zu dieser Session.">
        <Button size="icon-sm" variant="ghost" aria-label="Zum Hauptchat machen" onClick={() => promote(pane.id)}>
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Bereich schließen. Die Session läuft weiter.">
        <Button size="icon-sm" variant="ghost" aria-label="Bereich schließen" onClick={() => close(pane.id)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    </>
  );
}
