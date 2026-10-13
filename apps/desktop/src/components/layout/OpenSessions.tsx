import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Bot, Hourglass, MessageSquarePlus, Plus, SquareArrowOutUpRight, X } from "lucide-react";
import { openChatWindow, useChatWindows } from "@/lib/chat-windows";
import { call, useLiveSessions, useProjects, useSession } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { flatTabs, groupOf, groupTabs, openSessionId, openSessionTab, type TabGroup, type TabSession } from "@/lib/session-tabs";
import { agentLabel } from "@/lib/project-tree";
import { useTabTearOff } from "@/lib/tab-drag";
import { isBusy, isWorking } from "@/lib/working";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
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

/** Groups of the tree: every project with a running session, plus the project open in the workspace. */
export function openGroups(groups: TabGroup[], active: { id: string; name: string } | null): TabGroup[] {
  if (!active || groups.some((g) => g.projectId === active.id)) return groups;
  return [...groups, { projectId: active.id, projectName: active.name, tabs: [] }];
}

/**
 * Open projects in the sidebar as a tree, each with its sessions below: every session with a running
 * Claude process, plus the session open in the chat. Sessions of parallel agents sit under their main
 * project, marked as agent. A session dragged out of the tree becomes its own window, like a browser
 * tab. Ctrl+Tab walks the sessions in this order.
 */
export function OpenSessions() {
  const live = useLiveSessions();
  const projects = useProjects();
  const openId = useUi(openSessionId);
  const activeProjectId = useUi((s) => (s.view === "workspace" ? s.activeProjectId : null));
  const openProject = useUi((s) => s.openProject);
  // A new session without a message yet: listed while it is open, gone once you leave it.
  const newSessionProject = useUi((s) => (s.view === "workspace" && s.activeProjectId && s.activeSession[s.activeProjectId] === null ? s.activeProjectId : null));
  const openSession = useSession(openId);
  const inChatWindows = useChatWindows((s) => s.sessions);
  const listRef = useRef<HTMLDivElement>(null);

  const activeGroup = activeProjectId ? groupOf(activeProjectId, projects.data) : null;
  const newSessionGroup = newSessionProject ? (groupOf(newSessionProject, projects.data)?.id ?? newSessionProject) : null;
  const groups = openGroups(groupTabs(live.data ?? [], openSessionTab(openSession.data, projects.data), projects.data), activeGroup && { id: activeGroup.id, name: activeGroup.name });
  const agentOf = (projectId: string, groupId: string) => (projectId === groupId ? null : (projects.data?.find((p) => p.id === projectId) ?? null));
  const tabs = flatTabs(groups);
  const activeIndex = tabs.findIndex((s) => s.id === openId);
  const activeId = activeIndex >= 0 ? openId : null;

  const { drag, handlers: dragHandlers, consumeClick } = useTabTearOff(listRef, (id) => {
    const s = tabs.find((t) => t.id === id);
    if (s) void openChatWindow(s.projectId, s.id, s.title, { drag: true });
  });

  useEffect(() => {
    if (!activeId) return;
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-session-tab]") ?? [])].find((t) => t.dataset.sessionTab === activeId);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  if (!groups.length) return null;

  // Roving tabindex: one entry in the tab order, arrow keys move between sessions.
  const focusIndex = activeIndex < 0 ? 0 : activeIndex;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const s = tabs[i]!;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openProject(s.projectId, s.id);
      return;
    }
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    const target = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : step ? (i + step + tabs.length) % tabs.length : -1;
    if (target < 0) return;
    e.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  };

  let index = 0;
  return (
    <div ref={listRef} role="tablist" aria-orientation="vertical" aria-label="Sessions" className="flex flex-col gap-2">
      {groups.map((g) => {
        const projectActive = g.projectId === activeGroup?.id;
        const showNew = g.projectId === newSessionGroup;
        const newAgent = showNew && newSessionProject ? agentOf(newSessionProject, g.projectId) : null;
        return (
          <div key={g.projectId} data-project-group={g.projectId} className="flex flex-col">
            <div className={cn("group/project flex items-center rounded-lg", projectActive && !activeId && !showNew ? "bg-surface-3" : "hover:bg-surface-2")}>
              <button
                onClick={() => openProject(g.projectId)}
                title={`${g.projectName} öffnen`}
                className={cn("flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-ui", projectActive ? "text-fg" : "text-muted hover:text-fg")}
              >
                <ProjectIcon name={g.projectName} size={22} className="rounded-md" />
                <span className="truncate">{g.projectName}</span>
              </button>
              <button
                onClick={() => openProject(g.projectId, null)}
                aria-label={`Neue Session in ${g.projectName}`}
                title="Neue Session"
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle opacity-0 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover/project:opacity-100"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {(g.tabs.length > 0 || showNew) && (
              <div className="ml-[18px] flex flex-col gap-0.5 border-l border-border pl-2 pt-0.5">
                {g.tabs.map((s) => {
                  const i = index++;
                  const active = i === activeIndex;
                  const attention = s.status === "waiting_approval";
                  const closable = s.live && !isBusy(s.status) && s.background.length === 0;
                  const inWindow = inChatWindows.includes(s.id);
                  const title = s.title ?? "Ohne Titel";
                  const agent = agentOf(s.projectId, g.projectId);
                  const where = agent ? `Agent ${agentLabel(agent)} in ${g.projectName}` : s.projectName;
                  return (
                    <div
                      key={s.id}
                      data-session-tab={s.id}
                      className={cn(
                        "group flex h-8 min-w-0 animate-fade-in items-center rounded-lg text-body transition-[color,background-color,opacity] duration-120",
                        drag?.id === s.id && "opacity-50",
                        active ? "bg-surface-3 text-fg" : attention ? "bg-warning-soft text-fg hover:bg-surface-2" : "text-muted hover:bg-surface-2 hover:text-fg",
                      )}
                    >
                      <button
                        role="tab"
                        aria-selected={active}
                        aria-label={`${title}, ${where}, ${statusText(s)}`}
                        tabIndex={i === focusIndex ? 0 : -1}
                        onClick={() => {
                          if (!consumeClick()) openProject(s.projectId, s.id);
                        }}
                        onKeyDown={(e) => onTabKey(e, i)}
                        {...dragHandlers(s.id, title)}
                        title={`${title}${agent ? `\nParalleler Agent auf Branch ${agent.git?.branch ?? agentLabel(agent)}` : ""}\n${statusText(s)}${s.live ? "" : ". Kein laufender Claude-Prozess"}${inWindow ? "\nIn eigenem Fenster geöffnet" : ""}\nHerausziehen öffnet ein eigenes Fenster.`}
                        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 rounded-lg pl-2 pr-1 text-left focus-visible:outline-offset-[-2px]"
                      >
                        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(s))} />
                        {agent && <Bot aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                        <span className={cn("truncate", !s.live && "italic")}>{title}</span>
                        {inWindow && <AppWindow aria-hidden className="h-3 w-3 shrink-0 text-subtle" />}
                        {s.background.length > 0 && (
                          <span aria-hidden className="flex shrink-0 items-center gap-0.5 text-caption tabular-nums text-subtle">
                            <Hourglass className="h-3 w-3" />
                            {s.background.length}
                          </span>
                        )}
                      </button>
                      {!inWindow && (
                        <button
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle opacity-0 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                          aria-label={`${title} in eigenem Fenster öffnen`}
                          title="In eigenem Fenster öffnen"
                          onClick={() => void openChatWindow(s.projectId, s.id, s.title)}
                        >
                          <SquareArrowOutUpRight className="h-3 w-3" />
                        </button>
                      )}
                      {closable && (
                        <button
                          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle opacity-0 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                          aria-label={`Claude-Prozess von ${title} beenden`}
                          title="Beenden. Die Session bleibt fortsetzbar."
                          onClick={() => call("sessions.close", { sessionId: s.id }).catch((err: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(err)))}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {showNew && (
                  <div data-new-session className="flex h-8 min-w-0 animate-fade-in items-center rounded-lg bg-surface-3 text-body text-fg">
                    <span aria-current="page" className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 pr-1" title="Neue Session. Sie bleibt hier, sobald du die erste Nachricht schickst.">
                      <MessageSquarePlus aria-hidden className="h-3 w-3 shrink-0 text-subtle" />
                      {newAgent && <Bot aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                      <span className="truncate italic">{newAgent ? `Neue Session im Agenten ${agentLabel(newAgent)}` : "Neue Session"}</span>
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {drag &&
        createPortal(
          <div
            aria-hidden
            style={{ left: drag.x + 12, top: drag.y + 8 }}
            className="pointer-events-none fixed z-50 flex max-w-72 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-body text-muted shadow-lg"
          >
            <SquareArrowOutUpRight className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{drag.label}</span>
          </div>,
          document.body,
        )}
    </div>
  );
}
