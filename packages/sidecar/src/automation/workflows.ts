import { randomUUID } from "node:crypto";
import { ForgeError, type WorkflowOptions, type WorkflowRun, type WorkflowStepId, type WorkflowStepState } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import { isArtifactPath, isSensitiveFile, type GitEngine } from "../git/git.js";
import type { GitHubService } from "../github/github.js";
import type { ProjectManager } from "../projects/project-manager.js";
import type { SessionService } from "../sessions/session-service.js";
import { sessionEnv } from "../claude/environment.js";
import { runUserCommand } from "../util/shell.js";
import { slugify, type WorktreeService } from "./worktrees.js";

const ORDER: WorkflowStepId[] = ["branch", "plan", "approve", "implement", "test", "review", "commit", "push", "pr"];
const PROFILE_MODE = { safe: "default", balanced: "acceptEdits", autonomous: "bypassPermissions" } as const;

interface Row {
  id: string;
  project_id: string;
  title: string;
  requirement: string;
  options: string;
  status: string;
  step: string;
  steps: string;
  branch: string | null;
  session_id: string | null;
  work_project_id: string | null;
  pr_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toRun(r: Row): WorkflowRun {
  return {
    id: r.id,
    projectId: r.project_id,
    workProjectId: r.work_project_id,
    title: r.title,
    requirement: r.requirement,
    options: JSON.parse(r.options) as WorkflowOptions,
    status: r.status as WorkflowRun["status"],
    step: r.step as WorkflowStepId,
    steps: JSON.parse(r.steps) as WorkflowStepState[],
    branch: r.branch,
    sessionId: r.session_id,
    prUrl: r.pr_url,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * One-click feature workflow: branch/worktree, plan (optionally approved), implementation, tests,
 * review, commit, push, pull request. Each step is persisted; waiting steps resume after a restart.
 * A failed step stops the run and is shown as failed, never as success.
 */
export class WorkflowService {
  private running = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
    private readonly git: GitEngine,
    private readonly github: GitHubService,
    private readonly sessions: SessionService,
    private readonly worktrees: WorktreeService,
    private readonly emit: (run: WorkflowRun) => void,
  ) {
    // Runs that were mid-step when the app stopped cannot continue that step blindly.
    this.db.sql
      .prepare("UPDATE workflows SET status = 'failed', error = 'Unterbrochen: FORGE wurde während eines Schritts beendet.' WHERE status = 'running'")
      .run();
  }

  list(projectId?: string): WorkflowRun[] {
    const rows = (projectId
      ? this.db.sql.prepare("SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").all(projectId)
      : this.db.sql.prepare("SELECT * FROM workflows ORDER BY created_at DESC LIMIT 100").all()) as unknown as Row[];
    return rows.map(toRun);
  }

  get(id: string): WorkflowRun {
    const r = this.db.sql.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new ForgeError("NOT_FOUND", "Workflow nicht gefunden.");
    return toRun(r);
  }

  private save(run: WorkflowRun) {
    run.updatedAt = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE workflows SET status = ?, step = ?, steps = ?, branch = ?, session_id = ?, work_project_id = ?, pr_url = ?, error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(run.status, run.step, JSON.stringify(run.steps), run.branch, run.sessionId, run.workProjectId, run.prUrl, run.error, run.updatedAt, run.id);
    this.emit(run);
  }

  private mark(run: WorkflowRun, step: WorkflowStepId, status: WorkflowStepState["status"], message: string | null = null) {
    run.steps = run.steps.map((s) => (s.step === step ? { ...s, status, message, at: new Date().toISOString() } : s));
    run.step = step;
    this.save(run);
  }

  start(input: { projectId: string; title: string; requirement: string; branch?: string; options: WorkflowOptions }): WorkflowRun {
    const project = this.projects.requireExisting(input.projectId);
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: randomUUID(),
      projectId: project.id,
      workProjectId: null,
      title: input.title,
      requirement: input.requirement,
      options: input.options,
      status: "running",
      step: "branch",
      steps: ORDER.map((step) => ({ step, status: "pending", message: null, at: null })),
      branch: input.branch?.trim() || `feature/${slugify(input.title)}`,
      sessionId: null,
      prUrl: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.sql
      .prepare(
        `INSERT INTO workflows(id, project_id, title, requirement, options, status, step, steps, branch, session_id, work_project_id, pr_url, error, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(run.id, run.projectId, run.title, run.requirement, JSON.stringify(run.options), run.status, run.step, JSON.stringify(run.steps), run.branch, now, now);
    this.emit(run);
    void this.advance(run.id);
    return run;
  }

  cancel(id: string): WorkflowRun {
    const run = this.get(id);
    if (run.status === "done" || run.status === "cancelled") return run;
    run.status = "cancelled";
    if (run.sessionId) void this.sessions.stop(run.sessionId).catch(() => {});
    this.mark(run, run.step, "failed", "Abgebrochen");
    return this.get(id);
  }

  /** User decision on the plan: approve, or send feedback for a revised plan. */
  async approvePlan(id: string, approve: boolean, feedback?: string): Promise<WorkflowRun> {
    const run = this.get(id);
    if (run.step !== "approve" || run.status !== "waiting") throw new ForgeError("CONFLICT", "Es wartet kein Plan auf Freigabe.");
    if (approve) {
      this.mark(run, "approve", "done", "Plan freigegeben");
      run.status = "running";
      this.save(run);
      void this.advance(id);
      return this.get(id);
    }
    if (!feedback?.trim() || !run.sessionId) throw new ForgeError("VALIDATION", "Bitte beschreiben, was am Plan geändert werden soll.");
    run.status = "running";
    this.mark(run, "approve", "running", "Plan wird überarbeitet");
    void (async () => {
      const wait = this.sessions.waitForTurn(run.sessionId!);
      await this.sessions.send(run.sessionId!, `Bitte überarbeite den Plan: ${feedback}`);
      const err = await wait;
      const cur = this.get(id);
      if (cur.status === "cancelled") return;
      if (err) return this.fail(cur, "approve", err);
      cur.status = "waiting";
      this.mark(cur, "approve", "waiting", "Überarbeiteter Plan wartet auf Freigabe");
    })();
    return this.get(id);
  }

  /** Continue after the review step or after failed tests ("weiter trotz Fehlern" is not offered). */
  continueReview(id: string): WorkflowRun {
    const run = this.get(id);
    if (run.step !== "review" || run.status !== "waiting") throw new ForgeError("CONFLICT", "Kein Review offen.");
    this.mark(run, "review", "done", "Geprüft");
    run.status = "running";
    this.save(run);
    void this.advance(id);
    return this.get(id);
  }

  /** After failed tests: let Claude fix them with the test output, then test again. */
  fixTests(id: string): WorkflowRun {
    const run = this.get(id);
    if (run.step !== "test" || run.status !== "waiting" || !run.sessionId) throw new ForgeError("CONFLICT", "Keine fehlgeschlagenen Tests offen.");
    const output = run.steps.find((s) => s.step === "test")?.message ?? "";
    run.status = "running";
    this.mark(run, "test", "running", "Claude behebt die Fehler");
    void (async () => {
      const wait = this.sessions.waitForTurn(run.sessionId!);
      await this.sessions.send(run.sessionId!, `Die Tests schlagen fehl. Behebe die Ursache, ohne Tests abzuschwächen.\n\nAusgabe:\n${output.slice(-6000)}`);
      const err = await wait;
      const cur = this.get(id);
      if (cur.status === "cancelled") return;
      if (err) return this.fail(cur, "test", err);
      await this.advance(id);
    })();
    return this.get(id);
  }

  private fail(run: WorkflowRun, step: WorkflowStepId, message: string) {
    run.status = "failed";
    run.error = message;
    this.mark(run, step, "failed", message);
  }

  private wait(run: WorkflowRun, step: WorkflowStepId, message: string) {
    run.status = "waiting";
    this.mark(run, step, "waiting", message);
  }

  /** Executes steps from the current one until the run waits, fails or is done. */
  private async advance(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      for (;;) {
        const run = this.get(id);
        if (run.status !== "running") return;
        const next = run.steps.find((s) => s.status === "pending" || s.status === "running");
        if (!next) {
          run.status = "done";
          this.save(run);
          return;
        }
        try {
          const outcome = await this.execute(run, next.step);
          if (outcome === "wait") return;
        } catch (e) {
          this.fail(this.get(id), next.step, e instanceof Error ? e.message : String(e));
          return;
        }
      }
    } finally {
      this.running.delete(id);
    }
  }

  private async execute(run: WorkflowRun, step: WorkflowStepId): Promise<"next" | "wait"> {
    const o = run.options;
    const parent = this.projects.requireExisting(run.projectId);
    const work = () => this.projects.requireExisting(run.workProjectId ?? run.projectId);
    const skip = (msg: string) => {
      this.mark(run, step, "skipped", msg);
      return "next" as const;
    };
    this.mark(run, step, "running");

    switch (step) {
      case "branch": {
        if (o.useWorktree) {
          const wt = await this.worktrees.create(parent, run.branch!);
          run.workProjectId = wt.id;
          this.mark(run, step, "done", `Worktree ${wt.path}`);
        } else {
          const st = await this.git.status(parent.path);
          if (st.files.length) throw new Error("Die Arbeitskopie hat nicht committete Änderungen. Erst committen oder die Option „Eigener Worktree“ wählen.");
          await this.git.checkout(parent.path, run.branch!, true);
          run.workProjectId = parent.id;
          this.mark(run, step, "done", `Branch ${run.branch}`);
        }
        return "next";
      }
      case "plan": {
        if (!o.approvePlan) return skip("Ohne Planfreigabe");
        const s = await this.sessions.start({ projectId: work().id, planOnly: true, prompt: planPrompt(run) });
        run.sessionId = s.id;
        this.save(run);
        const err = await this.sessions.waitForTurn(s.id);
        if (err) throw new Error(err);
        this.mark(run, step, "done", "Plan erstellt");
        return "next";
      }
      case "approve": {
        if (!o.approvePlan) return skip("Ohne Planfreigabe");
        this.wait(run, step, "Plan wartet auf deine Freigabe");
        return "wait";
      }
      case "implement": {
        const project = work();
        let err: string | null;
        if (run.sessionId) {
          await this.sessions.setPermissionMode(run.sessionId, PROFILE_MODE[project.profile]);
          const wait = this.sessions.waitForTurn(run.sessionId);
          await this.sessions.send(run.sessionId, "Der Plan ist freigegeben. Setze ihn jetzt vollständig um. Halte dich an die Projektregeln. Commite nicht selbst.");
          err = await wait;
        } else {
          const s = await this.sessions.start({ projectId: project.id, planOnly: false, prompt: implementPrompt(run) });
          run.sessionId = s.id;
          this.save(run);
          err = await this.sessions.waitForTurn(s.id);
        }
        if (err) throw new Error(err);
        this.mark(run, step, "done", "Umgesetzt");
        return "next";
      }
      case "test": {
        const project = work();
        if (!o.runTests) return skip("Tests abgewählt");
        if (!project.testCommand) return skip("Kein Testbefehl im Projekt hinterlegt");
        const r = await runUserCommand(project.testCommand, project.path, sessionEnv(this.db.getSettings().stripApiKey));
        if (r.exitCode !== 0 || r.timedOut) {
          this.wait(run, step, `Tests fehlgeschlagen (Code ${r.exitCode ?? "?"})\n${r.output.slice(-4000)}`);
          return "wait";
        }
        this.mark(run, step, "done", `Tests grün (${Math.round(r.durationMs / 1000)} s)`);
        return "next";
      }
      case "review": {
        if (!o.review) return skip("Ohne Review");
        this.wait(run, step, "Änderungen im Git-Bereich prüfen, dann fortsetzen");
        return "wait";
      }
      case "commit": {
        const project = work();
        const st = await this.git.status(project.path);
        const files = st.files.filter((f) => f.kind !== "conflicted" && !isSensitiveFile(f.path) && !isArtifactPath(f.path)).map((f) => f.path);
        if (!files.length) throw new Error("Es gibt keine Änderungen zum Committen.");
        const { message } = await this.sessions.suggestCommitMessage(project.id, files);
        const c = await this.git.commit(project.path, message, files, false);
        this.mark(run, step, "done", `${c.hash.slice(0, 7)} ${c.summary}`);
        return "next";
      }
      case "push": {
        if (!o.push && !o.createPr) return skip("Ohne Push");
        const r = await this.git.push(work().path, false);
        this.mark(run, step, "done", `Gepusht: ${r.branch}`);
        return "next";
      }
      case "pr": {
        if (!o.createPr) return skip("Ohne Pull Request");
        const project = work();
        const s = await this.sessions.suggestPullRequest(project.id);
        run.prUrl = await this.github.createPr(project.path, { ...s, draft: o.draftPr });
        this.mark(run, step, "done", run.prUrl);
        return "next";
      }
    }
  }
}

function planPrompt(run: WorkflowRun) {
  return `Aufgabe: ${run.title}\n\n${run.requirement}\n\nErstelle einen konkreten Umsetzungsplan (betroffene Dateien, Schritte, Tests). Noch nichts ändern.`;
}

function implementPrompt(run: WorkflowRun) {
  return `Aufgabe: ${run.title}\n\n${run.requirement}\n\nSetze die Aufgabe vollständig um und ergänze passende Tests. Halte dich an die Projektregeln. Commite nicht selbst.`;
}
