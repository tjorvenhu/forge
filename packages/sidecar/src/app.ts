import path from "node:path";
import { ForgeUsagePurpose, type ServerEvent } from "@forge/protocol";
import { AgentSdkRuntime, type ClaudeRuntime } from "./claude/runtime.js";
import { UploadStore } from "./claude/uploads.js";
import { GitEngine } from "./git/git.js";
import { GitHubService } from "./github/github.js";
import { ClaudeSetupService } from "./claude/setup.js";
import { McpService } from "./config/mcp.js";
import { PluginService } from "./config/plugins.js";
import { WorktreeService } from "./automation/worktrees.js";
import { WorktreeSetup } from "./automation/worktree-setup.js";
import { AgentFinisher } from "./automation/agent-finish.js";
import { DailyReportService, reportText } from "./reports/daily-report.js";
import { DevServerService } from "./devserver/dev-server.js";
import { DevToolsService } from "./devtools/dev-tools.js";
import { TestDbService } from "./devtools/test-db.js";
import { DevEnvironment } from "./devtools/environment.js";
import { PreviewService } from "./preview/preview.js";
import { KnowledgeStore } from "./knowledge/knowledge.js";
import { RefChecker } from "./knowledge/staleness.js";
import { PhoneService } from "./phone/phone-service.js";
import { JobWatcher } from "./sessions/job-done.js";
import { tokenMeter } from "./claude/token-meter.js";
import { DictationService } from "./dictation/dictation.js";
import { Presence } from "./util/presence.js";
import { ChatWindowState } from "./util/chat-windows.js";
import { AppUpdateService } from "./update/app-update.js";
import { FullInstallService } from "./update/full-install.js";
import { UsageStatsService, usageStatsFile } from "./stats/usage-stats.js";
import { modelTokens } from "./claude/normalize.js";
import { SecretStore } from "./phone/secrets.js";
import { locateClaude, sessionEnv } from "./claude/environment.js";
import { readAuth, readPlan } from "./claude/diagnostics.js";
import { ASSIST_MODEL } from "./sessions/claude-assist.js";
import { BackupService } from "./backup/backup.js";
import { SyncService } from "./sync/sync.js";
import { SyncKey } from "./sync/crypto.js";
import { TemplateService } from "./templates/templates.js";

/** The key from the sync password, in the secret store (DPAPI) next to the phone's secrets. */
const SYNC_KEY_SECRET = "sync-key";
import { Db } from "./persistence/db.js";
import { ProjectManager } from "./projects/project-manager.js";
import { createHandlers, invokeHandler, type Handlers } from "./rpc/handlers.js";
import { RpcServer, type Writer } from "./rpc/server.js";
import { SessionService } from "./sessions/session-service.js";

export interface App {
  server: RpcServer;
  sessions: SessionService;
  db: Db;
  /** Lets post-turn work and the phone finish (within limitMs), then ends all child processes and closes the DB. */
  shutdown(limitMs?: number): Promise<void>;
}

/** Upper bound for a clean shutdown; the desktop shell is waiting for the sidecar to exit. */
export const SHUTDOWN_LIMIT_MS = 5_000;

/** Wires all services. Separate from index.ts so tests can run it in-process. */
export function createApp(opts: { dataDir: string; write: Writer; log?: (m: string) => void; runtime?: ClaudeRuntime }): App {
  const db = new Db(path.join(opts.dataDir, "forge.db"));
  db.markOrphanedSessions();
  const git = new GitEngine();
  const projects = new ProjectManager(db, git, () => db.getSettings().defaultProfile);
  let server: RpcServer | null = null;
  let phone: PhoneService | null = null;
  let jobs: JobWatcher | null = null;
  let sync: SyncService | null = null;
  const emit = (e: ServerEvent) => {
    server?.emit(e);
    phone?.onServerEvent(e);
    jobs?.onServerEvent(e);
    sync?.onServerEvent(e);
  };
  const uploads = new UploadStore(path.join(opts.dataDir, "uploads"));
  const runtime = opts.runtime ?? new AgentSdkRuntime({ readDirs: [uploads.dir] });
  const sessions = new SessionService(db, projects, git, runtime, emit, Date.now, uploads);
  tokenMeter.onRate((perSecond) => emit({ event: "tokens.rate", payload: { perSecond } }));
  // Session turns are recorded with their turn.result event; this catches the calls outside a session.
  tokenMeter.onResult((kind, m) => {
    const [base, purpose] = kind.split(":");
    if (base !== "complete" && base !== "phone") return;
    const usage = (m.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    db.recordClaudeUsage({
      kind: base === "phone" ? "phone" : "assist",
      purpose: base === "phone" ? "phone" : (ForgeUsagePurpose.safeParse(purpose).data ?? "other"),
      durationMs: n(m.duration_ms),
      apiCalls: n(m.num_turns),
      inputTokens: n(usage.input_tokens),
      outputTokens: n(usage.output_tokens),
      cacheReadTokens: n(usage.cache_read_input_tokens),
      cacheWriteTokens: n(usage.cache_creation_input_tokens),
      isError: m.is_error === true,
      models: modelTokens(m.modelUsage),
    });
  });
  jobs = new JobWatcher({
    session: (id) => (db.getSession(id) ? sessions.get(id) : null),
    parent: (id) => db.getSessionParent(id),
    children: (id) => db.listSessionChildren(id),
    emit,
  });
  sessions.startBackgroundChecks();
  const github = new GitHubService((payload) => emit({ event: "github.login", payload }));
  const claudeSetup = new ClaudeSetupService(
    (payload) => {
      // A new or updated Claude Code may bring new models and commands.
      if (payload.phase === "done") sessions.invalidateRuntimeInfo();
      emit({ event: "claude.setup", payload });
    },
    () => db.getSettings(),
  );
  const mcp = new McpService(
    () => locateClaude(db.getSettings().claudePath),
    () => sessionEnv(db.getSettings().stripApiKey),
  );
  const plugins = new PluginService(
    () => locateClaude(db.getSettings().claudePath),
    () => sessionEnv(db.getSettings().stripApiKey),
  );
  const worktrees = new WorktreeService(git, projects);
  const devTools = new DevToolsService(db, projects);
  const testDb = new TestDbService({ dataDir: opts.dataDir, devTools, emit: (payload) => emit({ event: "testdb.updated", payload }), log: (m) => opts.log?.(m) });
  const devEnv: DevEnvironment = new DevEnvironment(devTools, testDb, () => devServers, () => worktreeSetup);
  const devServers = new DevServerService(projects, () => sessionEnv(db.getSettings().stripApiKey), emit, (projectId, command) => devEnv.devServerPrep(projectId, command));
  const worktreeSetup: WorktreeSetup = new WorktreeSetup({
    git,
    projects,
    env: () => sessionEnv(db.getSettings().stripApiKey),
    emit: (payload) => emit({ event: "worktree.setup", payload }),
    testDb,
    devServers: () => devServers,
    log: (m) => opts.log?.(m),
  });
  worktrees.useSetup(worktreeSetup);
  sessions.useWorktreeSetup(worktreeSetup);
  const knowledge = new KnowledgeStore(projects, (projectId) => emit({ event: "knowledge.updated", payload: { projectId } }), new RefChecker(git, path.join(opts.dataDir, "knowledge-refs.json")));
  const preview = new PreviewService({ devServer: (projectId) => devServers.state(projectId) });
  sessions.useProjectTools({ knowledge, dev: devEnv, preview });
  const uiCompare = sessions.useUiCompare({
    dir: path.join(opts.dataDir, "ui-compare"),
    devServer: (projectId) => devServers.state(projectId),
    hasBrowser: () => preview.hasBrowser(),
    lastViewed: (sessionId) => preview.lastViewed(sessionId),
    capture: (projectId, url) => preview.capture(projectId, url),
  });
  void uiCompare.prune().catch(() => null);
  const notifyProject = (projectId: string) => emit({ event: "project.updated", payload: { projectId } });
  const agentFinish = new AgentFinisher({ db, git, projects, sessions, worktrees, devServers, notifyProject });
  sessions.useAgentFinisher(agentFinish);
  const templates = new TemplateService({
    db,
    rootOf: (projectId) => projects.get(projectId).parentId ?? projectId,
    emit: (projectId) => emit({ event: "templates.updated", payload: { projectId } }),
  });
  const reports = new DailyReportService({
    db,
    git,
    projects,
    dataDir: opts.dataDir,
    summarize: (prompt, cwd) => sessions.summarizeDailyReport(prompt, cwd),
  });
  sessions.useDailyReport(async (projectId, date) => reportText(await reports.build({ projectId: projectId ?? undefined, date })));
  const presence = new Presence();
  const chatWindows = new ChatWindowState(emit);
  const secrets = new SecretStore(path.join(opts.dataDir, "secrets"));
  let handlers: Handlers | null = null;
  phone = new PhoneService({
    rpc: (method, params) => {
      if (!handlers) throw new Error("FORGE startet noch.");
      return invokeHandler(handlers, method, params);
    },
    db,
    projects,
    sessions,
    devServers,
    testDb,
    knowledge,
    git,
    worktrees,
    agentFinish,
    github,
    devTools,
    secrets,
    emit,
    claude: () => {
      const settings = db.getSettings();
      return { path: locateClaude(settings.claudePath), env: sessionEnv(settings.stripApiKey), cwd: opts.dataDir };
    },
    log: (m) => opts.log?.(m),
    userPresent: () => presence.isPresent(),
    chatWindows,
  });
  void phone.init();
  sessions.useCallFocus(() => phone?.callFocus() ?? null);
  const claudeFor = () => {
    const settings = db.getSettings();
    return { path: locateClaude(settings.claudePath), env: sessionEnv(settings.stripApiKey) };
  };
  const updates = new AppUpdateService({
    emit: (payload) => emit({ event: "update.updated", payload }),
    requestInstall: () => emit({ event: "update.install", payload: {} }),
    enabled: () => db.getSettings().updateChecks,
    log: (m) => opts.log?.(m),
    claudeReady: async () => {
      const c = claudeFor();
      if (!c.path) return "no-claude";
      return (await readAuth(c.path, c.env)).loggedIn ? "ok" : "no-login";
    },
    writeChangelog: (prompt) => {
      const c = claudeFor();
      if (!c.path) throw new Error("Claude Code ist nicht installiert.");
      return runtime.complete(prompt, { cwd: opts.dataDir, env: c.env, claudePath: c.path, model: ASSIST_MODEL, purpose: "changelog" });
    },
  });
  const installs = new FullInstallService({
    emit: (payload) => emit({ event: "install.updated", payload }),
    requestInstall: () => emit({ event: "install.repair", payload: {} }),
    log: (m) => opts.log?.(m),
  });
  const usageStats = new UsageStatsService({
    enabled: () => db.getSettings().usageStats,
    totals: () => db.usageTotals(),
    plan: () => readPlan(),
    log: (m) => opts.log?.(m),
    file: usageStatsFile(opts.dataDir),
  });
  const backups = new BackupService({
    dir: path.join(opts.dataDir, "backups"),
    db,
    appVersion: process.env.FORGE_APP_VERSION ?? "dev",
    git,
    // The sync key belongs to the sync password, not to the phone settings of a backup.
    secrets: {
      encrypted: () => Object.fromEntries(Object.entries(secrets.encrypted()).filter(([n]) => n !== SYNC_KEY_SECRET)),
      restoreEncrypted: (files) => secrets.restoreEncrypted(files, [SYNC_KEY_SECRET]),
    },
    log: (m) => opts.log?.(m),
    afterRestore: async (parts) => {
      if (parts.includes("settings")) sessions.settingsChanged();
      if (parts.includes("phone")) await phone?.reload();
      if (parts.includes("templates")) emit({ event: "templates.updated", payload: { projectId: null } });
      for (const p of db.listProjects()) emit({ event: "project.updated", payload: { projectId: p.id } });
    },
  });
  const viaHandlers = () => {
    if (!handlers) throw new Error("FORGE startet noch.");
    return handlers;
  };
  sync = new SyncService({
    stateFile: path.join(opts.dataDir, "sync", "state.json"),
    appVersion: process.env.FORGE_APP_VERSION ?? "dev",
    remote: github,
    settings: () => db.getSettings(),
    // Through the handlers: every window gets the change, profiles and git switches take effect.
    updateSettings: (patch) => invokeHandler(viaHandlers(), "settings.update", patch),
    projects: () => projects.all(),
    remoteUrl: (dir) => git.remoteUrl(dir),
    identity: () => git.identity(),
    setIdentity: (name, email) => git.setIdentity(name, email),
    updateProject: async (projectId, patch) => {
      const p = await invokeHandler(viaHandlers(), "projects.update", { projectId, ...patch });
      notifyProject(projectId);
      return p;
    },
    cloneProject: async (url, parentDir) => {
      const p = await projects.clone(url, parentDir);
      notifyProject(p.id);
      return p;
    },
    removeProject: async (projectId) => {
      await invokeHandler(viaHandlers(), "projects.remove", { projectId, deleteFolder: false, deleteGitHubRepo: false });
      notifyProject(projectId);
    },
    devTools: {
      get: (projectId) => db.getDevTools(projectId),
      update: (projectId, patch) => {
        devTools.update(projectId, patch);
        notifyProject(projectId);
      },
    },
    templates: {
      list: () => db.listTemplates("all"),
      put: (t) => {
        const now = new Date().toISOString();
        db.putTemplate({ ...t, createdAt: db.getTemplate(t.id)?.createdAt ?? now, updatedAt: now });
        emit({ event: "templates.updated", payload: { projectId: t.projectId } });
      },
      remove: (id) => void templates.delete(id),
    },
    phone: {
      config: () => phone!.syncConfig(),
      apply: (config) => phone!.applySyncConfig(config),
      secretsChanged: () => phone!.secretsChanged(),
    },
    secrets: {
      names: () => Object.keys(secrets.encrypted()).filter((n) => n !== SYNC_KEY_SECRET),
      get: (name) => secrets.get(name),
      set: (name, value) => secrets.set(name, value),
    },
    key: {
      get: async () => {
        const raw = await secrets.get(SYNC_KEY_SECRET);
        const parsed = raw ? SyncKey.safeParse(JSON.parse(raw)) : null;
        return parsed?.success ? parsed.data : null;
      },
      set: (key) => secrets.set(SYNC_KEY_SECRET, key ? JSON.stringify(key) : null),
    },
    safetyBackup: async () => {
      await backups.create("before-restore");
    },
    emit: (payload) => emit({ event: "sync.updated", payload }),
    log: (m) => opts.log?.(m),
  });
  // Only in the desktop app (the shell passes its version); tests and the CLI do not look for updates,
  // write no start backups, do not sync and install nothing.
  // Sessions open at the last restart for an update come back; a second step of the update goes first.
  sessions.resumeAfterUpdate(() => updates.holdsResume());
  if (process.env.FORGE_APP_VERSION) {
    updates.start();
    installs.start();
    usageStats.start();
    sync.start();
    void backups.createOnStart().catch((e: unknown) => opts.log?.(`Backup beim Start fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`));
    // A fresh installation without Claude Code fetches it right away (official installer); a configured path is left alone.
    const settings = db.getSettings();
    if (!settings.claudePath && !locateClaude(null)) {
      opts.log?.("Claude Code fehlt, Installation startet");
      claudeSetup.install();
    }
  }
  const dictation = new DictationService({
    emit,
    cliVersion: () => claudeSetup.installedVersion(),
    refreshLogin: () => sessions.refreshClaudeLogin(),
  });
  handlers = createHandlers({
    dictation,
    presence,
    chatWindows,
    backups,
    sync,
    templates,
    updates,
    installs,
    mcp,
    plugins,
    worktrees,
    worktreeSetup,
    agentFinish,
    reports,
    devServers,
    devTools,
    testDb,
    knowledge,
    phone,
    github,
    claudeSetup,
    db,
    git,
    projects,
    sessions,
    uploads,
    uiCompare,
    dataDir: opts.dataDir,
    notifyProject,
    notifySettings: (settings) => emit({ event: "settings.updated", payload: settings }),
  });
  server = new RpcServer(handlers, opts.write, opts.log);
  return {
    server,
    sessions,
    db,
    async shutdown(limitMs = SHUTDOWN_LIMIT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((r) => (timer = setTimeout(r, limitMs)));
      // The phone hangs up and unregisters; tests and auto-commits of finished turns get a chance to land.
      // The test databases go down meanwhile: after the drain there is no time left before the shell ends us.
      await Promise.race([Promise.allSettled([sessions.drain(), Promise.resolve().then(() => phone?.shutdown()), testDb.stopAll(), preview.closeAll()]), limit]);
      clearTimeout(timer);
      sessions.shutdown();
      tokenMeter.stop();
      updates.stop();
      installs.stop();
      usageStats.stop();
      sync?.stop();
      devServers.shutdown();
      worktreeSetup.shutdown();
      preview.shutdown();
      testDb.shutdown();
      github.shutdown();
      claudeSetup.shutdown();
      dictation.shutdown();
      db.close();
    },
  };
}
