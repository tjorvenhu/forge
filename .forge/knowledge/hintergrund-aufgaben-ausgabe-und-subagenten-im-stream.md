---
title: "Hintergrund-Aufgaben: Ausgabe und Subagenten im Stream"
summary: "Was Claude Code über getTaskOutput und den Stream zu Hintergrund-Befehlen und Hintergrund-Subagenten liefert, geprüft mit echter CLI; wichtig für den Dialog „Ausgabe ansehen“ und den Subagenten-Verlauf."
tags: ["hintergrund","sdk","subagent","stolperfalle"]
updated: "2026-10-13T10:18:09.670Z"
---

Geprüft am 2026-10-13 mit Claude Code 2.1.296 und Agent SDK 0.3.296 (Probe-Skripte mit Haiku, danach gelöscht).

## Ausgabe von Hintergrund-Befehlen
- `getTaskOutput(taskId)` ist im SDK vorhanden, aber nicht in den Typen (`packages/sidecar/src/claude/runtime.ts`, `TaskOutputQuery`). Es schickt den Control-Request `get_task_output`.
- Für `local_bash`-Aufgaben liefert es die Ausgabe live, sie wächst mit jedem Abruf (`{ output, total_bytes, truncated }`). Nach dem Ende kommt zusätzlich `[exited with code N]`. Es funktioniert auch nach dem Ende weiter, solange der Prozess lebt.
- Für Subagenten (`local_agent`) gibt es einen Fehler: "no shell or Monitor task with that task_id in this session". Nur Shell- und Monitor-Aufgaben. Das Telefon (`background_task` output) nennt für Subagenten deshalb ihre letzte Fortschrittszeile.
- Leere Ausgabe im Dialog ist meist kein FORGE-Fehler: Befehle wie `pnpm test | grep ... | head` oder Warte-Schleifen geben bis zum Ende nichts aus (grep puffert in einer Pipe). Der Dialog (`apps/desktop/src/components/workspace/TaskThread.tsx`, `ShellOutput`) sagt das dazu.
- Dass das Ergebnis danach im Haupt-Chat steht, ist so gewollt: Claude Code meldet die fertige Aufgabe an Claude, das in einem neuen Durchlauf ohne Nutzernachricht antwortet. FORGE kann das nicht umleiten.

## Hintergrund-Subagenten
- `task_started` hat `is_backgrounded: true`, `tool_use_id` (Agent-Aufruf), `task_type: "local_agent"`. `task_notification` hat wieder `tool_use_id`, dazu `summary` = die Schlussantwort des Subagenten und `output_file`.
- Das `tool_result` des Agent-Aufrufs ist sofort ein Platzhalter ("Async agent launched successfully ..."). Das echte Ergebnis ist `task_notification.summary`. FORGE speichert es im Ereignis `background.task` (Feld `toolUseId`, ab 2026-10-13; ältere Ereignisse haben es nicht). `agentCall` in `TaskThread.tsx` nimmt bei Hintergrund-Subagenten dieses Ereignis als Ergebnis.
- Die Schritte des Subagenten kommen im Stream (assistant/user/stream_event mit `parent_tool_use_id`), aber erst nach dem `result` des Durchlaufs, der ihn gestartet hat. `SessionStream.handle` wertet deshalb nur Nachrichten ohne `parent_tool_use_id` als Beginn eines neuen Durchlaufs, sonst stünde die Session als „arbeitet“ da.
