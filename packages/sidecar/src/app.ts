import path from "node:path";
import type { ServerEvent } from "@forge/protocol";
import { AgentSdkRuntime, type ClaudeRuntime } from "./claude/runtime.js";
import { GitEngine } from "./git/git.js";
import { GitHubService } from "./github/github.js";
import { ClaudeSetupService } from "./claude/setup.js";
import { McpService } from "./config/mcp.js";
import { PluginService } from "./config/plugins.js";
import { WorktreeService } from "./automation/worktrees.js";
import { AgentFinisher } from "./automation/agent-finish.js";
import { DevServerService } from "./devserver/dev-server.js";
import { DevToolsService } from "./devtools/dev-tools.js";
import { TestDbService } from "./devtools/test-db.js";
import { DevEnvironment } from "./devtools/environment.js";
import { KnowledgeStore } from "./knowledge/knowledge.js";
import { PhoneService } from "./phone/phone-service.js";
import { DictationService } from "./dictation/dictation.js";
import { Presence } from "./util/presence.js";
import { AppUpdateService } from "./update/app-update.js";
import { SecretStore } from "./phone/secrets.js";
import { locateClaude, sessionEnv } from "./claude/environment.js";
import { readAuth } from "./claude/diagnostics.js";
import { ASSIST_MODEL } from "./sessions/claude-assist.js";
import { BackupService } from "./backup/backup.js";
import { Db } from "./persistence/db.js";
import { ProjectManager } from "./projects/project-manager.js";
import { createHandlers } from "./rpc/handlers.js";
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
  const emit = (e: ServerEvent) => {
    server?.emit(e);
    phone?.onServerEvent(e);
  };
  const runtime = opts.runtime ?? new AgentSdkRuntime();
  const sessions = new SessionService(db, projects, git, runtime, emit);
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
  const devEnv: DevEnvironment = new DevEnvironment(devTools, testDb, () => devServers);
  const devServers = new DevServerService(projects, () => sessionEnv(db.getSettings().stripApiKey), emit, (projectId) => devEnv.devServerPrep(projectId));
  const knowledge = new KnowledgeStore(projects, (projectId) => emit({ event: "knowledge.updated", payload: { projectId } }));
  sessions.useProjectTools({ knowledge, dev: devEnv });
  const notifyProject = (projectId: string) => emit({ event: "project.updated", payload: { projectId } });
  const agentFinish = new AgentFinisher({ db, git, projects, sessions, worktrees, devServers, notifyProject });
  sessions.useAgentFinisher(agentFinish);
  const presence = new Presence();
  const secrets = new SecretStore(path.join(opts.dataDir, "secrets"));
  phone = new PhoneService({
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
  });
  void phone.init();
  const claudeFor = () => {
    const settings = db.getSettings();
    return { path: locateClaude(settings.claudePath), env: sessionEnv(settings.stripApiKey) };
  };
  const updates = new AppUpdateService({
    emit: (payload) => emit({ event: "update.updated", payload }),
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
      return runtime.complete(prompt, { cwd: opts.dataDir, env: c.env, claudePath: c.path, model: ASSIST_MODEL });
    },
  });
  const backups = new BackupService({
    dir: path.join(opts.dataDir, "backups"),
    db,
    appVersion: process.env.FORGE_APP_VERSION ?? "dev",
    git,
    secrets,
    log: (m) => opts.log?.(m),
    afterRestore: async (parts) => {
      if (parts.includes("settings")) sessions.settingsChanged();
      if (parts.includes("phone")) await phone?.reload();
      for (const p of db.listProjects()) emit({ event: "project.updated", payload: { projectId: p.id } });
    },
  });
  // Only in the desktop app (the shell passes its version); tests and the CLI do not look for updates,
  // write no start backups and install nothing.
  if (process.env.FORGE_APP_VERSION) {
    updates.start();
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
  const handlers = createHandlers({
    dictation,
    presence,
    backups,
    updates,
    mcp,
    plugins,
    worktrees,
    agentFinish,
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
      await Promise.race([Promise.allSettled([sessions.drain(), Promise.resolve().then(() => phone?.shutdown()), testDb.stopAll()]), limit]);
      clearTimeout(timer);
      sessions.shutdown();
      updates.stop();
      devServers.shutdown();
      testDb.shutdown();
      github.shutdown();
      claudeSetup.shutdown();
      dictation.shutdown();
      db.close();
    },
  };
}
