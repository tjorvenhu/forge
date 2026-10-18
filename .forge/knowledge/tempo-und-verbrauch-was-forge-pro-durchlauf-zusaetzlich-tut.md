---
title: "Tempo und Verbrauch: was FORGE pro Durchlauf zusätzlich tut (Auto-Test nur wenn nötig)"
summary: "Wo FORGE neben Claude Zeit und Abo-Nutzung kostet (Auto-Test, Auto-Commit, Git, Haiku, knowledge_save), gemessene Zahlen aus forge.db, wann auto-test übersprungen wird, Aufräumen von Subagenten-Worktrees. Bei Beschwerden über Langsamkeit, zu viele Tests oder hohen Verbrauch."
tags: ["performance","git","auto-commit","usage","sidecar","tests","worktree"]
updated: "2026-10-18T12:07:24.075Z"
---

Stand: 2026-10-18.

## Gemessen (2026-10-18, 293 Durchläufe vom 13.–18.10.)
Methode: `%APPDATA%\forge\forge.db*` (samt -wal) nach /tmp kopieren, mit `node:sqlite` (`new DatabaseSync(path, { readOnly: true })`) die Tabelle `events` lesen. Pro Durchlauf: `user.message` ts → `session.init` → erstes `assistant.*`/`tool.use` → `turn.result` (enthält `durationMs` = Zeit im CLI, `numTurns`). `user.message` wird erst nach `captureBaseline` (git status) aufgezeichnet, diese ca. 0,15–0,3 s fehlen in den Zeitstempeln.
- **Wanduhr minus CLI-`durationMs`**: Median 0,02 s, p90 1,1 s. Fast die ganze Zeit verbringt claude.exe selbst.
- **Kaltstart** (Prozess neu, z. B. nach IdleClose): 1,0–1,7 s bis `session.init`.
- **Erste Ausgabe des Modells**: Median 1,5–1,9 s (reine API-Latenz).
- **Zurückgehaltene Nachricht** („Wartet auf Tests und Auto-Commit…“): 2× in 5 Tagen, je ca. 5 s, beide Male „push“ direkt nach einem Durchlauf. Auto-Commit nach Durchlaufende typisch 5–9 s.
- **Kleine Aufgaben** (`numTurns` ≤ 3, 96 Stück): Median 16 s, p90 33 s, fast nur Modellzeit (Thinking und 300–5000 Ausgabe-Token). Effort ist in FORGE (`defaultEffort` "high") und im Terminal (`~/.claude/settings.json` modelSettings claude-opus-5-5 effortLevel "high") gleich.
- **Von FORGE angestoßene Zusatzschritte** (ToolSearch für Forge-Werkzeuge, knowledge_read/search/save/merge): ca. 7 % der gesamten Durchlaufzeit; bei Durchläufen mit ≤ 3 Schritten praktisch nie, bei 4–10 Schritten in 19 von 62, dort Median 8,6 s. Spürbar ist vor allem **knowledge_save am Ende**: 15–35 s (das Modell schreibt den Eintrag als Ausgabe-Token), bei kleinen Fixes teils mehr als die eigentliche Arbeit; die Fertig-Meldung kommt erst danach.

## Die API-Anfragen selbst bremst FORGE nicht
Gleiches Modell/Effort wie im Terminal (Einstellung defaultModel/defaultEffort), angehängter Kontext ca. 2–3k Token (Wissensindex max. 60 Einträge/6000 Zeichen) plus ca. 2k Token Werkzeug-Schemas, gecacht.

## Zeit kostet die Arbeit drumherum
1. **Auto-Test und Auto-Commit halten die nächste Nachricht zurück** (`sessions/turn-automation.ts` schedule/afterTurn, `turns.ts` hold). Auto-Commit: git status, Haiku-Aufruf für die Commit-Nachricht (`claude-assist.ts` suggestCommitMessage, neuer claude.exe-Prozess), Commit, ggf. Push.
2. **git status vor jeder neuen Nachricht** (`turns.ts` build → captureBaseline): ca. 0,2 s im FORGE-Repo.
3. **Desktop-Refreshs** (`apps/desktop/src/lib/server-events.ts`).
4. **PreToolUse-Hook ohne Matcher** (`runtime.ts`): jede Werkzeug-Nutzung geht durch die Sidecar-Policy (wenige ms).
5. Jedes Event: redact + synchrones SQLite-Insert mit FTS-Trigger.

## Auto-Test nur wenn nötig (seit 2026-10-17)
Der Nutzer beschwerte sich über ständige Testläufe. `TurnAutomation.planTests` (Logik in `sessions/test-gate.ts`) lässt den Testbefehl aus und meldet den Grund als `automation`-Ereignis `action: "skip"` mit Text „Tests übersprungen: …“ (Karte mit eigenem Titel, Ton info, in `chat-items.ts`):
- **Keine Änderung seit dem letzten Stand**: FORGE merkt sich pro Projektordner einen Git-Tree des Ordners (`GitEngine.worktreeTree`: Kopie des Index, `git add -A --ignore-errors` mit `GIT_INDEX_FILE`, `write-tree`; ca. 0,2 s im FORGE-Repo) und vergleicht mit `treeChanges` (`git diff --name-only --relative`). Erkennt so auch Änderungen per Bash und Commits innerhalb des Durchlaufs; der echte Index bleibt unberührt.
- **Nur Dateien ohne Einfluss auf Tests** (`isTestRelevant`): .md/.rst/.adoc, Bilder, LICENSE/CHANGELOG, `.forge/knowledge/`, `.claude/`, `.vscode/`, `.idea/`. Ausnahme: solche Dateien in test/tests/__tests__/fixtures/__snapshots__/e2e zählen (Testeingaben). `.txt` und `.mdx` zählen bewusst als relevant.
- **Claude hat die ganze Suite nach seiner letzten Änderung schon grün laufen lassen**: aus tool.use/tool.result (Bash/PowerShell, auch Subagenten). Gleichwertig sind `npm test`/`pnpm run test`/`yarn test` und das root-`scripts.test`; Teil-Läufe nicht. Mit `|`, `;` oder `||` gehört der Exit-Code einem anderen Befehl (`pnpm test | tail -20`), dann muss die Ausgabe „N passed“ ohne Fehlschlag zeigen. `cd` wird über Befehle hinweg verfolgt (Claudes Shell behält das Verzeichnis). Edit/Write auf relevante Dateien oder ein möglicherweise schreibender Shell-Befehl danach machen den Lauf ungültig.
- **Fehlgeschlagener Stand ohne Änderung**: wird nicht erneut getestet, bleibt aber rot (`ok: false`, „Tests nicht erneut ausgeführt“). Damit bleiben Auto-Commit und `testsOk` für Auto-Merge (`agent-auto-merge.ts`) korrekt; übersprungen auf grünem Stand gibt `testsOk = true`.
- Neuer Testbefehl: läuft einmal, unabhängig von Änderungen.
- **Nur betroffene Pakete**: Ist der Befehl `pnpm -r test` (direkt oder als root-Script von `pnpm test`) und es gibt `pnpm-workspace.yaml`, läuft `pnpm -r --filter "...{./paket}" test` (Paket plus Abhängige). Eine geänderte Datei außerhalb aller Pakete oder ein vorheriger roter Lauf: ganze Suite.
- Erster Durchlauf nach App-Start (kein gespeicherter Tree): git status gegen die Baseline plus Edit/Write-Pfade; ein möglicherweise schreibender Shell-Befehl gilt als „unbekannt“ und es wird getestet. Der Stand liegt nur im Speicher.
- Fehlgeschlagene FORGE-Tests bekommt Claude mit der nächsten Nachricht (`testNotes`, Ende der Ausgabe). Start-Kontext (`forge-tools.ts` `testLine`): gezielt testen, nicht ohne Änderung wiederholen, bei auto-test die ganze Suite FORGE überlassen.
- Gemessen in `session-service.test.ts` („tests a realistic series of six turns twice instead of six times“): 6 Durchläufe → 2 Testläufe statt 6.

## Bereits optimiert (2026-10-14)
- `GitEngine.diff(cwd, file, staged, known?)`: suggestCommitMessage gibt den schon gelesenen Status mit, statt pro Datei erneut `status` (3 Prozesse) zu starten.
- `createGitRefresher` merkt sich tool.use-IDs von Lese-Werkzeugen (READ_ONLY_TOOLS); deren tool.result löst keinen Git-Refresh aus.
- Session idle/stopped: `refreshProjectInList` lädt nur dieses Projekt neu und setzt es in die Projektliste, statt `projects.list` (git status in allen Projekten) neu zu holen.

## Verbrauch (Abo)
Hauptsächlich die Opus-Sessions selbst. Zusätzlich: `agentProgressSummaries: true` (CLI fasst laufende Subagenten ca. alle 30 s zusammen), FORGE-Agenten (volle neue Session), Auto-Continue nach Limit-Reset und Kontext-Recovery (/compact) mit vollem Kontext, Haiku-Commit-Nachricht pro Durchlauf (Diff bis 30k Zeichen), Titel (max. 1/min). planUsage/probe/commands starten claude.exe ohne Modellaufruf: CPU, kein Verbrauch.

## Subagenten-Worktrees (.claude/worktrees/agent-*)
Kommen vom Agent-Werkzeug von Claude Code (isolation worktree), FORGE fordert das nirgends an. Claude Code entfernt sie sofort nur, wenn der Subagent nichts geändert hat; sonst erst im Retention-Sweep (`cleanupPeriodDays`, Standard 30 Tage).

FORGE räumt deshalb selbst auf: `automation/subagent-worktrees.ts` `pruneSubagentWorktrees`, aufgerufen in `SessionService` über `turnDone` nach jedem Durchlauf in einem Hauptprojekt (nicht in FORGE-Agenten-Worktrees). Entfernt nur Worktrees, die nicht gelockt (laufender Subagent), sauber und in den aktuellen Branch gemergt sind, samt Branch (`branch -d`). Ohne `.claude/worktrees` startet es keinen Git-Prozess. Wichtig auch für Tests: ein Git-Prozess nach Durchlaufende hielte unter Windows den Temp-Ordner fest (EPERM in session-service.test.ts). Siehe [[parallele-agenten-abschliessen-zusammenfuehren-verwerfen]].
