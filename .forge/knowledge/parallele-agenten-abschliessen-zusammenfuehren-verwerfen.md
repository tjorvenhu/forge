---
title: "Parallele Agenten abschließen (Zusammenführen/Verwerfen)"
summary: "Wie FORGE fertige Agenten-Worktrees zusammenführt oder verwirft (von Hand oder per auto-merge), wo der Ursprung gespeichert ist und wann das Modal erscheint."
tags: ["agenten","worktree","git","merge","auto-merge"]
updated: "2026-10-13T11:44:01.420Z"
---

Kern: `packages/sidecar/src/automation/agent-finish.ts` (`AgentFinisher`), RPC `agents.review` / `agents.finish`, MCP-Werkzeug `finish_agent` (autoAllow false), Telefon-Werkzeug `finish_agent`.

`finish_agent` in Sessions erreicht alle Agenten des Projekts: eigene über ihr Kürzel, fremde (Agenten-Reiter, Telefon, andere Sessions) über ihren Branch, mit oder ohne `agent/`. `agent_status` ohne Argument listet die fremden mit. Die eigene Worktree-Session kann sich nicht selbst abschließen. Neue Werkzeuge bekommt eine Session erst nach ihrem (Neu-)Start, also nach einem FORGE-Neustart mit neuem Build.

Agenten brauchen ein Git-Repository mit mindestens einem Commit (`WorktreeService.create` wirft sonst GIT_NOT_REPO bzw. GIT_FAILED). Ohne Git gibt es keine Agenten.

## Ablauf Zusammenführen
1. Nicht committete Änderungen im Worktree werden committet ("Restliche Änderungen von <branch>").
2. Hat der Ziel-Branch neue Commits: `git rebase refs/heads/<ziel>` im Worktree. Bei Konflikt: `rebase --abort`, der Agent bekommt per `sessions.send` einen Auftrag zum Auflösen (ohne Session: neue Session im Worktree). Ergebnis `outcome: "conflict"`, Worktree bleibt.
3. Im Zielordner `git merge --ff-only refs/heads/<branch>`. Absichtlich ohne autostash: Überschneidet sich die Arbeit mit nicht committeten Dateien dort, bricht git sicher ab (CONFLICT-Meldung).
4. `removeWorktree(..., { deleteBranch: true })`: Session beendet, Ordner, FORGE-Eintrag und Branch weg.

Verwerfen = `removeWorktree(force, deleteBranch nur wenn ein Branch ermittelbar ist)`. So räumt es auch halb entfernte Agenten auf (Branch schon gelöscht, Ordner ohne `.git`).

Windows: Ein Worktree-Ordner lässt sich nicht löschen, solange eine Claude-Session darin läuft ("Permission denied"). Agenten deshalb über FORGE entfernen (Agenten-Reiter, Modal, Telefon, `finish_agent`), nicht per `git worktree remove` oder `rm`. FORGE beendet die Session vorher.

## Automatisch zusammenführen (Tag auto-merge)
`packages/sidecar/src/automation/agent-auto-merge.ts` (`AgentAutoMerge`), gebaut in `SessionService.useAgentFinisher`. Auslöser: `TurnAutomation.schedule` ruft nach der Nach-Durchlauf-Arbeit (Tests, Auto-Commit) `host.turnDone(sessionId, testsOk)`, aber nur, wenn keine zurückgehaltene Nachricht nachfolgt.
- Entscheidend ist das Tag am Hauptprojekt (`autoMergeOn`), nicht am Worktree: Worktrees kopieren die Tags nur beim Anlegen. Der Schalter in den Projekt-Einstellungen ist deshalb bei Worktrees ausgeblendet (`rootOnly`), das Telefon (`project_automation`) setzt auto-merge immer am Hauptprojekt.
- Kein Merge bei laufenden Hintergrund-Aufgaben (still, der nächste Durchlauf versucht es), bei roten Tests oder `mergeBlocker` (dann `outcome: skipped`).
- Konflikte gehen höchstens `MAX_CONFLICT_ROUNDS` (3) mal an den Agenten zurück, gezählt im Speicher je Worktree.
- Meldung als `automation`-Ereignis mit `action: "merge"` (ok=false heißt Konflikt) bzw. `"skip"` im Agenten-Chat und im Chat der startenden Session, dazu ServerEvent `agent.autoMerge`. Der Desktop zeigt einen Toast und öffnet bei `skipped` den Abschluss-Dialog (`apps/desktop/src/lib/agent-review.ts`, `agentAutoMerged`).
- Agenten bekommen im Start-Kontext den Hinweis, Rückfragen nur per AskUserQuestion zu stellen: Ein Durchlauf, der mit einer Frage im Text endet, würde sonst sofort zusammengeführt.

## Wohin die Arbeit zurückgeht
`WorktreeService.create` speichert beim Anlegen eines neuen Branches in der Repo-Config `branch.<name>.forgeOriginDir` (Ordner, von dem abgezweigt wurde, also fromDir oder Hauptprojekt) und `branch.<name>.forgeOriginBranch`. `git branch -D` entfernt diese Sektion mit. Fehlt der Eintrag (ältere Agenten) oder ist der Ordner weg: Hauptprojekt und dessen aktueller Branch. Ist im Zielordner inzwischen ein anderer Branch als forgeOriginBranch ausgecheckt, wird das Zusammenführen blockiert (mergeBlocker), statt in den falschen Branch zu mergen.

## Modal im Hauptfenster
`apps/desktop/src/lib/agent-review.ts` reagiert auf `turn.result` (kein Fehler, nicht unterbrochen) einer Session in einem Worktree-Projekt (parentId) und legt das Projekt in die Warteschlange `stores/agent-review.ts`. Nicht ausgelöst, wenn die Session gerade im Hauptfenster offen ist, noch Hintergrund-Aufgaben laufen oder das Hauptprojekt auto-merge hat (dann entscheidet der Sidecar). Manuell: Knopf "Agent abschließen" im Kopf eines Worktrees und "Abschließen" im Agenten-Reiter. "Später" nimmt es aus der Warteschlange; das nächste Turn-Ende fragt erneut.

## Seitenleiste
Sessions eines Worktrees stehen in `OpenSessions` unter dem Hauptprojekt (`groupOf` in `lib/session-tabs.ts`), markiert mit Bot-Symbol. Klick öffnet weiter das Worktree-Projekt.
