---
title: "Agenten mit nicht committetem Stand starten (with_changes)"
summary: "Wie start_agent mit with_changes und das Telefon (start_session with_changes) den nicht committeten Stand per Snapshot-Commit an einen Agenten geben, ohne den Ordner der startenden Session anzufassen; wichtig bei Änderungen an WorktreeService.create oder GitEngine.exec."
tags: ["agenten","worktree","git","telefon","stolperfalle"]
updated: "2026-10-14T17:59:09.460Z"
---

## Ablauf
`WorktreeService.create(parent, branch, { fromDir, withChanges: true })` ruft `snapshot(fromDir, HEAD)` in `packages/sidecar/src/automation/worktrees.ts`:
- Temporärer Index über `GIT_INDEX_FILE` (neuer 5. Parameter `env` von `GitEngine.exec`): `read-tree HEAD`, `add -A .`, neu hinzugekommene Dateien mit `isSensitiveFile`/`isArtifactPath` per `rm --cached` wieder raus, `write-tree`, `commit-tree -p HEAD`.
- Ergebnis ist ein loser Commit ("FORGE: nicht committeter Stand von <branch> für den Agenten"), der neue Branch startet dort. Arbeitsbaum, echter Index und Branch der startenden Session bleiben unverändert. Ist nichts offen (Baum gleich HEAD), startet der Branch normal bei HEAD, ohne leeren Commit.
- `uncommitted(dir)` zählt offene Dateien; `start_agent` ohne with_changes hängt damit einen Hinweis an sein Ergebnis.

## Stolperfallen
- `GitEngine.env()` setzt `GIT_LITERAL_PATHSPECS=1`: magische Pfade wie `:/` funktionieren nicht. Deshalb laufen die Snapshot-Befehle im Toplevel (`rev-parse --show-toplevel`) mit Pfaden relativ dazu (so liefert sie auch `diff --name-only`).
- Tests unter Windows: autocrlf wandelt beim Checkout im Worktree `\n` in `\r\n`, Dateiinhalte also zeilenendenunabhängig vergleichen.
- Zurückführen: Der Snapshot-Commit geht mit dem Agenten-Branch zurück. Hat die startende Session dieselben Änderungen inzwischen committet (auto-commit), lässt der Rebase im Finisher ihn als bereits vorhanden fallen bzw. führt ihn konfliktfrei zusammen; weiter geänderte Dateien können Konflikte geben, die wie üblich an den Agenten gehen.

## Telefon
Telefon-Werkzeug `start_session` hat `with_changes` (nur mit `agent: true`), durchgereicht über `StartSessionOptions.withChanges` an `worktrees.create` in `phone-service.ts`.
