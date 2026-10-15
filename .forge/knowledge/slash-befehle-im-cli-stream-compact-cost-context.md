---
title: "Claude-Code-Stream: Slash-Befehle (/compact, /cost), Hintergrund-Aufgaben und Subagenten (getTaskOutput)"
summary: "Was Claude Code bei Slash-Befehlen, Hintergrund-Befehlen und Hintergrund-Subagenten in den Stream schreibt oder über getTaskOutput liefert (mit echter CLI geprüft) und wie FORGE das filtert; wichtig bei Änderungen an remote-bridge.ts, SessionStream, TaskThread oder der Chat-Darstellung."
tags: ["sdk","chat","slash","hintergrund","subagent","remote","stolperfalle"]
updated: "2026-10-15T06:42:32.882Z"
---

Geprüft am 2026-10-13 mit Claude Code 2.1.296 und Agent SDK 0.3.296 (Probe-Skripte mit Haiku bzw. `--replay-user-messages`, danach gelöscht). Achtung beim Probieren in Git Bash: `MSYS_NO_PATHCONV=1` setzen, sonst wird `/cost` zu `C:/Program Files/Git/cost`.

## Slash-Befehle

### Was im Stream ankommt
- **Lokale Befehle ohne Modell** (`/cost` → intern `/usage`, `/context`, `/model`, unbekannte wie `/release-notes`): eine synthetische `assistant`-Nachricht (`model: "<synthetic>"`, Feld `local_command_source`) mit der Ausgabe als Text. FORGE zeigt sie als normale Antwort. Danach ein Replay-Echo `<command-name>/x</command-name><command-message>…<command-args>…</command-args>` mit **unserer** uuid.
- **/compact**: `system/status compacting`, `compact_boundary` (→ `context.compacted`-Karte), eine `isSynthetic: true`-Nutzernachricht mit der Zusammenfassung, dann `<local-command-stdout>Compacted </local-command-stdout>` als `isReplay`-Nutzernachricht mit **neuer** uuid und **ohne** `origin`, zuletzt das `<command-name>`-Echo mit unserer uuid. Das `result` hat `num_turns: 0` und 0 Tokens.

### Wie FORGE damit umgeht
- `fromHuman` in `packages/sidecar/src/sessions/remote-bridge.ts` verwirft Texte, die mit `<task-notification>`, `<system-reminder>` oder `<local-command-stdout|stderr|caveat>` beginnen, noch vor der `origin`-Prüfung. Vorher landete „Compacted“ als Nachricht „aus der Claude-App“ im Chat, auch ohne eingeschaltetes Remote Control (`handleInput` sieht alle Replays).
- `<command-name>`-Echos mit fremder uuid (Befehl in der Claude-App getippt) werden zu `/x args` umgeschrieben (`slashCommandText`).
- Desktop: `INJECTED_PREFIXES` in `chat-items.ts` blendet dieselben Präfixe auch in alten, schon gespeicherten Ereignissen aus. `isSlashCommand` + `CommandMessage` (`UserMessage.tsx`) zeigen Befehle als schlanke Zeile ohne Blase; `ResultLine` lässt 0 Schritte / 0 Tokens weg.

### ultrathink
Das Schlüsselwort wirkt in der CLI selbst (sie hängt dem Prompt einen Hinweis an), FORGE muss nichts senden. Die Regenbogen-Darstellung ist reine UI: `apps/desktop/src/components/workspace/ultrathink.tsx` + Klasse `.ultrathink-text` in `styles.css`; im Composer liegt dafür eine Kopie des Texts hinter dem dann transparenten Textfeld (Scroll wird synchronisiert).

## Hintergrund-Befehle: Ausgabe
- `getTaskOutput(taskId)` ist im SDK vorhanden, aber nicht in den Typen (`packages/sidecar/src/claude/runtime.ts`, `TaskOutputQuery`). Es schickt den Control-Request `get_task_output`.
- Für `local_bash`-Aufgaben liefert es die Ausgabe live, sie wächst mit jedem Abruf (`{ output, total_bytes, truncated }`). Nach dem Ende kommt zusätzlich `[exited with code N]`. Es funktioniert auch nach dem Ende weiter, solange der Prozess lebt.
- Für Subagenten (`local_agent`) gibt es einen Fehler: "no shell or Monitor task with that task_id in this session". Nur Shell- und Monitor-Aufgaben. Das Telefon (`background_task` output) nennt für Subagenten deshalb ihre letzte Fortschrittszeile.
- Leere Ausgabe im Dialog „Ausgabe ansehen“ ist meist kein FORGE-Fehler: Befehle wie `pnpm test | grep ... | head` oder Warte-Schleifen geben bis zum Ende nichts aus (grep puffert in einer Pipe). Der Dialog (`apps/desktop/src/components/workspace/TaskThread.tsx`, `ShellOutput`) sagt das dazu.
- Dass das Ergebnis danach im Haupt-Chat steht, ist so gewollt: Claude Code meldet die fertige Aufgabe an Claude, das in einem neuen Durchlauf ohne Nutzernachricht antwortet. FORGE kann das nicht umleiten.

## Hintergrund-Subagenten
- `task_started` hat `is_backgrounded: true`, `tool_use_id` (Agent-Aufruf), `task_type: "local_agent"`. `task_notification` hat wieder `tool_use_id`, dazu `summary` = die Schlussantwort des Subagenten und `output_file`.
- Das `tool_result` des Agent-Aufrufs ist sofort ein Platzhalter ("Async agent launched successfully ..."). Das echte Ergebnis ist `task_notification.summary`. FORGE speichert es im Ereignis `background.task` (Feld `toolUseId`, ab 2026-10-13; ältere Ereignisse haben es nicht). `agentCall` in `TaskThread.tsx` nimmt bei Hintergrund-Subagenten dieses Ereignis als Ergebnis.
- Die Schritte des Subagenten kommen im Stream (assistant/user/stream_event mit `parent_tool_use_id`), aber erst nach dem `result` des Durchlaufs, der ihn gestartet hat. `SessionStream.handle` wertet deshalb nur Nachrichten ohne `parent_tool_use_id` als Beginn eines neuen Durchlaufs, sonst stünde die Session als „arbeitet“ da.
