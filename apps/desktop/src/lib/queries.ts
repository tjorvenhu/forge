import { useEffect } from "react";
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MethodName, ParamsOf, ResultOf } from "@forge/protocol";
import { rpc } from "./rpc";
import { useSessionEvents } from "@/stores/session-events";
import { useDevOutput } from "@/stores/dev-output";
import { toast } from "@/stores/toast";
import { errorMessage } from "./rpc";
import { playSound } from "./sounds";
import { notifyKind, notifySession, shouldNotify } from "./notifications";

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

/** Routes sidecar push events into caches and the session event store. Mount once. */
export function useServerEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let gitTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshGitSoon = (projectId: string) => {
      if (gitTimer) clearTimeout(gitTimer);
      gitTimer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: keys.git(projectId) });
        void qc.invalidateQueries({ queryKey: keys.project(projectId) });
        void qc.invalidateQueries({ queryKey: ["diff", projectId] });
      }, 400);
    };
    return rpc.subscribe((e) => {
      switch (e.event) {
        case "session.event": {
          useSessionEvents.getState().apply(e.payload);
          const t = e.payload.body.type;
          const kind = notifyKind(e.payload.body);
          if (kind && shouldNotify(e.payload.sessionId, kind)) {
            if (qc.getQueryData<ResultOf<"settings.get">>(keys.settings)?.sounds !== false) playSound(kind);
            void notifySession(qc, e.payload, kind);
          }
          if (t === "tool.result" || t === "turn.result") {
            const s = qc.getQueryData<ResultOf<"sessions.get">>(keys.session(e.payload.sessionId));
            if (s) refreshGitSoon(s.projectId);
          }
          break;
        }
        case "session.updated":
          qc.setQueryData(keys.session(e.payload.id), e.payload);
          void qc.invalidateQueries({ queryKey: keys.sessions(e.payload.projectId) });
          void qc.invalidateQueries({ queryKey: ["allSessions"] });
          void qc.invalidateQueries({ queryKey: keys.liveSessions });
          if (e.payload.status === "idle" || e.payload.status === "stopped") {
            refreshGitSoon(e.payload.projectId);
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
          qc.setQueryData(["remote", e.payload.projectId], e.payload.state);
          break;
        case "devserver.updated":
          qc.setQueryData(keys.devServer(e.payload.projectId), e.payload);
          break;
        case "devserver.output":
          useDevOutput.getState().append(e.payload.projectId, e.payload.text);
          break;
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
    });
  }, [qc]);
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

/** Loads persisted history once per session; live events arrive via useServerEvents. */
export function useSessionHistory(sessionId: string | null) {
  const loaded = useSessionEvents((s) => (sessionId ? s.buffers[sessionId]?.loaded : true));
  useEffect(() => {
    if (!sessionId || loaded) return;
    let cancelled = false;
    call("sessions.events", { sessionId })
      .then((events) => {
        if (!cancelled) useSessionEvents.getState().setHistory(sessionId, events);
      })
      .catch((e: unknown) => toast.error("Verlauf konnte nicht geladen werden", errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, loaded]);
  return useSessionEvents((s) => (sessionId ? s.buffers[sessionId] : undefined));
}

/** Mutation wrapper that shows errors as toasts. */
export function useRpcMutation<M extends MethodName>(method: M, opts: { onSuccess?: (r: ResultOf<M>, p: ParamsOf<M>) => void; errorTitle?: string } = {}) {
  return useMutation({
    mutationFn: (p: ParamsOf<M>) => call(method, p),
    onSuccess: (r, p) => opts.onSuccess?.(r, p),
    onError: (e) => toast.error(opts.errorTitle ?? "Aktion fehlgeschlagen", errorMessage(e)),
  });
}
