---
title: "Agent-Teams von Claude Code in FORGE (Team-Terminal, AgentTeams-Watcher, teams.*, agent_team, agentTeams, teamsEnabled)"
summary: "Wie FORGE Claude Codes Agent Teams einbindet (Lead im Terminal-Reiter, Ansicht im Agenten-Reiter, Telefon agent_team), Schalter global (Standard aus) und pro Projekt, Beenden/Entfernen, Lebenszeichen über ~/.claude/sessions, warum nicht im SDK, Dateiformate, Stolperfallen."
tags: ["agenten","sdk","telefon","ui","einstellungen","stolperfalle"]
updated: "2026-10-22T16:32:34.814Z"
---

# Agent-Teams von Claude Code in FORGE (gebaut 2026-10-22 auf dev, CLI 2.1.308, Agent SDK 0.3.296)

Doku: https://code.claude.com/docs/en/agent-teams (experimentell). Entscheidung des Besitzers 2026-10-22: FORGE nutzt die echten Agent Teams im Terminal, statt einen eigenen Team-Modus auf FORGE-Agenten nachzubauen. Grund: Ein Nachbau hätte den Lead nach jedem Teammitglied neu angestoßen, das kostet viel Abo-Verbrauch.

## Schalter (Wunsch des Besitzers: standardmäßig AUS, muss explizit aktiviert werden)
- Global: Setting `agentTeams` (Standard `false` in `DEFAULT_SETTINGS`, gilt damit auch für bestehende Installationen). Einstellungen → Claude → Verhalten, Palette-Toggle, Telefon `forge_settings agent_teams`.
- Pro Projekt: `Project.teamsEnabled` (DB `projects.teams_enabled`, Standard 1 = erlaubt, sobald global an). Nur am Hauptprojekt, Worktrees folgen (`update` am Worktree → CONFLICT `worktreeTeams`). Sync-Item optional, Backup Default true. Projekt-Einstellungen → Allgemein, Palette `project-teams`, Rechtsklick ProjectCard (nur wenn global an), Telefon `project settings teams`.
- Sidecar: `AgentTeamsDeps.enabled(projectId|null)` aus `app.ts`; `requestStart` wirft `TEAMS_DISABLED`. Global aus und kein Team bekannt: `scan()` liest gar nichts.
- Desktop: `useTeamsAllowed(project)` in `lib/agent-teams.ts`. Aus: Team-Abschnitt im Agenten-Reiter ausgeblendet (außer ein Team läuft noch, damit man es beenden kann), Team-Knopf im unteren Panel und Palette `team-start`/`team-view` weg.

## Umsetzung
- **Start:** Terminal-Tab mit `team: true` (`stores/terminals.ts`, `TerminalSpec` in `lib/terminal-registry.ts`), Tauri `term_open(team, prompt)`. `terminal.rs`: `--teammate-mode in-process`, Start-Prompt als Argument, `TEAM_ENV` setzt die beiden Variablen (s. u.). Telefon/Palette über RPC `teams.start` → Event `team.start` → `startTeamTerminal` im Hauptfenster.
- **Beobachten:** `packages/sidecar/src/teams/agent-teams.ts` (`AgentTeams`). Pollt alle 500 ms (bewusst ohne `fs.watch`, Windows hält sonst Sperr-Ordner offen), schreibt Inbox-Nachrichten mit (max. 300 je Team), behält beendete Teams bis zum Neustart oder bis der Nutzer sie entfernt (max. 20). Projekt über das `cwd` des Leads (`projectForCwd`).
- **RPC:** `teams.list`, `teams.message`, `teams.start`, `teams.stop` (Lead-Prozess beenden), `teams.dismiss` (ein beendetes Team oder alle beendeten eines Projekts aus der Liste). Event `teams.updated`.
- **Ansicht:** `components/workspace/AgentTeams.tsx`. Teamkarte mit „Beenden“ (ConfirmDialog, nur wenn `canStop`) bzw. X „Aus der Liste entfernen“, Abschnitt-Knopf „Beendete entfernen“; Rechtsklick enthält beides.
- **Telefon:** `agent_team` (status/message/start/stop/dismiss), komplett hinter der PIN (`run(true)`; der Test „locks every tool that reads or steers“ verlangt das, Teamnachrichten sind Inhalt).

## Lebt der Lead? (Stolperfalle)
- Der Team-Ordner allein sagt nichts: Wird der Terminal-Reiter geschlossen bzw. der Prozess hart beendet (Windows `TerminateProcess`), bleibt `~/.claude/teams/<team>` oft liegen. FORGE zeigte das Team dann für immer als „läuft“.
- Lösung: Claude Code schreibt für jeden laufenden Prozess `~/.claude/sessions/<pid>.json` (`pid`, `sessionId`, `cwd`, `startedAt` ms, `kind`, `status`). Ein Team läuft, wenn eine Datei mit lebender PID (`process.kill(pid, 0)`, EPERM zählt als lebend) passt: `sessionId === leadSessionId`, sonst (nach `/clear` neue Session-ID) gleicher Ordner und `startedAt` zwischen createdAt − 120 s und createdAt + 5 s. 15 s Schonfrist für neue Teams. Fehlt der Ordner `sessions` ganz (ältere CLI), gilt wie früher: Ordner da = läuft, `canStop` false.
- Die Session-Datei eines getöteten Prozesses bleibt ebenfalls liegen, deshalb immer die PID prüfen.
- `teams.stop` = `process.kill(pid)` und bis 5 s warten. `teams.dismiss` löscht einen liegengebliebenen Team-Ordner (Datei für Datei, s. Umlaut-Stolperfalle), sonst käme das Team nach jedem FORGE-Start als „beendet“ zurück. `~/.claude/tasks/<team>` bleibt (Claude Codes `cleanupPeriodDays`).

## Warum nicht im Agent SDK (FORGE-Chat)
- Probelauf mit gesetzter Variable und Agent-Aufruf mit `name`: Die CLI startet einen gewöhnlichen Hintergrund-Subagenten (`task_type: local_agent`), kein Ordner unter `~/.claude/teams`. Doku: SDK = nicht interaktiv. `teammateMode` ist nur ein settings.json-Feld.

## Interaktiv in einer PTY (auch Windows/ConPTY)
- `claude --teammate-mode in-process` mit `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` und `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. **Stolperfalle:** Ohne die zweite fehlen bei aktuellen Modellen `TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet` (gemeinsame Aufgabenliste).
- Split Panes brauchen tmux/iTerm2, unter Windows nicht möglich.
- `STRIP_ENV` in `terminal.rs` entfernt `CLAUDE_CODE_CHILD_SESSION`, sonst speichert claude kein Transkript.

## Dateien (Teamname = `session-` + erste 8 Zeichen der Session-ID)
- `~/.claude/teams/<team>/config.json` (oder unter `CLAUDE_CONFIG_DIR`): entsteht beim Start der interaktiven Sitzung, vor dem ersten Prompt. Felder: `name`, `createdAt` (ms), `leadAgentId`, `leadSessionId`, `members[]` (`agentId` `<name>@<team>`, `name` (Lead `team-lead`), `agentType`, `color`, `model`, `prompt`, `joinedAt`, `cwd`, `backendType`).
- `inboxes/<name>.json`: Array von `{ from, text, summary?, timestamp, color?, msgV: 1, msg_id, type: "message", read }`; der Empfänger leert die Datei nach 1–2 s. Strukturiert als JSON-String in `text`: `task_assignment`, `idle_notification` (`result` = Ergebnis an den Lead).
- `~/.claude/tasks/<team>/<id>.json`: `{ id, subject, description, owner?, status, blocks, blockedBy }`, dazu `.lock`, `.highwatermark`.

## Nachrichten von außen
- Eintrag mit `from: "user"`, neuer `msg_id`, `read: false` anhängen; wiederverwendete `msg_id` kommt nicht an. Sperre wie proper-lockfile: `<inbox>.json.lock` per mkdir, atomar schreiben (tmp + rename), `rmdirSync`; älter als 10 s = verwaist. Der Empfänger erfährt, dass sie aus einer anderen Sitzung kommt.

## Stolperfallen beim Entwickeln
- Node 24.11.1 löscht mit `fs.rmSync` unter einem Pfad mit Umlauten still nichts; `tempDir()` der Sidecar-Tests enthält „Ümläut“. Deshalb `unlinkSync`/`rmdirSync` (auch `removeDir` in agent-teams.ts).
- DB-Migrationen: `repairAgentsEnabledOrder` hängt an `AGENTS_ENABLED_VERSION` (Position der agents_enabled-Migration), nicht an `MIGRATIONS.length`; sonst bricht die Reparatur, sobald eine Migration angehängt wird.
- Python unter Windows schreibt im Textmodus CRLF; für Quelltext-Skripte `read_bytes`/`write_bytes`.
