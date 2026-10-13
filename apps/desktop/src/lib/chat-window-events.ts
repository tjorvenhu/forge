import type { QueryClient } from "@tanstack/react-query";
import { useSessionEvents } from "@/stores/session-events";
import { useUi, splitActive } from "@/stores/ui";
import { rpc } from "./rpc";
import { createGitRefresher, routeServerEvent } from "./server-events";

const EVICT_INTERVAL_MS = 60_000;
const MAX_IDLE_BUFFERS = 2;

type EventSource = Pick<typeof rpc, "subscribe" | "onStatus">;

function shownSession(): string | null {
  const ui = useUi.getState();
  return ui.activeProjectId ? splitActive(ui.activeSession[ui.activeProjectId]).sessionId : null;
}

/**
 * Server events for a chat window. Like startServerEvents, except that session events only feed the
 * chat shown here (and buffers this window already holds): sounds and Windows notifications come
 * from the main window only, otherwise every signal would sound once per window.
 */
export function startChatWindowEvents(qc: QueryClient, source: EventSource = rpc): () => void {
  const git = createGitRefresher(qc);
  const offEvents = source.subscribe((e) => {
    if (e.event !== "session.event") {
      routeServerEvent(qc, git, e);
      return;
    }
    const id = e.payload.sessionId;
    if (id === shownSession() || id in useSessionEvents.getState().buffers) useSessionEvents.getState().apply(e.payload);
  });
  let lastUp: boolean | null = null;
  const offStatus = source.onStatus((up) => {
    if (up && lastUp === false) {
      useSessionEvents.getState().markAllStale();
      void qc.invalidateQueries();
    }
    lastUp = up;
  });
  const evictTimer = setInterval(() => {
    const shown = shownSession();
    useSessionEvents.getState().evict(new Set(shown ? [shown] : []), MAX_IDLE_BUFFERS);
  }, EVICT_INTERVAL_MS);
  return () => {
    offEvents();
    offStatus();
    clearInterval(evictTimer);
    git.dispose();
  };
}
