# Tests und Ergebnisse

Letzter vollständiger Lauf: 2026-10-12, Windows 11 Pro 26200, Node 24.11, Claude Code mit Max-Login (E2E mit Haiku).

| Suite | Befehl | Ergebnis |
|---|---|---|
| Lint | `pnpm lint` | ohne Befund |
| Typecheck (protocol, sidecar, desktop) | `pnpm typecheck` | ohne Fehler |
| Sidecar Unit/Integration | `pnpm --filter @forge/sidecar test` | 386 / 388 bestanden; die 2 Fehler treten auch ohne die Änderungen vom 2026-10-12 auf (gelöschte Datei unter Windows kurz noch sichtbar, siehe HANDOFF) |
| Desktop Unit/Komponenten | `pnpm --filter @forge/desktop test` | 139 / 139 bestanden |
| E2E mit echter Claude-Session | `pnpm test:e2e` (unter PowerShell 5.1: Build und `npx vitest run test/e2e` einzeln) | 17 / 17 bestanden |
| Release-App ohne Node/Git/gh im PATH | manuell | Sidecar läuft aus `runtime/node`, Diagnose zeigt „mitgeliefert“ |
| Rust-Hülle | `cargo build` | ohne Warnungen |
| Gemini Live und Gemini-Sprache gegen den echten Dienst | `scripts/gemini-live-smoke.ts`, `scripts/gemini-voice-smoke.ts` | bestanden (2026-10-12) |
| Strukturierte Antwort mit der echten CLI | `scripts/structured-smoke.ts` | bestanden (Haiku, 4 s) |
| Rust-Hülle mit gebündelten Zeilen | `cargo build` | ohne Fehler |

## Was die Suites abdecken

**Unit/Integration (Sidecar)**
- `git-parsers.test.ts`: Porcelain-v2-Status (Umbenennungen, Konflikte, Leerzeichen, Umlaute, detached HEAD), Unified-Diff-Parser, Log, Branches, Secret-/Artefakt-Erkennung, Clone-URL-Validierung (`ext::`, `--upload-pack`, `file://` abgelehnt).
- `policy.test.ts`: Sperrliste (Force-Push, Push auf main, reset --hard, Branch löschen, rm -rf /, sensible Pfade), Profile, sandbox-only sperrt Autonomous, Redaction.
- `project-git.test.ts`: Import/Kanonisierung/Dubletten (auch Groß-/Kleinschreibung unter Windows), Persistenz über DB-Neustart, Projekt anlegen mit Vorlagen, fehlender Ordner, echte Git-Repos: Diff, Commit nur der ausgewählten Dateien, Secret-Stopp, Konflikt-Stopp, erster Commit.
- `normalize.test.ts`: Normalizer gegen eine aufgezeichnete echte `stream-json`-Ausgabe (Fixture), Robustheit gegen kaputte/unbekannte Events.
- `session-service.test.ts`: Session-Lebenszyklus mit simulierter Runtime: Profil-Modi, Freigaben + Audit, Sperrliste, Stop, Absturz und Resume, Fehlerdarstellung, Redaction.
- `usage-commit.test.ts`: Umwandlung der Usage-Daten, Prompt und Bereinigung der KI-Commit-Nachricht.
- `setup-tools.test.ts`: Auslesen der Login-URL aus der echten CLI-Ausgabe, Vorrang der mitgelieferten Werkzeuge, PATH für Sessions.

- `claude-config.test.ts`: CLAUDE.md global/Projekt/lokal mit Konflikterkennung, .bak, git exclude; Skills/Subagenten anlegen, auflisten, löschen; Hooks prüfen und nur den Schlüssel ersetzen; MCP-Ausgabe parsen und Argumente bauen.
- `worktrees.test.ts`: Worktree anlegen/entfernen (echtes Git), Branch-Slugs.
- `removal.test.ts`: GitHub-Repo aus dem Remote lesen, gesperrte Ordner (Laufwerk, Home, Standardordner, FORGE-Daten, verschachtelte Projekte), Löschen von Ordner (inkl. schreibgeschützter Git-Objekte) und Repo mit simuliertem gh. Worktree eines Agenten entfernen, während ein Prozess im Ordner läuft (Session wird vorher beendet; belegter Ordner gibt eine klare Meldung, der Rest geht beim nächsten Versuch).
- `session-service.test.ts` (Remote): Bridge für offene Sessions, Echo eigener Nachrichten ohne Dublette, Nachricht vom Handy startet einen Durchlauf und landet mit Markierung im Verlauf. Remote ist global: Einschalten ohne laufende Session startet nichts, N laufende Sessions aus mehreren Projekten bekommen N Einträge mit eindeutigen Namen, gestartete und fortgesetzte Sessions werden automatisch verbunden, beendete und gelöschte fallen heraus, Ausschalten trennt alle, erneutes Einschalten verbindet fehlgeschlagene neu.
- `session-service.test.ts` (ergänzt): Auto-Test + Auto-Commit nur mit Dateien des Durchlaufs, kein Commit bei roten Tests.
- `project-git.test.ts` (ergänzt): Push/Pull gegen lokales Bare-Remote (main-Schutz, Fast-Forward, Divergenz).

- `session-service.test.ts` (Phase 4): Antworten auf Rückfragen als `updatedInput.answers`, Überspringen, Plan annehmen setzt den Profilmodus, Feedback hält den Plan-Modus, Modus-Sync aus `system/status`, Kontextstand nach dem Durchlauf, Komprimierung im Verlauf.
- `policy.test.ts` (Phase 4): Plan-Datei in `~/.claude/plans` erlaubt, alles andere außerhalb weiter gesperrt (auch per `..`).
- `search-devserver.test.ts`: Volltextsuche (Präfix, Groß-/Kleinschreibung, Umlaute, FTS-Syntax wirkungslos, Treffer verschwinden mit der Session); Dev-Server-Erkennung (inkl. `npm run dev`), Adress-Erkennung aus typischer Ausgabe, Start/Stopp mit echtem Prozess, Absturz mit Exit-Code.

- `phone-units.test.ts`: SIP-Parser (Kurzformen, Fortsetzungszeilen, Header-Listen), Antworten, Digest gegen das RFC-2617-Beispiel, SDP, G.711 gegen Referenzwerte, Downsampling ohne Aliasing, WAV, Sprachpausen-Erkennung (auch höhere Schwelle während FORGE spricht), RTP mit Takt, Stille und DTMF, Nummernvergleich, vorlesbarer Text, DPAPI-Ablage mit Sonderzeichen.
- `phone-live.test.ts` (ADR 0011): Werkzeug-Schemas für Gemini und Prüfung der Argumente, Gemini-Live-Client mit Fake-WebSocket (Setup, 8↔16/24 kHz, Function Calls, goAway mit Resumption, abgelehnter Key), Gesprächsablauf mit Gemini (Begrüßung, Audio vor dem Abnehmen, Werkzeuge, zurückgezogene Aufrufe, Unterbrechen, Auflegen, PIN, Ausfall), Gemini-Sprache per SSE, Tischtelefon (Provisioning, LEDs, Digest am Telefon, Token- und IP-Prüfung, Taste startet Anruf, Freigabe-Menü, Taste im Gespräch).
- Gegen echte Dienste (braucht `GEMINI_API_KEY`): `pnpm --filter @forge/sidecar exec tsx scripts/gemini-live-smoke.ts` (Verbindung, Function Call, deutsche Antwort mit Sprache) und `scripts/gemini-voice-smoke.ts` (Sprachausgabe und Wiedererkennung).
- `phone-call.test.ts`: Test-Anlage über echtes UDP: Registrierung mit Digest und NAT-Erkennung, falsches Passwort, Wählen nur mit Ziffern und CANCEL beim Klingeln; PhoneService Ende zu Ende: fremde Nummer abgewiesen, erlaubter Anruf mit Begrüßung, Audio in beide Richtungen, Erkennung bis zu Claude, gesperrtes Steuern, falsche und richtige PIN per DTMF, Auflegen durch die Gegenstelle, Protokoll mit Transkript; Rückruf nach fertiger Session mit Proxy-Auth, Sprache erst nach dem Abnehmen, PCMU, Auflegen durch FORGE.

**Desktop**
- `chat-items.test.ts`: Zusammenbau der Chat-Elemente aus Events, Streaming-Puffer, Store-Merge.
- `title-tooltips.test.tsx`: eigener Tooltip statt nativem `title`, Wiederherstellen des Attributs, Schließen bei Klick.
- `chat-items.test.ts` (Phase 4): Sprung zur Nachricht eines Suchtreffers, Hinweis bei Komprimierung, Kurztexte für Rückfrage und Plan.
- `InteractiveCards.test.ts`: Fragen robust lesen, Antworten zusammensetzen (Einfach-/Mehrfachauswahl, eigene Antwort), Warnstufen der Kontextanzeige.
- `AgentsTab.test.tsx`: Worktrees nur des offenen Projekts, Entfernen beendet die Terminals des Worktrees und verlässt ihn, wenn er offen war, Bestätigung bei Änderungen.
- `SessionTabs.test.tsx`: Session-Tabs oben im Fenster: ausgeblendet ohne Sessions, Gruppen pro Projekt in stabiler Reihenfolge, aktive Session nur im Workspace markiert, offene Session ohne Prozess als letzter Tab ihrer Gruppe, Klick öffnet Projekt und Session, Beenden nur ohne laufende Arbeit, Pfeiltasten über Gruppen hinweg.
- `shortcuts.test.tsx` (ergänzt): `Strg+Tab` in der Reihenfolge der Tab-Leiste.
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
13. Rückfrage im Autonomous-Profil beantwortet, Claude nennt die gewählte Antwort; Kontextstand gemeldet; `/compact` erzeugt `context.compacted`
14. Plan-Modus im Autonomous-Profil: Plan-Datei nicht blockiert, Plan angenommen, Modus wechselt auf `bypassPermissions`, Datei angelegt

15. Telefon: Claude (Haiku) nutzt das Werkzeug status, antwortet in höchstens drei kurzen deutschen Sätzen ohne Markdown, schaltet Remote Control auf Zuruf ohne Rückfrage ein und legt bei „Tschüss“ selbst auf

(Weitere E2E-Fälle seit Phase 2: Profilwechsel im Lauf, Hintergrundaufgaben.)

Nicht getestet: echte Telefonanlage und echte OpenAI-Sprachdienste (keine Zugangsdaten im Testlauf).

## Manueller UI-Smoke-Test Telefon (2026-10-11)

Isolierter Dev-Build gegen eine Mini-Anlage auf 127.0.0.1: Telefon-Knopf oben rechts (angemeldet, Menü),
Einstellungen mit Status und gespeicherten Geheimnissen, Testanruf mit Anzeige „klingelt“ und Auflegen. Gefunden
und behoben: Auflegen beim Klingeln wartete bis zu 32 s auf die Antwort zum CANCEL; Nummern mit Leerzeichen wurden
URL-kodiert gewählt; Statusanzeige „Gespräch läuft“ schon beim Klingeln. Beobachtet: Die Windows-Firewall fragt
beim ersten Anruf nach Zugriff für Node.js (Hinweis in den Einstellungen ergänzt).

## Manueller UI-Smoke-Test Phase 4 (2026-10-11)

Dev-Build mit eigenem `FORGE_DATA_DIR` und `WEBVIEW2_USER_DATA_FOLDER` (die installierte FORGE lief parallel
unberührt), Testdaten per Skript: Suchfeld in der Sidebar, Strg+K mit Sessions und Volltexttreffern,
Sprung zur Nachricht mit Hervorhebung, Rückfrage-Karte offen und beantwortet, Plan-Karte, Komprimierungs-Hinweis,
Dev-Server über Kopfzeile und Panel gestartet (HTTP-Antwort geprüft), „An Claude“ füllt den Entwurf, Stoppen
beendet den Prozessbaum (Port frei). Gefunden und behoben: ohne Lockfile wurde `npm dev` statt `npm run dev` erkannt.
Nicht im Fenster geprüft: die Kontextanzeige (braucht eine laufende Session; im E2E-Test abgedeckt).

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

## Vierter UI-Durchlauf (Windows, Dev-Build mit eigenem Datenordner)

Remote Control echt: Einschalten ohne offene Session öffnet eine leere Session, Bridge verbunden, QR-Code und Link; Nachricht aus FORGE ohne Dublette im Verlauf; Ausschalten. Projekt löschen: Dialog mit Ordner und GitHub-Repo, Anfrage der Berechtigung delete_repo sichtbar (nicht ausgeführt), echtes Löschen des Ordners inkl. offener Session. Alle Ansichten auf Umbrüche und Platzierung geprüft. Gefundene und behobene Fehler: leere Modellauswahl bei neuer Remote-Session, „1 Schritte“, Titel blieb „Remote-Session“, Tag-Beschreibungen nicht bündig, Pfad brach mitten im Wort, Badge „Remote“ (Git-Remote) verwechselbar, doppelter Spinner in ladenden Knöpfen, Töne-Beschreibung gequetscht, „max Abo“, veraltete Texte („folgen in Phase 2“), Git-Tab ohne Repository zeigte Branches/Verlauf und hing nach der ersten Korrektur in einer Ladeschleife.

## Nicht getestet

- Töne: Wiedergabe kann ich nicht hören; Code-Pfad ist typgeprüft, Test-Knöpfe unter Einstellungen
- Installer-Installation auf einem frischen System ohne Claude Code
- Claude-Code-Installation aus der App (würde die vorhandene Installation verändern)
- Remote Control mit der echten Claude-App: Bridge-Verbindung und Session-Link mit dem echten SDK und in der App geprüft, Nachrichten vom Handy nur simuliert
- Eigene Tooltips im Fenster: Mausbewegung per Automation erreichte das Fenster nicht; Logik per Komponententest geprüft
- Push/PR gegen GitHub mit echtem Konto (gh nicht angemeldet); Logik gegen lokales Bare-Remote getestet
- Claude-Anmeldung bis zum Ende (URL-Ausgabe in isoliertem Konfigurationsordner geprüft) und GitHub-Anmeldung bis zum Ende
