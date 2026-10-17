import type { WorktreeSetup } from "../automation/worktree-setup.js";
import type { DevServerPrep, DevServerService } from "../devserver/dev-server.js";
import type { DevToolsService } from "./dev-tools.js";
import type { TestDbService } from "./test-db.js";

export type DevTarget = "dev-server" | "database";
export type DevAction = "start" | "stop" | "restart" | "reset";

/** Output lines Claude gets from the dev server. */
const CLAUDE_OUTPUT_LINES = 40;

function lastLines(text: string, n: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-n).join("\n");
}

/**
 * Brings the dev tools together: what the dev server and the test command get (test environment,
 * database URL), and what Claude can see and do through the FORGE tools.
 */
export class DevEnvironment {
  constructor(
    private readonly devTools: DevToolsService,
    private readonly testDb: TestDbService,
    private readonly devServers: () => DevServerService,
    /** preparation of agents' worktrees: their own dev server port and what is still being set up */
    private readonly setup: () => WorktreeSetup | null = () => null,
  ) {}

  /** Before the dev server starts: test environment, the database if it starts along, its URL, an agent's own port. */
  async devServerPrep(projectId: string, command?: string): Promise<DevServerPrep> {
    const cfg = this.devTools.get(projectId);
    const env = this.devTools.testVariables(projectId);
    const notes: string[] = [];
    const names = Object.keys(env);
    if (names.length) notes.push(`Test-Umgebung: ${names.join(", ")}`);
    const own = command ? await this.setup()?.devServerPort(projectId, command) : null;
    if (own) {
      Object.assign(env, own.env);
      notes.push(own.note);
    }
    if (cfg.database.withDevServer && !this.testDb.isRunning(projectId)) {
      try {
        await this.testDb.start(projectId);
      } catch (e) {
        notes.push(e instanceof Error ? e.message : String(e));
      }
    }
    const url = this.testDb.runningUrl(projectId);
    if (url && cfg.database.envVar) {
      env[cfg.database.envVar] = url;
      notes.push(`${cfg.database.envVar} zeigt auf die Test-Datenbank (${url.replace(/^.*@/, "")})`);
    }
    return { env, notes, command: own?.command };
  }

  /** Start context of a session in an agent's worktree: what FORGE prepares there. */
  setupContext(projectId: string): string {
    return this.setup()?.context(projectId) ?? "";
  }

  /** For the auto-test command: same variables, the database only when it already runs. */
  testCommandEnv(projectId: string): Record<string, string> {
    const env = this.devTools.testVariables(projectId);
    const envVar = this.devTools.get(projectId).database.envVar;
    const url = this.testDb.runningUrl(projectId);
    if (url && envVar) env[envVar] = url;
    return env;
  }

  /**
   * Current state for Claude (FORGE tool dev_environment). Values of the test environment stay out.
   * `waitMs`: in an agent's worktree, first wait that long for its preparation.
   */
  async describe(projectId: string, waitMs = 0): Promise<string> {
    const setup = this.setup();
    if (setup && waitMs > 0) await setup.wait(projectId, waitMs);
    const prepared = setup?.describe(projectId) ?? "";
    const cfg = this.devTools.get(projectId);
    const db = this.testDb.state(projectId);
    const dev = await this.devServers().state(projectId);
    const out = this.devServers().output(projectId);
    const testVars = Object.keys(this.devTools.testVariables(projectId));
    const lines = [
      prepared,
      "Dev-Server:",
      `  Status: ${dev.status}${dev.exitCode !== null ? ` (Exit-Code ${dev.exitCode})` : ""}`,
      `  Befehl: ${dev.command ?? dev.effectiveCommand ?? "keiner eingerichtet"}`,
      dev.url ? `  Adresse: ${dev.url}` : "",
      "Test-Datenbank (PostgreSQL " + db.version + ", nur lokal):",
      `  Status: ${db.status}${db.error ? `, Fehler: ${db.error}` : ""}`,
      `  Verbindung: ${db.url}`,
      `  Startet mit dem Dev-Server: ${cfg.database.withDevServer ? "ja" : "nein"}${cfg.database.envVar ? `, übergeben als ${cfg.database.envVar} (an Dev-Server und Testbefehl, solange sie läuft)` : ""}`,
      `Test-Umgebung: ${cfg.useEnv ? (testVars.length ? `aktiv, Variablen ${testVars.join(", ")} (Werte stehen nur in FORGE)` : "aktiv, aber leer") : "aus"}`,
      out.trim() ? `Letzte Ausgabe des Dev-Servers:\n${lastLines(out, CLAUDE_OUTPUT_LINES)}` : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  async control(projectId: string, target: DevTarget, action: DevAction): Promise<string> {
    if (target === "database") {
      if (action === "start") return `Test-Datenbank läuft: ${(await this.testDb.start(projectId)).url}`;
      if (action === "stop") return (await this.testDb.stop(projectId), "Test-Datenbank gestoppt.");
      if (action === "restart") {
        await this.testDb.stop(projectId);
        return `Test-Datenbank neu gestartet: ${(await this.testDb.start(projectId)).url}`;
      }
      const running = this.testDb.isRunning(projectId);
      await this.testDb.reset(projectId);
      if (running) await this.testDb.start(projectId);
      return running ? "Test-Datenbank geleert und neu gestartet." : "Test-Datenbank geleert. Der nächste Start legt sie leer an.";
    }
    const dev = this.devServers();
    if (action === "reset") return "Fehler: reset gibt es nur für die Datenbank.";
    if (action === "stop") return (await dev.stop(projectId), "Dev-Server gestoppt.");
    if (action === "restart") await dev.stop(projectId);
    const s = await dev.start(projectId);
    return `Dev-Server ${action === "restart" ? "neu gestartet" : "gestartet"}: ${s.command ?? ""}. Die Adresse steht nach ein paar Sekunden in dev_environment.`;
  }
}
