import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import type { MethodName, ParamsOf, ResultOf } from "@forge/protocol";
import { rpc } from "./rpc";
import { loadOlderPages, useSessionEvents } from "@/stores/session-events";
import { toast } from "@/stores/toast";
import { errorMessage } from "./rpc";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true },
    mutations: { retry: 0 },
  },
});

export const keys = {
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  git: (id: string) => ["git", id] as const,
  diff: (id: string, path: string, staged: boolean) => ["diff", id, path, staged] as const,
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
  githubAccount: ["githubAccount"] as const,
  githubLogin: ["githubLogin"] as const,
  githubRepos: ["githubRepos"] as const,
  claudeSetup: ["claudeSetup"] as const,
  claudeUpdate: ["claudeUpdate"] as const,
  files: (id: string, dir: string) => ["files", id, dir] as const,
  file: (id: string, path: string) => ["file", id, path] as const,
  claudeMd: (id: string) => ["claudeMd", id] as const,
  devServer: (id: string) => ["devServer", id] as const,
  phoneState: ["phoneState"] as const,
  phoneConfig: ["phoneConfig"] as const,
  phoneCalls: ["phoneCalls"] as const,
  search: (q: string) => ["search", q] as const,
};

export function call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  return rpc.call(method, params);
}

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => call("projects.list", {}) });

export const useProject = (id: string | null) =>
  useQuery({ queryKey: keys.project(id ?? ""), queryFn: () => call("projects.get", { projectId: id! }), enabled: !!id });

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => call("settings.get", {}), staleTime: Infinity });

export const useDiagnostics = () =>
  useQuery({ queryKey: keys.diagnostics, queryFn: () => call("system.diagnostics", {}), staleTime: 5 * 60_000, refetchOnWindowFocus: false });

export const useGitHubAccount = () =>
  useQuery({ queryKey: keys.githubAccount, queryFn: () => call("github.account", {}), staleTime: 5 * 60_000, retry: false });

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

/** Plan usage; refreshed every 5 minutes and after each finished turn. */
export const useUsage = () =>
  useQuery({
    queryKey: keys.usage,
    queryFn: () => call("system.usage", {}),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

export const useRuntimeInfo = () =>
  useQuery({ queryKey: keys.runtimeInfo, queryFn: () => call("system.runtimeInfo", {}), staleTime: 10 * 60_000, refetchOnWindowFocus: false });

export const useGitStatus = (projectId: string | null, enabled = true) =>
  useQuery({
    queryKey: keys.git(projectId ?? ""),
    queryFn: () => call("git.status", { projectId: projectId! }),
    enabled: !!projectId && enabled,
    retry: false,
  });

export const usePhoneState = () => useQuery({ queryKey: keys.phoneState, queryFn: () => call("phone.state", {}), staleTime: Infinity });
export const usePhoneConfig = () => useQuery({ queryKey: keys.phoneConfig, queryFn: () => call("phone.config", {}), staleTime: Infinity });

export const useDevServer = (projectId: string) =>
  useQuery({ queryKey: keys.devServer(projectId), queryFn: () => call("devserver.state", { projectId }), staleTime: 30_000 });

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

export const useSessions = (projectId: string | null) =>
  useQuery({ queryKey: keys.sessions(projectId ?? ""), queryFn: () => call("sessions.list", { projectId: projectId! }), enabled: !!projectId });

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
