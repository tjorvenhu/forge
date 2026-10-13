---
title: "Fertig-Meldung erst am Ende des ganzen Auftrags (session.done)"
summary: "Wann FORGE Ton, Windows-Benachrichtigung und Telefon-Anruf für „Claude ist fertig“ auslöst: nicht pro Durchlauf, sondern wenn Hintergrund-Aufgaben und gestartete Agenten auch durch sind."
tags: ["benachrichtigung","telefon","agenten","hintergrund","sessions"]
updated: "2026-10-13T12:55:06.784Z"
---

## Entscheidung (2026-10-13)
Der Nutzer will „fertig“ erst hören, wenn der gesamte Auftrag fertig ist, nicht nach jedem Durchlauf, der Hintergrund-Aufgaben oder Agenten weiterlaufen lässt. Im Chat stehen die Teilschritte weiter als fertig.

## Umsetzung
- `packages/sidecar/src/sessions/job-done.ts` (`JobWatcher`), in `app.ts` an `emit` gehängt. Sendet ServerEvent `session.done { sessionId }`.
- Erfolgreiches `turn.result` mit laufenden Hintergrund-Aufgaben (`session.background`) oder beschäftigten Kind-Sessions (Agenten aus `start_agent`, `parent_session_id` in der DB): die Session wartet (`waiting`), kein done.
- Hintergrund-Aufgaben: Claude Code startet nach ihrem Ende selbst einen neuen Durchlauf; dessen `turn.result` entscheidet. Deshalb wird beim Leeren von `background` nicht neu geprüft, sonst käme done doppelt.
- Agenten: lösen bei der startenden Session keinen Durchlauf aus. Das Ende des letzten Agenten „settled“ die wartende Elternsession. Das eigene Ende eines Agenten wird nicht gemeldet; nur wenn die Elternsession nicht auf ihn wartet und nicht arbeitet (z. B. später direkt mit dem Agenten gesprochen), meldet er sich selbst.
- Beim `turn.result` steht der Status der Session selbst noch auf running (setStatus idle kommt danach); deshalb wird die gerade fertige Session (`finished`) beim Prüfen ausgenommen.
- Fehler und Unterbrechungen löschen `waiting`; Fehler werden wie bisher sofort gemeldet.

## Abnehmer
- Desktop: `apps/desktop/src/lib/server-events.ts` (case `session.done`: Ton + `notifyDone`). `notifyKind` liefert für erfolgreiche `turn.result` nichts mehr.
- Telefon: `PhoneService.onServerEvent` ruft für done nur bei `session.done` an und erzählt das Ergebnis des letzten erfolgreichen Durchlaufs (`lastTurn`).
- Tests: `packages/sidecar/test/job-done.test.ts`.
