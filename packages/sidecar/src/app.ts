import path from "node:path";
import type { ServerEvent } from "@forge/protocol";
import { AgentSdkRuntime, type ClaudeRuntime } from "./claude/runtime.js";
import { GitEngine } from "./git/git.js";
import { GitHubService } from "./github/github.js";
import { ClaudeSetupService } from "./claude/setup.js";
import { McpService } from "./config/mcp.js";
import { RemoteService } from "./remote/remote.js";
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
  shutdown(): void;
}

/** Wires all services. Separate from index.ts so tests can run it in-process. */
export function createApp(opts: { dataDir: string; write: Writer; log?: (m: string) => void; runtime?: ClaudeRuntime }): App {
  const db = new Db(path.join(opts.dataDir, "forge.db"));
  db.markOrphanedSessions();
  const git = new GitEngine();
  const projects = new ProjectManager(db, git, () => db.getSettings().defaultProfile);
  let server: RpcServer | null = null;
  const emit = (e: ServerEvent) => server?.emit(e);
  const sessions = new SessionService(db, projects, git, opts.runtime ?? new AgentSdkRuntime(), emit);
  const github = new GitHubService((payload) => emit({ event: "github.login", payload }));
  const claudeSetup = new ClaudeSetupService(
    (payload) => emit({ event: "claude.setup", payload }),
    () => db.getSettings(),
  );
  const mcp = new McpService(
    () => locateClaude(db.getSettings().claudePath),
    () => sessionEnv(db.getSettings().stripApiKey),
  );
  const remote = new RemoteService(
    (projectId, state) => emit({ event: "remote.updated", payload: { projectId, state } }),
    () => locateClaude(db.getSettings().claudePath),
    () => sessionEnv(db.getSettings().stripApiKey),
  );
  const handlers = createHandlers({
    mcp,
    remote,
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
    shutdown() {
      sessions.shutdown();
      github.shutdown();
      claudeSetup.shutdown();
      remote.shutdown();
      db.close();
    },
  };
}
