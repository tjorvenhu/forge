import { ForgeError, type MethodName, type ParsedParamsOf, type ResultOf } from "@forge/protocol";
import { collectDiagnostics } from "../claude/diagnostics.js";
import type { Db } from "../persistence/db.js";
import type { GitEngine } from "../git/git.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionService } from "../sessions/session-service.js";
import type { GitHubService } from "../github/github.js";
import type { ClaudeSetupService } from "../claude/setup.js";
import type { McpService } from "../config/mcp.js";
import * as cfg from "../config/claude-config.js";
import os from "node:os";

export interface Services {
  db: Db;
  git: GitEngine;
  projects: ProjectManager;
  sessions: SessionService;
  dataDir: string;
  github: GitHubService;
  claudeSetup: ClaudeSetupService;
  mcp: McpService;
  notifyProject: (projectId: string) => void;
}

type Handler<M extends MethodName> = (params: ParsedParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>;
export type Handlers = { [M in MethodName]: Handler<M> };

export function createHandlers(s: Services): Handlers {
  let diagCache: ResultOf<"system.diagnostics"> | null = null;

  const projectDir = (projectId: string) => s.projects.requireExisting(projectId).path;
  const dirOf = (projectId: string | undefined) => (projectId ? projectDir(projectId) : null);
  const gitChanged = async (projectId: string) => {
    s.notifyProject(projectId);
    return s.git.status(projectDir(projectId));
  };

  return {
    "system.diagnostics": async ({ refresh }) => {
      if (!diagCache || refresh) {
        const settings = s.db.getSettings();
        diagCache = await collectDiagnostics({
          claudePathSetting: settings.claudePath,
          stripApiKey: settings.stripApiKey,
          dataDir: s.dataDir,
          capabilities: s.sessions.capabilities(),
        });
      }
      return { ...diagCache, capabilities: s.sessions.capabilities() };
    },
    "system.runtimeInfo": () => s.sessions.runtimeInfo(),
    "system.usage": ({ refresh }) => s.sessions.planUsage(refresh === true),

    "claude.setupState": () => s.claudeSetup.current(),
    "claude.install": () => s.claudeSetup.install(),
    "claude.login": () => s.claudeSetup.login(),
    "claude.submitLoginCode": ({ code }) => s.claudeSetup.submitCode(code),
    "claude.cancelSetup": () => s.claudeSetup.cancel(),

    "github.account": () => s.github.account(),
    "github.loginState": () => s.github.loginState(),
    "github.startLogin": () => s.github.startLogin(),
    "github.cancelLogin": () => s.github.cancelLogin(),
    "github.logout": async () => {
      await s.github.logout();
      return { ok: true };
    },
    "github.repos": () => s.github.repos(),
    "github.publish": async ({ projectId, private: isPrivate, name }) => {
      const p = s.projects.requireExisting(projectId);
      if (!(await s.git.isRepo(p.path))) await s.git.init(p.path);
      if (await s.git.remoteUrl(p.path)) throw new ForgeError("CONFLICT", "Das Projekt hat bereits ein Remote origin.");
      if (!(await s.git.hasCommits(p.path))) await s.git.initialCommit(p.path, "chore: Projekt angelegt");
      const url = await s.github.createRepo(p.path, name ?? p.name, isPrivate);
      s.notifyProject(projectId);
      return { url };
    },
    "git.identity": () => s.git.identity(),
    "git.setIdentity": async ({ name, email }) => {
      await s.git.setIdentity(name, email);
      return s.git.identity();
    },

    "config.memoryList": ({ projectId }) => cfg.listMemory(dirOf(projectId)),
    "config.memoryRead": ({ projectId, scope }) => cfg.readMemory(scope, dirOf(projectId)),
    "config.memoryWrite": ({ projectId, scope, content, expectedMtimeMs }) => cfg.writeMemory(scope, dirOf(projectId), content, expectedMtimeMs),
    "config.docs": ({ kind, projectId }) => cfg.listDocs(kind, dirOf(projectId)),
    "config.docRead": ({ kind, scope, name, projectId }) => cfg.readDoc(kind, scope, dirOf(projectId), name),
    "config.docWrite": ({ kind, scope, name, projectId, content, expectedMtimeMs }) => cfg.writeDoc(kind, scope, dirOf(projectId), name, content, expectedMtimeMs),
    "config.docCreate": ({ kind, scope, name, description, projectId }) =>
      cfg.writeDoc(kind, scope, dirOf(projectId), name, cfg.docTemplate(kind, name, description), null),
    "config.docDelete": async ({ kind, scope, name, projectId }) => {
      await cfg.deleteDoc(kind, scope, dirOf(projectId), name);
      return { ok: true };
    },
    "config.hooksRead": ({ scope, projectId }) => cfg.readHooks(scope, dirOf(projectId)),
    "config.hooksWrite": ({ scope, projectId, hooks, expectedMtimeMs }) => cfg.writeHooks(scope, dirOf(projectId), hooks, expectedMtimeMs),
    "mcp.list": ({ projectId }) => s.mcp.list(dirOf(projectId) ?? os.homedir()),
    "mcp.add": ({ projectId, ...input }) => s.mcp.add(dirOf(projectId) ?? os.homedir(), input),
    "mcp.remove": ({ projectId, name, scope }) => s.mcp.remove(dirOf(projectId) ?? os.homedir(), name, scope),

    "settings.get": () => s.db.getSettings(),
    "settings.update": (patch) => {
      diagCache = null;
      return s.db.updateSettings(patch);
    },

    "projects.list": () => s.projects.list(),
    "projects.get": async ({ projectId }) => s.projects.withStatus(s.projects.get(projectId)),
    "projects.import": ({ path }) => s.projects.import(path),
    "projects.create": async ({ github, ...p }) => {
      const project = await s.projects.create({ ...p, gitInit: p.gitInit || !!github });
      if (!github) return { project, github: null };
      try {
        if (!(await s.git.hasCommits(project.path))) await s.git.initialCommit(project.path, "chore: Projekt angelegt");
        const url = await s.github.createRepo(project.path, project.name, github.private);
        return { project, github: { url, error: null } };
      } catch (e) {
        return { project, github: { url: null, error: e instanceof Error ? e.message : String(e) } };
      }
    },
    "projects.clone": ({ url, parentDir, dirName }) => s.projects.clone(url, parentDir, dirName),
    "projects.update": ({ projectId, ...patch }) => s.projects.update(projectId, patch),
    "projects.confirmAutonomous": ({ projectId, confirmName }) =>
      s.projects.confirmAutonomous(projectId, confirmName, s.db.getSettings().autonomousUnlocked),
    "projects.remove": ({ projectId }) => ({ removed: s.projects.remove(projectId) }),
    "projects.touch": ({ projectId }) => s.projects.touch(projectId),
    "projects.readClaudeMd": ({ projectId }) => s.projects.readClaudeMd(projectId),
    "projects.listFiles": ({ projectId, dir }) => s.projects.listFiles(projectId, dir),
    "projects.readFile": ({ projectId, path }) => s.projects.readFile(projectId, path),

    "sessions.list": ({ projectId }) => s.sessions.list(projectId),
    "sessions.listAll": ({ query, status }) => s.sessions.listAll(query, status),
    "sessions.get": ({ sessionId }) => s.sessions.get(sessionId),
    "sessions.events": ({ sessionId, afterSeq }) => s.sessions.events(sessionId, afterSeq),
    "sessions.start": (p) => s.sessions.start(p),
    "sessions.send": ({ sessionId, text }) => s.sessions.send(sessionId, text),
    "sessions.resume": ({ sessionId, prompt }) => s.sessions.resume(sessionId, prompt),
    "sessions.stop": ({ sessionId }) => s.sessions.stop(sessionId),
    "sessions.close": ({ sessionId }) => s.sessions.close(sessionId),
    "sessions.setModel": ({ sessionId, model }) => s.sessions.setModel(sessionId, model),
    "sessions.setPermissionMode": ({ sessionId, mode }) => s.sessions.setPermissionMode(sessionId, mode),
    "sessions.respondApproval": ({ sessionId, requestId, decision, scope, message }) =>
      s.sessions.respondApproval(sessionId, requestId, decision, scope, message),

    "git.status": ({ projectId }) => s.git.status(projectDir(projectId)),
    "git.diff": ({ projectId, path, staged }) => s.git.diff(projectDir(projectId), path, staged),
    "git.stage": async ({ projectId, paths }) => {
      await s.git.stage(projectDir(projectId), paths);
      return gitChanged(projectId);
    },
    "git.unstage": async ({ projectId, paths }) => {
      await s.git.unstage(projectDir(projectId), paths);
      return gitChanged(projectId);
    },
    "git.commit": async ({ projectId, message, paths, allowSensitive }) => {
      const r = await s.git.commit(projectDir(projectId), message, paths, allowSensitive);
      s.notifyProject(projectId);
      return r;
    },
    "git.log": ({ projectId, limit }) => s.git.log(projectDir(projectId), limit),
    "git.branches": ({ projectId }) => s.git.branches(projectDir(projectId)),
    "git.checkout": async ({ projectId, branch, create }) => {
      const busy = s.sessions
        .listAll()
        .some((x) => x.projectId === projectId && x.live && (x.status === "running" || x.status === "waiting_approval"));
      if (busy) throw new ForgeError("SESSION_BUSY", "Eine aktive Session arbeitet gerade in diesem Projekt. Erst stoppen, dann Branch wechseln.");
      await s.git.checkout(projectDir(projectId), branch, create);
      return gitChanged(projectId);
    },
    "git.suggestCommitMessage": ({ projectId, paths }) => s.sessions.suggestCommitMessage(projectId, paths),
    "git.init": async ({ projectId }) => {
      await s.git.init(projectDir(projectId));
      return gitChanged(projectId);
    },
  };
}
