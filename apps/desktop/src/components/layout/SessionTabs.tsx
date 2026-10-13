import { useEffect, useRef, type KeyboardEvent } from "react";
import { AppWindow, Hourglass, SquareArrowOutUpRight, X } from "lucide-react";
import { openChatWindow, useChatWindows } from "@/lib/chat-windows";
import { call, useLiveSessions, useProjects, useSession } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { flatTabs, groupTabs, openSessionId, openSessionTab, type TabSession } from "@/lib/session-tabs";
import { isBusy, isWorking } from "@/lib/working";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { sessionStatusLabel } from "@/components/workspace/SessionStatusBadge";

function dotClass(s: TabSession): string {
  if (s.status === "waiting_approval") return "animate-soft-pulse bg-warning";
  if (s.status === "error") return "bg-danger";
  if (isWorking(s.status) || s.background.length > 0) return "animate-soft-pulse bg-accent";
  if (s.autoContinueAt) return "bg-warning";
  if (s.status === "idle" && s.live) return "bg-success";
  return "bg-subtle";
}

function statusText(s: TabSession): string {
  const label = sessionStatusLabel(s.status, s.live, s.autoContinueAt);
  return s.background.length ? `${label}, ${s.background.length} im Hintergrund` : label;
}

/**
 * App-wide session tabs above sidebar and views, grouped per project: every session with a running
 * Claude process, plus the session open in the chat. Hidden while there is nothing to show.
 */
export function SessionTabs() {
  const live = useLiveSessions();
  const projects = useProjects();
  const openId = useUi(openSessionId);
  const activeProjectId = useUi((s) => (s.view === "workspace" ? s.activeProjectId : null));
  const openProject = useUi((s) => s.openProject);
  const openSession = useSession(openId);
  const inChatWindows = useChatWindows((s) => s.sessions);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = groupTabs(live.data ?? [], openSessionTab(openSession.data, projects.data));
  const tabs = flatTabs(groups);
  const activeIndex = tabs.findIndex((s) => s.id === openId);
  const activeId = activeIndex >= 0 ? openId : null;

  useEffect(() => {
    if (!activeId) return;
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-session-tab]") ?? [])].find((t) => t.dataset.sessionTab === activeId);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  if (!tabs.length) return null;

  // Roving tabindex: one tab in the tab order, arrow keys move between tabs.
  const focusIndex = activeIndex < 0 ? 0 : activeIndex;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const s = tabs[i]!;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openProject(s.projectId, s.id);
      return;
    }
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : step ? (i + step + tabs.length) % tabs.length : -1;
    if (target < 0) return;
    e.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };

  let index = 0;
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Sessions"
      onWheel={(e) => {
        // A mouse wheel only scrolls vertically; the strip only scrolls horizontally.
        if (!e.deltaX && e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
      }}
      className="flex h-12 shrink-0 select-none items-center overflow-x-auto overflow-y-hidden border-b border-border bg-sidebar px-3"
    >
      {groups.map((g, gi) => (
        <div key={g.projectId} data-project-group={g.projectId} className="flex shrink-0 items-center gap-1">
          {gi > 0 && <span aria-hidden className="mx-3 h-5 w-px shrink-0 bg-border" />}
          {/* The project is part of every tab's accessible name; this label is only visual. */}
          <div aria-hidden title={g.projectName} className={cn("flex max-w-40 shrink-0 items-center gap-2 pl-1 pr-2 text-small", g.projectId === activeProjectId ? "text-fg" : "text-subtle")}>
            <ProjectIcon name={g.projectName} size={20} className="rounded-md" />
            <span className="truncate">{g.projectName}</span>
          </div>
          {g.tabs.map((s) => {
            const i = index++;
            const active = i === activeIndex;
            const attention = s.status === "waiting_approval";
            const closable = s.live && !isBusy(s.status) && s.background.length === 0;
            const inWindow = inChatWindows.includes(s.id);
            // Only on the open tab: a hidden button on every tab would widen the whole strip.
            const detachable = active && !inWindow;
            const title = s.title ?? "Ohne Titel";
            return (
              <div
                key={s.id}
                data-session-tab={s.id}
                className={cn(
                  // Same weight active or not, like the sidebar: a bolder title would make the strip jump.
                  "group flex h-8 min-w-0 max-w-60 shrink-0 animate-fade-in items-center rounded-lg text-body transition-[color,background-color] duration-120",
                  active ? "bg-surface-3 text-fg" : attention ? "bg-warning-soft text-fg hover:bg-surface-2" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <button
                  role="tab"
                  aria-selected={active}
                  aria-label={`${title}, ${s.projectName}, ${statusText(s)}`}
                  tabIndex={i === focusIndex ? 0 : -1}
                  onClick={() => openProject(s.projectId, s.id)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  title={`${s.projectName}: ${title}\n${statusText(s)}${s.live ? "" : ". Kein laufender Claude-Prozess"}${inWindow ? "\nIn eigenem Fenster geöffnet" : ""}\nStrg+Tab wechselt zur nächsten Session.`}
                  className={cn("flex h-full min-w-0 cursor-default items-center gap-2 rounded-lg pl-3 transition-transform duration-75 focus-visible:outline-offset-[-2px] active:scale-[0.97]", closable || detachable ? "pr-1.5" : "pr-3")}
                >
                  <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(s))} />
                  <span className={cn("truncate", !s.live && "italic")}>{title}</span>
                  {inWindow && <AppWindow aria-hidden className="h-3 w-3 shrink-0 text-subtle" />}
                  {s.background.length > 0 && (
                    <span aria-hidden className="flex shrink-0 items-center gap-0.5 text-caption tabular-nums text-subtle">
                      <Hourglass className="h-3 w-3" />
                      {s.background.length}
                    </span>
                  )}
                </button>
                {detachable && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className={cn("h-5 w-5 rounded-md text-subtle hover:bg-surface-2 hover:text-fg", !closable && "mr-1")}
                    aria-label={`${title} in eigenem Fenster öffnen`}
                    title="In eigenem Fenster öffnen"
                    onClick={() => void openChatWindow(s.projectId, s.id, s.title)}
                  >
                    <SquareArrowOutUpRight className="h-3 w-3" />
                  </Button>
                )}
                {closable && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className={cn("mr-1 h-5 w-5 rounded-md text-subtle hover:bg-surface-2 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100", active ? "opacity-100" : "opacity-0")}
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
      ))}
    </div>
  );
}
