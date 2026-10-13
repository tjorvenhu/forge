import { ForgeError, methods, type MethodName, type ParamsOf, type ParsedParamsOf, type ResultOf, type Settings } from "@forge/protocol";
import { startIntegrationSession } from "../git/integration-prompt.js";
import { collectDiagnostics } from "../claude/diagnostics.js";
import type { Db } from "../persistence/db.js";
import type { GitEngine } from "../git/git.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionService } from "../sessions/session-service.js";
import type { GitHubService } from "../github/github.js";
import type { ClaudeSetupService } from "../claude/setup.js";
import type { McpService } from "../config/mcp.js";
import type { PluginService } from "../config/plugins.js";
import type { WorktreeService } from "../automation/worktrees.js";
import type { AgentFinisher } from "../automation/agent-finish.js";
import type { DevServerService } from "../devserver/dev-server.js";
import type { DevToolsService } from "../devtools/dev-tools.js";
import type { TestDbService } from "../devtools/test-db.js";
import type { KnowledgeStore } from "../knowledge/knowledge.js";
import type { PhoneService } from "../phone/phone-service.js";
import type { DictationService } from "../dictation/dictation.js";
import type { Presence } from "../util/presence.js";
import type { AppUpdateService } from "../update/app-update.js";
import type { BackupService } from "../backup/backup.js";
import type { SyncService } from "../sync/sync.js";
import * as cfg from "../config/claude-config.js";
import { removalInfo, removeProject, removeWorktree } from "../projects/removal.js";
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
  plugins: PluginService;
  worktrees: WorktreeService;
  agentFinish: AgentFinisher;
  devServers: DevServerService;
  devTools: DevToolsService;
  testDb: TestDbService;
  knowledge: KnowledgeStore;
  phone: PhoneService;
  dictation: DictationService;
  presence: Presence;
  updates: AppUpdateService;
  backups: BackupService;
  sync: SyncService;
  notifyProject: (projectId: string) => void;
  /** every window takes the new settings, not only the one that saved them */
  notifySettings: (settings: Settings) => void;
}

type Handler<M extends MethodName> = (params: ParsedParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>;
export type Handlers = { [M in MethodName]: Handler<M> };

/** Calls a handler from inside the sidecar (the phone) the way the RPC server does: params checked and defaulted first. */
export async function invokeHandler<M extends MethodName>(handlers: Handlers, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  const parsed = methods[method].params.safeParse(params);
  if (!parsed.success) throw new ForgeError("VALIDATION", `Ungültige Angaben: ${parsed.error.issues.map((i) => `${i.path.join(".") || "Eingabe"} ${i.message}`).join("; ")}`);
  return (handlers[method] as Handler<M>)(parsed.data as ParsedParamsOf<M>);
}

export function createHandlers(s: Services): Handlers {
  let diagCache: ResultOf<"system.diagnostics"> | null = null;

  const projectDir = (projectId: string) => s.projects.requireExisting(projectId).path;
  /** Folder of a project that works with git; projects set to work without git refuse every git action. */
  const gitDir = (projectId: string) => s.projects.requireGit(projectId).path;
  const dirOf = (projectId: string | undefined) => (projectId ? projectDir(projectId) : null);
  const resolveInSession = async (projectId: string, e: unknown, push: boolean) => {
    const session = await startIntegrationSession(s.sessions, projectId, e, push);
    if (session) s.notifyProject(projectId);
    return session;
  };
  const gitChanged = async (projectId: string) => {
    s.notifyProject(projectId);
    return s.git.status(gitDir(projectId));
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
    "system.rateLimit": () => s.sessions.rateLimit(),

    "claude.setupState": () => s.claudeSetup.current(),
    "claude.install": () => s.claudeSetup.install(),
    "claude.login": () => s.claudeSetup.login(),
    "claude.checkUpdate": () => s.claudeSetup.checkUpdate(),
    "claude.update": () => s.claudeSetup.update(),
    "claude.submitLoginCode": ({ code }) => s.claudeSetup.submitCode(code),
    "claude.cancelSetup": () => s.claudeSetup.cancel(),

    "remote.state": () => s.sessions.remoteState(),
    "remote.start": () => s.sessions.remoteStart(),
    "remote.stop": () => s.sessions.remoteStop(),

    "github.account": () => s.github.account(),
    "github.loginState": () => s.github.loginState(),
    "github.startLogin": ({ scopes }) => s.github.startLogin(scopes),
    "github.cancelLogin": () => s.github.cancelLogin(),
    "github.logout": async () => {
      await s.github.logout();
      return { ok: true };
    },
    "github.repos": () => s.github.repos(),
    "github.orgs": () => s.github.orgs(),
    "github.publish": async ({ projectId, private: isPrivate, name, owner }) => {
      const p = s.projects.requireGit(projectId);
      if (!(await s.git.isRepo(p.path))) await s.git.init(p.path);
      if (await s.git.remoteUrl(p.path)) throw new ForgeError("CONFLICT", "Das Projekt hat bereits ein Remote origin.");
      if (!(await s.git.hasCommits(p.path))) await s.git.initialCommit(p.path, "chore: Projekt angelegt");
      const url = await s.github.createRepo(p.path, name ?? p.name, isPrivate, owner ?? null);
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
    "plugins.catalog": ({ refresh }) => s.plugins.catalog(refresh),
    "plugins.install": ({ id }) => s.plugins.install(id),
    "plugins.uninstall": ({ id }) => s.plugins.uninstall(id),
    "plugins.setEnabled": ({ id, enabled }) => s.plugins.setEnabled(id, enabled),

    "worktrees.create": ({ projectId, branch }) => s.worktrees.create(s.projects.requireGit(projectId), branch),
    "worktrees.remove": async ({ projectId, force, deleteBranch }) => {
      const r = await removeWorktree(projectId, force, s, { deleteBranch });
      return { ok: true, ...r };
    },
    "agents.review": ({ projectId }) => s.agentFinish.review(projectId),
    "agents.finish": ({ projectId, action }) => s.agentFinish.finish(projectId, action),
    "sessions.summarize": ({ sessionId }) => s.sessions.summarize(sessionId),

    "settings.get": () => s.db.getSettings(),
    "settings.update": (patch) => {
      diagCache = null;
      const next = s.db.updateSettings(patch);
      if (patch.autoContinueAfterLimit !== undefined) s.sessions.settingsChanged();
      s.notifySettings(next);
      if (patch.syncEnabled !== undefined) s.sync.enabledChanged();
      return next;
    },

    "projects.list": () => s.projects.list(),
    "projects.get": async ({ projectId }) => s.projects.withStatus(s.projects.get(projectId)),
    "projects.import": ({ path, gitEnabled }) => s.projects.import(path, null, gitEnabled),
    "projects.create": async ({ github, ...p }) => {
      const project = await s.projects.create({ ...p, gitInit: p.gitInit || !!github });
      if (!github || !project.gitEnabled) return { project, github: null };
      try {
        if (!(await s.git.hasCommits(project.path))) await s.git.initialCommit(project.path, "chore: Projekt angelegt");
        const url = await s.github.createRepo(project.path, project.name, github.private, github.owner);
        return { project, github: { url, error: null } };
      } catch (e) {
        return { project, github: { url: null, error: e instanceof Error ? e.message : String(e) } };
      }
    },
    "projects.clone": ({ url, parentDir, dirName }) => s.projects.clone(url, parentDir, dirName),
    "projects.update": async ({ projectId, ...patch }) => {
      const before = s.projects.get(projectId);
      const project = s.projects.update(projectId, patch);
      if (project.profile !== before.profile) await s.sessions.applyProjectProfile(projectId);
      if (project.gitEnabled !== before.gitEnabled) s.sessions.projectGitChanged(projectId, project.gitEnabled);
      return project;
    },
    "projects.removalInfo": ({ projectId }) => removalInfo(projectId, s),
    "projects.remove": ({ projectId, deleteFolder, deleteGitHubRepo }) => removeProject(projectId, { deleteFolder, deleteGitHubRepo }, s),
    "projects.touch": ({ projectId }) => s.projects.touch(projectId),
    "projects.readClaudeMd": ({ projectId }) => s.projects.readClaudeMd(projectId),
    "projects.listFiles": ({ projectId, dir }) => s.projects.listFiles(projectId, dir),
    "projects.readFile": ({ projectId, path }) => s.projects.readFile(projectId, path),

    "sessions.list": ({ projectId }) => s.sessions.list(projectId),
    "sessions.listAll": ({ query, status }) => s.sessions.listAll(query, status),
    "sessions.listLive": () => s.sessions.listLive(),
    "sessions.delete": ({ sessionId, deleteTranscript }) => s.sessions.delete(sessionId, deleteTranscript),
    "sessions.deleteAll": ({ deleteTranscript }) => s.sessions.deleteAll(deleteTranscript),
    "sessions.get": ({ sessionId }) => s.sessions.get(sessionId),
    "sessions.stopTask": ({ sessionId, taskId }) => s.sessions.stopTask(sessionId, taskId),
    "sessions.taskOutput": ({ sessionId, taskId }) => s.sessions.taskOutput(sessionId, taskId),
    "sessions.toBackground": ({ sessionId, toolUseId }) => s.sessions.toBackground(sessionId, toolUseId),
    "sessions.fork": ({ sessionId, beforeSeq, rewindFiles }) => s.sessions.fork(sessionId, { beforeSeq, rewindFiles }),
    "sessions.events": ({ sessionId, afterSeq, beforeSeq }) => s.sessions.events(sessionId, afterSeq, beforeSeq),
    "sessions.images": ({ sessionId, seq }) => s.sessions.images(sessionId, seq),
    "sessions.start": (p) => s.sessions.start(p),
    "sessions.send": ({ sessionId, text, attachments }) => s.sessions.send(sessionId, text, attachments),
    "sessions.resume": ({ sessionId, prompt, attachments }) => s.sessions.resume(sessionId, prompt, attachments),
    "sessions.rewind": ({ sessionId, messageUuid, dryRun }) => s.sessions.rewind(sessionId, messageUuid, dryRun),
    "system.commands": ({ projectId }) => s.sessions.commands(projectId),
    "sessions.stop": ({ sessionId }) => s.sessions.stop(sessionId),
    "sessions.cancelAutoContinue": ({ sessionId }) => s.sessions.cancelAutoContinue(sessionId),
    "sessions.close": ({ sessionId }) => s.sessions.close(sessionId),
    "sessions.setModel": ({ sessionId, model }) => s.sessions.setModel(sessionId, model),
    "sessions.setEffort": ({ sessionId, effort }) => s.sessions.setEffort(sessionId, effort),
    "sessions.setPermissionMode": ({ sessionId, mode }) => s.sessions.setPermissionMode(sessionId, mode),
    "sessions.respondApproval": ({ sessionId, requestId, decision, scope, message, answers }) =>
      s.sessions.respondApproval(sessionId, requestId, decision, scope, message, answers),
    "sessions.contextUsage": ({ sessionId }) => s.sessions.contextUsage(sessionId),
    "search.sessions": ({ query, limit }) => s.db.searchEvents(query, limit),

    "devserver.state": ({ projectId }) => s.devServers.state(projectId),
    "devserver.start": ({ projectId }) => s.devServers.start(projectId),
    "devserver.stop": ({ projectId }) => s.devServers.stop(projectId),
    "devserver.output": ({ projectId }) => ({ text: s.devServers.output(projectId) }),

    "devtools.get": ({ projectId }) => s.devTools.get(projectId),
    "devtools.update": ({ projectId, ...patch }) => s.devTools.update(projectId, patch),
    "devtools.envFiles": ({ projectId }) => s.devTools.envFiles(projectId),
    "devtools.readEnvFile": async ({ projectId, name }) => ({ text: await s.devTools.readEnvFile(projectId, name) }),

    "testdb.state": ({ projectId }) => s.testDb.state(projectId),
    "testdb.start": ({ projectId }) => s.testDb.start(projectId),
    "testdb.stop": ({ projectId }) => s.testDb.stop(projectId),
    "testdb.reset": ({ projectId }) => s.testDb.reset(projectId),
    "testdb.log": ({ projectId }) => ({ text: s.testDb.log(projectId) }),

    "knowledge.list": ({ projectId }) => s.knowledge.list(projectId),
    "knowledge.read": ({ projectId, id }) => s.knowledge.read(projectId, id),
    "knowledge.save": ({ projectId, ...input }) => s.knowledge.save(projectId, input),
    "knowledge.delete": async ({ projectId, id }) => ({ ok: await s.knowledge.delete(projectId, id) }),

    "app.updateState": () => s.updates.get(),
    "app.presence": ({ focused, active, window }) => {
      s.presence.report(window, focused, active);
      return {};
    },
    "app.checkUpdate": () => s.updates.check(),
    "app.downloadUpdate": () => s.updates.download(),
    "app.prepareInstall": ({ cancel }) => s.sessions.prepareUpdateRestart(!cancel),
    "app.installUpdate": () => s.updates.requestInstall(),
    "app.changelog": () => s.updates.changelog(),

    "backup.list": () => s.backups.list(),
    "backup.create": () => s.backups.create("manual"),
    "backup.export": ({ id, path }) => s.backups.exportTo(path, id),
    "backup.inspect": ({ path }) => s.backups.inspect(path),
    "backup.restore": async ({ id, path, parts }) => {
      const r = await s.backups.restore({ id, path }, parts);
      diagCache = null;
      return r;
    },

    "sync.status": () => s.sync.status(),
    "sync.now": () => s.sync.now(),
    "sync.probe": () => s.sync.probe(),
    "sync.cloneProject": ({ key }) => s.sync.cloneProject(key),
    "sync.setPassphrase": ({ passphrase }) => s.sync.setPassphrase(passphrase),
    "sync.resetRemote": ({ passphrase }) => s.sync.resetRemote(passphrase),
    "sync.forceLocal": ({ key }) => s.sync.forceLocal(key),
    "sync.keep": ({ key }) => s.sync.keep(key),
    "sync.versions": () => s.sync.versions(),
    "sync.restoreVersion": ({ sha, parts }) => s.sync.restoreVersion(sha, parts),

    "phone.config": () => s.phone.config(),
    "phone.saveConfig": (patch) => s.phone.saveConfig(patch),
    "phone.state": () => s.phone.state(),
    "phone.setEnabled": ({ enabled }) => s.phone.setEnabled(enabled),
    "phone.testCall": () => s.phone.testCall(),
    "phone.hangup": () => s.phone.hangup(),
    "phone.deskTest": () => s.phone.deskTest(),
    "phone.calls": ({ limit }) => s.phone.calls(limit),
    "voice.prewarm": (p) => {
      s.dictation.prewarm(p);
      return {};
    },
    "voice.start": (p) => s.dictation.start(p),
    "voice.audio": ({ id, pcm }) => {
      s.dictation.audio(id, pcm);
      return {};
    },
    "voice.stop": ({ id }) => s.dictation.stop(id),
    "voice.cancel": ({ id }) => {
      s.dictation.cancel(id);
      return {};
    },

    "git.status": ({ projectId }) => s.git.status(gitDir(projectId)),
    "git.diff": ({ projectId, path, staged }) => s.git.diff(gitDir(projectId), path, staged),
    "git.stage": async ({ projectId, paths }) => {
      await s.git.stage(gitDir(projectId), paths);
      return gitChanged(projectId);
    },
    "git.unstage": async ({ projectId, paths }) => {
      await s.git.unstage(gitDir(projectId), paths);
      return gitChanged(projectId);
    },
    "git.commit": async ({ projectId, message, paths, allowSensitive }) => {
      const r = await s.git.commit(gitDir(projectId), message, paths, allowSensitive);
      s.notifyProject(projectId);
      return r;
    },
    "git.log": ({ projectId, limit }) => s.git.log(gitDir(projectId), limit),
    "git.authorAvatars": async ({ projectId, limit }) => {
      const dir = gitDir(projectId);
      return s.github.authorAvatars(await s.git.remoteUrl(dir), await s.git.log(dir, limit));
    },
    "git.restoreTo": async ({ projectId, commit }) => {
      const busy = s.sessions
        .listAll()
        .some((x) => x.projectId === projectId && x.live && (x.status === "running" || x.status === "waiting_approval"));
      if (busy) throw new ForgeError("SESSION_BUSY", "Eine aktive Session arbeitet gerade in diesem Projekt. Erst stoppen, dann wiederherstellen.");
      const r = await s.git.restoreTo(gitDir(projectId), commit);
      s.notifyProject(projectId);
      return r;
    },
    "git.branches": ({ projectId }) => s.git.branches(gitDir(projectId)),
    "git.deleteBranch": async ({ projectId, branch, force }) => {
      await s.git.deleteBranch(gitDir(projectId), branch, force);
      s.notifyProject(projectId);
      return s.git.branches(gitDir(projectId));
    },
    "git.checkout": async ({ projectId, branch, create }) => {
      const busy = s.sessions
        .listAll()
        .some((x) => x.projectId === projectId && x.live && (x.status === "running" || x.status === "waiting_approval"));
      if (busy) throw new ForgeError("SESSION_BUSY", "Eine aktive Session arbeitet gerade in diesem Projekt. Erst stoppen, dann Branch wechseln.");
      await s.git.checkout(gitDir(projectId), branch, create);
      return gitChanged(projectId);
    },
    "git.suggestCommitMessage": ({ projectId, paths }) => {
      s.projects.requireGit(projectId);
      return s.sessions.suggestCommitMessage(projectId, paths);
    },
    "git.push": async ({ projectId, allowProtected }) => {
      try {
        const r = await s.git.push(gitDir(projectId), allowProtected);
        s.notifyProject(projectId);
        return { branch: r.branch, integrated: r.integrated, session: null };
      } catch (e) {
        const session = await resolveInSession(projectId, e, true);
        if (!session) throw e;
        return { branch: null, integrated: null, session };
      }
    },
    "git.pull": async ({ projectId }) => {
      try {
        const r = await s.git.pull(gitDir(projectId));
        s.notifyProject(projectId);
        return { ...r, session: null };
      } catch (e) {
        const session = await resolveInSession(projectId, e, false);
        if (!session) throw e;
        return { output: "Claude führt die Stände zusammen.", integrated: null, session };
      }
    },
    "git.fetch": async ({ projectId }) => {
      await s.git.fetch(gitDir(projectId));
      return gitChanged(projectId);
    },
    "github.pr": ({ projectId }) => s.github.prForBranch(gitDir(projectId)),
    "github.suggestPr": ({ projectId }) => {
      s.projects.requireGit(projectId);
      return s.sessions.suggestPullRequest(projectId);
    },
    "github.createPr": async ({ projectId, title, body, base, draft }) => {
      const dir = gitDir(projectId);
      const head = await s.git.currentBranch(dir);
      if (!head) throw new ForgeError("GIT_FAILED", "Kein Branch ausgecheckt.");
      if (head === base) throw new ForgeError("VALIDATION", "Ziel- und Quell-Branch sind gleich. Lege zuerst einen Feature-Branch an.");
      // The PR needs the branch on GitHub; pushing a feature branch is always allowed.
      await s.git.push(dir, false);
      const url = await s.github.createPr(dir, { title, body, base, head, draft });
      s.notifyProject(projectId);
      return { url };
    },
    "git.init": async ({ projectId }) => {
      await s.git.init(gitDir(projectId));
      return gitChanged(projectId);
    },
  };
}
