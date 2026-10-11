import path from "node:path";
import type { ServerEvent } from "@forge/protocol";
import { AgentSdkRuntime, type ClaudeRuntime } from "./claude/runtime.js";
import { GitEngine } from "./git/git.js";
import { GitHubService } from "./github/github.js";
import { ClaudeSetupService } from "./claude/setup.js";
import { McpService } from "./config/mcp.js";
import { WorktreeService } from "./automation/worktrees.js";
import { DevServerService } from "./devserver/dev-server.js";
import { PhoneService } from "./phone/phone-service.js";
import { SecretStore } from "./phone/secrets.js";
import { locateClaude, sessionEnv } from "./claude/environment.js";
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
  const sessions = new SessionService(db, projects, git, opts.runtime ?? new AgentSdkRuntime(), emit);
  sessions.startBackgroundChecks();
  const github = new GitHubService((payload) => emit({ event: "github.login", payload }));
  const claudeSetup = new ClaudeSetupService(
    (payload) => emit({ event: "claude.setup", payload }),
    () => db.getSettings(),
  );
  const mcp = new McpService(
    () => locateClaude(db.getSettings().claudePath),
    () => sessionEnv(db.getSettings().stripApiKey),
  );
  const worktrees = new WorktreeService(git, projects);
  const devServers = new DevServerService(projects, () => sessionEnv(db.getSettings().stripApiKey), emit);
  phone = new PhoneService({
    db,
    projects,
    sessions,
    devServers,
    git,
    secrets: new SecretStore(path.join(opts.dataDir, "secrets")),
    emit,
    claude: () => {
      const settings = db.getSettings();
      return { path: locateClaude(settings.claudePath), env: sessionEnv(settings.stripApiKey), cwd: opts.dataDir };
    },
    log: (m) => opts.log?.(m),
  });
  void phone.init();
  const handlers = createHandlers({
    mcp,
    worktrees,
    devServers,
    phone,
    github,
    claudeSetup,
    db,
    git,
    projects,
    sessions,
    dataDir: opts.dataDir,
    notifyProject: (projectId) => emit({ event: "project.updated", payload: { projectId } }),
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
      await Promise.race([Promise.allSettled([sessions.drain(), Promise.resolve().then(() => phone?.shutdown())]), limit]);
      clearTimeout(timer);
      sessions.shutdown();
      devServers.shutdown();
      github.shutdown();
      claudeSetup.shutdown();
      db.close();
    },
  };
}
