---
title: "Claude-Code-Stream: Slash-Befehle (/compact, /cost), Hintergrund-Aufgaben und Subagenten (getTaskOutput, SendMessage)"
summary: "Was Claude Code bei Slash-Befehlen, Hintergrund-Befehlen und -Subagenten in den Stream schreibt, was getTaskOutput und SendMessage können (mit echter CLI geprüft) und wie FORGE das nutzt (sessions.messageTask); wichtig für SessionStream, TaskThread."
tags: ["sdk","chat","slash","hintergrund","subagent","remote","stolperfalle"]
updated: "2026-10-17T10:50:33.440Z"
---

Geprüft am 2026-10-13 mit Claude Code 2.1.296 und Agent SDK 0.3.296 (Probe-Skripte mit Haiku bzw. `--replay-user-messages`, danach gelöscht). Nachrichten an Hintergrundaufgaben geprüft am 2026-10-17 (SDK 0.3.296, CLI 2.1.301 hat denselben Stand). Achtung beim Probieren in Git Bash: `MSYS_NO_PATHCONV=1` setzen, sonst wird `/cost` zu `C:/Program Files/Git/cost`. Probe-Skripte müssen im Projektordner liegen (FORGE-Policy sperrt Schreiben außerhalb); das SDK per `file:///…/packages/sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` importieren. Beliebige Control-Requests gehen mit `q.request({ subtype: … })` (nicht typisiert). Ein Vordergrund-`sleep 25` blockiert die CLI („Standalone-Sleep nicht erlaubt“), zum Warten `node -e 'setTimeout(()=>{},25000)'` nehmen.

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
- Das `tool_result` des Agent-Aufrufs ist sofort ein Platzhalter ("Async agent launched successfully ... agentId: <id> ..."). Die `task_id` ist gleich dieser agentId. Das echte Ergebnis ist `task_notification.summary`. FORGE speichert es im Ereignis `background.task` (Feld `toolUseId`, ab 2026-10-13; ältere Ereignisse haben es nicht). `agentCall` in `TaskThread.tsx` nimmt bei Hintergrund-Subagenten dieses Ereignis als Ergebnis.
- Die Schritte des Subagenten kommen im Stream (assistant/user/stream_event mit `parent_tool_use_id`), aber erst nach dem `result` des Durchlaufs, der ihn gestartet hat. `SessionStream.handle` wertet deshalb nur Nachrichten ohne `parent_tool_use_id` als Beginn eines neuen Durchlaufs, sonst stünde die Session als „arbeitet“ da.

## In Hintergrundaufgaben schreiben (geprüft 2026-10-17)
- **Kein direkter Weg im SDK.** Die CLI kennt den Control-Request `send_task_message`, antwortet aber „Unsupported control request subtype: send_task_message“ (in den Capabilities steht `send_task_message: false`). Eine Nutzernachricht mit `parent_tool_use_id` = Agent-Aufruf landet bei der Haupt-Session, nicht beim Subagenten. Bei einem CLI-Update lohnt es sich, `send_task_message` erneut zu prüfen; dann könnte FORGE direkt senden.
- **SendMessage über die Haupt-Session funktioniert zuverlässig** (auch mit Haiku): Claude lädt das Werkzeug per ToolSearch (`select:SendMessage`) und ruft `SendMessage { to: "<agentId>", message }`.
  - Subagent läuft: Ergebnis „Message queued for delivery to <id> at its next tool round.“ Die Nachricht kommt nach seinem laufenden Werkzeugaufruf an; im Stream gibt es dazu keine Nutzernachricht mit `parent_tool_use_id`.
  - Subagent fertig: „Resuming agent <id>“. Es kommt ein neues `task_started` mit **derselben task_id**, aber `tool_use_id` = der SendMessage-Aufruf (ob dabei `is_backgrounded` gesetzt ist, ist ungeprüft); `background_tasks_changed` listet ihn wieder. Seine neuen Schritte tragen weiter `parent_tool_use_id` = der ursprüngliche Agent-Aufruf, das `task_notification` danach wieder die SendMessage-ID.
- **stdin von Hintergrundbefehlen:** nicht erreichbar. Kein Control-Request dafür; `read line` in einem Hintergrund-Bash bekommt sofort eine leere Eingabe.

### Umsetzung in FORGE (2026-10-17)
- RPC `sessions.messageTask { sessionId, taskId? | toolUseId?, text }` → `SessionService.messageTask`. `sessions/task-message.ts`: `findTask` sucht die Aufgabe im Live-Zustand (`background`, `subagents`) und in den gespeicherten Ereignissen (`db.listEventsOfTypes`: tool.use, tool.result mit `agentId:` bzw. `with ID:`, background.task), auch wenn sie schon beendet ist. `taskNote` baut den Hinweis: Subagent → mit SendMessage an die agentId weitergeben; Befehl → Beschreibung, Befehl, Task-ID, „liest keine Eingaben, reagiere selbst“.
- Der Hinweis geht als Textblock vor dem Text (`TurnDispatch.build(..., task)`, 5. Parameter von `send`/`resume`), die Timeline speichert nur den Text des Nutzers mit Feld `task` (`TaskMessageRef`) am `user.message`. Beim Senden während eines Durchlaufs gilt das normale Verhalten (mitlaufen bzw. auf Tests/Auto-Commit warten).
- `Normalizer.taskCall` ordnet jede Subagent-Aufgabe dauerhaft ihrem ersten Agent-Aufruf zu (sonst hinge der fortgesetzte Lauf am SendMessage-Aufruf) und behandelt einen fortgesetzten Lauf wie einen Hintergrundlauf (`background.task` started/completed). `agentCall` setzt das Ergebnis bei einem neuen `started` zurück.
- Desktop: Eingabefeld `TaskComposer` im Dialog (`TaskThread.tsx`, `composerText` für Platzhalter/Hinweis), Kennzeichnung `TaskLabel` in `UserMessage.tsx` (klickbar, öffnet die Aufgabe; solche Nachrichten sind nicht bearbeitbar, auch nicht über `lastEditablePrompt`). Im Verlauf eines Subagenten erscheinen die an ihn geschriebenen Nachrichten (`toThisAgent` in `chat-items.ts`). `TaskView.compose` öffnet den Dialog mit Fokus im Feld: Rechtsklick „Nachricht schreiben“ (`taskMenu` in `WorkingIndicator.tsx`, auch an den Links in `ToolCard.tsx`) und Palette „Nachricht an Hintergrundaufgabe: …“. Telefon: `background_task` Aktion `message` mit `text`.
