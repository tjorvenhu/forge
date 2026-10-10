# FORGE – Claude Development Studio

**Master-Prompt / Product Requirements Document**  |  Version 1.0  |  10. Oktober 2026

**So verwenden:** Lege diese Markdown-Datei und die beigefügte FORGE_UI_Referenz.png in einen leeren Projektordner. Öffne dort Claude Code mit deinem bestehenden Max-Login und gib ein: „Lies FORGE_MASTER_PROMPT.md vollständig, betrachte FORGE_UI_Referenz.png und implementiere den Auftrag schrittweise. Beginne jetzt mit Phase 0 und Phase 1.“

**Designbild:** `FORGE_UI_Referenz.png` ist eine KI-generierte visuelle Konzeptstudie, keine fertige funktionierende UI.

## 01 | Rolle und Mission

Du bist leitender Staff-Software-Engineer, Desktop-App-Architekt, Produktdesigner und QA-Verantwortlicher. Baue eine echte, lokal ausführbare Desktop-App namens FORGE – Claude Development Studio. Sie ersetzt meinen üblichen Terminal-Workflow mit Claude Code durch eine erstklassige GUI. Das Ergebnis ist ein lauffähiges Produkt, kein Konzept, keine klickbare Scheinoberfläche und kein bloßer Chatbot. Arbeite eigenständig in umsetzbaren Schritten. Implementiere, teste und dokumentiere. Wenn etwas technisch nicht möglich ist, biete eine belastbare Alternative und kennzeichne die Einschränkung.

WICHTIGER NUTZERKONTEXT: Ich nutze Claude Code bereits mit einem Claude Max-Abonnement und möchte die bestehende offizielle Claude-Code-Anmeldung nutzen. Kein neuer Anthropic-API-Key als Pflicht; keine eigene OAuth-Credential-Extraktion, kein Token-Scraping, keine Umgehung der Authentifizierung. Prüfe zunächst die installierte CLI-/SDK-Version und die offiziell unterstützten Integrationswege. Die Max-/SDK-Bedingungen können sich ändern; dokumentiere die tatsächlich genutzte Methode und mögliche separate Abrechnung transparent.

## 02 | Nicht verhandelbare Produktziele

• Echte native Desktop-App, zunächst Windows 11 und Linux; lokaler Betrieb ohne Cloud-Backend-Zwang.
• Bestehende lokale Projekte öffnen, neue Ordner/Projekte anlegen, GitHub-Repositories klonen.
• Claude-Code-Sessions starten, Eingaben machen, Streaming, Tool-Events, Freigabeanfragen, Stop/Cancel und Resume aus einer UI.
• Projektspezifische Modi/Tags, einschließlich bewusst optierbarem gefährlichem Bypass-Modus mit Sicherheitsbarrieren.
• Git: Status, Diff, Branch, Commit, Push, Pull, PR; Automatisierung über Richtlinien statt blindem Auto-Push.
• Moderne, schnelle Dark-Mode-Oberfläche nach der beigefügten Referenz, responsive bei Desktop-Größen, vollständige Tastaturbedienung.
• Kein Mock als endgültige Funktion: Jede angezeigte primäre Aktion muss an echte lokale Logik gebunden sein.
• Projektdateien und native Claude-Konfiguration weiterverwenden; keine proprietäre Sackgasse.

## 03 | Technischer Stack und Architektur

Bevorzugt Tauri 2 + React + TypeScript + Vite + Tailwind CSS + shadcn/ui + Zustand + TanStack Query. Node.js-TypeScript-Sidecar für Claude-Code-Adapter/SDK-Anbindung; Rust/Tauri nur als restriktiver Desktop-Bridge-Layer. SQLite (z. B. Drizzle) für Projekt-Metadaten, Sitzungsindex, Events, Einstellungen und Workflow-Historie. Monaco für Dateiansicht und Diff; xterm.js + PTY-Bridge für eingebettetes Terminal, soweit OS-kompatibel. Git zunächst über robust gekapselte Git-CLI, GitHub über gh CLI, nur bei installiertem und authentifiziertem gh. Schema-Validierung mit Zod.

Trenne mindestens: desktop-shell; UI; claude-runtime adapter; project-manager; git-engine; workflow-engine; persistence; security/policy. Definiere typisierte Events und Fehlerklassen. Backend-Prozesse sauber stoppen, pro Session cwd und Environment explizit setzen. Keine Shell-Interpolation aus untrusted Strings; spawn mit Argument-Arrays. Terminal/Projektzugriffe nie durch ungeschützte Remote-Web-Schnittstellen bereitstellen.

Wähle zwischen Agent SDK und CLI-Adapter anhand der tatsächlich dokumentierten Fähigkeiten. Eine `ClaudeRuntime`-Schnittstelle muss mindestens startSession, sendMessage, streamEvents, approveOrDenyTool, stopSession, resumeSession, listSessions und capabilities() abstrahieren. Fehlt ein Feature im SDK, baue einen offiziell unterstützten CLI-Pfad nur wo stabil realisierbar. Nicht behaupten, dass jedes interaktive Slash-Kommando als SDK-API verfügbar ist. Sichtbare Capability-Matrix mit supported/partial/unavailable.

## 04 | App-Navigation und UX-Design

Layout: linke Hauptsidebar (Home, Projekte, Sessions, GitHub, Agenten, MCP, Automatisierungen, Einstellungen); Kopfzeile mit Projekt, Branch, Claude-Status, ausgewähltem Modell und Permission-Profil; zentrales Chat-/Plan-/Files-/Terminal-Panel; rechte kontextabhängige Spalte für Git-Diff, Dateiliste, Aufgaben, Aktivitätsfeed; einklappbares Terminal unten.

Design: sehr hochwertiger moderner Developer-Look, dunkelgraphitfarbene Oberflächen, sparsame violette Akzente, gute Lesbarkeit, kompakte sinnvolle Typografie, ruhige Icons, 8px-Spacing-System, konsistente Hover/Focus/Loading/Empty/Error-Zustände. Keine überladenen Neon-/Glassmorphism-Effekte. Alle Dialoge und Komponenten müssen funktionieren. Desktop-Mindestfenster 1100×700, bei kleinerer Breite Panels einklappen.

Screens: (1) Project Dashboard mit Favoriten, kürzlich geöffneten Projekten, Session-Resume, Git-Status; (2) Workspace mit Chat, Agent-Ereignissen und Diff; (3) Neues Projekt / Verzeichnis auswählen / Repository klonen; (4) Projekt-Einstellungen mit Tags und Risiken; (5) Git Center mit Diff, Commits, Branches, PR; (6) Sessions/History mit Filter und Suchfunktion; (7) Einstellungen & Diagnostics.

## 05 | Projektverwaltung

Projekt importieren über OS-Ordnerdialog. Pfad canonicalizen, Existenz/Zugriffsrechte prüfen und Dubletten erkennen. Neues Projekt mit Name, Pfad, optional Git-Initialisierung, README, .gitignore, optional CLAUDE.md und frei wählbarer Vorlage. GitHub-Klon über URL mit sicheren Argumenten und Validierung. Projekte dauerhaft speichern, Favoriten, Tags, Technologie-Erkennung und Last Opened.

Projekt-Karte: Name, Pfad, Git-Branch, Dirty-State, letzte Session, Modell/Profil, GitHub-Remote-Status. Beim Wechsel darf sich das Arbeitsverzeichnis einer aktiven Session nicht unkontrolliert ändern.

Projektkonfiguration: FORGE-eigene lokale JSON/DB-Einstellungen von Claude-eigenen .claude/settings.json sauber trennen; CLAUDE.md respektieren und in einem Editor zugänglich machen. Private/local Overrides nicht versehentlich committen.

## 06 | Claude Code: Sessions und Bedienelemente

Vor Beginn echte Smoke-Tests mit lokal installiertem `claude --version`, `claude --help`, Auth-Status und unterstützten SDK-APIs durchführen. Bestehende Anmeldung verwenden; `ANTHROPIC_API_KEY`-Override erkennen und vor möglichen zusätzlichen API-Kosten warnen, aber keine Secrets anzeigen.

Workspace: Prompt-Composer mit mehrzeiliger Eingabe; Enter/Shift+Enter konsistent; Antwort-Streaming; Tool-Aufrufe als expandierbare Ereigniskarten; Schrittstatus; Logs; Fehler, Retry wo möglich; Stop-Button; Modell- und Permission-Modus pro Session; neue und wiederaufnehmbare Sessions. Pfad- und Sitzungszuordnung müssen dauerhaft korrekt sein. Session-Abstürze und Neustart der App sauber behandeln.

Events mit Zeitstempel + Typ + Status + Session-ID persistieren; sensitive Inhalte bei Logging reduzieren. Bilder/Dateien und Slash-Commands nur implementieren, wenn über den aktiven Runtime-Adapter tatsächlich unterstützt; ansonsten explizit kennzeichnen. Kein Fake-Streaming. Kontexte und Usage nur anzeigen, wenn verlässliche Daten verfügbar sind; keine erfundenen Tokenkosten.

## 07 | Projektprofile / Tags / Permissions

Projekt-Tags sind konfigurierbare Verhaltensregeln, z.B. plan-first, auto-test, auto-commit, auto-push, review-required, sandbox-only, no-network, dangerous-skip-permissions. Implementiere drei Basisprofile: Safe (restriktiv), Balanced (konfigurierbare Genehmigungen), Autonomous (hohe Autonomie NUR mit klar festgelegten Grenzen). Mappings zu offiziellen Claude-Code-Modi zur Laufzeit aus Fähigkeiten ableiten; CLI-Flag `--dangerously-skip-permissions` bzw. SDK-bypassPermissions nur aktivieren, wenn wirklich unterstützt und explizit aktiviert.

AUTONOMOUS-SICHERHEIT: Beim Aktivieren deutliche Warnung und separate Bestätigung; standardmäßig gesperrt. Nur in isoliertem Workspace/Container/VM mit beschränkten Mounts, Benutzerrechten, Netz-/Secret-Zugriff anbieten. Bypass ist KEINE Sandbox. Keine stillschweigende Freischaltung durch importierte Repository-Konfigurationen oder Tags. FORGE-eigene irreversible Git-Aktionen nie allein wegen Bypass ungeprüft ausführen. Keine globale Freigabe gefährlicher Shell-Befehle aus einem Projektfile übernehmen.

Policy Engine: Regeln pro Projekt/Session; zugelassene Arbeitsverzeichnisse, persistierte Zustimmungen mit Ablauf/Scope, Audit-Trail. Secrets maskieren; sensible Ordner wie ~/.ssh, Browserprofile und Credential-Stores nicht ohne explizite Entscheidung einbinden.

## 08 | GitHub Autopilot

Git-Funktionen: Repo initialisieren, Status, Diff (staged/unstaged), einzelne Dateien stagen, Unstage, Commit, History, Branch anlegen/wechseln, Push, Pull, Remote-Infos. Mit gh: Login-Status anzeigen, PR anlegen, PR-Status abrufen, optional Review. Keine GitHub-Tokens im Klartext speichern; Auth über `gh auth` verwenden.

Policy: Auto-Commit erst nach konfigurierten Tests/Review; keine Secrets, Build-Artefakte oder fremden Dirty-State automatisch stagen; standardmäßig Dateien pro Workflow explizit auswählen. Auto-Push nur auf konfigurierten Feature-Branch; niemals ungefragt main/master, force-push, branch-delete, reset --hard oder Merge. Bei Konflikten stoppen und verständliche Optionen anbieten. Konfigurierbare Commit-Konventionen; sinnvolle Commit-Vorschläge, keine falschen Erfolgsbehauptungen. PR-Erzeugung mit verifizierten Änderungen und Tests.

Für parallele Agenten: Git Worktrees und getrennte Branches verwenden, Konfliktstrategien definieren. Git Timeline ordnet Commits und Diffs konkreten Claude-Sessions zu, ohne Git-Historie zu fälschen.

## 09 | Intelligente Workflows

Smart Project Resume: beim Öffnen zuletzt verwendete Sessions, relevanten Git-Status, offene Tasks und Projektregeln anzeigen. Zusammenfassungen nur aus nachweisbaren Session-/Git-/Dateidaten erzeugen, Herkunft kenntlich machen.

One-Click Feature Workflow: Anforderung -> Plan -> optional Freigabe -> Feature-Branch/Worktree -> Implementierung -> Tests/Lint -> Diff/Review -> Commit -> optional Push -> PR. Jeder Schritt idempotent wo möglich, kann pausiert/abgebrochen werden, mit nachvollziehbaren Logs und Checkpoints. Failures dürfen nicht als Erfolg angezeigt werden.

Session Time Machine: Timeline mit Nachrichten, Tool-Events, File Diffs und Git-Checkpoints; Revert kontrolliert über Git, nie unbemerkt fremde Änderungen überschreiben.

Später: Multi-Agent-Jobs mit getrennten Worktrees, Agentenrollen, Git-Audit, Rules/Skills/MCP-Editor, Hooks, Task Templates, geplante lokale Automatisierungen. Die App darf erst bei erfüllten Grundfunktionen zu Phase 2 wechseln.

## 10 | MVP-Scope und Entwicklungsphasen

PHASE 0 – Discovery (unbedingt zuerst): lokale OS-/Runtime-Voraussetzungen erkennen; Auth-Anbindung mit Max prüfen; kurze Capability-Matrix; minimalen Event-Streaming-Spike; Architekturentscheidungen als ADR festhalten.

PHASE 1 – wirklich funktionierender MVP: Tauri App lauffähig; Projekte erstellen/importieren; Claude-Code-Sitzung starten; Streaming; Prompt senden; Stop/Resume; Session-Verwaltung; Git-Status + Diff; Commit; Persistenz; Fehler- und Empty-States. Fertig nur wenn reale E2E-Demonstration möglich.

PHASE 2 – Workflow: Rechteprofile mit bestätigungspflichtigen Tool-Aktionen; Projekt-Tags; automatisierte Checks; gh-PR-Flow; Git-Autopilot mit Guardrails; CLAUDE.md-Editor; Git Timeline.

PHASE 3 – Pro: Git Worktrees, Agentenorchestrierung, MCP/Skills/Hooks-Verwaltung, Resume-Zusammenfassungen, Usage-Diagnostics, Setup Wizard, Installer/Paketierung.

KEINE UI-ONLY DEMO: wenn die Zeit begrenzt ist, schneide nachweisbar funktionierende Features vertikal zu statt überall Platzhalter zu hinterlassen.

## 11 | Tests, Sicherheit und Qualität

Automatisierte Tests: Unit für ProjectManager/Policy/Git-Parser; Integration für Claude-Event-Adapter mit Fixtures; E2E für Projektimport, Sessionstart, streaming output, Cancel, Git-Diff und Commit, App-Restart/Resume. Mindestens Windows und Linux smoke-testen sofern die jeweilige Umgebung verfügbar ist; fehlende Plattform offen deklarieren.

Edge-Cases: Claude nicht installiert; Max nicht eingeloggt; Login ungültig; ANTHROPIC_API_KEY überschreibt Abo; git/gh fehlt; Repo dirty; Git Konflikt; kein Netzwerk; malformed stream-json; Pfade mit Leerzeichen/Umlauten; Abbruch mitten im Tool-Call; zwei Sessions im selben Repo; Projektordner gelöscht; abgebrochene Sidecar-Prozesse.

Security: keine Telemetrie standardmäßig, lokale Datenhaltung, redact secrets, IPC-Schema validieren, minimale Tauri-Berechtigungen, CSP, sichere Pfadauflösung, klar kontrolliertes Prozess-Spawning, Logs begrenzen und rotieren, opt-in Debug Logs. Drittanbieter-Abhängigkeiten auf Lizenz und Wartung prüfen.

Performance: flotte Projektnavigation, virtualisierte Events und Diff-Listen, Hintergrund-Tasks UI-nicht-blockierend, graceful cleanup.

## 12 | Liefergegenstände und Abnahmekriterien

Liefergegenstände: vollständig versioniertes Repository; install-/build-/run-Skripte; README (deutsch) mit Voraussetzungen, Claude-Max-Login und Screenshots; Architekturübersicht; Security-/Permission-Konzept; Beispieldaten/Test-Fixtures; Tests und Ergebnisse; gebaute Desktop-App soweit OS/CI möglich; bekannter Funktionsumfang & Lücken; kurze Roadmap.

DEFINITION OF DONE für MVP:
[ ] App startet als Fenster mit echter Navigation.
[ ] Lokalen Projektordner importieren, schließen und nach Neustart wiederfinden.
[ ] Neuer Projektordner lässt sich erstellen.
[ ] Claude Max über unterstützten offiziellen Weg nutzbar, ohne obligatorischen neuen API-Key.
[ ] Reale Claude-Session im Projekt starten und Prompt senden.
[ ] Live-Ergebnisse + Tool-Events erscheinen im Workspace.
[ ] Stop, Fehlerbehandlung und Wiederaufnahme funktionieren oder sind explizit capability-gated.
[ ] Git-Status und echter Diff erscheinen korrekt.
[ ] Reviewten Commit sicher erstellen.
[ ] Permission-Profil wird wirksam – kein kosmetisches Tag.
[ ] Tests laufen und werden im README aufgeführt.
[ ] Weder hardcodierte Demo-Projekte noch Dummy-Buttons in kritischen Pfaden.

## 13 | Exakte Anweisung an Claude Code

Beginne mit einer kurzen technischen Bestandsaufnahme, dann implementiere sofort Phase 0 und Phase 1. Erstelle zuerst eine Taskliste im Repository. Frage mich nur bei echten Produktentscheidungen, fehlendem Zugriff oder irreversiblen/datengefährdenden Schritten. Sonst triff vernünftige Annahmen und halte sie in ADRs fest. Nutze bestehende installierte Tools, soweit sicher. Lies die beigefügte UI-Referenz als visuelle Richtung, kopiere keine unzulässigen Marken. Gestalte zuerst das Shell-Layout und implementiere dann Ende-zu-Ende einen vollständig funktionierenden Claude-Chat. Setze danach Projekte, Sessions, Git und Einstellungen um. Nach jedem Meilenstein starte Tests/Lint/Build, behebe Fehler und aktualisiere README sowie offene Punkte.

Wenn du am Ende einer Session stoppen musst, hinterlasse ein klares HANDOFF.md mit: aktuellem Stand, Testresultaten, ausführbaren Befehlen, bekannten Fehlern und genau drei nächsten Aufgaben. Behaupte niemals, etwas gebaut oder getestet zu haben, das du nicht tatsächlich ausgeführt hast. Starte JETZT mit der Inventarisierung des aktuellen Verzeichnisses und der Laufzeitvoraussetzungen.

## 14 | Quellen und Prüfpunkte

Anthropic – Use Claude Agent SDK with your Claude plan (Stand 07.10.2026): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
Anthropic – Use Claude Code with your Pro or Max plan: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
Anthropic – Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-usage
Anthropic – Claude Code Getting Started: https://docs.anthropic.com/en/docs/claude-code/getting-started
GitHub CLI manual: https://cli.github.com/manual/
Tauri: https://tauri.app/

Diese Links sind Prüfpunkte, kein Ersatz für eine aktuelle Laufzeit-/Versionsprüfung. Die API- und Abonnement-Bedingungen können sich verändern.
