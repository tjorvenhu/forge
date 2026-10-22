---
title: "Agent-Teams von Claude Code in FORGE (Team-Terminal, AgentTeams-Watcher, teams.*, agent_team)"
summary: "Wie FORGE Claude Codes Agent Teams einbindet (Lead im Terminal-Reiter, Ansicht im Agenten-Reiter, Telefon agent_team); warum nicht im SDK; Variablen, Dateiformate unter ~/.claude/teams und ~/.claude/tasks, Inbox-Sperre, Stolperfallen."
tags: ["agenten","sdk","telefon","ui","stolperfalle"]
updated: "2026-10-22T16:06:04.187Z"
---

# Agent-Teams von Claude Code in FORGE (gebaut 2026-10-22 auf dev, CLI 2.1.308, Agent SDK 0.3.296)

Doku: https://code.claude.com/docs/en/agent-teams (experimentell). Entscheidung des Besitzers 2026-10-22: FORGE nutzt die echten Agent Teams im Terminal (Weg A), statt einen eigenen Team-Modus auf FORGE-Agenten nachzubauen. Grund: Ein Nachbau hätte den Lead nach jedem Teammitglied neu angestoßen, das kostet viel Abo-Verbrauch.

## Umsetzung
- **Start:** Terminal-Tab mit `team: true` (`stores/terminals.ts`, `TerminalSpec` in `lib/terminal-registry.ts`), Tauri `term_open(team, prompt)`. `terminal.rs`: `claude_args` hängt `--teammate-mode in-process` und den Start-Prompt als Argument an, `TEAM_ENV` setzt die beiden Variablen (s. u.). Einstiege: Knopf mit Users-Symbol im unteren Panel, „Team starten“ im Agenten-Reiter (Dialog mit optionalem Auftrag), Palette `team-start`/`team-view`, Telefon `agent_team start` (RPC `teams.start` → Event `team.start` → `lib/agent-teams.ts` `startTeamTerminal` im Hauptfenster).
- **Beobachten:** `packages/sidecar/src/teams/agent-teams.ts` (`AgentTeams`, in `app.ts` gestartet). Fragt alle 500 ms ab (bewusst ohne `fs.watch`), schreibt Inbox-Nachrichten mit, solange FORGE läuft (höchstens 300 je Team), und behält beendete Teams bis zum Neustart (höchstens 20). Zuordnung zum Projekt über das `cwd` des Leads (`projectForCwd`, tiefster passender Projektordner). Zustand eines Mitglieds: `idle` nach seiner `idle_notification`, `working` nach Nachricht oder Aufgabe an es, oder solange es eine Aufgabe `in_progress` hat.
- **RPC:** `teams.list` (optional projectId inkl. Worktrees), `teams.message` (an Name, `team-lead`/`lead` oder `all` = alle Teammitglieder ohne Lead), `teams.start`. Event `teams.updated`, Desktop invalidiert `keys.agentTeams`.
- **Ansicht:** `components/workspace/AgentTeams.tsx`, oben im Agenten-Reiter (auch ohne Git). Teamkarte mit Kommunikations-Graph (SVG; frische Nachrichten 20 s animiert, CSS `.team-flow` in `styles.css`), Mitgliederkarten, Aufgabenbrett (Offen/In Arbeit/Erledigt, blockiert mit „wartet auf #…“), Nachrichtenverlauf und Eingabe (Strg+Enter). Beendete Teams starten eingeklappt. Rechtsklick auf Karte, Mitglied, Aufgabe und Nachricht.
- **Telefon:** Werkzeug `agent_team` (status/message/start), in `phone/coverage.ts` für alle drei RPCs eingetragen.

## Warum nicht im Agent SDK (FORGE-Chat)
- Probelauf mit gesetzter Variable, Streaming-Eingabe wie `claude/runtime.ts`, Agent-Aufruf mit `name: "scout"`: Die CLI startet einen gewöhnlichen Hintergrund-Subagenten (`task_type: local_agent`). Es entsteht kein Ordner unter `~/.claude/teams`. Die Doku sagt dasselbe (SDK = nicht interaktiv).
- Im SDK gibt es `Task`, `ListAgents`, `SendMessage`, `TaskStop`. `teammateMode` ist nur ein settings.json-Feld, keine SDK-Option.

## Interaktiv in einer PTY: geht, auch unter Windows (ConPTY)
- `claude --teammate-mode in-process` mit **zwei** Variablen:
  - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (Teams)
  - `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`: **Stolperfalle.** Ohne sie fehlen bei aktuellen Modellen (alles nach Opus 4.7/Sonnet 4.6/Haiku 4.5) `TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet`, also die gemeinsame Aufgabenliste. Claude meldet dann, es könne keine Aufgaben anlegen. In-process-Teammates folgen dem Lead.
- Split Panes brauchen tmux/iTerm2, unter Windows nicht möglich.
- `STRIP_ENV` in `terminal.rs` entfernt `CLAUDE_CODE_CHILD_SESSION`; fehlt das, speichert claude kein Transkript („Transcript saving is off“).

## Dateien (Teamname = `session-` + erste 8 Zeichen der Session-ID)
- `~/.claude/teams/<team>/config.json` (oder unter `CLAUDE_CONFIG_DIR`): entsteht direkt beim Start der interaktiven Sitzung, vor dem ersten Prompt. Felder: `name`, `createdAt` (ms), `leadAgentId`, `leadSessionId`, `members[]` mit `agentId` (`<name>@<team>`), `name` (Lead heißt `team-lead`), `agentType`, `color` (blue, green …), `model`, `prompt`, `joinedAt` (ms), `cwd`, `backendType`. Die CLI löscht den Ordner beim Ende, auch nach einem Kill.
- `inboxes/<name>.json`: JSON-Array von `{ from, text, summary?, timestamp, color?, msgV: 1, msg_id, type: "message", read }`. Der Empfänger leert die Datei nach dem Lesen, oft innerhalb von 1–2 s. Strukturierte Nachrichten stehen als JSON-String in `text`: `task_assignment` (`taskId`, `subject`, `description`, `assignedBy`) und `idle_notification` (`from`, `result` = Ergebnis an den Lead).
- `~/.claude/tasks/<team>/<id>.json`: `{ id, subject, description, owner?, status, blocks, blockedBy }`, dazu `.lock` und `.highwatermark`. Bleibt nach dem Ende liegen (`cleanupPeriodDays`).

## Nachrichten von außen
- Eintrag mit `from: "user"`, neuer `msg_id` und `read: false` anhängen: Untätige Teammates und der wartende Lead verarbeiten ihn (Probelauf). Eine wiederverwendete `msg_id` kommt nicht an.
- Sperre wie die CLI (proper-lockfile): Ordner `<inbox>.json.lock` per mkdir, lesen, anhängen, atomar schreiben (tmp + rename), Sperre mit `rmdirSync` freigeben. Älter als 10 s gilt sie als verwaist.
- Der Empfänger erfährt, dass die Nachricht von einer anderen Sitzung kommt, nicht vom Nutzer. Für Aufträge an den Lead ist der Start-Prompt besser.

## Stolperfallen beim Entwickeln
- Node 24.11.1 (Node auf dem Entwicklungsrechner) löscht mit `fs.rmSync` unter einem Pfad mit Umlauten gar nichts, still und ohne Fehler; `tempDir()` der Sidecar-Tests enthält absichtlich „Ümläut“. FORGEs mitgeliefertes Node 24.21 ist nicht betroffen. Tests räumen deshalb mit `unlinkSync`/`rmdirSync` auf (`test/agent-teams.test.ts`).
- Python schreibt unter Windows im Textmodus CRLF. Für Skripte, die Quelldateien ändern, `read_bytes`/`write_bytes` nutzen (die Unix-Werkzeuge in Git Bash haben die Zeilenenden ebenfalls nicht zuverlässig umgestellt).
