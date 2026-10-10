# FORGE – Taskliste

Status: `[x]` erledigt und verifiziert · `[~]` teilweise · `[ ]` offen

## Phase 0 – Discovery

- [x] Inventar Laufzeit: Node 24.14, pnpm 10.30, git 2.53, Claude Code 2.1.296, Windows 11 (26200)
- [x] Fehlende Voraussetzungen: Rust, MSVC Build Tools, gh → per winget installiert (Freigabe durch Nutzer)
- [x] Auth-Prüfung: `claude auth status` → `authMethod: claude.ai`, `subscriptionType: max`, kein `ANTHROPIC_API_KEY`
- [x] Spike CLI: `claude -p --output-format stream-json --include-partial-messages` streamt echte Events
- [x] Spike Agent SDK 0.3.296: `query()` + `canUseTool` + `listSessions` mit Max-Login (`apiKeySource: none`)
- [x] Capability-Matrix (docs/adr/0002, zur Laufzeit in Einstellungen → Diagnose)
- [x] ADRs: docs/adr/0001–0004

## Phase 1 – MVP

- [ ] Monorepo (pnpm workspace): protocol, sidecar, desktop
- [ ] Protokoll: typisierte RPC-Methoden, Events, Fehlerklassen (Zod)
- [ ] Sidecar: JSON-Lines-RPC über stdio
- [ ] Persistenz: SQLite (node:sqlite) mit Migrationen
- [ ] Projektverwaltung: importieren, anlegen, klonen, Favoriten, Tags, Technologie-Erkennung, Dubletten
- [ ] Claude-Runtime (Agent SDK): start, send, Streaming, Tool-Events, Freigaben, Stop, Resume, Liste
- [ ] Policy: Profile Safe/Balanced/Autonomous, harte Sperrliste via PreToolUse-Hook, Audit
- [ ] Git: Status, Diff, Stage/Unstage, Commit mit Prüfungen, Log, Branches
- [ ] Diagnose: CLI-Version, Auth, API-Key-Override, git, gh
- [ ] UI-Shell nach Referenz (Sidebar, Kopfzeile, Tabs, rechte Spalte, unteres Panel)
- [ ] Workspace-Chat Ende-zu-Ende
- [ ] Screens: Dashboard, Neues Projekt, Projekt-Einstellungen, Git, Sessions, Einstellungen
- [ ] Tauri-Shell: Sidecar-Prozess, Ordnerdialog, CSP, minimale Rechte
- [ ] Tests: Unit (Parser, Policy, ProjectManager), Integration (Event-Adapter mit Fixtures), E2E (Sidecar mit echter Claude-Session)
- [ ] README, Architektur, Security-Konzept, HANDOFF

## Phase 2 (noch nicht begonnen)

- [ ] Projekt-Tags mit Verhalten (plan-first, auto-test, review-required …)
- [ ] gh-PR-Flow, Push/Pull mit Guardrails
- [ ] CLAUDE.md-Editor (Monaco)
- [ ] Git Timeline je Session
- [ ] Eingebettetes Terminal (xterm.js + PTY)
