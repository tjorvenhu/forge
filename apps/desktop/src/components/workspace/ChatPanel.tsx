import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDown, History, MessageSquarePlus, RotateCcw, Terminal } from "lucide-react";
import type { ExternalSession, Project, Session, SessionEvent } from "@forge/protocol";
import { useOlderHistory, useSession, useSessionHistory, useSessions } from "@/lib/queries";
import { isWorking } from "@/lib/working";
import { cn, relativeTime } from "@/lib/utils";
import { draftKey } from "@/stores/drafts";
import { toast } from "@/stores/toast";
import { splitActive, useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { ChatSkeleton } from "@/components/ui/skeleton";
import { Arrivals } from "@/lib/arrivals";
import { usePending, usePendingMessages } from "@/stores/pending-messages";
import { PendingMessages } from "./PendingMessages";
import { appendStreaming, IncrementalItems, itemIndexForSeq, lastUserPrompt, reuseStableItems, rowSpacing, startsAnswer, type ChatItem, type RowSpacing } from "./chat-items";
import { Composer } from "./Composer";
import { SessionBar } from "./SessionBar";
import { ChatSurface } from "./chat-surface";
import { ItemView } from "./ChatItemView";
import { BackgroundIndicator, WorkingIndicator } from "./WorkingIndicator";
import { turnStartedAt } from "./working";
import { anchoredScrollTop, captureAnchor, type ScrollAnchor } from "./scroll-anchor";
import { FollowState } from "./follow";

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
import { LeadMarker } from "./ChatRow";
import { ClaudeMark } from "./ClaudeMark";

/** Claude's mark in the gutter of the first entry of each answer, like the avatar of a chat. */
const CLAUDE_LEAD = <ClaudeMark size={20} />;

const NO_EVENTS: SessionEvent[] = [];
const NO_STREAMING: Record<string, string> = {};
/** room above the first row for the "load older" button */
const OLDER_BAR_HEIGHT = 44;
/** "tight" must stay pt-1.5: the guide line of subagent calls reaches up exactly that far. */
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

const toastNotFound = () => toast.error("Eintrag nicht gefunden", "Der Eintrag ist im Verlauf dieser Session nicht vorhanden.");

export function ChatPanel({ project, workingInPanel = false }: { project: Project; workingInPanel?: boolean }) {
  const active = useUi((s) => s.activeSession[project.id] ?? null);
  const setActive = useUi((s) => s.setActiveSession);
  const sessions = useSessions(project.id);
  const { sessionId, externalId } = splitActive(active);
  const external = externalId ? (sessions.data?.external.find((e) => e.claudeSessionId === externalId) ?? null) : null;
  const session = useSession(sessionId);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);

  // First open of a project: pick the most recent session instead of an empty chat.
  const didAutoSelect = useRef<string | null>(null);
  useEffect(() => {
    if (didAutoSelect.current === project.id || !sessions.data) return;
    didAutoSelect.current = project.id;
    const state = useUi.getState().activeSession;
    if (!(project.id in state) && sessions.data.sessions[0]) setActive(project.id, sessions.data.sessions[0].id);
  }, [project.id, sessions.data, setActive]);

  return (
    <div ref={setSurface} className="relative flex h-full min-h-0 flex-col">
      <ChatSurface.Provider value={surface}>
      <SessionBar
        project={project}
        session={session.data ?? null}
        external={external}
        sessions={sessions.data?.sessions ?? []}
        externals={sessions.data?.external ?? []}
        onSelect={(id) => setActive(project.id, id)}
      />
      {sessionId ? (
        <SessionThread key={sessionId} sessionId={sessionId} session={session.data ?? null} project={project} workingInPanel={workingInPanel} />
      ) : (
        <NewSessionPane project={project} external={external} />
      )}
      </ChatSurface.Provider>
    </div>
  );
}

function NewSessionPane({ project, external }: { project: Project; external: ExternalSession | null }) {
  // The first message of a session that is being started shows right away.
  const pending = usePending(draftKey(project.id, null, external?.claudeSessionId));
  return (
    <>
      <div className="min-h-0 flex-1 animate-view-in overflow-y-auto">
        {pending.length ? (
          <PendingMessages items={pending} />
        ) : external ? (
          <EmptyState icon={<Terminal className="h-9 w-9" />} title="Session aus dem Terminal fortsetzen">
            „{external.summary}“, zuletzt {relativeTime(external.lastModified)}
            {external.gitBranch ? ` auf ${external.gitBranch}` : ""}. Schreibe eine Nachricht, um sie in FORGE weiterzuführen. Der bisherige Verlauf wird übernommen.
          </EmptyState>
        ) : (
          <EmptyState icon={<MessageSquarePlus className="h-9 w-9" />} title={`Neue Session in ${project.name}`}>
            Claude Code arbeitet im Projektordner mit Profil {project.profile === "safe" ? "Safe" : project.profile === "balanced" ? "Balanced" : "Autonomous"}. CLAUDE.md und
            die Projekt-Einstellungen aus .claude/ werden berücksichtigt.
          </EmptyState>
        )}
      </div>
      {/* Keyed per project and terminal session: local composer state must not carry over to another project. */}
      <Composer key={draftKey(project.id, null, external?.claudeSessionId)} project={project} session={null} resumeClaudeSessionId={external?.claudeSessionId} />
    </>
  );
}

function SessionThread({ sessionId, session, project, workingInPanel }: { sessionId: string; session: Session | null; project: Project; workingInPanel: boolean }) {
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
  const [jump, setJump] = useState<"new" | "end" | null>(null);
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
  // Leaving the thread: keep position and row heights for the next visit.
  useEffect(
    () => () => {
      const el = scrollRef.current;
      if (el) rememberView(sessionId, { offset: el.scrollTop, pinned: follow.pinned, measurements: virtualizer.measurementsCache });
    },
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
  useEffect(() => {
    // The scrollbar can be released outside the thread, even outside the window.
    const release = () => follow.setDragging(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [follow]);
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
              title="Verlauf konnte nicht geladen werden"
              action={
                <Button size="sm" variant="outline" onClick={retry}>
                  <RotateCcw className="h-3.5 w-3.5" /> Erneut laden
                </Button>
              }
            >
              {error}
            </ErrorBanner>
          </div>
        </div>
      );
    }
    return <ChatSkeleton />;
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
        className="min-h-0 flex-1 overflow-y-auto"
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
          const hint = follow.scrolled(el.scrollTop, el.scrollHeight, el.clientHeight, performance.now());
          if (hint === "pinned") setJump(null);
          else if (hint === "far") setJump((j) => j ?? "end");
        }}
      >
        <div ref={contentRef}>
          <div className="relative mx-auto w-full max-w-5xl" style={{ height: virtualizer.getTotalSize() + 24 }}>
            {hasOlder && (
              <div className="absolute inset-x-0 top-0 flex items-end justify-center" style={{ height: OLDER_BAR_HEIGHT }}>
                <Button size="sm" variant="outline" loading={loadingOlder} onClick={() => void loadOlder()}>
                  <History className="h-3.5 w-3.5" /> Ältere Einträge laden
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
          {startedAt && !workingInPanel && <WorkingIndicator startedAt={startedAt} subagents={session?.subagents} sessionId={sessionId} />}
          {!!session?.background.length && <BackgroundIndicator tasks={session.background} sessionId={sessionId} />}
        </div>
      </div>
      {jump && (
        <button
          type="button"
          onClick={jumpToEnd}
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 animate-rise-in items-center gap-1.5 rounded-full border border-border bg-surface-3 px-3 py-1 text-small text-fg shadow-lg transition-[background-color,transform] duration-120 hover:bg-border-strong active:scale-[0.97]"
        >
          <ArrowDown className="h-3.5 w-3.5" /> {jump === "new" ? "Neue Nachrichten" : "Zum Ende"}
        </button>
      )}
      </div>
      <Composer project={project} session={session} prefill={retryText} onPrefillConsumed={clearRetry} />
    </>
  );
}
