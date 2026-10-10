# Tests und Ergebnisse

Letzter vollständiger Lauf: 2026-10-10, Windows 11 Pro 26200, Node 24.14, Claude Code 2.1.296 (Max-Login).

| Suite | Befehl | Ergebnis |
|---|---|---|
| Lint | `pnpm lint` | ohne Befund |
| Typecheck (protocol, sidecar, desktop) | `pnpm typecheck` | ohne Fehler |
| Sidecar Unit/Integration | `pnpm --filter @forge/sidecar test` | 104 / 104 bestanden |
| Desktop Unit/Komponenten | `pnpm --filter @forge/desktop test` | 8 / 8 bestanden |
| E2E mit echter Claude-Session | `pnpm test:e2e` | 12 / 12 bestanden (mit System-Werkzeugen; 8/8 zusätzlich mit `FORGE_RUNTIME_DIR` auf die mitgelieferte Laufzeit) |
| Release-App ohne Node/Git/gh im PATH | manuell | Sidecar läuft aus `runtime/node`, Diagnose zeigt „mitgeliefert“ |
| Rust-Hülle | `cargo build` | ohne Warnungen |

## Was die Suites abdecken

**Unit/Integration (Sidecar)**
- `git-parsers.test.ts`: Porcelain-v2-Status (Umbenennungen, Konflikte, Leerzeichen, Umlaute, detached HEAD), Unified-Diff-Parser, Log, Branches, Secret-/Artefakt-Erkennung, Clone-URL-Validierung (`ext::`, `--upload-pack`, `file://` abgelehnt).
- `policy.test.ts`: Sperrliste (Force-Push, Push auf main, reset --hard, Branch löschen, rm -rf /, sensible Pfade), Profile, Autonomous-Sperre, Redaction.
- `project-git.test.ts`: Import/Kanonisierung/Dubletten (auch Groß-/Kleinschreibung unter Windows), Persistenz über DB-Neustart, Projekt anlegen mit Vorlagen, fehlender Ordner, echte Git-Repos: Diff, Commit nur der ausgewählten Dateien, Secret-Stopp, Konflikt-Stopp, erster Commit.
- `normalize.test.ts`: Normalizer gegen eine aufgezeichnete echte `stream-json`-Ausgabe (Fixture), Robustheit gegen kaputte/unbekannte Events.
- `session-service.test.ts`: Session-Lebenszyklus mit simulierter Runtime: Profil-Modi, Freigaben + Audit, Sperrliste, Stop, Absturz und Resume, Fehlerdarstellung, Redaction.
- `usage-commit.test.ts`: Umwandlung der Usage-Daten, Prompt und Bereinigung der KI-Commit-Nachricht.
- `setup-tools.test.ts`: Auslesen der Login-URL aus der echten CLI-Ausgabe, Vorrang der mitgelieferten Werkzeuge, PATH für Sessions.

- `claude-config.test.ts`: CLAUDE.md global/Projekt/lokal mit Konflikterkennung, .bak, git exclude; Skills/Subagenten anlegen, auflisten, löschen; Hooks prüfen und nur den Schlüssel ersetzen; MCP-Ausgabe parsen und Argumente bauen.
- `automation.test.ts`: Zeitplan-Fälligkeit, Worktree anlegen/entfernen (echtes Git), kompletter Feature-Workflow mit simulierter Runtime, Stopp bei roten Tests, Ablehnung bei unsauberer Arbeitskopie.
- `session-service.test.ts` (ergänzt): Auto-Test + Auto-Commit nur mit Dateien des Durchlaufs, kein Commit bei roten Tests.
- `project-git.test.ts` (ergänzt): Push/Pull gegen lokales Bare-Remote (main-Schutz, Fast-Forward, Divergenz).

**Desktop**
- `chat-items.test.ts`: Zusammenbau der Chat-Elemente aus Events, Streaming-Puffer, Store-Merge.
- `GitPanel.test.tsx`: Commit-Flow in der Komponente (Auswahl, Review-Dialog, exakter RPC-Aufruf) und KI-Vorschlag.

**E2E (`real-claude.e2e.test.ts`)**, echter Sidecar-Prozess + installierte CLI + echtes Git:
1. Diagnose: CLI gefunden, angemeldet (claude.ai, max), kein API-Key; echte Abo-Nutzung abrufbar
2. Projektimport mit Leerzeichen/Umlauten im Pfad
3. Session starten, echte Token-Deltas, Tool-Events, Datei geschrieben (Balanced)
4. Git-Status und Diff, KI-Commit-Vorschlag, Commit
5. Safe: Freigabeanfrage, Ablehnung, Befehl nicht ausgeführt
6. Autonomous (bypassPermissions): Sperrliste blockiert `git branch -D` per PreToolUse-Hook
7. Stop mitten im Streaming, Session bleibt nutzbar
8. Bild-Anhang: Claude erkennt die Farbe eines erzeugten PNG
9. Datei-Checkpoint: von Claude angelegte Datei per Rewind entfernt
10. Session-Zusammenfassung aus dem Verlauf
11. Slash-Commands (68 im Test)
12. Sidecar-Absturz (SIGKILL), Neustart, Session als unterbrochen erkannt, Resume mit Kontext

## Manueller UI-Smoke-Test (Windows, über UI Automation)

In der laufenden Desktop-App (`pnpm tauri dev`) durchgeführt:
Projekt öffnen, Datei-Diff ansehen, zwei Dateien auswählen, Commit-Nachricht, Review-Dialog, Commit
(per `git log` bestätigt); neue Session starten und Prompt senden; Profil auf Safe, Freigabekarte erscheint,
Erlauben, Datei angelegt; App-Neustart öffnet das letzte Projekt; hartes Beenden des Fensters hinterlässt
keine Node-Prozesse.

Dabei gefundene und behobene Fehler: Kopfzeile aktualisierte sich nach Commit nicht; absolute Pfade in
Tool-Karten; Radix-Select hat beim Laden der Modellliste das Session-Modell ohne Nutzeraktion geändert;
fehlende Error-Boundary; Warnung über parallele Sessions zählte auch untätige Sessions.

## Zweiter UI-Durchlauf (Windows)

Usage-Balken in der Statuskarte, GitHub-Anmeldung bis zur Code-Anzeige (abgebrochen; abschließen kann nur der Nutzer), KI-Commit-Nachricht über den Funken-Knopf, kompakte Nachrichtenblase, schlichter Profil-Knopf, gebaute App mit bereinigtem PATH.

## Dritter UI-Durchlauf (Windows)

Erweiterungen mit echtem MCP-Server, Terminal-Tab (PowerShell im Projekt), Remote-Steuerung (Erkennung „Ordner nicht freigegeben“, Claude-Vertrauensfrage im eingebetteten Terminal), echter Feature-Workflow über die Oberfläche (Worktree, Umsetzung mit zwei Freigaben im Safe-Profil, Commit auf dem Feature-Branch). Gefundene und behobene Fehler: weiße Seite durch freezePrototype; Workflow zeigte nicht an, dass Claude auf eine Freigabe wartet; MCP-Status englisch; Test-Flake durch Hintergrundarbeit beim Aufräumen.

## Nicht getestet

- Linux (keine Umgebung verfügbar)
- Töne: Wiedergabe kann ich nicht hören; Code-Pfad ist typgeprüft, Test-Knöpfe unter Einstellungen
- Installer-Installation auf einem frischen System ohne Claude Code
- Claude-Code-Installation aus der App (würde die vorhandene Installation verändern)
- Remote Control bis zur Steuerung vom Handy (Verbindung und Link wurden vorher per CLI geprüft)
- Push/PR gegen GitHub mit echtem Konto (gh nicht angemeldet); Logik gegen lokales Bare-Remote getestet
- Claude-Anmeldung bis zum Ende (URL-Ausgabe in isoliertem Konfigurationsordner geprüft) und GitHub-Anmeldung bis zum Ende
