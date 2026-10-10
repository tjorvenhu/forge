# Tests und Ergebnisse

Letzter vollständiger Lauf: 2026-10-10, Windows 11 Pro 26200, Node 24.14, Claude Code 2.1.296 (Max-Login).

| Suite | Befehl | Ergebnis |
|---|---|---|
| Lint | `pnpm lint` | ohne Befund |
| Typecheck (protocol, sidecar, desktop) | `pnpm typecheck` | ohne Fehler |
| Sidecar Unit/Integration | `pnpm --filter @forge/sidecar test` | 76 / 76 bestanden |
| Desktop Unit/Komponenten | `pnpm --filter @forge/desktop test` | 7 / 7 bestanden |
| E2E mit echter Claude-Session | `pnpm test:e2e` | 8 / 8 bestanden |
| Rust-Hülle | `cargo build` | ohne Warnungen |

## Was die Suites abdecken

**Unit/Integration (Sidecar)**
- `git-parsers.test.ts`: Porcelain-v2-Status (Umbenennungen, Konflikte, Leerzeichen, Umlaute, detached HEAD), Unified-Diff-Parser, Log, Branches, Secret-/Artefakt-Erkennung, Clone-URL-Validierung (`ext::`, `--upload-pack`, `file://` abgelehnt).
- `policy.test.ts`: Sperrliste (Force-Push, Push auf main, reset --hard, Branch löschen, rm -rf /, sensible Pfade), Profile, Autonomous-Sperre, Redaction.
- `project-git.test.ts`: Import/Kanonisierung/Dubletten (auch Groß-/Kleinschreibung unter Windows), Persistenz über DB-Neustart, Projekt anlegen mit Vorlagen, fehlender Ordner, echte Git-Repos: Diff, Commit nur der ausgewählten Dateien, Secret-Stopp, Konflikt-Stopp, erster Commit.
- `normalize.test.ts`: Normalizer gegen eine aufgezeichnete echte `stream-json`-Ausgabe (Fixture), Robustheit gegen kaputte/unbekannte Events.
- `session-service.test.ts`: Session-Lebenszyklus mit simulierter Runtime: Profil-Modi, Freigaben + Audit, Sperrliste, Stop, Absturz und Resume, Fehlerdarstellung, Redaction.

**Desktop**
- `chat-items.test.ts`: Zusammenbau der Chat-Elemente aus Events, Streaming-Puffer, Store-Merge.
- `GitPanel.test.tsx`: Commit-Flow in der Komponente (Auswahl, Review-Dialog, exakter RPC-Aufruf).

**E2E (`real-claude.e2e.test.ts`)**, echter Sidecar-Prozess + installierte CLI + echtes Git:
1. Diagnose: CLI gefunden, angemeldet (claude.ai, max), kein API-Key
2. Projektimport mit Leerzeichen/Umlauten im Pfad
3. Session starten, echte Token-Deltas, Tool-Events, Datei geschrieben (Balanced)
4. Git-Status und Diff, Commit
5. Safe: Freigabeanfrage, Ablehnung, Befehl nicht ausgeführt
6. Autonomous (bypassPermissions): Sperrliste blockiert `git branch -D` per PreToolUse-Hook
7. Stop mitten im Streaming, Session bleibt nutzbar
8. Sidecar-Absturz (SIGKILL), Neustart, Session als unterbrochen erkannt, Resume mit Kontext

## Manueller UI-Smoke-Test (Windows, über UI Automation)

In der laufenden Desktop-App (`pnpm tauri dev`) durchgeführt:
Projekt öffnen, Datei-Diff ansehen, zwei Dateien auswählen, Commit-Nachricht, Review-Dialog, Commit
(per `git log` bestätigt); neue Session starten und Prompt senden; Profil auf Safe, Freigabekarte erscheint,
Erlauben, Datei angelegt; App-Neustart öffnet das letzte Projekt; hartes Beenden des Fensters hinterlässt
keine Node-Prozesse.

Dabei gefundene und behobene Fehler: Kopfzeile aktualisierte sich nach Commit nicht; absolute Pfade in
Tool-Karten; Radix-Select hat beim Laden der Modellliste das Session-Modell ohne Nutzeraktion geändert;
fehlende Error-Boundary; Warnung über parallele Sessions zählte auch untätige Sessions.

## Nicht getestet

- Linux (keine Umgebung verfügbar)
- Töne: Wiedergabe kann ich nicht hören; Code-Pfad ist typgeprüft, Test-Knöpfe unter Einstellungen
- Installer-Installation auf einem frischen System
