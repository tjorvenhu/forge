---
title: "Auto-Commit: Claude erfährt FORGE-Commits per Hinweis; mehrere Sessions im selben Checkout"
summary: "Wie Claude-Sessions mitbekommen, dass FORGE nach einem Durchlauf selbst committet oder gepusht hat (auto-commit/auto-push), und warum parallele Sessions im selben Checkout sich gegenseitig Änderungen in Commits ziehen."
tags: ["git","auto-commit","sessions","stolperfalle"]
updated: "2026-10-24T12:12:15.859Z"
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

## Stolperfalle: mehrere Sessions im selben Checkout (2026-10-24)

- Laufen zwei Sessions gleichzeitig im Hauptordner (nicht in Worktrees), committet der Auto-Commit am Ende eines
  Durchlaufs ganze Dateien. Dabei landen auch die Änderungen der anderen Session in diesem Commit, sogar
  Hilfsdateien unter `.claude/`. So geschehen beim Entfernen der Agent-Teams parallel zu einer MCP-Session.
- Erkennen: `git status` zeigt Dateien, die man nicht angefasst hat; `ListAgents` zeigt die andere Session.
- Ausweg, solange nichts gepusht ist: `git reset --soft HEAD~1 && git reset`, dann den eigenen Teil per
  `git diff -U0 HEAD` in Hunks zerlegen, fremde Hunks aussortieren und mit `git apply --cached --unidiff-zero`
  nur die eigenen stagen. Zuerst gegen HEAD anwenden, denn bei `-U0` zählen die alten Zeilennummern.
  Den Rest danach als eigenen Commit.
- Besser: größere Umbauten in einem Agenten-Worktree machen oder die andere Session vorher per SendMessage warnen.
  Hilfsskripte nicht unter `.claude/` im Repo ablegen, das ist nicht ignoriert.
