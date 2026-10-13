# FORGE: Claude Development Studio

Desktop-Oberfläche für Claude Code. FORGE startet und steuert echte Claude-Code-Sessions in deinen
Projekten, zeigt Antworten live, fragt Freigaben ab und bringt Git-Status, Diffs und geprüfte Commits in
dieselbe Ansicht. Die Anmeldung läuft über dein Claude-Abo (z. B. Max). Ein API-Key ist nicht nötig.

> Stand 2026-10-12: Phasen 0 bis 5 umgesetzt (Sessions, Git, GitHub, Agenten, Telefon), dazu Updates über
> GitHub, Backups und das neue Branding. Details zu Umfang und Lücken unten und in [HANDOFF.md](HANDOFF.md).

## Installation

**Für Nutzer:** `FORGE_0.1.0_x64-setup.exe` ausführen. Mehr braucht es nicht: Node.js, Git (inkl. Bash)
und die GitHub CLI sind enthalten. Fehlt Claude Code, installiert FORGE es beim ersten Start selbst über den
offiziellen Installer von Anthropic. Anmeldung bei Claude und GitHub erfolgt in der App (Einstellungen → Claude Code
bzw. Einstellungen → Allgemein → GitHub).

FORGE läuft nur unter Windows (getestet mit Windows 11).

**Für die Entwicklung:**

| Werkzeug | Version (getestet) |
|---|---|
| Node.js | ≥ 22.13 (getestet 24.14) |
| pnpm | 10.x |
| Rust + Cargo | stable (getestet 1.99, MSVC) |
| Visual Studio Build Tools | 2022, Workload „C++ Build Tools" |

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
```

## Claude-Anmeldung

FORGE nutzt die **installierte Claude-Code-CLI** über den offiziellen Agent SDK
(`@anthropic-ai/claude-agent-sdk`, Option `pathToClaudeCodeExecutable`). Anmelden kannst du dich direkt in FORGE
(Einstellungen → Claude Code). Die Anmeldung speichert Claude Code selbst, sie gilt also auch im Terminal und umgekehrt:

```bash
claude auth status   # sollte "loggedIn": true und "subscriptionType": "max" zeigen
claude auth login    # falls nicht angemeldet, oder in FORGE: Einstellungen → Claude Code
```

- FORGE liest keine Tokens und speichert keine Zugangsdaten.
- Ist `ANTHROPIC_API_KEY` gesetzt, würde Claude Code den Key statt des Abos nutzen. FORGE erkennt das,
  warnt und entfernt den Key standardmäßig aus der Session-Umgebung (abschaltbar unter Einstellungen → Claude Code).
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
pnpm build        # Release inkl. Installer (lädt und prüft beim ersten Mal Node/Git/gh, ca. 140 MB)
pnpm prepare:runtime  # nur die mitgelieferte Laufzeit vorbereiten (für pnpm dev mit Bundle-Werkzeugen)
```

Umgebungsvariablen für Sonderfälle: `FORGE_NODE` (Pfad zu node), `FORGE_SIDECAR` (Pfad zu `sidecar.mjs`),
`FORGE_DATA_DIR` (Datenordner), `FORGE_E2E=0` (E2E überspringen), `FORGE_E2E_MODEL` (Modell für E2E).

## Was funktioniert

- **Projekte:** Ordner importieren (kanonisiert, Dubletten-Erkennung), neu anlegen (Ordner + git, optional GitHub-Repo), Repository klonen (nur https/ssh, sichere Argumente), Favoriten, Tags,
  Technologie-Erkennung, „Ordner fehlt"-Zustand. Entfernen nur aus FORGE oder auf Wunsch mit lokalem Ordner und GitHub-Repository.
- **Claude-Sessions:** starten, Prompt senden, echtes Token-Streaming, Tool-Aufrufe als aufklappbare
  Karten, Aufgabenlisten (TodoWrite), Freigabeanfragen mit Erlauben / Für Session erlauben / Ablehnen,
  Stop (Esc), Modell- und Effort-Wechsel (global, pro Projekt, pro Session), Plan-Modus, Resume auch nach App-Absturz, Übernahme von im Terminal
  gestarteten Sessions inkl. Verlauf.
- **Geöffnet (Seitenleiste):** Baum der geöffneten Projekte, darunter ihre Sessions: alle mit laufendem Claude-Prozess
  und die offene Session. Status als Punkt, wartende Freigaben farbig markiert, Hintergrundaufgaben mit Anzahl. Klick öffnet
  Projekt und Session, das Plus am Projekt startet eine neue Session, `Strg+Tab` wechselt der Reihe nach. Favoriten stehen
  auf der Startseite.
- **Werkzeugleiste:** Standardmäßig füllt der Chat den Arbeitsbereich. Der Knopf „Werkzeuge“ im Projektkopf blendet die Leiste
  mit Chat, Agenten, Git, Dateien, Dev-Tools, Wissen und Einstellungen ein; sie erscheint auch von selbst, sobald ein anderer
  Bereich geöffnet wird (Tastenkürzel, „In Datei anzeigen“). Ausblenden führt zurück zum Chat.
- **Sessiontitel:** Der Titel folgt den neuesten Prompts. Nach einer neuen Aufgabe schreibt Claude einen kurzen Titel
  (höchstens etwa 6 Wörter), sichtbar in den Session-Tabs, unter Sessions, in Claude Code und bei eingeschaltetem
  Remote Control in der Claude-App. Kurze Antworten wie „ok“ oder „weiter“, Slash-Commands und automatische
  Nachrichten ändern ihn nicht. Höchstens einmal pro Minute.
- **Permission-Profile:** Safe / Balanced / Autonomous mit echter Wirkung auf den Claude-Permission-Modus,
  harte Sperrliste in allen Profilen, Audit-Log.
- **Git:** Status, echter Diff (auch für neue Dateien), Stage/Unstage, Commit nur der ausgewählten Dateien
  mit Review-Dialog und Rückfrage bei sensiblen Dateien (`.env`, Schlüsseldateien, Build-Artefakte), Verlauf mit Wiederherstellung (alle Dateien auf den Stand eines früheren Commits zurückholen, als neue Änderungen), Branches anlegen, wechseln und löschen (nicht gemergte nur nach Rückfrage), git init. Beim Entfernen eines Agenten lässt sich sein Branch ohne Merge mitlöschen.
- **Abo-Nutzung:** 5-Stunden- und Wochenfenster (auch pro Modell) unten links, mit Reset-Zeit. Ist ein Limit fast oder ganz erreicht, steht das dauerhaft am Composer („Limit fast erreicht · Reset 19:10“), statt bei jeder Anfrage als Meldung im Chat.
- **Nach dem Nutzungslimit weitermachen:** Stoppt das Limit eine Session, macht FORGE nach dem Reset (plus 2 Minuten) selbst weiter: Session fortsetzen, falls nötig, und Claude bitten, dort weiterzumachen. Die Karte im Chat zeigt die Uhrzeit und lässt sich abbrechen. Der Plan übersteht einen Neustart von FORGE und Standby. Eine eigene Nachricht oder Stopp hebt ihn auf, nach drei automatischen Fortsetzungen ohne deine Eingabe ist Schluss. Abschaltbar unter Einstellungen → Claude Code.
- **GitHub:** Anmeldung unter Einstellungen → Allgemein (Code anzeigen, Browser öffnet sich). Beim Klonen eines neuen Projekts stehen deine Repositories zur Auswahl.
- **Commit-Nachricht per KI:** Funken-Knopf im Commit-Feld; Claude (Haiku) schreibt die Nachricht aus dem Diff im Stil der bisherigen Commits. Sensible Dateien werden nicht gesendet.
- **Regeln für Claude:** CLAUDE.md global, pro Projekt und lokal (nicht im Git) direkt in FORGE bearbeiten.
- **Composer:** Bilder, PDFs und Textdateien anhängen (Knopf, Einfügen, Hineinziehen), Slash-Commands mit Auswahlliste, `/clear` (auch `/reset`, `/new`) startet wie im Terminal ein neues Gespräch mit leerem Chat, Dateien auf den Stand vor einer Nachricht zurücksetzen.
- **In der Claude-App weiterarbeiten:** Remote Control macht jede laufende FORGE-Session als eigenen Eintrag in der Claude-App und auf claude.ai anwählbar, aus allen Projekten. Sessions, die später starten oder fortgesetzt werden, kommen automatisch dazu. Nachrichten erscheinen auf beiden Seiten, Freigaben und Sperrliste gelten weiter.
- **Terminal:** eingebettete Terminals im Projektordner.
- **Git & GitHub:** Push/Pull mit Schutzregeln. Vor dem Push übernimmt FORGE neue Commits vom Remote (Vorspulen oder Rebase, nicht committete Änderungen bleiben); bei Konflikten startet eine Claude-Session, die zusammenführt, bei Unklarheit nachfragt und dann pusht. Dazu Pull Requests mit KI-Beschreibung und Status, neues Projekt direkt als GitHub-Repo.
- **Projekt-Tags mit Verhalten:** plan-first, auto-test, auto-commit, auto-push, review-required, no-network, sandbox-only.
- **Parallele Agenten:** Auf der Projektseite stehen Agenten in der Kachel ihres Projekts (Branch, arbeitet/wartet, letzte Session), nicht als eigene Projekte. Tab „Agenten“ neben „Chat“: Sessions in eigenen Git-Worktrees des offenen Projekts, dazu die eigenen Subagenten. Claude kann in jeder Session selbst Agenten starten, verfolgen und anschreiben (FORGE-Werkzeuge `start_agent`, `agent_status`, `message_agent`; höchstens 4 je Session, Agenten starten keine weiteren) und dich mit `notify` benachrichtigen, dringend auch per Anruf.
- **Subagenten und Hintergrund-Aufgaben:** Laufende Subagenten zeigen unter dem Chat eine Zeile Fortschritt (etwa alle 30 Sekunden) und lassen sich in den Hintergrund schicken (wie Strg+B). Hintergrund-Aufgaben lassen sich einzeln stoppen; Stopp beendet nur den Durchlauf.
- **Verzweigen:** An jeder eigenen Nachricht „Ab hier verzweigen“: neue Session mit dem Verlauf bis davor, die Nachricht steht zum Ändern im Eingabefeld, das Original bleibt. Auf Wunsch werden die Dateien mit zurückgesetzt.
- **Erweiterungen:** MCP-Server und Hooks verwalten. Skills: Browser für die Marketplaces von Claude Code (Plugins suchen, installieren, entfernen über `claude plugin`), dazu eigene Skills anlegen und bearbeiten.
- **Wiedereinstieg:** KI-Zusammenfassung einer Session.
- **PR-Texte** kommen als strukturierte Antwort (JSON-Schema), Opus fällt bei Überlastung automatisch auf Sonnet zurück.
- **Rückfragen und Pläne:** Fragt Claude nach (AskUserQuestion), erscheinen die Optionen als Karte im Chat. Pläne aus dem Plan-Modus lassen sich annehmen oder mit Feedback zurückgeben.
- **Kontextanzeige:** Belegung des Kontextfensters am Composer, Komprimieren per Knopf (/compact).
- **Befehlspalette (Strg+K):** Projekte, Sessions, Aktionen und Volltextsuche über alle Verläufe.
- **Telefon (SIP, optional):** Einrichten und einschalten unter Einstellungen → Telefon. Der Telefon-Knopf oben erscheint erst, wenn eine Anlage eingetragen ist. FORGE meldet sich mit deinen SIP-Zugangsdaten als eigene Nebenstelle an deiner Telefonanlage an. Ruf die Zentrale an und rede frei: Stand abfragen, Sessions anschreiben oder starten, parallele Agenten im eigenen Worktree starten, Freigaben, Remote Control, Git, Dev-Server, Test-Datenbank (starten, stoppen, leeren) und Projektwissen (nachfragen, „merk dir für Projekt X …“ legt eine Notiz ab oder ergänzt den passenden Eintrag). Gesprächspartner ist Gemini 3.8 Live (hört und spricht selbst, man kann jederzeit dazwischenreden) oder wahlweise Claude über dein Abo mit Sprache von Gemini oder OpenAI. Steuern geht nach der PIN über die Tastatur und wird sofort ausgeführt. FORGE ruft dich an, wenn eine Session fertig ist, eine Entscheidung braucht oder ein Fehler auftritt. Auf Zuruf auch zu einer bestimmten Zeit: „Ruf mich in fünf Minuten zurück und sag mir dann, ob die Tests grün sind“ – FORGE prüft dann frisch und meldet sich (der Termin übersteht einen Neustart).
- **Tischtelefon (Yealink, optional):** Pro laufender Session eine Taste mit Namen und farbiger LED (arbeitet, wartet, neu, bereit), Status auf dem Display, Freigaben als Menü. Abheben ruft FORGE an, eine Session-Taste startet ein Gespräch über genau diese Session. Einrichtung per Auto-Provisioning von FORGE. Ersetzt das Skript klaus_telefon.
- **Dev-Tools (Tab neben Chat, Agenten, Git, Dateien):** Dev-Server mit Startbefehl (oder erkannt aus package.json), Adresse als Link, Ausgabe, letzte Zeilen per Knopf an Claude; die Ausgabe gibt es weiter auch im unteren Panel. Der Status steht als Punkt am Tab. Dazu eine **Test-Datenbank** pro Projekt: echtes PostgreSQL 17, nur auf 127.0.0.1, eigener Port und Datenordner unter `%APPDATA%/forge/testdb`. Beim ersten Start lädt FORGE die Binaries einmalig (rund 38 MB, npm-Paket `@embedded-postgres/windows-x64`, SHA-512 im Code festgelegt), Docker ist nicht nötig. Starten, stoppen, zurücksetzen (leert alle Daten), Verbindungs-URL kopieren, Port und Datenbankname einstellen, wahlweise mit dem Dev-Server starten. Die URL geht als `DATABASE_URL` (Name einstellbar) an Dev-Server und Testbefehl, solange die Datenbank läuft. Und eine **Test-Umgebung** im .env-Format (auch aus `.env.example` und Co. übernehmbar) für Dev-Server und Testbefehl. Sie bleibt in FORGEs Datenbank, landet nie im Projektordner und ist nicht im Backup; Claude sieht nur die Variablennamen. Agenten-Worktrees nutzen Test-Datenbank und Test-Umgebung ihres Projekts.
- **Projektwissen (Tab „Wissen“):** Einträge als Markdown unter `.forge/knowledge/` im Projekt, also im Git und in jedem Worktree verfügbar. Jede FORGE-Session bekommt beim Start einen kompakten Index (Titel, ein Satz, Tags; höchstens 60 Einträge) und die Anweisung, passende Einträge vor der Arbeit zu lesen und Neues selbst abzulegen. Dafür gibt es die FORGE-Werkzeuge `knowledge_search`, `knowledge_read`, `knowledge_save` (lehnt Einträge mit fast gleichem Titel ab und verweist auf den bestehenden) und `knowledge_delete` (mit Freigabe). Dazu `dev_environment` (Stand von Dev-Server und Test-Datenbank samt URL und letzter Ausgabe) und `dev_control` (starten, stoppen, neu starten, Datenbank leeren; mit Freigabe). Im Tab lassen sich Einträge suchen, lesen, bearbeiten, anlegen und löschen. Sessions, die nur im Terminal laufen, sehen die Werkzeuge nicht; die Dateien können sie trotzdem lesen.
- **Chats in eigenen Fenstern:** Jede Session lässt sich über den Knopf im Chatkopf oder an der Session in der Seitenleiste in ein eigenes Fenster lösen, etwa zwei Chats nebeneinander. Oder wie ein Tab in Chrome: die Session aus der Seitenleiste ziehen, sie wird sofort zum eigenen Fenster, das an der Maus hängt, bis man loslässt (Esc bricht vorher ab). Im Hauptfenster steht dann ein Hinweis mit „Fenster anzeigen“ und „Zurückholen“. Schließen des Hauptfensters beendet FORGE samt aller Chat-Fenster.
- **Töne:** Signal, wenn Claude fertig ist, eine Freigabe braucht oder ein Fehler auftritt (abschaltbar).
- **Updates:** Jeder Push auf `main` baut über GitHub Actions ein Release (`v0.1.<Nummer>`). Meist ist das ein kleines Update von etwa 4 MB (nur App und Sidecar); den vollen Installer mit node, git und gh gibt es nur, wenn sich diese Laufzeit ändert (ADR 0013). FORGE sucht wenige Sekunden nach dem Start und danach alle 30 Minuten. Ist ein Update da, erscheint ein Fenster mit „Jetzt aktualisieren“ und einem Changelog, den Claude (Haiku) aus Release-Notizen und Commits schreibt. Er umfasst alle Versionen seit der installierten, nicht nur die neueste (höchstens die letzten 20; bei älteren oder lokal gebauten Versionen steht ein Hinweis dabei). Ohne Claude-Login steht dort, dass kein Changelog verfügbar ist. Installiert wird mit einem Klick: laden, Prüfsumme prüfen, Dateien tauschen oder still installieren, neu starten. Läuft über die GitHub-Anmeldung in FORGE, also auch mit privatem Repository (Zugriff nötig). Abschaltbar unter Einstellungen → Über FORGE.
- **Backups:** Einstellungen, Projektliste, Telefon, Claude-Code-Konfiguration (CLAUDE.md, Hooks, Agenten, Befehle, Skills, MCP-Server) und Git-Name mit E-Mail. FORGE sichert bei jedem Start, sobald sich seit dem letzten Backup etwas geändert hat, und behält die letzten 40. Unter Einstellungen → Backup: von Hand sichern, als Datei herunterladen, aus einer Datei oder auf den Stand eines Datums zurücksetzen, wahlweise nur einzelne Teile. Vor jedem Zurücksetzen sichert FORGE den aktuellen Stand. Nicht enthalten: Chatverläufe, Projektdateien, Logins bei Claude und GitHub.
- **Einstellungen:** in Bereiche gegliedert (Allgemein, Claude Code, Telefon, Backup, Globale Regeln, Über FORGE), jede Einstellung mit kurzer Erklärung.
- **Diagnose:** CLI-Version, Anmeldestatus, API-Key-Override, git, gh, Capability-Matrix.
- **Persistenz:** SQLite für Projekte, Sessions, Events, Freigaben, Einstellungen (unter `%APPDATA%\forge`, Backups im Unterordner `backups`). Beim Start öffnet FORGE das zuletzt genutzte Projekt.

Tastatur: `Strg+1..7` Workspace-Tabs, `Strg+Tab` / `Strg+Umschalt+Tab` nächste / vorherige Session, `Strg+N` neue Session, `Strg+O` Projekt hinzufügen, `Strg+J` Claude-Output,
`Strg+Umschalt+E` Seitenleiste, `Esc` im Eingabefeld stoppt Claude.

## Tests

Letzter Lauf am 2026-10-12 (Details in [docs/TESTING.md](docs/TESTING.md)): Lint und Typecheck ohne Befund,
399 Sidecar-Tests und 139 Desktop-Tests bestanden. Die 17 E2E-Tests mit echter Claude-Session liefen zuletzt vor den
Änderungen vom 2026-10-12 grün.

## Dokumentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Prozesse, Module, Statusmaschine
- [docs/SECURITY.md](docs/SECURITY.md): Permission- und Sicherheitskonzept
- [docs/adr/](docs/adr): Architekturentscheidungen (Telefon: 0010, Gemini Live und Tischtelefon: 0011, flüssige Oberfläche und Agent SDK: 0012, Updates über GitHub: 0013)
- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md): mitgelieferte Software
- [docs/TASKS.md](docs/TASKS.md): Taskliste
- [HANDOFF.md](HANDOFF.md): aktueller Stand, bekannte Fehler, nächste Schritte

## Bekannte Lücken

- Telefon: nur SIP über UDP mit G.711, kein TLS/SRTP. Mit einer echten Anlage noch nicht getestet, nur gegen eine Test-Anlage im Testlauf. Gemini Live ist gegen den echten Dienst geprüft, aber noch nicht über eine echte Telefonleitung.
- Tischtelefon: nur gegen Fakes getestet, noch nicht am echten T53W.
- Remote Control funktioniert nur, solange FORGE geöffnet ist. Die genutzte SDK-Funktion ist nicht offiziell dokumentiert.
- Claude Code selbst wird nicht mitgeliefert, sondern beim ersten Start über den offiziellen Installer geladen. Auf einem frischen System noch nicht getestet.

## Roadmap

- Installer signieren (Windows SmartScreen), sobald ein Code-Signing-Zertifikat vorhanden ist.
- Merge-Hilfe für parallele Agenten (Konflikte gemeinsam mit Claude lösen).
