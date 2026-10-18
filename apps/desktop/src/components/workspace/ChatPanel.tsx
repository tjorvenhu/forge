import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { History, MessageSquarePlus, RotateCcw, Terminal } from "lucide-react";
import type { ExternalSession, Project, Session, SessionEvent } from "@forge/protocol";
import { useOlderHistory, useSession, useSessionHistory, useSessions } from "@/lib/queries";
import { isWorking } from "@/lib/working";
import { cn, relativeTime } from "@/lib/utils";
import { draftKey } from "@/stores/drafts";
import { toast } from "@/stores/toast";
import { shownSessions, splitActive, useUi, type SplitPane } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { ChatColumnSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Arrivals } from "@/lib/arrivals";
import { usePending, usePendingMessages } from "@/stores/pending-messages";
import { useInChatWindow } from "@/lib/chat-windows";
import { PendingMessages } from "./PendingMessages";
import { InChatWindowPane } from "./InChatWindowPane";
import { appendStreaming, IncrementalItems, itemIndexForSeq, lastUserPrompt, reuseStableItems, rowSpacing, startsAnswer, type ChatItem, type RowSpacing } from "./chat-items";
import { Composer } from "./Composer";
import { SessionBar } from "./SessionBar";
import { ChatSurface } from "./chat-surface";
import { ChatSlotContext, MAIN_SLOT, useChatSlot, type ChatSlot } from "./chat-slot";
import { FileLinkContext, type FileLinkTarget } from "./file-links";
import { ItemView } from "./ChatItemView";
import { BackgroundIndicator, WorkingIndicator } from "./WorkingIndicator";
import { TaskThreadDialog } from "./TaskThread";
import { turnStartedAt } from "./working";
import { anchoredScrollTop, captureAnchor, type ScrollAnchor } from "./scroll-anchor";
import { FollowState, SCROLL_KEYS } from "./follow";
import { JumpToEnd, useDragRelease, type JumpKind } from "./FollowScroll";
import { LeadMarker } from "./ChatRow";
import { ClaudeMark } from "./ClaudeMark";
import { t } from "@/i18n";

/** Claude's mark in the gutter of the first entry of each answer, like the avatar of a chat. */
const CLAUDE_LEAD = <ClaudeMark size={20} />;

const NO_EVENTS: SessionEvent[] = [];
const NO_STREAMING: Record<string, string> = {};
/** room above the first row for the "load older" button */
const OLDER_BAR_HEIGHT = 44;
const ROW_SPACING: Record<RowSpacing, string> = { first: "pt-5", turn: "pt-8", block: "pt-3.5", tight: "pt-1.5" };

/**
 * Where each thread was scrolled to and how tall its rows were, so switching sessions or tabs comes
 * back to the same place without rows jumping from estimated to measured height.
 */
const threadViews = new Map<string, { offset: number; pinned: boolean; measurements: VirtualItem[] }>();
const MAX_THREAD_VIEWS = 30;

function rememberView(sessionId: string, view: { offset: number; pinned: boolean; measurements: VirtualItem[] }) {
  threadViews.delete(sessionId);
  threadViews.set(sessionId, view);
  if (threadViews.size > MAX_THREAD_VIEWS) threadViews.delete(threadViews.keys().next().value!);
}

const toastNotFound = () => toast.error(t.chat.panel.entryNotFound, t.chat.panel.entryNotFoundDetail);

/**
 * `detached`: rendered as the only content of a chat window. `pane`: the chat of a further area of the split view,
 * with its own session; without it the panel shows the session the workspace has open for the project.
 */
export function ChatPanel({ project, detached = false, pane }: { project: Project; detached?: boolean; pane?: SplitPane }) {
  const mainActive = useUi((s) => s.activeSession[project.id] ?? null);
  const active = pane ? pane.active : mainActive;
  const setSplitPane = useUi((s) => s.setSplitPane);
  const paneId = pane?.id ?? null;
  const slot = useMemo<ChatSlot>(() => (paneId ? { pane: paneId, select: (projectId, id) => setSplitPane(paneId, projectId, id) } : MAIN_SLOT), [paneId, setSplitPane]);
  const fileLinks = useMemo<FileLinkTarget>(() => ({ projectId: project.id, root: project.path, pane: paneId }), [project.id, project.path, paneId]);
  const sessions = useSessions(project.id);
  const { sessionId, externalId } = splitActive(active);
  const external = externalId ? (sessions.data?.external.find((e) => e.claudeSessionId === externalId) ?? null) : null;
  const session = useSession(sessionId);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  // Shown in a chat window: one live composer per session, so this window only points there.
  const elsewhere = useInChatWindow(sessionId) && !detached;
  // Until the auto-pick below has run, "Neue Session" would flash before the last session opens.
  const mainSettled = useUi((s) => project.id in s.activeSession);
  const settled = (pane ? !pane.pick : mainSettled) || sessions.isError;
  const shownElsewhere = useShownElsewhere(project.id, active);

  // First open of a project (in a split pane: opened without a session): pick the most recent session
  // instead of an empty chat, but not one that is on screen already.
  const didAutoSelect = useRef<string | null>(null);
  const picking = pane ? !!pane.pick : !mainSettled;
  useEffect(() => {
    if (!picking || !sessions.data) return;
    // A pane's pick flag goes with the choice; the main chat picks once per project.
    if (!paneId) {
      if (didAutoSelect.current === project.id) return;
      didAutoSelect.current = project.id;
    }
    const shown = shownSessions(useUi.getState());
    // Without any session the chat starts a new one, so the sidebar lists it as such.
    slot.select(project.id, sessions.data.sessions.find((s) => !shown.has(s.id))?.id ?? null);
  }, [picking, paneId, project.id, sessions.data, slot]);

  if (!settled) return <ChatPanelSkeleton detached={detached} />;

  return (
    <div ref={setSurface} data-split-pane={paneId ?? undefined} className="chat-surface relative flex h-full min-h-0 flex-col">
      <ChatSlotContext.Provider value={slot}>
      <FileLinkContext.Provider value={fileLinks}>
      <ChatSurface.Provider value={surface}>
      <SessionBar
        project={project}
        session={session.data ?? null}
        external={external}
        sessions={sessions.data?.sessions ?? []}
        externals={sessions.data?.external ?? []}
        onSelect={(id) => slot.select(project.id, id)}
        detached={detached}
        inChatWindow={elsewhere}
        pane={pane}
        shownElsewhere={shownElsewhere}
      />
      {sessionId && elsewhere ? (
        <InChatWindowPane project={project} sessionId={sessionId} title={session.data?.title ?? null} />
      ) : sessionId ? (
        <SessionThread key={sessionId} sessionId={sessionId} session={session.data ?? null} project={project} />
      ) : (
        <NewSessionPane project={project} external={external} />
      )}
      </ChatSurface.Provider>
      </FileLinkContext.Provider>
      </ChatSlotContext.Provider>
    </div>
  );
}

/** Session bar, thread and composer in their final sizes, for while the project or its session choice loads. */
export function ChatPanelSkeleton({ detached = false }: { detached?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4" aria-hidden>
        {detached ? (
          <>
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-40" />
          </>
        ) : (
          <div className="flex items-center gap-1.5 px-2 py-1">
            <Skeleton className="h-3.5 w-3.5 rounded-sm" />
            <Skeleton className="h-3 w-44" />
          </div>
        )}
      </div>
      <ChatColumnSkeleton />
    </div>
  );
}

/** Sessions of a project that another chat of the split view shows; their entries in the session picker are disabled. */
function useShownElsewhere(projectId: string, active: string | null): ReadonlySet<string> {
  const key = useUi((s) => {
    const shown = s.splitPanes.filter((p) => p.projectId === projectId && p.active).map((p) => p.active!);
    if (s.activeProjectId === projectId && s.activeSession[projectId]) shown.push(s.activeSession[projectId]!);
    return shown.filter((id) => id !== active).sort().join("\n");
  });
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

function NewSessionPane({ project, external }: { project: Project; external: ExternalSession | null }) {
  const slot = useChatSlot();
  const key = draftKey(project.id, null, external?.claudeSessionId, slot.pane);
  // The first message of a session that is being started shows right away.
  const pending = usePending(key);
  return (
    <>
      <div className="min-h-0 flex-1 animate-view-in overflow-y-auto">
        {pending.length ? (
          <PendingMessages items={pending} />
        ) : external ? (
          <EmptyState icon={<Terminal className="h-9 w-9" />} title={t.chat.panel.resumeTitle}>
            {t.chat.panel.resumeBody(external.summary, relativeTime(external.lastModified), external.gitBranch)}
          </EmptyState>
        ) : (
          <EmptyState icon={<MessageSquarePlus className="h-9 w-9" />} title={t.chat.panel.newSessionTitle(project.name)}>
            {t.chat.panel.newSessionBody(project.profile === "safe" ? "Safe" : project.profile === "balanced" ? "Balanced" : "Autonomous")}
          </EmptyState>
        )}
      </div>
      {/* Keyed per project and terminal session: local composer state must not carry over to another project. */}
      <Composer key={key} project={project} session={null} resumeClaudeSessionId={external?.claudeSessionId} />
    </>
  );
}

function SessionThread({ sessionId, session, project }: { sessionId: string; session: Session | null; project: Project }) {
  const { buffer, error, retry } = useSessionHistory(sessionId);
  const events = buffer?.events ?? NO_EVENTS;
  const streaming = buffer?.streaming ?? NO_STREAMING;
  // Deltas only change `streaming`; the event items (and their identity) stay as they are.
  const previous = useRef<ChatItem[]>([]);
  const [builder] = useState(() => new IncrementalItems());
  const eventItems = useMemo(() => (previous.current = reuseStableItems(previous.current, builder.build(events))), [builder, events]);
  const items = useMemo(() => appendStreaming(eventItems, streaming), [eventItems, streaming]);
  const retryPrompt = useMemo(() => lastUserPrompt(events), [events]);
  const working = isWorking(session?.status);
  const startedAt = useMemo(() => (working ? (turnStartedAt(events) ?? session?.updatedAt ?? null) : null), [working, events, session?.updatedAt]);
  const [retryText, setRetryText] = useState<string | null>(null);
  const retryLast = useCallback(() => setRetryText(retryPrompt), [retryPrompt]);
  const onRetry = retryPrompt && !working ? retryLast : undefined;
  const clearRetry = useCallback(() => setRetryText(null), []);

  // Sent but not yet echoed by the sidecar; dropped as soon as the real message is in the buffer.
  const pending = usePending(sessionId);
  useEffect(() => usePendingMessages.getState().settle(sessionId, events), [sessionId, events]);

  // Rows that arrive while the thread is open slide in once; loaded history does not.
  const [arrivals] = useState(() => new Arrivals());
  if (buffer?.loaded && !arrivals.isPrimed) arrivals.prime(items.map((it) => it.key));

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** "new": content grew while scrolled up; "end": far from the end. Shows the jump button. */
  const [jump, setJump] = useState<JumpKind | null>(null);
  const [saved] = useState(() => threadViews.get(sessionId));
  const [follow] = useState(() => new FollowState(saved?.pinned ?? true));
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 8,
    getItemKey: (i) => items[i]!.key,
    paddingStart: buffer?.hasOlder ? OLDER_BAR_HEIGHT : 0,
    initialMeasurementsCache: saved?.measurements,
    initialOffset: saved && !saved.pinned ? saved.offset : undefined,
  });
  // Leaving the thread: keep position and row heights for the next visit. The position comes from
  // onScroll: React has already detached scrollRef when this cleanup runs on unmount.
  const offset = useRef(saved && !saved.pinned ? saved.offset : 0);
  useEffect(
    () => () => rememberView(sessionId, { offset: offset.current, pinned: follow.pinned, measurements: virtualizer.measurementsCache }),
    [sessionId, virtualizer, follow],
  );

  // Older rows land above the viewport: keep the row that was at the top in the same place.
  const anchor = useRef<ScrollAnchor | null>(null);
  const { hasOlder, loading: loadingOlder, loadOlder, loadUntil } = useOlderHistory(sessionId, () => {
    const el = scrollRef.current;
    anchor.current = el ? captureAnchor(virtualizer.getVirtualItems(), el.scrollTop) : null;
  });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    const i = items.findIndex((it) => it.key === a.key);
    // getVirtualItems brings the measurements up to date with the new rows.
    virtualizer.getVirtualItems();
    const top = anchoredScrollTop(a, i >= 0 ? virtualizer.measurementsCache[i] : undefined);
    if (top !== null) el.scrollTop = top;
  }, [events, items, virtualizer]);

  // A search hit asked for this session: scroll to the message once the history is there.
  const focus = useUi((s) => s.focusEvent);
  const [highlight, setHighlight] = useState<string | null>(null);
  const oldestSeq = events[0]?.seq;
  useEffect(() => {
    if (!focus || focus.sessionId !== sessionId || !buffer?.loaded) return;
    useUi.getState().setFocusEvent(null);
    follow.unpin();
    if (oldestSeq !== undefined && focus.seq < oldestSeq) {
      // The hit is older than the loaded pages: page back to it, then focus it again.
      void loadUntil(focus.seq).then((found) => {
        if (found) useUi.getState().setFocusEvent(focus);
        else if (found === false) toastNotFound();
      });
      return;
    }
    const i = itemIndexForSeq(items, focus.seq);
    if (i < 0) {
      toastNotFound();
      return;
    }
    virtualizer.scrollToIndex(i, { align: "center" });
    // Item heights are measured while scrolling; a second pass lands on the final position.
    requestAnimationFrame(() => virtualizer.scrollToIndex(i, { align: "center" }));
    setHighlight(items[i]!.key);
  }, [focus, sessionId, buffer?.loaded, items, virtualizer, oldestSeq, loadUntil, follow]);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, [highlight]);

  // Follow new content only while pinned, and only when the content actually grew. Scrolling
  // on every render fought the user (the virtualizer re-renders during a scroll before onScroll
  // runs), and reading scrollHeight on every streamed token forced a layout each time. A
  // ResizeObserver reports growth once per frame instead. The thread itself is observed too: when
  // the composer grows (approval or plan card), the visible area shrinks and the end moves out of view.
  const loaded = !!buffer?.loaded;
  useDragRelease(follow);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let lastHeight = 0;
    let lastViewport = 0;
    const onResize = () => {
      const h = content.offsetHeight;
      const viewport = el.clientHeight;
      const grew = h > lastHeight;
      if (follow.pinned && (grew || viewport < lastViewport)) el.scrollTop = el.scrollHeight;
      else if (!follow.pinned && lastHeight > 0 && grew) setJump("new");
      lastHeight = h;
      lastViewport = viewport;
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded, follow]);

  if (!buffer?.loaded) {
    if (error) {
      return (
        <div className="flex flex-1 justify-center p-6">
          <div className="w-full max-w-xl">
            <ErrorBanner
              title={t.chat.panel.historyFailed}
              action={
                <Button size="sm" variant="outline" onClick={retry}>
                  <RotateCcw className="h-3.5 w-3.5" /> {t.chat.panel.reload}
                </Button>
              }
            >
              {error}
            </ErrorBanner>
          </div>
        </div>
      );
    }
    return <ChatColumnSkeleton />;
  }

  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    follow.pin();
    setJump(null);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <>
      <div className="relative flex min-h-0 flex-1 animate-view-in flex-col">
      <div
        ref={scrollRef}
        className="chat-fade-top min-h-0 flex-1 overflow-y-auto"
        onWheel={(e) => follow.wheel(e.deltaY, performance.now())}
        onKeyDown={(e) => {
          if (SCROLL_KEYS.has(e.key)) follow.userInput(performance.now());
        }}
        onTouchMove={() => follow.userInput(performance.now())}
        onPointerDown={(e) => {
          // A press on the scroll container itself, not on a row, is a press on its scrollbar.
          if (e.target === e.currentTarget) follow.setDragging(true);
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          offset.current = el.scrollTop;
          // Set directly: a state update here would re-render the thread on every scroll frame.
          el.toggleAttribute("data-scrolled", el.scrollTop > 0);
          const hint = follow.scrolled(el.scrollTop, el.scrollHeight, el.clientHeight, performance.now());
          if (hint === "pinned") setJump(null);
          else if (hint === "far") setJump((j) => j ?? "end");
        }}
      >
        <div ref={contentRef}>
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() + 24 }}>
            {hasOlder && (
              <div className="absolute inset-x-0 top-0 flex items-end justify-center" style={{ height: OLDER_BAR_HEIGHT }}>
                <Button size="sm" variant="outline" loading={loadingOlder} onClick={() => void loadOlder()}>
                  <History className="h-3.5 w-3.5" /> {t.chat.panel.loadOlder}
                </Button>
              </div>
            )}
            {virtualizer.getVirtualItems().map((v) => (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={cn("absolute left-0 right-0 px-6", ROW_SPACING[rowSpacing(items[v.index - 1], items[v.index]!)])} style={{ transform: `translateY(${v.start}px)` }}>
                <div
                  className={cn(
                    "rounded-md transition-shadow duration-500",
                    highlight === items[v.index]!.key && "ring-2 ring-accent/60 ring-offset-4 ring-offset-bg",
                    arrivals.isNew(String(v.key)) && "animate-slide-up-in",
                  )}
                >
                  <LeadMarker.Provider value={startsAnswer(items[v.index - 1], items[v.index]!) ? CLAUDE_LEAD : null}>
                    <ItemView item={items[v.index]!} sessionId={sessionId} live={!!session?.live} projectDir={session?.cwd ?? project.path} onRetry={onRetry} />
                  </LeadMarker.Provider>
                </div>
              </div>
            ))}
          </div>
          {pending.length > 0 && <PendingMessages items={pending} />}
          {!!session?.background.length && <BackgroundIndicator tasks={session.background} sessionId={sessionId} />}
        </div>
      </div>
      {jump && <JumpToEnd kind={jump} onClick={jumpToEnd} />}
      </div>
      {/* Outside the scroll area: the line stays right above the composer, however short the chat is. */}
      {startedAt && <WorkingIndicator startedAt={startedAt} subagents={session?.subagents} sessionId={sessionId} />}
      <Composer project={project} session={session} prefill={retryText} onPrefillConsumed={clearRetry} />
      <TaskThreadDialog sessionId={sessionId} projectDir={session?.cwd ?? project.path} />
    </>
  );
}
