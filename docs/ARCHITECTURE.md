# FORGE – Architektur

```
┌──────────────────────────────── Tauri-Fenster (WebView2) ───────────────────────────────────┐
│  React-UI (apps/desktop/src)                                                                  │
│   Zustand (UI-State, Event-Puffer) · TanStack Query (RPC-Cache) · Radix/Tailwind-Primitives   │
│        │ invoke("sidecar_send", line)                     ▲ event "sidecar://message"        │
└────────┼──────────────────────────────────────────────────┼──────────────────────────────────┘
         ▼                                                  │
┌──────── Rust-Hülle (apps/desktop/src-tauri) ──────────────┼──────────────────────────────────┐
│  sidecar.rs: startet node, schreibt stdin, liest stdout   │   Plugins: dialog (Ordner),        │
│  keine Shell-/FS-/HTTP-Rechte für die Webview             │   opener (https, localhost)        │
└────────┼──────────────────────────────────────────────────┼──────────────────────────────────┘
         ▼ stdin (JSON-Lines)                               │ stdout (JSON-Lines)
┌──────── Node-Sidecar (packages/sidecar) ────────────────────────────────────────────────────┐
│  rpc/server.ts      Zod-Validierung aller Parameter (packages/protocol)                       │
│  sessions/          SessionService: Statusmaschine, Freigaben, Persistenz, Redaction          │
│  claude/            ClaudeRuntime-Interface, AgentSdkRuntime, Normalizer, Diagnose            │
│  policy/            Profile, harte Sperrliste (PreToolUse), Secret-Redactor                   │
│  git/               GitEngine (git-CLI, Argument-Arrays), Parser                               │
│  projects/          ProjectManager, Technologie-Erkennung, Vorlagen                           │
│  persistence/       SQLite (node:sqlite), Migrationen                                         │
└────────┬───────────────────────────────┬────────────────────────────────────────────────────┘
         ▼                               ▼
   Claude Code CLI (installiert,      git / gh
   eigener Login in ~/.claude)
```

## Module und Verantwortung

| Modul | Pfad | Aufgabe |
|---|---|---|
| desktop-shell | `apps/desktop/src-tauri` | Fenster, Ordnerdialog, Lebenszyklus des Sidecars |
| UI | `apps/desktop/src` | Screens, Komponenten, Stores |
| protocol | `packages/protocol` | RPC-Methoden, Events, Modelle, Fehlercodes (Zod) |
| claude-runtime | `packages/sidecar/src/claude` | Adapter zum Agent SDK, Normalisierung der Stream-Events |
| session-service | `packages/sidecar/src/sessions` | Sessions starten/fortsetzen/stoppen, Freigaben, Persistenz. `session-service` ist nur die Fassade (öffentliche API, Verdrahtung). Aufgeteilt in `session-core` (Live-Sessions, Events, Status), `lifecycle` (Start, Fortsetzen, Stop, Schließen, Löschen, Shutdown), `turns` (Nachrichten senden, zurückhalten bis die Automatik fertig ist), `stream` (CLI-Ausgabe zu Timeline, Status, Kontext, Hintergrundaufgaben), `approvals` (Policy-Hook, Freigabeanfragen, Audit), `permission-mode` (Modus auf das Profil begrenzen, Profilwechsel), `runtime-catalog` (Fähigkeiten, Modelle, Befehle, Plan-Nutzung), `live-session`, `remote-bridge` (Remote Control), `turn-automation` (Tests, Auto-Commit mit Rückfrage bei möglichen Secrets, Auto-Push) und `claude-assist` (Commit-Nachricht, PR-Text, Zusammenfassung) |
| project-manager | `packages/sidecar/src/projects` | Import, Anlage, Klonen, Metadaten |
| git-engine | `packages/sidecar/src/git` | Status, Diff, Stage, Commit, Branches |
| security/policy | `packages/sidecar/src/policy` | Profile, Sperrliste, Redaction |
| persistence | `packages/sidecar/src/persistence` | SQLite-Schema, Repositories |

## ClaudeRuntime-Schnittstelle

Gefordert waren `startSession, sendMessage, streamEvents, approveOrDenyTool, stopSession, resumeSession,
listSessions, capabilities`. Umsetzung in `claude/runtime.ts`:

| Gefordert | Umsetzung |
|---|---|
| startSession | `ClaudeRuntime.startSession(opts, sink)` |
| sendMessage | `RuntimeSession.sendMessage(text)` |
| streamEvents | Push über `SessionSink.onMessage` → `Normalizer` → `session.event` an die UI |
| approveOrDenyTool | `SessionSink.onApproval` liefert ein Promise; `SessionService.respondApproval` löst es auf |
| stopSession | `RuntimeSession.interrupt()` (Turn stoppen) und `close()` (Prozess beenden) |
| resumeSession | `ClaudeRuntime.startSession({ resume: claudeSessionId, … }, sink)` |
| listSessions | `ClaudeRuntime.listSessions(dir)` (auch im Terminal gestartete Sessions) |
| capabilities | `ClaudeRuntime.capabilities(init, cliCapabilities)` |

## Session-Statusmaschine

```
starting ─► running ◄──► waiting_approval
              │  ▲
   turn.result│  │send
              ▼  │
             idle
              │
           close / Prozessende ─► stopped
           Absturz / Auth-Fehler ─► error
   running / waiting_approval ──stop──► stopping ─► idle (Turn abgebrochen, Session lebt weiter)
   App-Ende oder Neustart: offene Sessions ─► interrupted ─(resume)─► starting
```

Stop auf einer untätigen Session tut nichts. Start und Resume einer Session laufen nacheinander; ein
zweites Resume oder Senden wartet auf den Prozess, den das erste gestartet hat. Beim Beenden der App
wartet der Sidecar bis zu 5 Sekunden auf Nacharbeiten (Tests, Auto-Commit) und das Telefon, dann
setzt er offene Sessions auf `interrupted`.

Jede Session speichert `cwd` beim Start. Resume nutzt immer dieses `cwd`, auch wenn das Projekt
verschoben wurde. Events werden mit `seq`, Zeitstempel, Typ und Session-ID in SQLite abgelegt;
Token-Deltas werden nur live gesendet, nie gespeichert. `sessions.events` liefert die neuesten
20.000 Events in aufsteigender Reihenfolge, ältere über den Parameter `beforeSeq`. Einmal-Aufrufe
der CLI (Prüfung, Befehlsliste, Commit-Nachricht, Usage) brechen nach 45 Sekunden ab.

## Prozesse und Aufräumen

- **Job Object:** Jeder Sidecar-Start läuft in einem eigenen Job Object mit `KILL_ON_JOB_CLOSE`. Beenden,
  Neustart oder Absturz von FORGE beenden damit auch alle Kindprozesse (Claude, Dev-Server, Tests).
  Terminals sind davon getrennt.
- **Zeitlimits:** Ein Timeout beendet den ganzen Prozessbaum (`taskkill /T /F`).
  Rust wartet beim Beenden 7 Sekunden auf den Sidecar; das muss über dessen eigenem Limit von
  5 Sekunden bleiben (`SHUTDOWN_GRACE` in `sidecar.rs`, `SHUTDOWN_LIMIT_MS` in `app.ts`).

## Datenablage

- `%APPDATA%\forge\forge.db`, überschreibbar mit `FORGE_DATA_DIR`.
- Tabellen: `projects`, `sessions`, `events`, `approvals` (Audit), `settings`.
- Claude-eigene Daten (`~/.claude`, `.claude/settings.json`, `CLAUDE.md`) schreibt FORGE nur auf Klick:
  CLAUDE.md-Dateien, Skills, Subagenten und den Schlüssel `hooks` in `settings.json`. Schreiben ist atomar,
  legt eine `.bak` an und erkennt gleichzeitige Änderungen. Gelöschte Skills wandern nach
  `<Datenordner>/trash/skills/`.
