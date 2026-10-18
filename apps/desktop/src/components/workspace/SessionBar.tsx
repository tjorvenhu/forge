import { useState } from "react";
import { ChevronDown, History, Hourglass, MessageSquarePlus, Pin, PinOff, Power, ShieldAlert, SquareArrowOutDownLeft, SquareArrowOutUpRight, Terminal, Trash2 } from "lucide-react";
import type { ExternalSession, Project, Session } from "@forge/protocol";
import { openChatWindow, reattachChatWindow } from "@/lib/chat-windows";
import { contextItems } from "@/lib/context-menu";
import { setChatWindowPin, useChatWindowPin } from "@/lib/window-options";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { EXTERNAL_PREFIX, type SplitPane } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, Tooltip } from "@/components/ui/misc";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { ChatWindowPinButton } from "@/components/layout/AlwaysOnTopButton";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { SummaryButton } from "./SummaryButton";
import { ChatViewToggle } from "./chat-view";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { useSplitLayout } from "./chat-slot";
import { t } from "@/i18n";

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
  /** the bar of the chat of a further area of the split view */
  pane?: SplitPane;
  /** sessions another chat of the split view shows; not offered in the picker */
  shownElsewhere?: ReadonlySet<string>;
}) {
  const m = t.workspace.sessionBar;
  const title = session?.title ?? (external ? external.summary : m.newSession);
  // Captured when the dialog opens: the shown session may change behind it (Strg+Tab, a notification).
  const [deleting, setDeleting] = useState<Session | null>(null);
  const split = useSplitLayout();
  // Several chats side by side: buttons without labels, so the title keeps some room.
  const compact = !!pane || (split?.shown ?? 1) > 1;
  const taken = (id: string) => shownElsewhere?.has(id) ?? false;
  // A chat window offers its own actions on a right click of its bar.
  const windowItems = contextItems(() => {
    const pinned = useChatWindowPin.getState().on;
    return [
      ...(pinned === null
        ? []
        : [
            pinned
              ? { label: m.unpin, icon: <PinOff className="h-3.5 w-3.5" />, onSelect: () => void setChatWindowPin(false) }
              : { label: m.pin, icon: <Pin className="h-3.5 w-3.5" />, onSelect: () => void setChatWindowPin(true) },
          ]),
      { label: m.recallToMain, icon: <SquareArrowOutDownLeft className="h-3.5 w-3.5" />, onSelect: () => void reattachChatWindow() },
    ];
  });
  return (
    <div className="@container/sessionbar flex h-11 shrink-0 items-center gap-2 border-b border-border px-4" onContextMenu={detached ? windowItems : undefined}>
      {detached ? (
        // Shrinks before the badges next to it; the title gives way first, then the project name.
        <div className="flex min-w-8 items-center gap-2 overflow-hidden text-body" title={`${project.name} · ${title}`}>
          <ProjectIcon id={project.parentId ?? project.id} name={project.name} size={20} className="shrink-0 rounded-md" />
          <span className="min-w-0 max-w-40 truncate text-muted">{project.name}</span>
          <span className="min-w-0 shrink-[4] truncate">{title}</span>
        </div>
      ) : (
        <DropdownMenu
          align="start"
          header={sessions.length || externals.length ? m.sessionsHeader : m.noSessions}
          trigger={
            <button className="flex min-w-0 max-w-105 items-center gap-1.5 rounded-md px-2 py-1 text-body hover:bg-surface-3" aria-label={m.pickSession}>
              <History className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">{title}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
            </button>
          }
          items={[
            { label: m.newSession, icon: <MessageSquarePlus className="h-3.5 w-3.5" />, onSelect: () => onSelect(null), hint: pane ? undefined : m.newSessionShortcut },
            ...sessions.slice(0, 30).map((s) => ({
              label: s.title ?? m.untitled,
              hint: taken(s.id) ? m.openBeside : relativeTime(s.updatedAt),
              disabled: taken(s.id),
              icon: <span className={cn("h-1.5 w-1.5 rounded-full", s.live ? "bg-accent" : "bg-subtle")} />,
              onSelect: () => onSelect(s.id),
            })),
            ...externals.slice(0, 15).map((e) => ({
              label: e.summary,
              hint: taken(EXTERNAL_PREFIX + e.claudeSessionId) ? m.openBeside : m.terminal,
              disabled: taken(EXTERNAL_PREFIX + e.claudeSessionId),
              icon: <Terminal className="h-3.5 w-3.5 text-muted" />,
              onSelect: () => onSelect(EXTERNAL_PREFIX + e.claudeSessionId),
            })),
          ]}
        />
      )}
      {session && <SessionStatusBadge status={session.status} live={session.live} autoContinueAt={session.autoContinueAt} />}
      {!!session?.background.length && (
        <Tooltip content={session.background.map((t) => t.description).join(", ")}>
          <span>
            <Badge tone="accent">
              <Hourglass className="h-3 w-3" /> {m.background(session.background.length)}
            </Badge>
          </span>
        </Tooltip>
      )}
      {session?.permissionMode === "plan" && <Badge tone="accent">{m.planOnly}</Badge>}
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
      {session && <ChatViewToggle sessionId={session.id} compact={compact} />}
      {session && <SummaryButton sessionId={session.id} title={session.title} size="icon-sm" />}
      {session?.live && (session.status === "idle" || session.status === "error") && (
        <Button
          size={compact ? "icon-sm" : "sm"}
          variant="ghost"
          aria-label={m.stop}
          title={
            session.background.length
              ? m.stopTitleBackground
              : m.stopTitle
          }
          onClick={() => call("sessions.close", { sessionId: session.id }).catch((e: unknown) => toast.error(m.stopFailed, errorMessage(e)))}
        >
          <Power className="h-3.5 w-3.5" />
          {!compact && ` ${m.stop}`}
        </Button>
      )}
      {detached ? (
        <>
          <ChatWindowPinButton />
          <Button size="sm" variant="ghost" onClick={() => void reattachChatWindow()} title={m.recallTitle} aria-label={m.recall}>
            <SquareArrowOutDownLeft className="h-3.5 w-3.5" />
            <span className="hidden @2xl/sessionbar:inline">{m.recall}</span>
          </Button>
        </>
      ) : (
        <>
          {session && !inChatWindow && (
            <Tooltip content={m.openWindow}>
              <Button size="icon-sm" variant="ghost" aria-label={m.openWindow} onClick={() => void openChatWindow(project.id, session.id, session.title)}>
                <SquareArrowOutUpRight className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          {session && (
            <Tooltip content={m.deleteSession}>
              <Button size="icon-sm" variant="ghost" aria-label={m.deleteSession} className="hover:text-danger" onClick={() => setDeleting(session)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          )}
          <Button size={compact ? "icon-sm" : "sm"} variant="ghost" aria-label={m.newSession} onClick={() => onSelect(null)} title={pane ? m.newInPane : m.newSessionTitle}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {!compact && ` ${m.new}`}
          </Button>
          <DeleteSessionDialog session={deleting} onClose={() => setDeleting(null)} />
        </>
      )}
    </div>
  );
}

