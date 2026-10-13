import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Project, ServerEvent, SessionEventBody } from "@forge/protocol";
import { sessionEnv } from "../claude/environment.js";
import type { Db } from "../persistence/db.js";
import { isArtifactPath, isSensitiveFile, type GitEngine } from "../git/git.js";
import { runUserCommand } from "../util/shell.js";
import type { ProjectManager } from "../projects/project-manager.js";

export interface AutomationHost {
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  suggestCommitMessage(projectId: string, paths: string[]): Promise<{ message: string }>;
  /** test environment and test database URL of the project (dev tools) */
  testEnv?(projectId: string): Record<string, string>;
  /** the post-turn work is done and no held turn follows; testsOk is false when auto-test failed */
  turnDone?(sessionId: string, testsOk: boolean): Promise<void>;
}

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
    const p = this.git.status(cwd).then(
      (st) => void this.baseline.set(sessionId, new Set(st.files.map((f) => f.path))),
      () => void this.baseline.set(sessionId, new Set()),
    );
    this.track(p);
    return p;
  }

  noteTurnStart(sessionId: string) {
    this.turnSeq.set(sessionId, (this.turnSeq.get(sessionId) ?? 0) + 1);
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
  }

  /** The notes about commits and pushes since Claude's last message, once; null when there are none. */
  takeNote(sessionId: string): string | null {
    const list = this.notes.get(sessionId);
    this.notes.delete(sessionId);
    if (!list?.length) return null;
    return [
      "[FORGE-Hinweis, nicht vom Nutzer geschrieben] Nach deinem letzten Durchlauf hat FORGE selbst gearbeitet (Projekt-Tags auto-commit/auto-push):",
      ...list.map((l) => `- ${l}`),
      "Diese Commits und Pushes stammen von FORGE, nicht von jemand anderem. Soll committet oder gepusht werden, prüfe mit git status und git log, was noch offen ist, committe nur das und push dann. Erwähne die FORGE-Commits nicht als Überraschung.",
    ].join("\n");
  }

  private report(sessionId: string, body: Extract<SessionEventBody, { type: "automation" }>) {
    this.host.record(sessionId, body);
    const line =
      body.action === "commit"
        ? body.ok
          ? `Commit ${body.hash?.slice(0, 7) ?? ""} „${body.message}“ mit ${body.files.length} Datei(en): ${body.files.slice(0, 8).join(", ")}${body.files.length > 8 ? ", …" : ""}`
          : `Auto-Commit fehlgeschlagen: ${body.message}. Die Änderungen sind nicht committet.`
        : body.action === "push"
          ? `${body.message} (automatischer Push)`
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
    const holds = !!project && (project.tags.includes("auto-commit") || (project.tags.includes("auto-test") && !!project.testCommand));
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
    if (!tags.has("auto-commit")) return this.runTests(sessionId, project.id, project.testCommand, tags, cwd);
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
    const testsOk = await this.runTests(sessionId, project.id, project.testCommand, tags, cwd);

    if (tags.has("review-required")) {
      this.report(sessionId, { type: "automation", action: "skip", ok: true, message: "Auto-Commit übersprungen: review-required verlangt eine Prüfung im Git-Bereich.", hash: null, files: [] });
      return testsOk;
    }
    if (!testsOk) {
      this.report(sessionId, { type: "automation", action: "skip", ok: false, message: "Auto-Commit übersprungen: Tests sind fehlgeschlagen.", hash: null, files: [] });
      return false;
    }
    if (!files.length) return true;
    // A turn from the Claude app or a background task may have started meanwhile; it bypasses the hold.
    const after = await this.hashFiles(cwd, files);
    if ((this.turnSeq.get(sessionId) ?? 0) !== seq || files.some((f) => before.get(f) !== after.get(f))) {
      this.report(sessionId, { type: "automation", action: "skip", ok: true, message: "Auto-Commit übersprungen: Dateien haben sich nach dem Durchlauf weiter geändert. Bitte im Git-Bereich prüfen.", hash: null, files: [] });
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
          this.report(sessionId, { type: "automation", action: "skip", ok: true, message: `Auto-Push übersprungen: ${branch ?? "ohne Branch"} ist geschützt.`, hash: null, files: [] });
        } else {
          await this.git.push(cwd, false);
          this.report(sessionId, { type: "automation", action: "push", ok: true, message: `Gepusht: ${branch}`, hash: r.hash, files: [] });
        }
      }
    } catch (e) {
      this.report(sessionId, { type: "automation", action: "commit", ok: false, message: e instanceof Error ? e.message : String(e), hash: null, files });
    }
  }

  /** Runs the project's test command when auto-test is set; true when green or not configured. */
  private async runTests(sessionId: string, projectId: string, testCommand: string | null, tags: Set<string>, cwd: string): Promise<boolean> {
    if (!tags.has("auto-test") || !testCommand) return true;
    this.host.record(sessionId, { type: "status", status: "idle", detail: `Tests laufen: ${testCommand}` });
    let testEnv: Record<string, string> = {};
    try {
      testEnv = this.host.testEnv?.(projectId) ?? {};
    } catch {
      /* tests run without the test environment */
    }
    const r = await runUserCommand(testCommand, cwd, { ...sessionEnv(this.db.getSettings().stripApiKey), ...testEnv });
    const ok = r.exitCode === 0 && !r.timedOut;
    this.host.record(sessionId, { type: "check.result", command: testCommand, ok, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output });
    return ok;
  }
}
