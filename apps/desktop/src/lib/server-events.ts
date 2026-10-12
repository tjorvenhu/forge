import type { QueryClient } from "@tanstack/react-query";
import type { ResultOf, ServerEvent, Session } from "@forge/protocol";
import { useSessionEvents } from "@/stores/session-events";
import { useDevOutput } from "@/stores/dev-output";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { call, keys } from "./queries";
import { rpc } from "./rpc";
import { playSound } from "./sounds";
import { notifyAutoContinue, notifyKind, notifySession, shouldNotify } from "./notifications";

const GIT_REFRESH_DELAY_MS = 400;
const EVICT_INTERVAL_MS = 60_000;
/** Session buffers kept besides the live and the shown ones. */
const MAX_IDLE_BUFFERS = 12;

/** Debounced git refresh, one timer per project so a burst in project B does not swallow A's refresh. */
export function createGitRefresher(qc: QueryClient, delayMs = GIT_REFRESH_DELAY_MS) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(projectId: string) {
      const prev = timers.get(projectId);
      if (prev) clearTimeout(prev);
      timers.set(
        projectId,
        setTimeout(() => {
          timers.delete(projectId);
          void qc.invalidateQueries({ queryKey: keys.git(projectId) });
          void qc.invalidateQueries({ queryKey: keys.project(projectId) });
          void qc.invalidateQueries({ queryKey: ["diff", projectId] });
        }, delayMs),
      );
    },
    dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

type GitRefresher = ReturnType<typeof createGitRefresher>;

/**
 * Puts a changed session into the lists that are on screen instead of refetching them: each refetch
 * of the project's list also scans the Claude transcripts on disk, and approvals change the status
 * twice in a row. A session the list does not know yet (just started) still triggers a refetch.
 */
export function patchSessionLists(qc: QueryClient, s: Session) {
  const list = qc.getQueryData<ResultOf<"sessions.list">>(keys.sessions(s.projectId));
  if (list && list.sessions.some((x) => x.id === s.id)) {
    const sessions = list.sessions.map((x) => (x.id === s.id ? s : x)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    qc.setQueryData(keys.sessions(s.projectId), { ...list, sessions });
  } else void qc.invalidateQueries({ queryKey: keys.sessions(s.projectId) });

  const live = qc.getQueryData<ResultOf<"sessions.listLive">>(keys.liveSessions);
  const known = live?.find((x) => x.id === s.id);
  if (!live || (s.live && !known)) void qc.invalidateQueries({ queryKey: keys.liveSessions });
  else if (!s.live && known) qc.setQueryData(keys.liveSessions, live.filter((x) => x.id !== s.id));
  else if (known) qc.setQueryData(keys.liveSessions, live.map((x) => (x.id === s.id ? { ...s, projectName: x.projectName } : x)));
}

/** Routes one sidecar push event into the query cache and the stores. */
export function routeServerEvent(qc: QueryClient, git: GitRefresher, e: ServerEvent) {
  switch (e.event) {
    case "session.event": {
      useSessionEvents.getState().apply(e.payload);
      const t = e.payload.body.type;
      const kind = notifyKind(e.payload.body);
      if (kind && shouldNotify(e.payload.sessionId, kind)) {
        if (qc.getQueryData<ResultOf<"settings.get">>(keys.settings)?.sounds !== false) playSound(kind);
        void notifySession(qc, e.payload, kind);
      }
      if (t === "auto_continue") void notifyAutoContinue(qc, e.payload);
      if (t === "tool.result" || t === "turn.result") {
        const s = qc.getQueryData<ResultOf<"sessions.get">>(keys.session(e.payload.sessionId));
        if (s) git.schedule(s.projectId);
      }
      break;
    }
    case "session.updated":
      qc.setQueryData(keys.session(e.payload.id), e.payload);
      patchSessionLists(qc, e.payload);
      // Only the Sessions view shows these; inactive queries are just marked stale.
      void qc.invalidateQueries({ queryKey: ["allSessions"] });
      if (e.payload.status === "idle" || e.payload.status === "stopped") {
        git.schedule(e.payload.projectId);
        void qc.invalidateQueries({ queryKey: keys.projects });
        void qc.invalidateQueries({ queryKey: keys.project(e.payload.projectId) });
        void qc.invalidateQueries({ queryKey: keys.usage });
      }
      break;
    case "github.login":
      qc.setQueryData(keys.githubLogin, e.payload);
      if (e.payload.phase === "done") {
        void qc.invalidateQueries({ queryKey: keys.githubAccount });
        void qc.invalidateQueries({ queryKey: keys.githubRepos });
        void qc.invalidateQueries({ queryKey: keys.diagnostics });
      }
      break;
    case "claude.setup":
      qc.setQueryData(keys.claudeSetup, e.payload);
      if (e.payload.phase === "done") {
        void call("system.diagnostics", { refresh: true }).then((d) => qc.setQueryData(keys.diagnostics, d));
        void qc.invalidateQueries({ queryKey: keys.usage });
        void qc.invalidateQueries({ queryKey: keys.runtimeInfo });
        void qc.invalidateQueries({ queryKey: keys.claudeUpdate });
      }
      if (e.payload.task === "update" && e.payload.phase === "done") {
        toast.success("Claude Code aktualisiert", `${e.payload.message ?? ""} Offene Sessions nutzen die neue Version nach einem Neustart.`.trim());
      } else if (e.payload.task === "update" && e.payload.phase === "error") {
        toast.error("Update fehlgeschlagen", e.payload.message ?? undefined);
      }
      break;
    case "remote.updated":
      qc.setQueryData(keys.remote, e.payload);
      break;
    case "ratelimit.updated":
      qc.setQueryData(keys.rateLimit, e.payload);
      break;
    case "devserver.updated":
      qc.setQueryData(keys.devServer(e.payload.projectId), e.payload);
      break;
    case "devserver.output":
      useDevOutput.getState().append(e.payload.projectId, e.payload.text);
      break;
    case "update.updated":
      qc.setQueryData(keys.appUpdate, e.payload);
      break;
    case "runtime.models": {
      void qc.invalidateQueries({ queryKey: keys.runtimeInfo });
      const names = e.payload.added.map((m) => m.displayName);
      if (names.length === 1) toast.info("Neues Modell verfügbar", `${names[0]} lässt sich jetzt im Composer und in den Einstellungen auswählen.`);
      else if (names.length > 1) toast.info("Neue Modelle verfügbar", `${names.join(", ")} lassen sich jetzt im Composer und in den Einstellungen auswählen.`);
      break;
    }
    case "phone.updated": {
      const prev = qc.getQueryData<ResultOf<"phone.state">>(keys.phoneState);
      qc.setQueryData(keys.phoneState, e.payload);
      if (prev?.call && !e.payload.call) void qc.invalidateQueries({ queryKey: keys.phoneCalls });
      break;
    }
    case "project.updated":
      void qc.invalidateQueries({ queryKey: keys.git(e.payload.projectId) });
      void qc.invalidateQueries({ queryKey: ["diff", e.payload.projectId] });
      void qc.invalidateQueries({ queryKey: keys.log(e.payload.projectId) });
      void qc.invalidateQueries({ queryKey: keys.branches(e.payload.projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.project(e.payload.projectId) });
      break;
  }
}

/** Live sessions and the session each project shows keep their buffer; the rest is evicted by age. */
export function evictSessionBuffers(qc: QueryClient, max = MAX_IDLE_BUFFERS) {
  const keep = new Set<string>();
  for (const s of qc.getQueryData<ResultOf<"sessions.listLive">>(keys.liveSessions) ?? []) keep.add(s.id);
  for (const id of Object.values(useUi.getState().activeSession)) if (id) keep.add(id);
  useSessionEvents.getState().evict(keep, max);
}

type EventSource = Pick<typeof rpc, "subscribe" | "onStatus">;

/**
 * Subscribes once, outside React: the UI tree unmounts while the sidecar is down, and events must not be
 * lost with it. After a restart all queries refetch and session buffers reload, since events in between
 * were missed and caches with staleTime Infinity would otherwise stay outdated.
 */
export function startServerEvents(qc: QueryClient, source: EventSource = rpc): () => void {
  const git = createGitRefresher(qc);
  const offEvents = source.subscribe((e) => routeServerEvent(qc, git, e));
  let lastUp: boolean | null = null;
  const offStatus = source.onStatus((up) => {
    if (up && lastUp === false) {
      useSessionEvents.getState().markAllStale();
      void qc.invalidateQueries();
    }
    lastUp = up;
  });
  const evictTimer = setInterval(() => evictSessionBuffers(qc), EVICT_INTERVAL_MS);
  return () => {
    offEvents();
    offStatus();
    clearInterval(evictTimer);
    git.dispose();
  };
}
