import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitStatus, Project, ServerEvent, SessionEventBody } from "@forge/protocol";
import { sessionEnv } from "../claude/environment.js";
import type { Db } from "../persistence/db.js";
import { isArtifactPath, isSensitiveFile, type GitEngine } from "../git/git.js";
import { runUserCommand } from "../util/shell.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { analyzeTurn, equivalentTestCommands, isTestRelevant, scopedTestCommand } from "./test-gate.js";
import { tr } from "../i18n/index.js";

export interface AutomationHost {
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  suggestCommitMessage(projectId: string, paths: string[]): Promise<{ message: string }>;
  /** test environment and test database URL of the project (dev tools) */
  testEnv?(projectId: string): Record<string, string>;
  /** the post-turn work is done and no held turn follows; testsOk is false when auto-test failed */
  turnDone?(sessionId: string, testsOk: boolean): Promise<void>;
  /** a CLI turn started (also a message joining the running turn) */
  turnStarted?(sessionId: string): void;
}

/** The last state of a project folder auto-test looked at. */
interface TestedState {
  /** worktreeTree of the folder then; null without git */
  tree: string | null;
  command: string;
  ok: boolean;
  /** the tests really ran on it (by FORGE or by Claude), not just a start without changes */
  ran: boolean;
}

type TestPlan = { skip: string; ok: boolean } | { skip: null; command: string; remember: (ok: boolean) => void };

/** A turn FORGE holds back while the previous turn's tests and auto-commit run. */
export interface HeldTurn {
  deliver(): void;
  /** the session ended or was stopped before the turn could be sent */
  drop(reason: string): void;
}

/**
 * Work after a successful turn, driven by the project tags (auto-test, auto-commit, auto-push). Runs in the background; new FORGE messages for the session wait until it is done, so
 * the commit only contains what the finished turn changed.
 */
export class TurnAutomation {
  /** Files already changed before a turn; auto-commit never takes those (foreign dirty state). */
  private baseline = new Map<string, Set<string>>();
  /** counts CLI turn starts per session; a change during afterTurn means a new turn touched files */
  private turnSeq = new Map<string, number>();
  private running = new Map<string, Promise<void>>();
  private held = new Map<string, HeldTurn[]>();
  private background = new Set<Promise<unknown>>();
  /**
   * What the post-turn work did, for Claude. Without it Claude finds commits it did not make and
   * reports them as someone else's work; the next message it gets tells it they came from FORGE.
   */
  private notes = new Map<string, string[]>();
  /** Project changes a running session must know about (git switched on or off), for its next message. */
  private hints = new Map<string, string>();
  /** Failed auto-test runs, for Claude's next message: Claude leaves the full suite to FORGE and must learn its result. */
  private testNotes = new Map<string, string>();
  /** per project folder: what auto-test last saw, so an unchanged folder is not tested again */
  private tested = new Map<string, TestedState>();
  /** per session: tool events after this seq are not yet looked at by auto-test */
  private toolSeq = new Map<string, number>();
  /** per session: where Claude's shell is (a cd persists between its commands) */
  private shellDirs = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    private readonly git: GitEngine,
    private readonly host: AutomationHost,
  ) {}

  track(p: Promise<unknown>) {
    const done = p.catch(() => {}).finally(() => this.background.delete(done));
    this.background.add(done);
  }

  /** Waits for post-turn work (tests, auto-commit) and other tracked background work to finish. */
  async drain() {
    while (this.background.size) await Promise.all([...this.background]);
  }

  /** Callers often do not await this; tracking it lets drain() and shutdown wait for the git process. */
  captureBaseline(sessionId: string, cwd: string): Promise<void> {
    // Only the first turn moves the start; later ones keep tool events of interrupted turns for auto-test.
    if (!this.toolSeq.has(sessionId)) this.toolSeq.set(sessionId, this.lastSeq(sessionId));
    const p = this.git.status(cwd).then(
      (st) => void this.baseline.set(sessionId, new Set(st.files.map((f) => f.path))),
      () => void this.baseline.set(sessionId, new Set()),
    );
    this.track(p);
    return p;
  }

  noteTurnStart(sessionId: string) {
    this.turnSeq.set(sessionId, (this.turnSeq.get(sessionId) ?? 0) + 1);
    this.host.turnStarted?.(sessionId);
  }

  /** True while the post-turn work of the session runs; new turns must be held. */
  isBusy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  hold(sessionId: string, turn: HeldTurn) {
    const list = this.held.get(sessionId) ?? [];
    list.push(turn);
    this.held.set(sessionId, list);
  }

  /** Drops held turns (stop, session end); returns how many there were. */
  dropHeld(sessionId: string, reason: string): number {
    const list = this.held.get(sessionId) ?? [];
    this.held.delete(sessionId);
    for (const t of list) t.drop(reason);
    return list.length;
  }

  forget(sessionId: string) {
    this.baseline.delete(sessionId);
    this.turnSeq.delete(sessionId);
    this.held.delete(sessionId);
    this.notes.delete(sessionId);
    this.hints.delete(sessionId);
    this.testNotes.delete(sessionId);
    this.toolSeq.delete(sessionId);
    this.shellDirs.delete(sessionId);
  }

  private lastSeq(sessionId: string): number {
    return this.db.listEvents(sessionId, 0, { limit: 1 })[0]?.seq ?? 0;
  }

  /** Replaces an earlier hint of the session: only the latest project state counts. */
  hint(sessionId: string, text: string) {
    this.hints.set(sessionId, text);
  }

  /** The project hint and the notes about commits and pushes since Claude's last message, once; null when there are none. */
  takeNote(sessionId: string): string | null {
    const hint = this.hints.get(sessionId);
    this.hints.delete(sessionId);
    const tests = this.testNotes.get(sessionId);
    this.testNotes.delete(sessionId);
    const commits = this.commitNote(sessionId);
    const parts = [hint ? tr().core.sessions.hint(hint) : "", tests ?? "", commits ?? ""].filter(Boolean);
    return parts.length ? parts.join("\n\n") : null;
  }

  private commitNote(sessionId: string): string | null {
    const list = this.notes.get(sessionId);
    this.notes.delete(sessionId);
    if (!list?.length) return null;
    const m = tr().core.sessions;
    return [m.commitNoteHead, ...list.map((l) => `- ${l}`), m.commitNoteTail].join("\n");
  }

  private report(sessionId: string, body: Extract<SessionEventBody, { type: "automation" }>) {
    this.host.record(sessionId, body);
    const m = tr().core.sessions;
    const line =
      body.action === "commit"
        ? body.ok
          ? m.commitLine(body.hash?.slice(0, 7) ?? "", body.message, body.files.length, `${body.files.slice(0, 8).join(", ")}${body.files.length > 8 ? ", …" : ""}`)
          : m.autoCommitFailedLine(body.message)
        : body.action === "push"
          ? m.autoPushLine(body.message)
          : body.message;
    const list = this.notes.get(sessionId) ?? [];
    list.push(line);
    this.notes.set(sessionId, list);
  }

  /**
   * Starts the post-turn work of a successful turn. When it runs tests or commits, new turns are held
   * until it is done; without either there is nothing to wait for.
   */
  schedule(sessionId: string) {
    const rec = this.db.getSession(sessionId);
    const project = rec ? this.projects.get(rec.projectId) : null;
    const holds = !!project && ((project.gitEnabled && project.tags.includes("auto-commit")) || (project.tags.includes("auto-test") && !!project.testCommand));
    let testsOk = true;
    const p = this.afterTurn(sessionId)
      .then(
        (ok) => void (testsOk = ok),
        () => {},
      )
      .finally(() => {
        if (this.running.get(sessionId) === p) this.running.delete(sessionId);
        const list = this.held.get(sessionId) ?? [];
        this.held.delete(sessionId);
        for (const t of list) t.deliver();
        if (!list.length && this.host.turnDone) this.track(this.host.turnDone(sessionId, testsOk));
      });
    if (holds) this.running.set(sessionId, p);
    this.track(p);
  }

  private async hashFiles(cwd: string, files: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const f of files) {
      try {
        out.set(f, createHash("sha1").update(await readFile(path.join(cwd, f))).digest("hex"));
      } catch {
        out.set(f, "-");
      }
    }
    return out;
  }

  /** false only when auto-test ran and failed */
  private async afterTurn(sessionId: string): Promise<boolean> {
    const rec = this.db.getSession(sessionId);
    if (!rec) return true;
    const project = this.projects.get(rec.projectId);
    const cwd = rec.cwd;
    const seq = this.turnSeq.get(sessionId) ?? 0;
    const baseline = this.baseline.get(sessionId) ?? new Set<string>();
    const tags = new Set(project.tags);
    if (!project.gitEnabled || !tags.has("auto-commit")) return this.runTests(sessionId, project, tags, cwd, baseline);
    let status;
    try {
      status = await this.git.status(cwd);
    } catch {
      return true; // not a git repository: nothing to commit
    }
    const files = status.files
      .filter((f) => !baseline.has(f.path) && f.kind !== "conflicted" && !isSensitiveFile(f.path) && !isArtifactPath(f.path))
      .map((f) => f.path);
    const before = await this.hashFiles(cwd, files);
    const testsOk = await this.runTests(sessionId, project, tags, cwd, baseline, status);

    if (tags.has("review-required")) {
      this.report(sessionId, { type: "automation", action: "skip", ok: true, message: tr().core.sessions.skipReview, hash: null, files: [] });
      return testsOk;
    }
    if (!testsOk) {
      this.report(sessionId, { type: "automation", action: "skip", ok: false, message: tr().core.sessions.skipTestsFailed, hash: null, files: [] });
      return false;
    }
    if (!files.length) return true;
    // A turn from the Claude app or a background task may have started meanwhile; it bypasses the hold.
    const after = await this.hashFiles(cwd, files);
    if ((this.turnSeq.get(sessionId) ?? 0) !== seq || files.some((f) => before.get(f) !== after.get(f))) {
      this.report(sessionId, { type: "automation", action: "skip", ok: true, message: tr().core.sessions.skipChangedAgain, hash: null, files: [] });
      return true;
    }
    let message: string;
    try {
      message = (await this.host.suggestCommitMessage(project.id, files)).message;
    } catch (e) {
      this.report(sessionId, { type: "automation", action: "commit", ok: false, message: e instanceof Error ? e.message : String(e), hash: null, files });
      return true;
    }
    await this.commitAndPush(sessionId, project, cwd, files, message, status.summary.branch);
    return true;
  }

  /** Commits the files and pushes when the project has auto-push. Sensitive files were filtered out before. */
  private async commitAndPush(sessionId: string, project: Project, cwd: string, files: string[], message: string, branch: string | null) {
    try {
      const r = await this.git.commit(cwd, message, files, false);
      this.report(sessionId, { type: "automation", action: "commit", ok: true, message: r.summary, hash: r.hash, files });
      this.host.emit({ event: "project.updated", payload: { projectId: project.id } });
      if (project.tags.includes("auto-push")) {
        if (!branch || branch === "main" || branch === "master") {
          this.report(sessionId, { type: "automation", action: "skip", ok: true, message: tr().core.sessions.skipPushProtected(branch), hash: null, files: [] });
        } else {
          await this.git.push(cwd, false);
          this.report(sessionId, { type: "automation", action: "push", ok: true, message: tr().core.sessions.pushed(branch), hash: r.hash, files: [] });
        }
      }
    } catch (e) {
      this.report(sessionId, { type: "automation", action: "commit", ok: false, message: e instanceof Error ? e.message : String(e), hash: null, files });
    }
  }

  /**
   * Runs the project's test command when auto-test is set and the tests are needed; true when green,
   * not configured or skipped on a green state. A skip on a state whose tests failed stays false.
   */
  private async runTests(sessionId: string, project: Project, tags: Set<string>, cwd: string, baseline: Set<string>, status?: GitStatus): Promise<boolean> {
    const testCommand = project.testCommand;
    if (!tags.has("auto-test") || !testCommand) return true;
    const plan = await this.planTests(sessionId, project, testCommand, cwd, baseline, status);
    if (plan.skip !== null) {
      // Only shown in the chat: Claude needs no note about tests that did not run.
      this.host.record(sessionId, { type: "automation", action: "skip", ok: plan.ok, message: plan.skip, hash: null, files: [] });
      return plan.ok;
    }
    this.host.record(sessionId, { type: "status", status: "idle", detail: tr().core.sessions.testsRunning(plan.command) });
    let testEnv: Record<string, string> = {};
    try {
      testEnv = this.host.testEnv?.(project.id) ?? {};
    } catch {
      /* tests run without the test environment */
    }
    const r = await runUserCommand(plan.command, cwd, { ...sessionEnv(this.db.getSettings().stripApiKey), ...testEnv });
    const ok = r.exitCode === 0 && !r.timedOut;
    this.host.record(sessionId, { type: "check.result", command: plan.command, ok, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output });
    plan.remember(ok);
    if (!ok) {
      this.testNotes.set(
        sessionId,
        tr().core.sessions.testsFailedNote(plan.command, r.timedOut, r.exitCode, r.output.slice(-1500)),
      );
    }
    return ok;
  }

  /**
   * Whether the tests have to run: not when nothing that can affect tests changed since auto-test
   * last looked at the folder, and not when Claude ran the full test command after its last change.
   * Changes come from comparing snapshots of the folder (worktreeTree); without an earlier snapshot
   * from git status against the turn's baseline plus the files Claude edited.
   */
  private async planTests(sessionId: string, project: Project, testCommand: string, cwd: string, baseline: Set<string>, status?: GitStatus): Promise<TestPlan> {
    const root = await rootTestScript(cwd);
    const events = this.db.listEventsOfTypes(sessionId, ["tool.use", "tool.result"], this.toolSeq.get(sessionId) ?? 0);
    this.toolSeq.set(sessionId, this.lastSeq(sessionId));
    const turn = analyzeTurn(events, cwd, equivalentTestCommands(testCommand, root), this.shellDirs.get(sessionId) ?? cwd);
    this.shellDirs.set(sessionId, turn.shellDir);

    const key = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    const prev = this.tested.get(key);
    // A changed test command makes the earlier result meaningless: it runs once.
    const last = prev?.command === testCommand ? prev : undefined;
    const tree = project.gitEnabled ? await this.git.worktreeTree(cwd).catch(() => null) : null;
    const remember = (ok: boolean, ran: boolean) => this.tested.set(key, { tree, command: testCommand, ok, ran });

    let changed: string[] | null = null;
    if (tree && last?.tree) changed = await this.git.treeChanges(cwd, last.tree, tree).catch(() => null);
    if (changed) {
      changed = [...new Set([...changed, ...turn.edited])];
    } else if (!turn.shellChanges && (!prev || last)) {
      // No snapshot to compare with: what the turn did. A shell command that may have written files
      // (or committed them, which git status no longer shows) leaves it unknown.
      const st = status ?? (project.gitEnabled ? await this.git.status(cwd).catch(() => null) : null);
      changed = [...new Set([...(st?.files.filter((f) => !baseline.has(f.path)).map((f) => f.path) ?? []), ...turn.edited])];
    }

    if (turn.testedAfterLastChange) {
      remember(true, true);
      return { skip: tr().core.sessions.testsAlreadyRan(testCommand), ok: true };
    }
    const relevant = changed?.filter((f) => isTestRelevant(f)) ?? null;
    if (relevant && !relevant.length) {
      const ok = last?.ok ?? true;
      remember(ok, last?.ran ?? false);
      if (!ok) {
        return {
          skip: changed!.length
            ? tr().core.sessions.testsNotRerunIrrelevant
            : tr().core.sessions.testsNotRerunUnchanged,
          ok,
        };
      }
      if (changed!.length) {
        const shown = changed!.slice(0, 3).join(", ") + (changed!.length > 3 ? ", …" : "");
        return { skip: tr().core.sessions.testsSkippedIrrelevant(shown), ok };
      }
      return { skip: last?.ran ? tr().core.sessions.testsSkippedSinceLast : tr().core.sessions.testsSkippedNoChanges, ok };
    }
    // After a failed run the whole suite runs: the failure may sit in a package that did not change since.
    const scoped =
      relevant && (!last || last.ok)
        ? scopedTestCommand(testCommand, root, relevant, (dir) => existsSync(path.join(cwd, dir, "package.json")), existsSync(path.join(cwd, "pnpm-workspace.yaml")))
        : null;
    return { skip: null, command: scoped ?? testCommand, remember: (ok) => remember(ok, true) };
  }
}

/** scripts.test of the project's package.json, null without one */
async function rootTestScript(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.test === "string" ? pkg.scripts.test : null;
  } catch {
    return null;
  }
}
