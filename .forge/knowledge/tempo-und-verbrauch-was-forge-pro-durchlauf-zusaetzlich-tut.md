---
title: "Tempo und Verbrauch: was FORGE pro Durchlauf zusätzlich tut (Auto-Test nur wenn nötig)"
summary: "Wo FORGE neben Claude Zeit und Abo-Nutzung kostet (Auto-Test, Auto-Commit, Git, Haiku), wann auto-test übersprungen wird, was optimiert ist, Aufräumen von Subagenten-Worktrees. Bei Beschwerden über Langsamkeit, zu viele Tests oder hohen Verbrauch."
tags: ["performance","git","auto-commit","usage","sidecar","tests","worktree"]
updated: "2026-10-17T11:38:27.578Z"
---

Stand: 2026-10-17. Analyse überwiegend per Code-Lesen.

## Die API-Anfragen selbst bremst FORGE nicht
Gleiches Modell/Effort wie im Terminal (Einstellung defaultModel/defaultEffort), angehängter Kontext ca. 2–3k Token (Wissensindex max. 60 Einträge/6000 Zeichen) plus ca. 2k Token Werkzeug-Schemas, gecacht.

## Zeit kostet die Arbeit drumherum
1. **Auto-Test und Auto-Commit halten die nächste Nachricht zurück** (`sessions/turn-automation.ts` schedule/afterTurn, `turns.ts` „Wartet auf Tests und Auto-Commit…“). Auto-Commit: git status, Haiku-Aufruf für die Commit-Nachricht (`claude-assist.ts` suggestCommitMessage, neuer claude.exe-Prozess), Commit, ggf. Push. Typisch 5–20 s.
2. **git status vor jeder Nachricht** (`turns.ts` captureBaseline): 3 Git-Prozesse.
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
- Gemessen in `session-service.test.ts` („tests a realistic series of six turns twice instead of six times“): 6 Durchläufe (Code, Frage, Doku, Code+Claude testet, Code nach Claudes Test, Dank) → 2 Testläufe statt 6.

## Bereits optimiert (2026-10-14)
- `GitEngine.diff(cwd, file, staged, known?)`: suggestCommitMessage gibt den schon gelesenen Status mit, statt pro Datei erneut `status` (3 Prozesse) zu starten.
- `createGitRefresher` merkt sich tool.use-IDs von Lese-Werkzeugen (READ_ONLY_TOOLS); deren tool.result löst keinen Git-Refresh aus.
- Session idle/stopped: `refreshProjectInList` lädt nur dieses Projekt neu und setzt es in die Projektliste, statt `projects.list` (git status in allen Projekten) neu zu holen.

## Verbrauch (Abo)
Hauptsächlich die Opus-Sessions selbst. Zusätzlich: `agentProgressSummaries: true` (CLI fasst laufende Subagenten ca. alle 30 s zusammen), FORGE-Agenten (volle neue Session), Auto-Continue nach Limit-Reset und Kontext-Recovery (/compact) mit vollem Kontext, Haiku-Commit-Nachricht pro Durchlauf (Diff bis 30k Zeichen), Titel (max. 1/min). planUsage/probe/commands starten claude.exe ohne Modellaufruf: CPU, kein Verbrauch.

## Subagenten-Worktrees (.claude/worktrees/agent-*)
Kommen vom Agent-Werkzeug von Claude Code (isolation worktree), FORGE fordert das nirgends an. Claude Code selbst entfernt sie sofort nur, wenn der Subagent nichts geändert hat. Mit Änderungen bleiben Worktree und Branch `worktree-agent-<hex>` stehen, auch nachdem die Haupt-Session den Branch gemergt hat. Claude Code räumt sie erst in seinem Retention-Sweep weg (`cleanupStaleAgentWorktrees` in claude.exe): nur älter als `cleanupPeriodDays` (Standard 30 Tage), sauber, nicht gelockt und HEAD auf einem Remote.

FORGE räumt deshalb selbst auf: `automation/subagent-worktrees.ts` `pruneSubagentWorktrees`, aufgerufen in `SessionService` über `turnDone` nach jedem Durchlauf in einem Hauptprojekt (nicht in FORGE-Agenten-Worktrees). Entfernt nur Worktrees, die nicht gelockt (laufender Subagent), sauber und in den aktuellen Branch gemergt sind, samt Branch (`branch -d`). Ohne `.claude/worktrees` startet es keinen Git-Prozess. Das ist auch wichtig für Tests: ein Git-Prozess nach Durchlaufende hielte sonst unter Windows den Temp-Ordner fest (EPERM beim Aufräumen in session-service.test.ts). Siehe [[parallele-agenten-abschliessen-zusammenfuehren-verwerfen]].
