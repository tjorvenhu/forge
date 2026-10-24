import type { QueryClient } from "@tanstack/react-query";
import type { ResultOf, ServerEvent, Session } from "@forge/protocol";
import { useSessionEvents } from "@/stores/session-events";
import { useDevOutput } from "@/stores/dev-output";
import { useTokenRate } from "@/stores/token-rate";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { call, keys } from "./queries";
import { rpc } from "./rpc";
import { playSound } from "./sounds";
import { notifyAutoContinue, notifyDone, notifyKind, notifySession, shouldNotify } from "./notifications";
import { announceLearnedTemplates } from "./template-learning";
import { handleChatWindowRequest, isChatWindow } from "./chat-windows";
import { agentAutoMerged, agentTurnEnded } from "./agent-review";
import { installFull, installUpdate } from "./app-install";
import { crewNotice } from "./crew";
import { t } from "@/i18n";

const GIT_REFRESH_DELAY_MS = 400;
const EVICT_INTERVAL_MS = 60_000;
/** Session buffers kept besides the live and the shown ones. */
const MAX_IDLE_BUFFERS = 12;

/** Tools that never change files: their results need no git refresh (each one costs a git status). */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch", "AskUserQuestion", "BashOutput", "TaskOutput"]);

/** Debounced git refresh, one timer per project so a burst in project B does not swallow A's refresh. */
export function createGitRefresher(qc: QueryClient, delayMs = GIT_REFRESH_DELAY_MS) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const readOnlyCalls = new Set<string>();
  return {
    toolStarted(toolUseId: string, name: string) {
      if (!READ_ONLY_TOOLS.has(name)) return;
      // Calls whose result never came (session stopped) would pile up otherwise.
      if (readOnlyCalls.size > 500) readOnlyCalls.clear();
      readOnlyCalls.add(toolUseId);
    },
    /** false for a read-only tool: nothing to refresh */
    toolChangesFiles(toolUseId: string) {
      return !readOnlyCalls.delete(toolUseId);
    },
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
 * Reloads one project and puts it into the project list. Refetching the whole list would run a git
 * status in every project after each turn.
 */
export async function refreshProjectInList(qc: QueryClient, projectId: string) {
  try {
    const p = await qc.fetchQuery({ queryKey: keys.project(projectId), queryFn: () => call("projects.get", { projectId }), staleTime: 0 });
    const list = qc.getQueryData<ResultOf<"projects.list">>(keys.projects);
    if (list?.some((x) => x.id === p.id)) qc.setQueryData(keys.projects, list.map((x) => (x.id === p.id ? p : x)));
    else void qc.invalidateQueries({ queryKey: keys.projects });
  } catch {
    void qc.invalidateQueries({ queryKey: keys.projects });
  }
}

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

/**
 * Routes one sidecar push event into the query cache and the stores. Every window routes the same
 * events; toasts only show in the main window, otherwise each one would pop up once per window.
 */
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
      if (t === "turn.result" && !isChatWindow()) agentTurnEnded(qc, e.payload);
      if (e.payload.body.type === "tool.use") git.toolStarted(e.payload.body.toolUseId, e.payload.body.name);
      if ((e.payload.body.type === "tool.result" && git.toolChangesFiles(e.payload.body.toolUseId)) || t === "turn.result") {
        const s = qc.getQueryData<ResultOf<"sessions.get">>(keys.session(e.payload.sessionId));
        if (s) git.schedule(s.projectId);
      }
      break;
    }
    case "session.done":
      // The daily report counts turns and commits; an open report refetches, others are only marked stale.
      void qc.invalidateQueries({ queryKey: ["report"] });
      // Chat windows get this event too; sound and notification come from the main window only.
      if (!isChatWindow() && shouldNotify(e.payload.sessionId, "done")) {
        if (qc.getQueryData<ResultOf<"settings.get">>(keys.settings)?.sounds !== false) playSound("done");
        void notifyDone(qc, e.payload.sessionId);
      }
      break;
    case "session.updated":
      qc.setQueryData(keys.session(e.payload.id), e.payload);
      patchSessionLists(qc, e.payload);
      // Only the Sessions view shows these; inactive queries are just marked stale.
      void qc.invalidateQueries({ queryKey: ["allSessions"] });
      if (e.payload.status === "idle" || e.payload.status === "stopped") {
        git.schedule(e.payload.projectId);
        void refreshProjectInList(qc, e.payload.projectId);
        void qc.invalidateQueries({ queryKey: keys.usage });
        void qc.invalidateQueries({ queryKey: keys.sessionUsage(e.payload.id) });
      }
      break;
    case "github.login":
      qc.setQueryData(keys.githubLogin, e.payload);
      if (e.payload.phase === "done") {
        void qc.invalidateQueries({ queryKey: keys.githubAccount });
        void qc.invalidateQueries({ queryKey: keys.devChannel });
        void qc.invalidateQueries({ queryKey: keys.githubRepos });
        void qc.invalidateQueries({ queryKey: keys.githubOrgs });
        void qc.invalidateQueries({ queryKey: keys.diagnostics });
        void qc.invalidateQueries({ queryKey: keys.syncProbe });
      }
      break;
    case "claude.setup":
      qc.setQueryData(keys.claudeSetup, e.payload);
      // idle without a task is only sent after a logout (also one from the phone or another window)
      if (e.payload.phase === "done" || (e.payload.phase === "idle" && e.payload.task === null)) {
        void call("system.diagnostics", { refresh: true }).then((d) => qc.setQueryData(keys.diagnostics, d));
        void qc.invalidateQueries({ queryKey: keys.usage });
        void qc.invalidateQueries({ queryKey: keys.runtimeInfo });
        void qc.invalidateQueries({ queryKey: keys.claudeUpdate });
      }
      if (isChatWindow()) break;
      if (e.payload.task === "update" && e.payload.phase === "done") {
        toast.success(t.lib.serverEvents.claudeUpdated, `${e.payload.message ?? ""} ${t.lib.serverEvents.claudeUpdatedBody}`.trim());
      } else if (e.payload.task === "update" && e.payload.phase === "error") {
        toast.error(t.lib.serverEvents.updateFailed, e.payload.message ?? undefined);
      }
      break;
    case "claude.authRequired":
      void call("system.diagnostics", { refresh: true }).then((d) => qc.setQueryData(keys.diagnostics, d));
      // One dialog in the main window; each window would open the sign-in page on its own otherwise.
      if (!isChatWindow()) useUi.getState().openClaudeLogin("expired");
      break;
    case "remote.updated":
      qc.setQueryData(keys.remote, e.payload);
      break;
    case "settings.updated":
      qc.setQueryData(keys.settings, e.payload);
      break;
    case "ratelimit.updated":
      qc.setQueryData(keys.rateLimit, e.payload);
      break;
    case "tokens.rate":
      useTokenRate.getState().set(e.payload.perSecond);
      break;
    case "devserver.updated":
      qc.setQueryData(keys.devServer(e.payload.projectId), e.payload);
      break;
    case "devserver.output":
      useDevOutput.getState().append(e.payload.projectId, e.payload.text);
      break;
    case "testdb.updated":
      qc.setQueryData(keys.testDb(e.payload.projectId), e.payload);
      break;
    case "worktree.setup":
      qc.setQueryData(keys.worktreeSetup(e.payload.projectId), e.payload);
      break;
    case "templates.learned":
      if (!isChatWindow()) announceLearnedTemplates(e.payload.names);
      break;
    case "templates.updated":
      // Every list may show it: global ones appear in each project.
      void qc.invalidateQueries({ queryKey: ["templates"] });
      break;
    case "knowledge.updated":
      // List and open entries; an entry Claude just rewrote shows its new text.
      void qc.invalidateQueries({ queryKey: keys.knowledge(e.payload.projectId) });
      break;
    case "update.updated":
      qc.setQueryData(keys.appUpdate, e.payload);
      break;
    case "update.install":
      if (!isChatWindow()) void installUpdate(qc);
      break;
    case "chatWindow.request":
      if (!isChatWindow()) handleChatWindowRequest(e.payload);
      break;
    case "install.updated":
      qc.setQueryData(keys.appInstall, e.payload);
      break;
    case "install.repair":
      if (!isChatWindow()) void installFull(qc);
      break;
    case "runtime.models": {
      void qc.invalidateQueries({ queryKey: keys.runtimeInfo });
      if (isChatWindow()) break;
      const names = e.payload.added.map((m) => m.displayName);
      if (names.length === 1) toast.info(t.lib.serverEvents.newModel, t.lib.serverEvents.newModelBody(names[0]!));
      else if (names.length > 1) toast.info(t.lib.serverEvents.newModels, t.lib.serverEvents.newModelsBody(names.join(", ")));
      break;
    }
    case "phone.updated": {
      const prev = qc.getQueryData<ResultOf<"phone.state">>(keys.phoneState);
      qc.setQueryData(keys.phoneState, e.payload);
      if (prev?.call && !e.payload.call) void qc.invalidateQueries({ queryKey: keys.phoneCalls });
      break;
    }
    case "sync.updated": {
      const prev = qc.getQueryData<ResultOf<"sync.status">>(keys.sync);
      qc.setQueryData(keys.sync, e.payload);
      if (prev?.lastSyncAt !== e.payload.lastSyncAt) {
        // A finished sync may have written a new state to GitHub, and taken over data from another
        // computer. Forms that keep a cached copy (phone, dev tools) would otherwise save the old one back.
        for (const queryKey of [keys.syncVersions, keys.phoneConfig, keys.gitIdentity, ["devTools"], ["memory"], ["docs"], ["hooks"], ["mcp"]]) {
          void qc.invalidateQueries({ queryKey });
        }
      }
      break;
    }
    case "uiCompare.updated":
      qc.setQueryData(keys.uiCompare(e.payload.sessionId, e.payload.id), e.payload);
      void qc.invalidateQueries({ queryKey: ["uiCompareLatest"] });
      break;
    case "crew.updated":
      void qc.invalidateQueries({ queryKey: ["crews"] });
      break;
    case "crew.notice":
      if (!isChatWindow()) crewNotice(qc, e.payload);
      break;
    case "agent.autoMerge":
      if (!isChatWindow()) agentAutoMerged(e.payload);
      void qc.invalidateQueries({ queryKey: ["report"] });
      break;
    case "project.updated": {
      const id = e.payload.projectId;
      void qc.invalidateQueries({ queryKey: keys.git(id) });
      void qc.invalidateQueries({ queryKey: ["diff", id] });
      void qc.invalidateQueries({ queryKey: keys.log(id) });
      void qc.invalidateQueries({ queryKey: keys.branches(id) });
      // Dev tools are kept under the project a worktree belongs to (DevToolsTab); the phone and the sync change them too.
      const project = qc.getQueryData<ResultOf<"projects.get">>(keys.project(id)) ?? qc.getQueryData<ResultOf<"projects.list">>(keys.projects)?.find((p) => p.id === id);
      void qc.invalidateQueries({ queryKey: keys.devTools(project?.parentId ?? id) });
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: keys.project(id) });
      break;
    }
  }
}

/** Live sessions and the session each project shows keep their buffer; the rest is evicted by age. */
export function evictSessionBuffers(qc: QueryClient, max = MAX_IDLE_BUFFERS) {
  const keep = new Set<string>();
  for (const s of qc.getQueryData<ResultOf<"sessions.listLive">>(keys.liveSessions) ?? []) keep.add(s.id);
  for (const id of Object.values(useUi.getState().activeSession)) if (id) keep.add(id);
  for (const p of useUi.getState().splitPanes) if (p.active) keep.add(p.active);
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
