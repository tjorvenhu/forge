/** German texts (core.automation). Source of the keys: the English file is typed against this one. */
export const automation = {
  // worktrees.ts
  /** fallback of a branch slug without usable letters; lowercase a-z only */
  slugFallback: "aufgabe",
  needsGitRepo: "Worktrees brauchen ein Git-Repository.",
  needsCommit: "Das Repository braucht mindestens einen Commit.",
  invalidBranch: (branch: string) => `Ungültiger Branch-Name: ${branch}`,
  originNoCommit: "Der Ausgangsstand hat noch keinen Commit.",
  createFailed: "Worktree konnte nicht angelegt werden",
  snapshotFailed: (detail: string) => `Nicht committeter Stand nicht übernommen: ${detail}`,
  gitStepFailed: (command: string) => `git ${command} fehlgeschlagen`,
  snapshotCommit: (branch: string | null) => `FORGE: nicht committeter Stand${branch ? ` von ${branch}` : ""} für den Agenten`,
  removeFailed: "Worktree konnte nicht entfernt werden",
  notWorktreeProject: "Das ist kein Worktree-Projekt.",
  uncommittedChanges: (n: number) => `Der Worktree hat ${n} nicht committete Änderungen.`,
  branchUnknown: "Der Branch des Worktrees war nicht mehr zu ermitteln.",
  repoNotFound: (dir: string) => `Das Repository zu diesem Worktree wurde nicht gefunden: ${dir}`,
  folderInUse: (detail: string) =>
    `Der Worktree-Ordner wird noch von einem anderen Programm benutzt, etwa einem Terminal, Editor oder Explorer-Fenster. Schließe es und versuche es noch einmal. (${detail})`,
  foreignBranch: (branch: string) => `Den Branch ${branch} hat nicht FORGE für diesen Agenten angelegt, er bleibt erhalten.`,

  // agent-finish.ts
  notAgentWorktree: "Das ist kein Agent-Worktree.",
  blockerFolderMissing: "Der Ordner des Agenten fehlt.",
  blockerTargetGone: "Das Projekt, in das die Arbeit zurückgehen soll, ist nicht mehr da.",
  blockerNoBranch: "Im Worktree des Agenten ist kein Branch ausgecheckt.",
  blockerNoTargetBranch: "Im Projekt ist kein Branch ausgecheckt.",
  blockerBusy: "Der Agent arbeitet noch.",
  blockerOriginGone: (origin: string) =>
    `Der Agent ist von ${origin} abgezweigt, diesen Branch gibt es nicht mehr. Lege ${origin} wieder an, dann lässt sich der Agent zusammenführen.`,
  blockerNoWork: "Der Agent hat nichts geändert.",
  discardedBranchKept: (error: string) => `Agent verworfen, aber der Branch blieb: ${error}`,
  discardedForeign: (foreign: string) => `Agent verworfen. ${foreign}`,
  discarded: (branch: string | null) => `Agent verworfen${branch ? `, Branch ${branch} gelöscht` : ""}.`,
  remainingCommit: (branch: string) => `Restliche Änderungen von ${branch}`,
  conflictMessage: (target: string, files: string[]) =>
    `${target} hat sich seit dem Start des Agenten geändert, die Änderungen kollidieren${files.length ? ` in ${files.join(", ")}` : ""}. Der Agent löst die Konflikte jetzt, danach kannst du erneut zusammenführen.`,
  commitsTaken: (commits: number, branch: string, target: string) => `${commits === 1 ? "1 Commit" : `${commits} Commits`} von ${branch} in ${target} übernommen`,
  folderNotDeleted: (done: string, why: string) => `${done}. Der Worktree-Ordner ließ sich aber nicht löschen: ${why}`,
  mergedAllDeleted: (done: string) => `${done}, Worktree und Branch gelöscht.`,
  mergedWorktreeDeleted: (done: string, rest: string) => `${done}, Worktree gelöscht. ${rest}`,
  branchKept: (error: string) => `Der Branch blieb aber: ${error}`,
  notTaken: (branch: string, target: string) => `${branch} ließ sich nicht in ${target} übernehmen.`,
  /** prefix of a merge that has to wait; the auto-merge strips it with notMergedYet("") */
  notMergedYet: (why: string) => `Noch nicht zusammengeführt: ${why}`,
  waitSessionBusy: (target: string, files: string[]) =>
    `In ${target} arbeitet gerade eine Session, und es gibt dort nicht committete Änderungen an Dateien, die auch der Agent geändert hat (${files.join(", ") || "siehe git status"}).`,
  waitUntracked: (files: string[]) => `Im Projekt liegen neue, nicht committete Dateien, die der Agent ebenfalls angelegt hat: ${files.join(", ")}.`,
  dryRunFailed: "Probelauf des Zusammenführens fehlgeschlagen.",
  waitClash: (files: string[]) =>
    `Die nicht committeten Änderungen im Projekt und die Arbeit des Agenten betreffen dieselben Stellen${files.length ? ` in ${files.join(", ")}` : ""}.`,
  stashMessage: (branch: string) => `FORGE: beiseitegelegt beim Zusammenführen von ${branch}`,
  stashFailed: "Offene Änderungen ließen sich nicht beiseitelegen.",
  stashPopFailed: (detail: string) =>
    `Die offenen Änderungen im Projekt ließen sich nicht vollständig zurücklegen; sie liegen weiter im Stash (git stash list). ${detail}`,
  conflictPrompt: (branch: string, target: string, behind: number, files: string[]) =>
    [
      `Ich wollte deinen Branch ${branch} in ${target} übernehmen. Auf ${target} gibt es seit deinem Start ${behind} neue Commits, die mit deinen Änderungen kollidieren in:`,
      files.length ? files.map((f) => `- ${f}`).join("\n") : "- (git hat keine Dateien genannt)",
      "",
      "Dein Branch ist unverändert.",
      "",
      "Bitte:",
      `1. Committe zuerst alles Offene, dann \`git merge ${target}\` (kein Rebase: so löst du jeden Konflikt nur einmal).`,
      "2. Löse die Konflikte so, dass deine Änderungen und die neuen Commits erhalten bleiben. Wenn nicht klar ist, welche Seite gelten soll: frag mich mit AskUserQuestion und rate nicht.",
      "3. Prüf danach, ob das Projekt noch baut und die Tests laufen, sofern es dafür einen Befehl gibt.",
      "4. Nicht pushen. Fass am Ende kurz zusammen, wie du jeden Konflikt aufgelöst hast. Danach übernimmt FORGE deinen Branch.",
    ].join("\n"),

  // agent-auto-merge.ts
  waitingBackground: "Wartet aufs Zusammenführen: Der Agent hat noch laufende Hintergrundaufgaben. FORGE führt ihn zusammen, sobald sie beendet sind.",
  notAutoMerged: (reason: string) => `Nicht automatisch zusammengeführt: ${reason}`,
  testsFailed: "Die Tests sind fehlgeschlagen.",
  conflictsRemain: (target: string, rounds: number) => `Die Konflikte mit ${target} sind nach ${rounds} Versuchen noch da.`,
  waitingMerge: (why: string) =>
    `Wartet aufs Zusammenführen: ${why} FORGE führt den Agenten selbst zusammen, sobald es passt: nach dem nächsten Durchlauf im Projekt (samt Auto-Commit), sonst beim nächsten Versuch in einer halben Minute.`,
  autoMerged: (message: string) => `Automatisch zusammengeführt: ${message}`,

  // worktree-setup.ts
  stepFiles: "Lokale Konfiguration",
  stepDeps: "Abhängigkeiten",
  stepBuild: "Build-Ausgaben",
  stepDatabase: "Test-Datenbank",
  stepDevserver: "Dev-Server",
  ownPortFlag: (port: number) => `Eigener Port dieses Agenten: ${port}`,
  ownPortEnv: (port: number) => `Eigener Port dieses Agenten: ${port} (als PORT übergeben; liest der Server ihn nicht, nutzt er seinen eigenen)`,
  setupRunningFor: (time: string) => `läuft seit ${time}`,
  setupFinished: (failed: boolean, time: string) => `${failed ? "mit Fehlern beendet" : "fertig"} nach ${time}`,
  statusPending: "wartet",
  statusRunning: "läuft",
  statusDone: "fertig",
  statusSkipped: "übersprungen",
  statusFailed: "fehlgeschlagen",
  setupHeader: (head: string) => `Vorbereitung des Worktrees (FORGE, ${head}):`,
  setupFailedHint: "  Was fehlgeschlagen ist, kannst du selbst nachholen, z. B. die Installation mit dem gleichen Befehl.",
  contextPort: (port: number) => ` Dein Dev-Server hat einen eigenen Port (${port}), getrennt vom Hauptprojekt; dev_control startet ihn.`,
  contextReady: (port: string) =>
    `Dein Worktree ist vorbereitet wie der Hauptordner (Abhängigkeiten, lokale Konfiguration, Build-Ausgaben, eigene Test-Datenbank).${port} Stand und Fehler zeigt dev_environment.`,
  contextRunning: (steps: string[]) =>
    `FORGE bereitet deinen Worktree gerade vor wie den Hauptordner (${steps.join(", ")}). Installiere Abhängigkeiten nicht selbst, das läuft schon; bis dahin kannst du lesen und planen.`,
  contextWait: "Vor dem ersten Build, Test oder Dev-Server-Start: mcp__forge__dev_environment mit wait=true wartet, bis die Vorbereitung fertig ist, und zeigt, was fehlgeschlagen ist.",
  cancelled: "abgebrochen",
  mainFolderMissing: "Hauptordner nicht gefunden.",
  noLocalConfig: "Keine lokalen Konfigurationsdateien im Hauptordner.",
  nothingToCopy: "Nichts zu kopieren.",
  copiedFiles: (names: string[]) => {
    const list = names.length > 6 ? `${names.slice(0, 6).join(", ")} und ${names.length - 6} weitere` : names.join(", ");
    return `${names.length} ${names.length === 1 ? "Datei" : "Dateien"} kopiert: ${list}`;
  },
  noLockfile: "Kein Lockfile gefunden.",
  installFailed: (command: string, code: number | null, output: string) => `${command} fehlgeschlagen (Exit-Code ${code ?? "?"}): ${output}`,
  rustDeps: (dir: string) => `Rust-Abhängigkeiten (${dir})`,
  rustDepsFailed: (dir: string, detail: string) => `Rust-Abhängigkeiten nicht kopiert (${dir}: ${detail})`,
  copied: (dir: string) => `${dir} kopiert`,
  notCopied: (dir: string, error: string) => `${dir} nicht kopiert: ${error}`,
  nothingToTake: "Nichts zu übernehmen.",
  robocopyCode: (code: number | null) => `robocopy Code ${code ?? "?"}`,
  noTestDb: "Das Projekt hat keine Test-Datenbank.",
  ownTestDb: "Eigene Test-Datenbank vorhanden.",
  testDbRunning: "Die Datenbank des Projekts läuft gerade und lässt sich so nicht kopieren. Der erste Start legt eine eigene, leere an (Migrationen danach ausführen).",
  testDbCopied: "Eigene Kopie der Datenbank des Projekts, eigener Port beim Start.",
  noDevCommand: "Kein Dev-Server-Befehl bekannt.",
  port: (port: number) => `Port ${port}`,
  ownPort: "eigener Port",
  devRunning: (port: string) => `läuft (${port})`,
  devOnDemand: (port: string) => `startet bei Bedarf (${port})`,
  devExited: (code: number | null) => `beendet${code !== null ? ` mit Exit-Code ${code}` : ""}`,
  devStarted: (port: string) => `gestartet, weil der des Projekts läuft (${port})`,
};
