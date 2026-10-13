---
title: "Slash-Befehle im CLI-Stream (/compact, /cost, /context)"
summary: "Was Claude Code bei Slash-Befehlen in den Stream schreibt (Echo, local-command-stdout, synthetische Antworten) und wie FORGE das filtert; wichtig bei Änderungen an remote-bridge.ts oder der Chat-Darstellung von Befehlen."
tags: ["slash","sdk","chat","remote","stolperfalle"]
updated: "2026-10-13T20:01:48.128Z"
---

Geprüft am 2026-10-13 mit Claude Code 2.1.296 / Agent SDK 0.3.296 (Probe-Skript mit `--replay-user-messages`, danach gelöscht). Achtung beim Probieren in Git Bash: `MSYS_NO_PATHCONV=1` setzen, sonst wird `/cost` zu `C:/Program Files/Git/cost`.

## Was im Stream ankommt
- **Lokale Befehle ohne Modell** (`/cost` → intern `/usage`, `/context`, `/model`, unbekannte wie `/release-notes`): eine synthetische `assistant`-Nachricht (`model: "<synthetic>"`, Feld `local_command_source`) mit der Ausgabe als Text. FORGE zeigt sie als normale Antwort. Danach ein Replay-Echo `<command-name>/x</command-name><command-message>…<command-args>…</command-args>` mit **unserer** uuid.
- **/compact**: `system/status compacting`, `compact_boundary` (→ `context.compacted`-Karte), eine `isSynthetic: true`-Nutzernachricht mit der Zusammenfassung, dann `<local-command-stdout>Compacted </local-command-stdout>` als `isReplay`-Nutzernachricht mit **neuer** uuid und **ohne** `origin`, zuletzt das `<command-name>`-Echo mit unserer uuid. Das `result` hat `num_turns: 0` und 0 Tokens.

## Wie FORGE damit umgeht
- `fromHuman` in `packages/sidecar/src/sessions/remote-bridge.ts` verwirft Texte, die mit `<task-notification>`, `<system-reminder>` oder `<local-command-stdout|stderr|caveat>` beginnen, noch vor der `origin`-Prüfung. Vorher landete „Compacted“ als Nachricht „aus der Claude-App“ im Chat, auch ohne eingeschaltetes Remote Control (`handleInput` sieht alle Replays).
- `<command-name>`-Echos mit fremder uuid (Befehl in der Claude-App getippt) werden zu `/x args` umgeschrieben (`slashCommandText`).
- Desktop: `INJECTED_PREFIXES` in `chat-items.ts` blendet dieselben Präfixe auch in alten, schon gespeicherten Ereignissen aus. `isSlashCommand` + `CommandMessage` (`UserMessage.tsx`) zeigen Befehle als schlanke Zeile ohne Blase; `ResultLine` lässt 0 Schritte / 0 Tokens weg.

## ultrathink
Das Schlüsselwort wirkt in der CLI selbst (sie hängt dem Prompt einen Hinweis an), FORGE muss nichts senden. Die Regenbogen-Darstellung ist reine UI: `apps/desktop/src/components/workspace/ultrathink.tsx` + Klasse `.ultrathink-text` in `styles.css`; im Composer liegt dafür eine Kopie des Texts hinter dem dann transparenten Textfeld (Scroll wird synchronisiert).
