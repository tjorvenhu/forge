---
title: "Hintergrund-Aufgaben: Ausgabe und Subagenten im Stream"
summary: "Was Claude Code über getTaskOutput und den Stream zu Hintergrund-Befehlen und Hintergrund-Subagenten liefert, geprüft mit echter CLI; wichtig für den Dialog „Ausgabe ansehen“."
tags: ["hintergrund","sdk","subagent","stolperfalle"]
updated: "2026-10-13T10:08:16.537Z"
---

Geprüft am 2026-10-13 mit Claude Code 2.1.296 und Agent SDK 0.3.296 (Probe-Skript mit Haiku, danach gelöscht).

## Ausgabe von Hintergrund-Befehlen
- `getTaskOutput(taskId)` ist im SDK vorhanden, aber nicht in den Typen (`packages/sidecar/src/claude/runtime.ts`, `TaskOutputQuery`). Es schickt den Control-Request `get_task_output`.
- Für `local_bash`-Aufgaben liefert es die Ausgabe live, sie wächst mit jedem Abruf (`{ output, total_bytes, truncated }`). Nach dem Ende kommt zusätzlich `[exited with code N]`. Es funktioniert auch nach dem Ende weiter, solange der Prozess lebt.
- Für Subagenten (`local_agent`) gibt es einen Fehler: "no shell or Monitor task with that task_id in this session". Nur Shell- und Monitor-Aufgaben.
- Leere Ausgabe im Dialog ist meist kein FORGE-Fehler: Befehle wie `pnpm test | grep ... | head` oder Warte-Schleifen geben bis zum Ende nichts aus (grep puffert in einer Pipe). Der Dialog (`apps/desktop/src/components/workspace/TaskThread.tsx`, `ShellOutput`) sagt das inzwischen dazu.
- `task_notification` bringt am Ende `output_file` (Pfad unter `%TEMP%\claude\...\tasks\<id>.output`) und `summary`.
- Dass das Ergebnis danach im Haupt-Chat steht, ist so gewollt: Claude Code meldet die fertige Aufgabe an Claude, das in einem neuen Durchlauf ohne Nutzernachricht antwortet. FORGE kann das nicht in den Dialog umleiten.

## Hintergrund-Subagenten im Stream
- Die Schritte eines Subagenten mit `run_in_background` kommen im Stream des Hauptprozesses an (assistant/user mit `parent_tool_use_id` = Agent-Aufruf, dazu `task_progress`), aber erst nach dem `result` des Durchlaufs, der ihn gestartet hat.
- Das `tool_result` des Agent-Aufrufs ist sofort ein Platzhalter. Das eigentliche Ergebnis steht in `task_notification.summary`.
- Stolperfalle: `SessionStream.handle` setzt bei jeder `assistant`-Nachricht im Status idle `markRunning`, auch bei Nachrichten mit `parent_tool_use_id`. Ein Hintergrund-Subagent lässt die Session deshalb als „arbeitet“ erscheinen, bis der nächste Durchlauf endet.
