import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import type { MethodName, ParamsOf, ResultOf } from "@forge/protocol";
import { rpc } from "./rpc";
import { usageOutdated, usageRefetchIn } from "./rate-limit";
import { loadOlderPages, useSessionEvents } from "@/stores/session-events";
import { toast } from "@/stores/toast";
import { errorMessage } from "./rpc";

export const queryClient = new QueryClient({
  defaultOptions: {
    // Most data changes through events from the sidecar; refetching everything on each Alt+Tab
    // kept the sidecar busy (git status for every project, transcript scans) while text streamed.
    // Data that changes outside FORGE (git, terminal sessions) opts back in below.
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

export const keys = {
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  git: (id: string) => ["git", id] as const,
  diff: (id: string, path: string, staged: boolean) => ["diff", id, path, staged] as const,
  commitFiles: (id: string, hash: string) => ["commitFiles", id, hash] as const,
  commitDiff: (id: string, hash: string, path: string) => ["commitDiff", id, hash, path] as const,
  log: (id: string) => ["log", id] as const,
  branches: (id: string) => ["branches", id] as const,
  sessions: (projectId: string) => ["sessions", projectId] as const,
  allSessions: (q: string, status: string) => ["allSessions", q, status] as const,
  liveSessions: ["liveSessions"] as const,
  session: (id: string) => ["session", id] as const,
  settings: ["settings"] as const,
  diagnostics: ["diagnostics"] as const,
  runtimeInfo: ["runtimeInfo"] as const,
  usage: ["usage"] as const,
  rateLimit: ["rateLimit"] as const,
  githubAccount: ["githubAccount"] as const,
  githubLogin: ["githubLogin"] as const,
  githubRepos: ["githubRepos"] as const,
  githubOrgs: ["githubOrgs"] as const,
  claudeSetup: ["claudeSetup"] as const,
  claudeUpdate: ["claudeUpdate"] as const,
  files: (id: string, dir: string) => ["files", id, dir] as const,
  file: (id: string, path: string) => ["file", id, path] as const,
  claudeMd: (id: string) => ["claudeMd", id] as const,
  devServer: (id: string) => ["devServer", id] as const,
  devTools: (id: string) => ["devTools", id] as const,
  testDb: (id: string) => ["testDb", id] as const,
  knowledge: (id: string) => ["knowledge", id] as const,
  knowledgeEntry: (id: string, entryId: string) => ["knowledge", id, entryId] as const,
  /** colon: entry ids never contain one, so this cannot clash with an entry */
  knowledgeCleanup: (id: string) => ["knowledge", id, ":cleanup"] as const,
  phoneState: ["phoneState"] as const,
  phoneConfig: ["phoneConfig"] as const,
  phoneCalls: ["phoneCalls"] as const,
  appUpdate: ["appUpdate"] as const,
  appChangelog: (tag: string) => ["appChangelog", tag] as const,
  backups: ["backups"] as const,
  sync: ["sync"] as const,
  syncProbe: ["syncProbe"] as const,
  syncVersions: ["syncVersions"] as const,
  gitIdentity: ["gitIdentity"] as const,
  remote: ["remote"] as const,
  agentReview: (id: string) => ["agentReview", id] as const,
  search: (q: string) => ["search", q] as const,
};

export function call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  return rpc.call(method, params);
}

/** Branches and changes can move outside FORGE; after a minute away the list refreshes on focus. */
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => call("projects.list", {}), staleTime: 60_000, refetchOnWindowFocus: true });

export const useProject = (id: string | null) =>
  useQuery({ queryKey: keys.project(id ?? ""), queryFn: () => call("projects.get", { projectId: id! }), enabled: !!id });

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => call("settings.get", {}), staleTime: Infinity });

export const useDiagnostics = () =>
  useQuery({ queryKey: keys.diagnostics, queryFn: () => call("system.diagnostics", {}), staleTime: 5 * 60_000, refetchOnWindowFocus: false });

export const useGitHubAccount = () =>
  useQuery({ queryKey: keys.githubAccount, queryFn: () => call("github.account", {}), staleTime: 5 * 60_000, retry: false });

/** Organisations of the signed-in account, as owners for new repositories. */
export const useGitHubOrgs = (enabled = true) =>
  useQuery({ queryKey: keys.githubOrgs, queryFn: () => call("github.orgs", {}), enabled, staleTime: 5 * 60_000, retry: false });

export const useGitHubLogin = () => useQuery({ queryKey: keys.githubLogin, queryFn: () => call("github.loginState", {}), staleTime: Infinity });

export const useClaudeSetup = () => useQuery({ queryKey: keys.claudeSetup, queryFn: () => call("claude.setupState", {}), staleTime: Infinity });

/** Checked on app start (the sidebar mounts this right away) and every six hours after that. */
export const useClaudeUpdate = () =>
  useQuery({
    queryKey: keys.claudeUpdate,
    queryFn: () => call("claude.checkUpdate", {}),
    staleTime: Infinity,
    refetchInterval: 6 * 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

/** Plan usage; refreshed every 5 minutes, after each finished turn and right after a window resets. */
export const useUsage = () =>
  useQuery({
    queryKey: keys.usage,
    queryFn: () => call("system.usage", {}),
    staleTime: 60_000,
    refetchInterval: (q) => usageRefetchIn(q.state.data),
    refetchOnWindowFocus: (q) => usageOutdated(q.state.data) && "always",
  });

/** Latest plan rate limit of the account; changes arrive as ratelimit.updated. */
export const useRateLimit = () =>
  useQuery({ queryKey: keys.rateLimit, queryFn: () => call("system.rateLimit", {}), staleTime: Infinity, refetchOnWindowFocus: false });

export const useRuntimeInfo = () =>
  // Hourly: Claude Code updates itself in the background, new models show up without a restart.
  useQuery({ queryKey: keys.runtimeInfo, queryFn: () => call("system.runtimeInfo", {}), staleTime: 10 * 60_000, refetchInterval: 60 * 60_000, refetchOnWindowFocus: false });

export const useGitStatus = (projectId: string | null, enabled = true) =>
  useQuery({
    queryKey: keys.git(projectId ?? ""),
    queryFn: () => call("git.status", { projectId: projectId! }),
    enabled: !!projectId && enabled,
    retry: false,
    // Files are edited in other programs too: check again when FORGE gets the focus back.
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

/** FORGE updates; changes arrive as update.updated. */
export const useAppUpdate = () => useQuery({ queryKey: keys.appUpdate, queryFn: () => call("app.updateState", {}), staleTime: Infinity });

/** Claude's changelog of the offered release; asked again every 1.5 s while Claude still writes it. */
export const useAppChangelog = (tag: string | null) =>
  useQuery({
    queryKey: keys.appChangelog(tag ?? ""),
    queryFn: () => call("app.changelog", {}),
    enabled: !!tag,
    staleTime: Infinity,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === "writing" ? 1500 : false),
  });

export const useBackups = () => useQuery({ queryKey: keys.backups, queryFn: () => call("backup.list", {}), staleTime: 30_000 });

export const useGitIdentity = (enabled = true) => useQuery({ queryKey: keys.gitIdentity, queryFn: () => call("git.identity", {}), enabled, staleTime: 60_000 });

/** Comes along with every change as sync.updated. */
export const useSyncStatus = () => useQuery({ queryKey: keys.sync, queryFn: () => call("sync.status", {}), staleTime: Infinity });

export const useSyncVersions = (enabled: boolean) =>
  useQuery({ queryKey: keys.syncVersions, queryFn: () => call("sync.versions", {}), enabled, staleTime: 60_000, retry: false });

/** What the sync repository of the GitHub account holds; only while a dialog asks whether to sync. */
export const useSyncProbe = (enabled: boolean) =>
  useQuery({ queryKey: keys.syncProbe, queryFn: () => call("sync.probe", {}), enabled, staleTime: 60_000, retry: false });

export const usePhoneState = () => useQuery({ queryKey: keys.phoneState, queryFn: () => call("phone.state", {}), staleTime: Infinity });
export const usePhoneConfig = () => useQuery({ queryKey: keys.phoneConfig, queryFn: () => call("phone.config", {}), staleTime: Infinity });

export const useDevServer = (projectId: string) =>
  useQuery({ queryKey: keys.devServer(projectId), queryFn: () => call("devserver.state", { projectId }), staleTime: 30_000 });

/** Dev tools and test database are per project; worktrees use their project's (pass the owner id). */
export const useDevTools = (ownerId: string) => useQuery({ queryKey: keys.devTools(ownerId), queryFn: () => call("devtools.get", { projectId: ownerId }), staleTime: Infinity });

/** Changes arrive as testdb.updated. */
export const useTestDb = (ownerId: string) => useQuery({ queryKey: keys.testDb(ownerId), queryFn: () => call("testdb.state", { projectId: ownerId }), staleTime: Infinity });

/** Entries of the project's knowledge; Claude's changes arrive as knowledge.updated. */
export const useKnowledge = (ownerId: string) => useQuery({ queryKey: keys.knowledge(ownerId), queryFn: () => call("knowledge.list", { projectId: ownerId }), staleTime: 60_000, refetchOnWindowFocus: true });

/** Full-text search over prompts and answers; runs from three characters on. */
export const useSearch = (query: string, limit = 50) => {
  const q = query.trim();
  return useQuery({
    queryKey: [...keys.search(q), limit],
    queryFn: () => call("search.sessions", { query: q, limit }),
    enabled: q.length >= 3,
    placeholderData: (prev) => prev,
    staleTime: 10_000,
  });
};

/** Also lists sessions started in a terminal; those appear after a minute away on focus. */
export const useSessions = (projectId: string | null) =>
  useQuery({
    queryKey: keys.sessions(projectId ?? ""),
    queryFn: () => call("sessions.list", { projectId: projectId! }),
    enabled: !!projectId,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

/** Sessions with a running Claude process, across projects; refreshed on every session.updated. */
export const useLiveSessions = () => useQuery({ queryKey: keys.liveSessions, queryFn: () => call("sessions.listLive", {}), staleTime: Infinity });

export const useSession = (sessionId: string | null) =>
  useQuery({ queryKey: keys.session(sessionId ?? ""), queryFn: () => call("sessions.get", { sessionId: sessionId! }), enabled: !!sessionId });

/** Loads persisted history once per session; live events arrive via startServerEvents. */
export function useSessionHistory(sessionId: string | null) {
  const loaded = useSessionEvents((s) => (sessionId ? s.buffers[sessionId]?.loaded : true));
  const [failure, setFailure] = useState<{ sessionId: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!sessionId || loaded) return;
    let cancelled = false;
    call("sessions.events", { sessionId })
      .then((events) => {
        if (!cancelled) useSessionEvents.getState().setHistory(sessionId, events);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ sessionId, message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, loaded, attempt]);
  const buffer = useSessionEvents((s) => (sessionId ? s.buffers[sessionId] : undefined));
  const error = failure && failure.sessionId === sessionId && !buffer?.loaded ? failure.message : null;
  const retry = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  return { buffer, error, retry };
}

/**
 * Loads older pages of a session's history on demand: the next one, or with `loadUntil` all pages
 * down to a seq. `beforeApply` runs right before each page lands in the store, so the caller can
 * remember its scroll position. Loads run one after another; each resolves to whether it reached
 * its goal, or null after an error (already shown as a toast).
 */
export function useOlderHistory(sessionId: string, beforeApply?: () => void) {
  const hasOlder = useSessionEvents((s) => !!s.buffers[sessionId]?.hasOlder);
  const [loading, setLoading] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const beforeApplyRef = useRef(beforeApply);
  useEffect(() => {
    beforeApplyRef.current = beforeApply;
  });
  const loadUntil = useCallback(
    (untilSeq?: number): Promise<boolean | null> => {
      pending.current += 1;
      setLoading(true);
      const run = queue.current
        .then(() =>
          loadOlderPages(sessionId, (beforeSeq) => call("sessions.events", { sessionId, beforeSeq }), {
            untilSeq,
            beforeApply: () => beforeApplyRef.current?.(),
          }),
        )
        .catch((e: unknown) => {
          toast.error("Ältere Einträge nicht geladen", errorMessage(e));
          return null;
        })
        .finally(() => {
          pending.current -= 1;
          if (!pending.current) setLoading(false);
        });
      queue.current = run;
      return run;
    },
    [sessionId],
  );
  const loadOlder = useCallback(() => loadUntil(), [loadUntil]);
  return { hasOlder, loading, loadOlder, loadUntil };
}

/** Mutation wrapper that shows errors as toasts. */
export function useRpcMutation<M extends MethodName>(method: M, opts: { onSuccess?: (r: ResultOf<M>, p: ParamsOf<M>) => void; errorTitle?: string } = {}) {
  return useMutation({
    mutationFn: (p: ParamsOf<M>) => call(method, p),
    onSuccess: (r, p) => opts.onSuccess?.(r, p),
    onError: (e) => toast.error(opts.errorTitle ?? "Aktion fehlgeschlagen", errorMessage(e)),
  });
}
