import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { History, MessageSquarePlus, RotateCcw, Terminal } from "lucide-react";
import type { ExternalSession, Project, Session, SessionEvent } from "@forge/protocol";
import { useOlderHistory, useSession, useSessionHistory, useSessions } from "@/lib/queries";
import { isWorking } from "@/lib/working";
import { cn, relativeTime } from "@/lib/utils";
import { draftKey } from "@/stores/drafts";
import { toast } from "@/stores/toast";
import { splitActive, useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorBanner, Loading } from "@/components/ui/misc";
import { appendStreaming, buildEventItems, itemIndexForSeq, lastUserPrompt, reuseStableItems, type ChatItem } from "./chat-items";
import { Composer } from "./Composer";
import { SessionBar } from "./SessionBar";
import { ItemView } from "./ChatItemView";
import { BackgroundIndicator, WorkingIndicator } from "./WorkingIndicator";
import { turnStartedAt } from "./working";
import { anchoredScrollTop, captureAnchor, type ScrollAnchor } from "./scroll-anchor";

const NO_EVENTS: SessionEvent[] = [];
const NO_STREAMING: Record<string, string> = {};
/** room above the first row for the "load older" button */
const OLDER_BAR_HEIGHT = 44;

const toastNotFound = () => toast.error("Eintrag nicht gefunden", "Der Eintrag ist im Verlauf dieser Session nicht vorhanden.");

export function ChatPanel({ project, workingInPanel = false }: { project: Project; workingInPanel?: boolean }) {
  const active = useUi((s) => s.activeSession[project.id] ?? null);
  const setActive = useUi((s) => s.setActiveSession);
  const sessions = useSessions(project.id);
  const { sessionId, externalId } = splitActive(active);
  const external = externalId ? (sessions.data?.external.find((e) => e.claudeSessionId === externalId) ?? null) : null;
  const session = useSession(sessionId);

  // First open of a project: pick the most recent session instead of an empty chat.
  const didAutoSelect = useRef<string | null>(null);
  useEffect(() => {
    if (didAutoSelect.current === project.id || !sessions.data) return;
    didAutoSelect.current = project.id;
    const state = useUi.getState().activeSession;
    if (!(project.id in state) && sessions.data.sessions[0]) setActive(project.id, sessions.data.sessions[0].id);
  }, [project.id, sessions.data, setActive]);

  return (
    <div className="flex h-full min-h-0 flex-col">
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
    </div>
  );
}

function NewSessionPane({ project, external }: { project: Project; external: ExternalSession | null }) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {external ? (
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
  const eventItems = useMemo(() => (previous.current = reuseStableItems(previous.current, buildEventItems(events))), [events]);
  const items = useMemo(() => appendStreaming(eventItems, streaming), [eventItems, streaming]);
  const retryPrompt = useMemo(() => lastUserPrompt(events), [events]);
  const working = isWorking(session?.status);
  const startedAt = useMemo(() => (working ? (turnStartedAt(events) ?? session?.updatedAt ?? null) : null), [working, events, session?.updatedAt]);
  const [retryText, setRetryText] = useState<string | null>(null);
  const retryLast = useCallback(() => setRetryText(retryPrompt), [retryPrompt]);
  const onRetry = retryPrompt && !working ? retryLast : undefined;
  const clearRetry = useCallback(() => setRetryText(null), []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => items[i]!.key,
    paddingStart: buffer?.hasOlder ? OLDER_BAR_HEIGHT : 0,
  });

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
    pinned.current = false;
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
  }, [focus, sessionId, buffer?.loaded, items, virtualizer, oldestSeq, loadUntil]);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, [highlight]);

  // Follow new content only while pinned, and only when the content actually grew. Scrolling
  // on every render fought the user: the virtualizer re-renders during a scroll before onScroll runs.
  const lastHeight = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinned.current && el.scrollHeight > lastHeight.current) el.scrollTop = el.scrollHeight;
    lastHeight.current = el.scrollHeight;
  });

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
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loading />
      </div>
    );
  }

  return (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onWheel={(e) => {
          if (e.deltaY < 0) pinned.current = false;
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="relative mx-auto w-full max-w-4xl" style={{ height: virtualizer.getTotalSize() + 24 }}>
          {hasOlder && (
            <div className="absolute inset-x-0 top-0 flex items-end justify-center" style={{ height: OLDER_BAR_HEIGHT }}>
              <Button size="sm" variant="outline" loading={loadingOlder} onClick={() => void loadOlder()}>
                <History className="h-3.5 w-3.5" /> Ältere Einträge laden
              </Button>
            </div>
          )}
          {virtualizer.getVirtualItems().map((v) => (
            <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute left-0 right-0 px-6 pt-4" style={{ transform: `translateY(${v.start}px)` }}>
              <div className={cn("rounded-lg transition-shadow duration-500", highlight === items[v.index]!.key && "ring-2 ring-accent/60 ring-offset-4 ring-offset-bg")}>
                <ItemView item={items[v.index]!} sessionId={sessionId} live={!!session?.live} projectDir={session?.cwd ?? project.path} onRetry={onRetry} />
              </div>
            </div>
          ))}
        </div>
        {startedAt && !workingInPanel && <WorkingIndicator startedAt={startedAt} />}
        {!!session?.background.length && <BackgroundIndicator tasks={session.background} />}
      </div>
      <Composer project={project} session={session} prefill={retryText} onPrefillConsumed={clearRetry} />
    </>
  );
}
