---
title: "Sidecar-Tests: Zeitüberschreitungen im Gesamtlauf"
summary: "Einzelne Git-lastige Sidecar-Tests (removal, worktrees) laufen im parallelen Gesamtlauf unter Windows gelegentlich in die 5-Sekunden-Grenze; so erkennt man das und prüft gegen."
tags: ["tests","sidecar","windows","stolperfalle"]
updated: "2026-10-13T16:53:19.126Z"
---

Beobachtet 2026-10-13: Bei `pnpm -r test` schlugen `test/removal.test.ts` und `test/worktrees.test.ts` (Worktree entfernen, Branch löschen, Dev-Server stoppen) mit Laufzeiten knapp über 5 s fehl. Einzeln (`pnpm exec vitest run test/removal.test.ts test/worktrees.test.ts` in `packages/sidecar`) liefen alle grün.

Ursache: viele echte git-Aufrufe unter Windows, im parallelen Lauf mit allen Paketen zu langsam für das Vitest-Standardlimit von 5 s. Kein Zusammenhang mit der jeweiligen Änderung.

Vorgehen: Fehlschläge in diesen Dateien mit ~5 s Laufzeit erst einzeln wiederholen, bevor man den Code verdächtigt. Wenn es häufiger stört: den betroffenen Tests ein höheres Timeout geben (drittes Argument von `it`).
