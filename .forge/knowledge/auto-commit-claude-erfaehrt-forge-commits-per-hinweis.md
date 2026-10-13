---
title: "Auto-Commit: Claude erfährt FORGE-Commits per Hinweis"
summary: "Wie Claude-Sessions mitbekommen, dass FORGE nach einem Durchlauf selbst committet oder gepusht hat (auto-commit/auto-push), damit sie das nicht für fremde Commits halten."
tags: ["git","auto-commit","sessions","stolperfalle"]
updated: "2026-10-13T11:09:10.417Z"
---

## Problem

Mit dem Tag `auto-commit` committet FORGE nach jedem erfolgreichen Durchlauf die darin geänderten Dateien
(`packages/sidecar/src/sessions/turn-automation.ts`). Die nächste Nachricht hält FORGE so lange zurück. Claude wusste
davon nichts: Bat der Nutzer ums Committen oder Pushen, fand Claude alles schon committet und meldete jedes Mal,
„jemand“ habe vor ihm committet.

## Lösung (seit 2026-10-13)

1. **Hinweis mit der nächsten Nachricht:** `TurnAutomation.report()` merkt sich jedes `automation`-Ereignis (Commit,
   Push, übersprungen, fehlgeschlagen). `TurnDispatch.withNote()` (`sessions/turns.ts`) holt die Hinweise beim
   Zustellen der nächsten Nachricht einmalig ab (`takeNote`). Sie gehen als eigener Text-Block vor den Nutzertext an
   Claude, beginnend mit `[FORGE-Hinweis, nicht vom Nutzer geschrieben]`, mit Hash, Commit-Nachricht und Dateien.
   - Der Block hängt an allen drei Wegen zur CLI: `send` (direkt), `deliverHeld` (zurückgehaltene Nachricht) und
     `resume` in `lifecycle.ts`.
   - Im Chat erscheint er nicht: Aufgezeichnet wird nur `msg.text`, Echos der CLI werden über die uuid erkannt.
2. **Zeile im Start-Kontext:** `forge-tools.ts` (`autoCommitLine`) erklärt beim Session-Start, dass FORGE selbst
   committet (und bei `auto-push` pusht, nie auf main/master), und dass Claude vor eigenem Commit/Push mit
   `git status`/`git log` prüfen soll, was noch offen ist.

## Hinweise

- Der Start-Kontext gilt mit den Tags vom Session-Start. Werden die Tags später geändert, ist allein der Hinweis
  maßgeblich, denn er beschreibt, was wirklich passiert ist.
- Die Hinweise liegen nur im Speicher. Nach einem Neustart der App sind nicht abgeholte Hinweise weg.
- Test: `session-service.test.ts`, „holds a new message until tests and auto-commit of the last turn are done“.
