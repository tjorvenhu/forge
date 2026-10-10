# FORGE – Architektur

```
┌──────────────────────────── Tauri-Fenster (WebView2 / WebKitGTK) ───────────────────────────┐
│  React-UI (apps/desktop/src)                                                                  │
│   Zustand (UI-State, Event-Puffer) · TanStack Query (RPC-Cache) · Radix/Tailwind-Primitives   │
│        │ invoke("sidecar_send", line)                     ▲ event "sidecar://message"        │
└────────┼──────────────────────────────────────────────────┼──────────────────────────────────┘
         ▼                                                  │
┌──────── Rust-Hülle (apps/desktop/src-tauri) ──────────────┼──────────────────────────────────┐
│  sidecar.rs: startet node, schreibt stdin, liest stdout   │   Plugins: dialog (Ordner),        │
│  keine Shell-/FS-/HTTP-Rechte für die Webview             │   opener (nur https)               │
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
| session-service | `packages/sidecar/src/sessions` | Sessions starten/fortsetzen/stoppen, Freigaben, Persistenz |
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
| resumeSession | `ClaudeRuntime.resumeSession(claudeSessionId, …)` |
| listSessions | `ClaudeRuntime.listSessions(dir)` (auch im Terminal gestartete Sessions) |
| capabilities | `ClaudeRuntime.capabilities(init, cliCapabilities)` |

## Session-Statusmaschine

```
starting ─► running ◄──► waiting_approval
              │  ▲
   turn.result│  │send
              ▼  │
             idle ──stop──► stopping ─► idle (Turn abgebrochen, Session lebt weiter)
              │
           close / Prozessende ─► stopped
           Absturz / Auth-Fehler ─► error
   App-Neustart: offene Sessions ─► interrupted ─(resume)─► starting
```

Jede Session speichert `cwd` beim Start. Resume nutzt immer dieses `cwd`, auch wenn das Projekt
verschoben wurde. Events werden mit `seq`, Zeitstempel, Typ und Session-ID in SQLite abgelegt;
Token-Deltas werden nur live gesendet, nie gespeichert.

## Datenablage

- `%APPDATA%\forge\forge.db` (Windows) bzw. `~/.local/share/forge/forge.db` (Linux), überschreibbar mit `FORGE_DATA_DIR`.
- Tabellen: `projects`, `sessions`, `events`, `approvals` (Audit), `settings`.
- Claude-eigene Daten (`~/.claude`, `.claude/settings.json`, `CLAUDE.md`) werden nur gelesen, nie geschrieben.
