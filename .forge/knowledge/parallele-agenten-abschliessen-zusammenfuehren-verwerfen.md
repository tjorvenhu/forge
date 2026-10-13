---
title: "Parallele Agenten abschließen (Zusammenführen/Verwerfen)"
summary: "Wie FORGE fertige Agenten-Worktrees zusammenführt oder verwirft, wo der Ursprung gespeichert ist und wann das Modal erscheint."
tags: ["agenten","worktree","git","merge"]
updated: "2026-10-13T09:25:11.815Z"
---

Kern: `packages/sidecar/src/automation/agent-finish.ts` (`AgentFinisher`), RPC `agents.review` / `agents.finish`, MCP-Werkzeug `finish_agent` (nur für startende Sessions, autoAllow false), Telefon-Werkzeug `finish_agent`.

## Ablauf Zusammenführen
1. Nicht committete Änderungen im Worktree werden committet ("Restliche Änderungen von <branch>").
2. Hat der Ziel-Branch neue Commits: `git rebase refs/heads/<ziel>` im Worktree. Bei Konflikt: `rebase --abort`, der Agent bekommt per `sessions.send` einen Auftrag zum Auflösen (ohne Session: neue Session im Worktree). Ergebnis `outcome: "conflict"`, Worktree bleibt.
3. Im Zielordner `git merge --ff-only refs/heads/<branch>`. Absichtlich ohne autostash: Überschneidet sich die Arbeit mit nicht committeten Dateien dort, bricht git sicher ab (CONFLICT-Meldung).
4. `removeWorktree(..., { deleteBranch: true })`: Session beendet, Ordner und Branch weg.

Verwerfen = `removeWorktree(force, deleteBranch)`.

## Wohin die Arbeit zurückgeht
`WorktreeService.create` speichert beim Anlegen eines neuen Branches in der Repo-Config `branch.<name>.forgeOriginDir` (Ordner, von dem abgezweigt wurde, also fromDir oder Hauptprojekt) und `branch.<name>.forgeOriginBranch`. `git branch -D` entfernt diese Sektion mit. Fehlt der Eintrag (ältere Agenten) oder ist der Ordner weg: Hauptprojekt und dessen aktueller Branch. Ist im Zielordner inzwischen ein anderer Branch als forgeOriginBranch ausgecheckt, wird das Zusammenführen blockiert (mergeBlocker), statt in den falschen Branch zu mergen.

## Modal im Hauptfenster
`apps/desktop/src/lib/agent-review.ts` reagiert auf `turn.result` (kein Fehler, nicht unterbrochen) einer Session in einem Worktree-Projekt (parentId) und legt das Projekt in die Warteschlange `stores/agent-review.ts`. Nicht ausgelöst, wenn die Session gerade im Hauptfenster offen ist oder noch Hintergrund-Aufgaben laufen. Manuell: Knopf "Agent abschließen" im Kopf eines Worktrees und "Abschließen" im Agenten-Reiter. "Später" nimmt es aus der Warteschlange; das nächste Turn-Ende fragt erneut.

## Seitenleiste
Sessions eines Worktrees stehen in `OpenSessions` unter dem Hauptprojekt (`groupOf` in `lib/session-tabs.ts`), markiert mit Bot-Symbol. Klick öffnet weiter das Worktree-Projekt.
