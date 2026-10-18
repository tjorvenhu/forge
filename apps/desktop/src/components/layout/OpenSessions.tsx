import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueries } from "@tanstack/react-query";
import { AppWindow, Bot, CalendarDays, ChevronDown, Columns2, FileStack, FolderOpen, Hourglass, LayoutGrid, MessageSquare, MessageSquarePlus, Plus, SquareArrowOutUpRight, X } from "lucide-react";
import { openChatWindow, useChatWindows } from "@/lib/chat-windows";
import { contextItems } from "@/lib/context-menu";
import { call, keys, useLiveSessions, useProjects, useSession } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { flatTabs, groupOf, groupTabs, openSessionId, openSessionTab, type TabGroup, type TabSession } from "@/lib/session-tabs";
import { agentLabel } from "@/lib/project-tree";
import { useTabTearOff } from "@/lib/tab-drag";
import { isBusy, isWorking } from "@/lib/working";
import { cn, formatTokens } from "@/lib/utils";
import { handoffSession } from "@/components/workspace/handoff";
import { splitActive, useUi, type SplitPane } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { useTemplateDialogs } from "@/stores/templates";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { sessionStatusLabel } from "@/components/workspace/SessionStatusBadge";
import { focusComposer, openChat } from "@/components/workspace/chat-slot";

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
 * One session under its project, joined to the project's line by a bend. The line reaches up over
 * the gap to the row above and, except after the last row, goes on down to the next one.
 */
function Branch({ last = false, children }: { last?: boolean; children: ReactNode }) {
  return (
    <div className="relative pl-3.5">
      <span aria-hidden className="pointer-events-none absolute -top-0.5 left-0 h-[calc(50%+2px)] w-2.5 rounded-bl-md border-b border-l border-border" />
      {!last && <span aria-hidden className="pointer-events-none absolute -top-0.5 bottom-0 left-0 w-px bg-border" />}
      {children}
    </div>
  );
}

/** One project row with two sessions under it, in the sizes of the real tree. */
function OpenSessionsSkeleton() {
  return (
    <SkeletonRegion label="Lädt Sessions" className="flex flex-col">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <Skeleton className="h-5.5 w-5.5 shrink-0" />
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="ml-[18px] flex flex-col gap-0.5 pt-0.5">
        {[60, 45].map((w, n) => (
          <Branch key={w} last={n === 1}>
            <div className="flex h-8 items-center gap-2 pl-2">
              <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full" />
              <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
            </div>
          </Branch>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Groups of the tree: every project with a running session, plus the projects open in the workspace (main area and split panes). */
export function openGroups(groups: TabGroup[], open: { id: string; name: string } | null | readonly ({ id: string; name: string } | null)[]): TabGroup[] {
  const out = [...groups];
  for (const p of Array.isArray(open) ? open : [open]) {
    if (p && !out.some((g) => g.projectId === p.id)) out.push({ projectId: p.id, projectName: p.name, tabs: [] });
  }
  return out;
}

const NO_PANES: readonly SplitPane[] = [];
const MENU_ICON = "h-3.5 w-3.5";

/**
 * The split view as an entry above the open projects: marked while it is on screen. A click brings it
 * back from any other view, also after opening a single chat closed it; the cross closes it for good.
 */
export function SplitViewEntry() {
  const open = useUi((s) => (s.activeProjectId ? s.splitPanes.length : 0));
  const stashed = useUi((s) => s.splitStash?.panes.length ?? 0);
  const onScreen = useUi((s) => s.view === "workspace" && open > 0);
  const restore = useUi((s) => s.restoreSplit);
  const closeAll = useUi((s) => s.closeSplitPanes);
  const panes = open || stashed;
  if (!panes) return null;
  const areas = panes + 1;
  return (
    <div
      className={cn(
        "group/split mb-2 flex items-center rounded-lg border border-accent/30 transition-colors duration-120",
        onScreen ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <button
        onClick={() => restore()}
        aria-current={onScreen ? "page" : undefined}
        title={onScreen ? `Geteilte Ansicht mit ${areas} Bereichen` : `Geteilte Ansicht wieder öffnen (${areas} Bereiche)`}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-ui"
      >
        <span className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
          <LayoutGrid className="h-3.5 w-3.5" />
        </span>
        <span className="truncate">Geteilte Ansicht</span>
        <span className="ml-auto shrink-0 text-caption tabular-nums text-subtle" aria-label={`${areas} Bereiche`}>
          {areas}
        </span>
      </button>
      <button
        onClick={() => closeAll()}
        aria-label="Teilung aufheben"
        title="Teilung aufheben. Die Sessions laufen weiter."
        className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle opacity-0 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover/split:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
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
  const openReport = useUi((s) => s.openReport);
  // A new session without a message yet: listed while it is open, gone once you leave it.
  const newSessionProject = useUi((s) => (s.view === "workspace" && s.activeProjectId && s.activeSession[s.activeProjectId] === null ? s.activeProjectId : null));
  const openSession = useSession(openId);
  const inChatWindows = useChatWindows((s) => s.sessions);
  // Further chats of the split view: their sessions are on screen too, and there may be room for one more.
  const inPanes = useUi((s) => s.splitPanes.flatMap((p) => (p.active ? [p.active] : [])).join(" "));
  const splitRoom = useUi((s) => s.splitRoom);
  const addSplitPane = useUi((s) => s.addSplitPane);
  // The split view's further areas, while it is on screen: their sessions and projects are listed like the main chat's.
  const panes = useUi((s) => (s.view === "workspace" ? s.splitPanes : NO_PANES));
  const paneSessionIds = panes.flatMap((p) => splitActive(p.active).sessionId ?? []);
  const paneSessions = useQueries({
    queries: paneSessionIds.map((id) => ({ queryKey: keys.session(id), queryFn: () => call("sessions.get", { sessionId: id }) })),
  });
  const listRef = useRef<HTMLDivElement>(null);

  const activeGroup = activeProjectId ? groupOf(activeProjectId, projects.data) : null;
  const paneGroups = panes.flatMap((p) => (p.projectId ? [groupOf(p.projectId, projects.data)] : []));
  // New sessions without a message yet: the main chat's, and those of split panes (not while a pane still picks its session).
  const newRows = [
    ...(newSessionProject ? [{ key: "main", projectId: newSessionProject, pane: null }] : []),
    ...panes.flatMap((p) => (p.projectId && !p.active && !p.pick ? [{ key: p.id, projectId: p.projectId, pane: p.id }] : [])),
  ].map((r) => ({ ...r, groupId: groupOf(r.projectId, projects.data)?.id ?? r.projectId }));
  const groups = openGroups(
    groupTabs(live.data ?? [], [openSessionTab(openSession.data, projects.data), ...paneSessions.map((q) => openSessionTab(q.data, projects.data))], projects.data),
    [activeGroup, ...paneGroups].map((p) => p && { id: p.id, name: p.name }),
  );
  const agentOf = (projectId: string, groupId: string) => (projectId === groupId ? null : (projects.data?.find((p) => p.id === projectId) ?? null));
  const collapsedGroups = useUi((s) => s.collapsedGroups);
  const toggleGroup = useUi((s) => s.toggleGroup);
  const isCollapsed = (g: TabGroup) => collapsedGroups.includes(g.projectId);
  // Only what is shown takes part in the arrow keys; a hidden open session marks its project instead.
  const tabs = flatTabs(groups.filter((g) => !isCollapsed(g)));
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

  if (live.isPending || projects.isPending) return <OpenSessionsSkeleton />;
  if (!groups.length) return null;

  // Roving tabindex: one entry in the tab order, arrow keys move between sessions.
  const focusIndex = activeIndex < 0 ? 0 : activeIndex;

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const s = tabs[i]!;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openChat(s.projectId, s.id);
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
        const collapsed = isCollapsed(g);
        const groupNew = newRows.filter((r) => r.groupId === g.projectId);
        const news = collapsed ? [] : groupNew;
        const showNew = news.some((r) => !r.pane);
        const hasRows = g.tabs.length > 0 || groupNew.length > 0;
        // Collapsed, the project row still says whether one of its sessions waits or works.
        const lead = collapsed ? (g.tabs.find((s) => s.status === "waiting_approval") ?? g.tabs.find((s) => s.status === "error") ?? g.tabs.find((s) => isWorking(s.status) || s.background.length > 0)) : undefined;
        return (
          <div key={g.projectId} data-project-group={g.projectId} className="flex flex-col">
            <div
              className={cn("group/project flex items-center rounded-lg", projectActive && !activeId && !showNew ? "bg-surface-3" : "hover:bg-surface-2")}
              onContextMenu={contextItems(() => [
                { label: "Projekt öffnen", icon: <FolderOpen className={MENU_ICON} />, onSelect: () => openProject(g.projectId) },
                ...(splitRoom > 0 && !projectActive ? [{ label: "Daneben öffnen", icon: <Columns2 className={MENU_ICON} />, onSelect: () => addSplitPane(g.projectId) }] : []),
                {
                  label: "Neue Session",
                  icon: <MessageSquarePlus className={MENU_ICON} />,
                  onSelect: () => {
                    toggleGroup(g.projectId, false);
                    openProject(g.projectId, null);
                  },
                },
                { label: "Tagesbericht", icon: <CalendarDays className={MENU_ICON} />, onSelect: () => openReport(g.projectId) },
                { label: "Vorlage anwenden", icon: <FileStack className={MENU_ICON} />, onSelect: () => useTemplateDialogs.getState().openApply({ projectId: g.projectId }) },
                ...(hasRows ? [{ label: collapsed ? "Sessions einblenden" : "Sessions ausblenden", icon: <ChevronDown className={MENU_ICON} />, onSelect: () => toggleGroup(g.projectId) }] : []),
              ])}
            >
              <button
                onClick={(e) => {
                  if (e.shiftKey && splitRoom > 0 && !projectActive) addSplitPane(g.projectId);
                  else openProject(g.projectId);
                }}
                title={`${g.projectName} öffnen${splitRoom > 0 && !projectActive ? "\nUmschalt+Klick öffnet es daneben." : ""}`}
                className={cn("flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-ui", projectActive ? "text-fg" : "text-muted hover:text-fg")}
              >
                <ProjectIcon id={g.projectId} name={g.projectName} size={22} className="rounded-md" />
                <span className="truncate">{g.projectName}</span>
                {collapsed && g.tabs.length > 0 && (
                  <span className="flex shrink-0 items-center gap-1.5 text-caption tabular-nums text-subtle" aria-label={`${g.tabs.length} ${g.tabs.length === 1 ? "Session" : "Sessions"} ausgeblendet`}>
                    {lead && <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dotClass(lead))} />}
                    {g.tabs.length}
                  </span>
                )}
              </button>
              <button
                onClick={() => {
                  toggleGroup(g.projectId, false);
                  openProject(g.projectId, null);
                }}
                aria-label={`Neue Session in ${g.projectName}`}
                title="Neue Session"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle opacity-0 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover/project:opacity-100"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              {hasRows ? (
                <button
                  onClick={() => toggleGroup(g.projectId)}
                  aria-expanded={!collapsed}
                  aria-label={`Sessions von ${g.projectName} ${collapsed ? "einblenden" : "ausblenden"}`}
                  title={collapsed ? "Sessions einblenden" : "Sessions ausblenden"}
                  className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-surface-3 hover:text-fg"
                >
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-120", collapsed && "-rotate-90")} />
                </button>
              ) : (
                <span aria-hidden className="mr-1 w-6 shrink-0" />
              )}
            </div>
            {!collapsed && hasRows && (
              <div className="ml-[18px] flex flex-col gap-0.5 pt-0.5">
                {g.tabs.map((s, n) => {
                  const i = index++;
                  const active = i === activeIndex;
                  const attention = s.status === "waiting_approval";
                  const closable = s.live && !isBusy(s.status) && s.background.length === 0;
                  const inWindow = inChatWindows.includes(s.id);
                  const inPane = inPanes.split(" ").includes(s.id);
                  const canSplit = splitRoom > 0 && !active && !inPane && !inWindow;
                  const title = s.title ?? "Ohne Titel";
                  const agent = agentOf(s.projectId, g.projectId);
                  const where = agent ? `Agent ${agentLabel(agent)} in ${g.projectName}` : s.projectName;
                  return (
                    <Branch key={s.id} last={n === g.tabs.length - 1 && !news.length}>
                      <div
                        data-session-tab={s.id}
                        onContextMenu={contextItems(() => [
                          { label: "Öffnen", icon: <MessageSquare className={MENU_ICON} />, onSelect: () => openChat(s.projectId, s.id) },
                          ...(canSplit ? [{ label: "Daneben öffnen", icon: <Columns2 className={MENU_ICON} />, onSelect: () => addSplitPane(s.projectId, s.id) }] : []),
                          ...(!inWindow ? [{ label: "In eigenem Fenster öffnen", icon: <SquareArrowOutUpRight className={MENU_ICON} />, onSelect: () => void openChatWindow(s.projectId, s.id, s.title) }] : []),
                          ...(s.claudeSessionId && !isBusy(s.status)
                            ? [
                                {
                                  label: "In neuer Session weitermachen",
                                  icon: <MessageSquarePlus className={MENU_ICON} />,
                                  hint: s.context ? `${formatTokens(s.context.totalTokens)} Tokens` : undefined,
                                  onSelect: () => void handoffSession(s),
                                },
                              ]
                            : []),
                          ...(closable
                            ? [
                                {
                                  label: "Claude-Prozess beenden",
                                  icon: <X className={MENU_ICON} />,
                                  hint: "bleibt fortsetzbar",
                                  onSelect: () => void call("sessions.close", { sessionId: s.id }).catch((err: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(err))),
                                },
                              ]
                            : []),
                        ])}
                        className={cn(
                          "group flex h-8 min-w-0 animate-fade-in items-center rounded-lg text-body transition-[color,background-color,opacity] duration-120",
                          drag?.id === s.id && "opacity-50",
                          active ? "bg-surface-3 text-fg" : attention ? "bg-warning-soft text-fg hover:bg-surface-2" : inPane ? "bg-surface-2 text-fg hover:bg-surface-3" : "text-muted hover:bg-surface-2 hover:text-fg",
                        )}
                      >
                        <button
                          role="tab"
                          aria-selected={active}
                          aria-label={`${title}, ${where}, ${statusText(s)}`}
                          tabIndex={i === focusIndex ? 0 : -1}
                          onClick={(e) => {
                            if (consumeClick()) return;
                            if (e.shiftKey && canSplit) addSplitPane(s.projectId, s.id);
                            else openChat(s.projectId, s.id);
                          }}
                          onKeyDown={(e) => onTabKey(e, i)}
                          {...dragHandlers(s.id, title)}
                          title={`${title}${agent ? `\nParalleler Agent auf Branch ${agent.git?.branch ?? agentLabel(agent)}` : ""}\n${statusText(s)}${s.live ? "" : ". Kein laufender Claude-Prozess"}${inWindow ? "\nIn eigenem Fenster geöffnet" : ""}${inPane ? "\nIn der geteilten Ansicht geöffnet" : ""}\nHerausziehen öffnet ein eigenes Fenster.${canSplit ? "\nUmschalt+Klick öffnet sie daneben." : ""}`}
                          className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 rounded-lg pl-2 pr-1 text-left focus-visible:outline-offset-[-2px]"
                        >
                          <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(s))} />
                          {agent && <Bot aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                          <span className={cn("truncate", !s.live && "italic")}>{title}</span>
                          {inWindow && <AppWindow aria-hidden className="h-3 w-3 shrink-0 text-subtle" />}
                          {inPane && <Columns2 aria-hidden className="h-3 w-3 shrink-0 text-accent" />}
                          {s.background.length > 0 && (
                            <span aria-hidden className="flex shrink-0 items-center gap-0.5 text-caption tabular-nums text-subtle">
                              <Hourglass className="h-3 w-3" />
                              {s.background.length}
                            </span>
                          )}
                        </button>
                        {canSplit && (
                          <button
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle opacity-0 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                            aria-label={`${title} daneben öffnen`}
                            title="Daneben öffnen"
                            onClick={() => addSplitPane(s.projectId, s.id)}
                          >
                            <Columns2 className="h-3 w-3" />
                          </button>
                        )}
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
                    </Branch>
                  );
                })}
                {news.map((r, n) => {
                  const pane = r.pane;
                  const newAgent = agentOf(r.projectId, g.projectId);
                  const label = newAgent ? `Neue Session im Agenten ${agentLabel(newAgent)}` : "Neue Session";
                  const icons = (
                    <>
                      <MessageSquarePlus aria-hidden className="h-3 w-3 shrink-0 text-subtle" />
                      {newAgent && <Bot aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
                    </>
                  );
                  return (
                    <Branch key={r.key} last={n === news.length - 1}>
                      {pane ? (
                        <button
                          data-pane-new-session
                          onClick={() => focusComposer({ pane })}
                          title={`${label} in der geteilten Ansicht`}
                          className="flex h-8 w-full min-w-0 animate-fade-in items-center gap-2 rounded-lg pl-2 pr-1 text-left text-body text-muted transition-colors duration-120 hover:bg-surface-2 hover:text-fg"
                        >
                          {icons}
                          <span className="truncate italic">{label}</span>
                          <Columns2 aria-hidden className="h-3 w-3 shrink-0 text-accent" />
                        </button>
                      ) : (
                        <div data-new-session className="flex h-8 min-w-0 animate-fade-in items-center rounded-lg bg-surface-3 text-body text-fg">
                          <span aria-current="page" className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 pr-1" title="Neue Session. Sie bleibt hier, sobald du die erste Nachricht schickst.">
                            {icons}
                            <span className="truncate italic">{label}</span>
                          </span>
                        </div>
                      )}
                    </Branch>
                  );
                })}
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
