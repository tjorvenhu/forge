# FORGE – Claude Development Studio

Desktop-Oberfläche für Claude Code. FORGE startet und steuert echte Claude-Code-Sessions in deinen
Projekten, zeigt Antworten live, fragt Freigaben ab und bringt Git-Status, Diffs und geprüfte Commits in
dieselbe Ansicht. Die Anmeldung läuft über deine bestehende Claude-Code-Anmeldung (z. B. Max-Abo).
Ein API-Key ist nicht nötig.

> Stand: Phase 0 und Phase 1 (MVP). Details zu Umfang und Lücken unten und in [HANDOFF.md](HANDOFF.md).

![Workspace mit Chat, Tool-Karten und Diff](docs/screenshots/workspace.png)

| Home | Freigabeanfrage im Safe-Profil |
|---|---|
| ![Home](docs/screenshots/home.png) | ![Freigabe](docs/screenshots/freigabe.png) |

## Voraussetzungen

| Werkzeug | Version (getestet) | Wofür |
|---|---|---|
| Windows 11 oder Linux | Windows 11 26200 | Linux: nicht getestet, siehe Lücken |
| Node.js | ≥ 22.13 (getestet 24.14) | Sidecar, nutzt `node:sqlite` |
| pnpm | 10.x | Paketverwaltung |
| Rust + Cargo | stable (getestet 1.99, MSVC) | Tauri-Hülle |
| Windows: Visual Studio Build Tools | 2022, Workload „C++ Build Tools" | Rust-Linker |
| Claude Code CLI | getestet 2.1.296 | Sessions |
| git | getestet 2.53 | Git-Funktionen |
| GitHub CLI `gh` | optional, getestet 2.102 | ab Phase 2 (PRs) |

Installation unter Windows (einmalig):

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
winget install GitHub.cli   # optional
```

Linux (Debian/Ubuntu) braucht zusätzlich die Tauri-Systempakete: `libwebkit2gtk-4.1-dev`, `build-essential`,
`libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

## Claude-Max-Anmeldung

FORGE nutzt die **installierte Claude-Code-CLI** über den offiziellen Agent SDK
(`@anthropic-ai/claude-agent-sdk`, Option `pathToClaudeCodeExecutable`). Es gilt also genau die Anmeldung,
die du im Terminal benutzt:

```bash
claude auth status   # sollte "loggedIn": true und "subscriptionType": "max" zeigen
claude auth login    # falls nicht angemeldet
```

- FORGE liest keine Tokens und speichert keine Zugangsdaten.
- Ist `ANTHROPIC_API_KEY` gesetzt, würde Claude Code den Key statt des Abos nutzen. FORGE erkennt das,
  warnt und entfernt den Key standardmäßig aus der Session-Umgebung (abschaltbar unter Einstellungen).
- Pro Session zeigt FORGE die von der CLI gemeldete `apiKeySource` an. Im Test: `none` (Abo-Anmeldung).
- Laut Anthropic-Hilfeartikel „Use the Claude Agent SDK with your Claude plan" (Stand 07.10.2026) ist diese
  Nutzung mit Abo vorgesehen. Bedingungen können sich ändern; prüfe den Artikel bei Unsicherheit.
- `total_cost_usd` aus Claude Code ist bei Abo ein API-Äquivalent. FORGE zeigt deshalb keine Kosten an, nur
  Tokens und Dauer pro Durchlauf.

## Starten

```bash
pnpm install
pnpm dev          # baut den Sidecar und startet die Desktop-App (Tauri dev)
```

Weitere Befehle:

```bash
pnpm lint         # ESLint über alle Pakete
pnpm typecheck    # TypeScript strict für protocol, sidecar, desktop
pnpm test         # Unit- und Integrationstests (ohne echte Claude-Aufrufe)
pnpm test:e2e     # E2E mit echter Claude-Session (verbraucht etwas Abo-Kontingent, Modell haiku)
pnpm build        # Release-Build inkl. Installer (NSIS unter Windows)
```

Umgebungsvariablen für Sonderfälle: `FORGE_NODE` (Pfad zu node), `FORGE_SIDECAR` (Pfad zu `sidecar.mjs`),
`FORGE_DATA_DIR` (Datenordner), `FORGE_E2E=0` (E2E überspringen), `FORGE_E2E_MODEL` (Modell für E2E).

## Was funktioniert (Phase 1)

- **Projekte:** Ordner importieren (kanonisiert, Dubletten-Erkennung), neu anlegen (Vorlagen, git init,
  README, .gitignore, CLAUDE.md), Repository klonen (nur https/ssh, sichere Argumente), Favoriten, Tags,
  Technologie-Erkennung, „Ordner fehlt"-Zustand, Entfernen ohne Dateien zu löschen.
- **Claude-Sessions:** starten, Prompt senden, echtes Token-Streaming, Tool-Aufrufe als aufklappbare
  Karten, Aufgabenlisten (TodoWrite), Freigabeanfragen mit Erlauben / Für Session erlauben / Ablehnen,
  Stop (Esc), Modellwechsel, Plan-Modus, Resume auch nach App-Absturz, Übernahme von im Terminal
  gestarteten Sessions inkl. Verlauf.
- **Permission-Profile:** Safe / Balanced / Autonomous mit echter Wirkung auf den Claude-Permission-Modus,
  harte Sperrliste in allen Profilen, Audit-Log.
- **Git:** Status, echter Diff (auch für neue Dateien), Stage/Unstage, Commit nur der ausgewählten Dateien
  mit Review-Dialog und Secret-Prüfung, Verlauf, Branches anlegen und wechseln, git init.
- **Töne:** Signal, wenn Claude fertig ist, eine Freigabe braucht oder ein Fehler auftritt (abschaltbar).
- **Diagnose:** CLI-Version, Anmeldestatus, API-Key-Override, git, gh, Capability-Matrix.
- **Persistenz:** SQLite für Projekte, Sessions, Events, Freigaben, Einstellungen. Beim Start öffnet FORGE das zuletzt genutzte Projekt.

Tastatur: `Strg+1..4` Workspace-Tabs, `Strg+N` neue Session, `Strg+O` Projekt hinzufügen, `Strg+J` Claude-Output,
`Strg+Umschalt+E` Seitenleiste, `Esc` im Eingabefeld stoppt Claude.

## Tests

Letzter Lauf (Details in [docs/TESTING.md](docs/TESTING.md)): Lint und Typecheck ohne Befund, 76 Sidecar-Tests,
7 Desktop-Tests, 8 E2E-Tests mit echter Claude-Session, alle bestanden.

## Dokumentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Prozesse, Module, Statusmaschine
- [docs/SECURITY.md](docs/SECURITY.md): Permission- und Sicherheitskonzept
- [docs/adr/](docs/adr): Architekturentscheidungen
- [docs/TASKS.md](docs/TASKS.md): Taskliste
- [HANDOFF.md](HANDOFF.md): aktueller Stand, bekannte Fehler, nächste Schritte

## Bekannte Lücken

- Linux nicht getestet (keine Linux-Umgebung verfügbar). Code ist plattformneutral geschrieben.
- Kein eingebettetes Terminal (PTY) und kein CLAUDE.md-Editor: Phase 2.
- Kein Push, Pull und keine PRs aus FORGE: Phase 2 (mit Guardrails).
- Projekt-Tags werden gespeichert und angezeigt, steuern aber noch kein automatisches Verhalten.
- Bilder/Dateianhänge im Prompt nicht umgesetzt.
- Der Installer bündelt Node.js nicht; Node ≥ 22.13 muss installiert sein.

## Roadmap

1. **Phase 2:** Tag-Verhalten (plan-first, auto-test, review-required), gh-PR-Flow, Push/Pull mit
   Guardrails, CLAUDE.md-Editor (Monaco), Git-Timeline je Session, Terminal (xterm.js + PTY).
2. **Phase 3:** Git-Worktrees für parallele Agenten, MCP-/Skills-/Hooks-Verwaltung, Resume-Zusammenfassungen,
   Setup-Wizard, Installer mit gebündeltem Node.
