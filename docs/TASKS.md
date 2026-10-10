# FORGE – Taskliste

Status: `[x]` erledigt und verifiziert · `[~]` teilweise · `[ ]` offen · `[-]` verworfen

## Phase 0 – Discovery

- [x] Inventar Laufzeit: Node 24.14, pnpm 10.30, git 2.53, Claude Code 2.1.296, Windows 11 (26200)
- [x] Fehlende Voraussetzungen: Rust, MSVC Build Tools, gh → per winget installiert (Freigabe durch Nutzer)
- [x] Auth-Prüfung: `claude auth status` → `authMethod: claude.ai`, `subscriptionType: max`, kein `ANTHROPIC_API_KEY`
- [x] Spike CLI: `claude -p --output-format stream-json --include-partial-messages` streamt echte Events
- [x] Spike Agent SDK 0.3.296: `query()` + `canUseTool` + `listSessions` mit Max-Login (`apiKeySource: none`)
- [x] Capability-Matrix (docs/adr/0002, zur Laufzeit in Einstellungen → Diagnose)
- [x] ADRs: docs/adr/0001–0005

## Phase 1 – MVP

- [x] Monorepo (pnpm workspace): protocol, sidecar, desktop
- [x] Protokoll: typisierte RPC-Methoden, Events, Fehlerklassen (Zod)
- [x] Sidecar: JSON-Lines-RPC über stdio
- [x] Persistenz: SQLite (node:sqlite) mit Migrationen
- [x] Projektverwaltung: importieren, anlegen, klonen, Favoriten, Tags, Technologie-Erkennung, Dubletten
- [x] Claude-Runtime (Agent SDK): start, send, Streaming, Tool-Events, Freigaben, Stop, Resume, Liste
- [x] Policy: Profile Safe/Balanced/Autonomous, harte Sperrliste via PreToolUse-Hook, Audit
- [x] Git: Status, Diff, Stage/Unstage, Commit mit Prüfungen, Log, Branches
- [x] Diagnose: CLI-Version, Auth, API-Key-Override, git, gh
- [x] UI-Shell nach Referenz (Sidebar, Kopfzeile, Tabs, rechte Spalte, unteres Panel)
- [x] Workspace-Chat Ende-zu-Ende
- [x] Screens: Dashboard, Neues Projekt, Projekt-Einstellungen, Git, Sessions, Einstellungen
- [x] Tauri-Shell: Sidecar-Prozess, Ordnerdialog, CSP, minimale Rechte
- [x] Tests: Unit, Integration (Fixtures), E2E mit echter Claude-Session
- [x] README, Architektur, Security-Konzept, HANDOFF
- [x] Nutzerwünsche: Schrift Geist, Töne, Amboss-Logo, Claude-Marke im Chat
- [x] Release-Build/Installer mit mitgelieferter Laufzeit (Node, Git, gh)
- [x] Abo-Nutzung in der Statuskarte
- [x] GitHub-Anmeldung und Repository-Liste in der App
- [x] Claude-Code-Installation und -Anmeldung in der App (Ende-zu-Ende nicht getestet)
- [x] KI-Commit-Nachricht
- [ ] Linux-Smoke-Test

## Phase 2 – Workflow

- [x] Rechteprofile mit bestätigungspflichtigen Tool-Aktionen (seit Phase 1)
- [x] Projekt-Tags mit Verhalten (plan-first, auto-test, auto-commit, auto-push, review-required, no-network, sandbox-only)
- [x] Automatisierte Checks (Testbefehl pro Projekt, Ergebnis im Chat)
- [x] gh-PR-Flow, Push/Pull mit Guardrails, PR-Status
- [x] Git-Autopilot mit Guardrails (nur Dateien des Durchlaufs, nie main/master, nie Force)
- [x] CLAUDE.md-Editor (CodeMirror statt Monaco, ADR 0003/0007)
- [x] Git-Timeline je Session (Checkpoints, Auto-Commits, Datei-Rewind)
- [x] Eingebettetes Terminal (xterm.js + PTY in Rust)
- [x] Anhänge, Slash-Commands
- [x] Remote Control für die Claude-App (FORGE-Sessions selbst, Nachrichten in beide Richtungen, ADR 0008)
- [x] Projekt löschen mit Ordner und GitHub-Repository
- [x] Eigene Tooltips statt der nativen

## Phase 3 – Pro

- [x] Git-Worktrees für parallele Agenten
- [-] Feature-Workflow und geplante Aufgaben: gebaut, auf Wunsch wieder entfernt (ADR 0008)
- [x] MCP-/Skills-/Subagenten-/Hooks-Verwaltung
- [x] Resume-Zusammenfassungen
- [x] Usage-Anzeige, Diagnose, Einrichtung in der App
- [x] Installer mit mitgelieferter Laufzeit
- [ ] Untätige Claude-Prozesse nach Zeit automatisch schließen
- [ ] Installer signieren
