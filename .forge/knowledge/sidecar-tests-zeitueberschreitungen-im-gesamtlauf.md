---
title: "Entwickeln unter Windows: Bash-Heredocs verlieren Backslashes, Sidecar-Tests mit Zeitüberschreitung"
summary: "Stolperfallen der Windows-Entwicklungsumgebung: Backslashes gehen in Bash-Heredocs verloren (Code mit Edit/Write ändern), und Git-lastige Sidecar-Tests (removal, worktrees) überschreiten im Gesamtlauf gelegentlich die 5-Sekunden-Grenze."
tags: ["windows","bash","tests","sidecar","stolperfalle"]
updated: "2026-10-15T06:42:38.529Z"
---

## Bash-Heredocs verlieren Backslashes
In Bash-Heredocs gehen hier Backslashes verloren (`\n`, `\``). Wer Code mit Escapes oder mehrzeiligen Strings per `cat <<EOF > datei` schreibt, bekommt kaputte Strings, ohne dass ein Fehler erscheint. Solche Änderungen mit den Werkzeugen Edit/Write machen.

## Sidecar-Tests: Zeitüberschreitungen im Gesamtlauf
Beobachtet 2026-10-13: Bei `pnpm -r test` schlugen `test/removal.test.ts` und `test/worktrees.test.ts` (Worktree entfernen, Branch löschen, Dev-Server stoppen) mit Laufzeiten knapp über 5 s fehl. Einzeln (`pnpm exec vitest run test/removal.test.ts test/worktrees.test.ts` in `packages/sidecar`) liefen alle grün.

Ursache: viele echte git-Aufrufe unter Windows, im parallelen Lauf mit allen Paketen zu langsam für das Vitest-Standardlimit von 5 s. Kein Zusammenhang mit der jeweiligen Änderung.

Vorgehen: Fehlschläge in diesen Dateien mit ~5 s Laufzeit erst einzeln wiederholen, bevor man den Code verdächtigt. Wenn es häufiger stört: den betroffenen Tests ein höheres Timeout geben (drittes Argument von `it`).
