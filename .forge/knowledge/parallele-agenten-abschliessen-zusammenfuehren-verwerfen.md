---
title: "Parallele Agenten abschließen (Zusammenführen/Verwerfen)"
summary: "Wie FORGE fertige Agenten-Worktrees zusammenführt oder verwirft (von Hand oder per auto-merge), was bei nicht committeten Änderungen im Projekt passiert (mitnehmen oder warten), wo der Ursprung gespeichert ist, wann das Modal erscheint und was bei zu langen Windows-Pfaden passiert."
tags: ["agenten","worktree","git","merge","auto-merge","windows"]
updated: "2026-10-13T14:49:54.329Z"
---

Kern: `packages/sidecar/src/automation/agent-finish.ts` (`AgentFinisher`), RPC `agents.review` / `agents.finish`, MCP-Werkzeug `finish_agent` (autoAllow false), Telefon-Werkzeug `finish_agent`.

`finish_agent` in Sessions erreicht alle Agenten des Projekts: eigene über ihr Kürzel, fremde (Agenten-Reiter, Telefon, andere Sessions) über ihren Branch, mit oder ohne `agent/`. `agent_status` ohne Argument listet die fremden mit. Die eigene Worktree-Session kann sich nicht selbst abschließen. Neue Werkzeuge bekommt eine Session erst nach ihrem (Neu-)Start, also nach einem FORGE-Neustart mit neuem Build.

Agenten brauchen ein Git-Repository mit mindestens einem Commit (`WorktreeService.create` wirft sonst GIT_NOT_REPO bzw. GIT_FAILED). Ohne Git gibt es keine Agenten.

## Ablauf Zusammenführen
1. Nicht committete Änderungen im Worktree werden committet ("Restliche Änderungen von <branch>").
2. Hat der Ziel-Branch neue Commits: `git rebase refs/heads/<ziel>` im Worktree. Bei Konflikt: `rebase --abort`, der Agent bekommt per `sessions.send` einen Auftrag zum Auflösen (ohne Session: neue Session im Worktree). Ergebnis `outcome: "conflict"`, Worktree bleibt.
3. Im Zielordner `fastForward()`: erst `git merge --ff-only refs/heads/<branch>`. Scheitert das an nicht committeten Änderungen dort ("would be overwritten", auch "untracked working tree files"):
   - Arbeitet eine Session im Zielordner (`sessions.listLive()`, Status running/waiting_approval/…, gleicher cwd): **warten**, nichts anfassen. Ihre Dateien dürfen nicht unter ihr weggestasht werden.
   - Neue, nicht committete Datei mit demselben Namen wie eine Datei des Agenten: warten.
   - Sonst Probelauf ohne Änderung am Arbeitsbaum: `git stash create` (Commit der offenen Arbeit) und `git merge-tree --write-tree --name-only --no-messages --merge-base=HEAD refs/heads/<branch> <stash>` (Exit 0 sauber, 1 Konflikt, sonst Fehler). Sauber: `stash push`, `merge --ff-only`, `stash pop`. Die offenen Änderungen der Hauptsession bleiben danach nicht committet erhalten. Konflikt (dieselben Zeilen): warten.
   - Warten = `outcome: "waiting"`, Meldung „Noch nicht zusammengeführt: <Grund>“, Worktree und Zielordner unverändert.
4. `removeWorktree(..., { deleteBranch: true })`: Session beendet, Ordner, FORGE-Eintrag und Branch weg. Scheitert das Löschen nach erfolgreichem Fast-Forward, gilt der Merge trotzdem als `merged` (Hinweis in der Meldung), der Branch wird mit `git branch -d` gelöscht.

Verwerfen = `removeWorktree(force, deleteBranch nur wenn ein Branch ermittelbar ist)`. So räumt es auch halb entfernte Agenten auf (Branch schon gelöscht, Ordner ohne `.git`).

Windows: Ein Worktree-Ordner lässt sich nicht löschen, solange eine Claude-Session darin läuft ("Permission denied"). Agenten deshalb über FORGE entfernen (Agenten-Reiter, Modal, Telefon, `finish_agent`), nicht per `git worktree remove` oder `rm`. FORGE beendet die Session vorher. Git checkt Dateien in Tests mit CRLF aus: Inhalte zeilenendungsneutral vergleichen.

## Stolperfalle: zu lange Pfade (Windows)
Agenten-Worktrees haben eigenes `node_modules` (pnpm) mit Pfaden über 260 Zeichen. `git worktree remove` brach mit `error: failed to delete '…': Filename too long` ab, nachdem es die `.git`-Datei schon gelöscht hatte: git kannte den Worktree nicht mehr, Ordner, FORGE-Eintrag und Branch blieben.
Abhilfe (2026-10-13):
- `GitEngine.exec` setzt immer `-c core.longpaths=true`.
- `WorktreeService.deleteFolder` löscht bei „Filename too long“ mit Node `rm` (kann lange Pfade), danach `worktree prune`.
- `AgentAutoMerge.run`: Hat der Worktree-Ordner keine `.git` mehr, sind es Reste eines schon abgeschlossenen Agenten; sie werden still per discard aufgeräumt.
Reste von Hand aufräumen: prüfen mit `git log --oneline main..<branch>` (0 Commits = alles in main), dann `finish_agent` discard und `git branch -d <branch>`.

## Automatisch zusammenführen (Tag auto-merge)
`packages/sidecar/src/automation/agent-auto-merge.ts` (`AgentAutoMerge`), gebaut in `SessionService.useAgentFinisher`, `dispose()` in `SessionService.shutdown`. Auslöser: `TurnAutomation.schedule` ruft nach der Nach-Durchlauf-Arbeit (Tests, Auto-Commit) `host.turnDone(sessionId, testsOk)`, aber nur, wenn keine zurückgehaltene Nachricht nachfolgt.
- Entscheidend ist das Tag am Hauptprojekt (`autoMergeOn`), nicht am Worktree: Worktrees kopieren die Tags nur beim Anlegen. Der Schalter in den Projekt-Einstellungen ist deshalb bei Worktrees ausgeblendet (`rootOnly`), das Telefon (`project_automation`) setzt auto-merge immer am Hauptprojekt.
- Kein Merge bei laufenden Hintergrund-Aufgaben (still, der nächste Durchlauf versucht es), bei roten Tests oder `mergeBlocker` (dann `outcome: skipped`).
- **Warten:** Liefert der Finisher `waiting`, merkt sich AgentAutoMerge den Agenten (`waiting`-Map, nur im Speicher, geht bei Neustart verloren) und meldet einmal „Wartet aufs Zusammenführen: …“ (Ereignis `automation` mit `action: "wait"`, ServerEvent `agent.autoMerge` mit `outcome: "waiting"`, Toast in Info-Farbe). Neue Versuche still: am Ende **jedes** Durchlaufs irgendeiner Session (`turnDone` ruft zuerst `retryWaiting`; nach dem Auto-Commit der Hauptsession passt es meist) und alle `WAITING_RETRY_MS` (2 min) per Timer, solange jemand wartet. Verschwundene Worktrees oder abgeschaltetes auto-merge fallen aus der Liste.
- Konflikte gehen höchstens `MAX_CONFLICT_ROUNDS` (3) mal an den Agenten zurück, gezählt im Speicher je Worktree.
- Meldung als `automation`-Ereignis mit `action: "merge"` (ok=false heißt Konflikt), `"wait"` bzw. `"skip"` im Agenten-Chat und im Chat der startenden Session, dazu ServerEvent `agent.autoMerge`.
- Mit auto-merge öffnet der Desktop nie von selbst ein Modal (Wunsch des Nutzers): `skipped` wird ein Toast mit Knopf „Ansehen“, der den Abschluss-Dialog öffnet (`apps/desktop/src/lib/agent-review.ts`, `agentAutoMerged`).
- Manuelles Zusammenführen im Dialog mit `waiting`: Warn-Toast mit Grund, ohne automatische Wiederholung (ohne auto-merge).
- Agenten bekommen im Start-Kontext den Hinweis, Rückfragen nur per AskUserQuestion zu stellen: Ein Durchlauf, der mit einer Frage im Text endet, würde sonst sofort zusammengeführt.

## Wohin die Arbeit zurückgeht
`WorktreeService.create` speichert beim Anlegen eines neuen Branches in der Repo-Config `branch.<name>.forgeOriginDir` (Ordner, von dem abgezweigt wurde, also fromDir oder Hauptprojekt) und `branch.<name>.forgeOriginBranch`. `git branch -D` entfernt diese Sektion mit. Fehlt der Eintrag (ältere Agenten) oder ist der Ordner weg: Hauptprojekt und dessen aktueller Branch. Ist im Zielordner inzwischen ein anderer Branch als forgeOriginBranch ausgecheckt, wird das Zusammenführen blockiert (mergeBlocker), statt in den falschen Branch zu mergen.

## Modal im Hauptfenster (ohne auto-merge)
`apps/desktop/src/lib/agent-review.ts` reagiert auf `turn.result` (kein Fehler, nicht unterbrochen) einer Session in einem Worktree-Projekt (parentId) und legt das Projekt in die Warteschlange `stores/agent-review.ts`. Nicht ausgelöst, wenn die Session gerade im Hauptfenster offen ist, noch Hintergrund-Aufgaben laufen oder das Hauptprojekt auto-merge hat. Manuell: Knopf "Agent abschließen" im Kopf eines Worktrees und "Abschließen" im Agenten-Reiter. "Später" nimmt es aus der Warteschlange; das nächste Turn-Ende fragt erneut.

## Seitenleiste
Sessions eines Worktrees stehen in `OpenSessions` unter dem Hauptprojekt (`groupOf` in `lib/session-tabs.ts`), markiert mit Bot-Symbol. Klick öffnet weiter das Worktree-Projekt.
