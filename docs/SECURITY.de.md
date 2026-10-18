<a href="SECURITY.md"><img src="../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# FORGE – Security- und Permission-Konzept

Sicherheitslücken bitte vertraulich melden, wie in [SECURITY.md](../SECURITY.de.md) beschrieben.

## Grundsätze

1. **Keine lokale Schnittstelle für die UI.** UI und Sidecar sprechen über stdin/stdout. Es gibt keinen localhost-Port. Einzige Ausnahme im Netz ist das Telefon (Phase 5): SIP und RTP über UDP auf der Schnittstelle zur Anlage, nur Pakete von der Anlage, und beim eingebundenen Tischtelefon ein HTTP-Port, der nur dem Telefon antwortet (siehe Abschnitt Telefon).
2. **Webview mit minimalen Rechten.** Tauri-Capabilities: `core:default`, `dialog:allow-open`, `opener:allow-open-url` für `https://` sowie `http://localhost:*` und `http://127.0.0.1:*` (Dev-Server). Kein Shell-, FS- oder HTTP-Plugin. CSP ohne externe Quellen (nur GitHub-Avatare als Bilder). `freezePrototype` ist aus, weil Editor- und Terminal-Bibliotheken beim Laden Prototyp-Methoden setzen; es werden keine fremden Inhalte geladen.
3. **Kein Shell-Interpolieren.** Alle Prozesse (`git`, `gh`, `claude`) starten mit `spawn(cmd, args[], {shell:false})` und explizitem `cwd`.
4. **Validierung an der Grenze.** Jede RPC-Anfrage wird im Sidecar mit Zod geprüft. Pfade werden kanonisiert, auch über Symlinks und Junctions hinweg (`projects.readFile`, `projects.listFiles`); Datei- und Git-Operationen außerhalb des Projektordners werden abgelehnt. Git bekommt Pfade als literale Pathspecs (`GIT_LITERAL_PATHSPECS=1`), Zeichen wie `[` oder `*` im Dateinamen wählen also keine weiteren Dateien aus. `FORGE_NODE` und `FORGE_SIDECAR` wirken nur in Debug-Builds; `term_open` akzeptiert nur ein vorhandenes Verzeichnis und eine Datei namens `claude`, `claude.exe` oder `claude.cmd`.
5. **Keine Credentials in FORGE.** Claude-Anmeldung macht die CLI, GitHub-Anmeldung `gh auth`. FORGE liest `~/.claude/.credentials.json` nicht und speichert keine Tokens. Einzige Ausnahme: Lehnt GitHub die anonyme Update-Abfrage ab (Ratenlimit), holt FORGE für diesen einen Abruf das Token der gh-Anmeldung über `gh auth token` (siehe ADR 0013). `ANTHROPIC_API_KEY` wird erkannt, nie angezeigt, und standardmäßig aus Session-Umgebungen entfernt.
6. **Was FORGE selbst ins Netz schickt.** Projektdaten bleiben lokal. Eigene Anfragen von FORGE:
   - **Nutzungsstatistik (standardmäßig aus, Einstellungen > Über FORGE > Datenschutz):** Nach dem Einrichtungsassistenten und der Sync-Frage fragt FORGE einmal, ob sie eingeschaltet werden soll. Ohne Antwort bleibt sie aus; wer den Dialog schließt, wird beim nächsten Start erneut gefragt. Eingeschaltet schickt FORGE alle 5 Minuten anonyme Summen an `https://forge.vanturis.de` (zufällige Installations-ID, Version, Betriebssystem, Art des Claude-Abos, Zählerstände). Keine Inhalte, Namen oder Pfade. Abschalten löscht den Datensatz beim Dienst. Details in `packages/sidecar/src/stats/usage-stats.ts`.
   - **Updates:** Release-Liste und Dateien von der GitHub-API, jede Datei mit Ed25519-Signatur geprüft (ADR 0013).
   - **Claude-Code-Version:** beim Start und danach alle sechs Stunden die Versionsnummer von `https://downloads.claude.ai/claude-code-releases/<latest|stable>` (derselbe Endpunkt wie der offizielle Installer, Kanal aus `autoUpdatesChannel`), ohne mitgeschickte Daten. Das Update selbst führt `claude update` aus.

## Permission-Profile

Siehe [ADR 0004](adr/0004-permission-profile.de.md). Kurz:

| Profil | Claude-Modus | Rückfragen |
|---|---|---|
| Safe | `default` | jede Anfrage, kein „für Session erlauben", keine Web-Tools |
| Balanced | `acceptEdits` | Edits im Projekt automatisch, Befehle mit Freigabe |
| Autonomous | `bypassPermissions` | keine; Standard für neue Projekte, per Tag `sandbox-only` pro Projekt abschaltbar |

Wirksamkeit ist getestet: `session-service.test.ts` prüft die übergebenen Modi, `real-claude.e2e.test.ts`
prüft mit echter CLI, dass Safe eine Freigabe anfordert und eine Ablehnung die Ausführung verhindert.

## Harte Sperrliste (alle Profile)

Umgesetzt als `PreToolUse`-Hook (`policy/guard.ts`). Sie wirkt auch bei `bypassPermissions`, weil Hooks vor
der Rechteprüfung laufen. Blockiert werden u. a.:

- `git push --force` / `-f` / `--force-with-lease` / `+refspec`, Push auf `main`/`master` (auch als `refs/heads/main`, `HEAD:main` oder in Anführungszeichen) und Push vom geschützten Branch (beides standardmäßig aus, siehe unten), `git push --mirror`/`--prune`, Löschen entfernter Branches (`--delete`, `-d`, `:branch`)
- `git reset --hard`, `git branch -d/-D/--delete`, `git clean -f…`
- rekursives Löschen von `/`, `~`, `$HOME`/`${HOME}`, Laufwerkswurzeln (auch `/c/`, `/mnt/c`), mit `--`, Langoptionen oder angehängtem `/*` bzw. `\*`; `Remove-Item`/`rd /s` auf Laufwerkswurzeln und `$env:USERPROFILE`; Formatieren von Datenträgern
- Datei-Tools und Befehle auf `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gh`, `~/.git-credentials`, `~/.npmrc`, `~/.netrc`, `~/.pgpass`, `~/.docker/config.json`, `~/.claude/.credentials.json`, Browserprofilen, Windows-Credential-Store. `~` wird dabei immer gegen das echte Benutzerverzeichnis aufgelöst.
- Grep und Glob, wenn ihr Muster oder ihr Suchordner einen dieser Ordner erreichen kann
- im Autonomous-Profil: Schreibzugriffe der Datei-Tools (Write, Edit, MultiEdit, NotebookEdit) außerhalb des Projekts
- ein Permission-Modus über dem Profil: Meldet Claude Code einen höheren Modus (etwa nach einem Wechsel über Remote Control), setzt FORGE ihn zurück (Regel `permission-mode`); klappt das nicht, wird die Session beendet

Unter Einstellungen → Sperrliste lässt sich jede Regel einzeln ausschalten (Setting `disabledPolicyRules`, gilt global
für alle Projekte und Profile ab dem nächsten Tool-Aufruf). Standard: alle Regeln an außer `git-push-protected`
(Push auf `main`/`master` ist erlaubt; Force-Push, `--mirror`/`--prune` und Löschen entfernter Branches bleiben
gesperrt) und `git-branch-delete` (lokale Branches fertiger Agenten löschen). Bestehende Installationen bekommen
diese Regeln beim Update einmalig ausgeschaltet (DB-Migration); wer sie danach wieder einschaltet, behält das. Nicht abschaltbar sind die
Profil-Regeln (`profile-tool`, `permission-mode`) und `guard-error`.

Jede Blockade wird als `policy.blocked`-Event angezeigt und in `approvals` auditiert. Schlägt die Prüfung selbst
oder das Protokollieren fehl, wird der Aufruf abgelehnt (Regel `guard-error`).

**Grenzen:** Die Sperrliste arbeitet mit Mustern auf Befehlstexten. Sie ist eine Leitplanke, keine Sandbox.
Ein verschleierter Befehl (z. B. per Skript-Datei) kann sie umgehen. Schreibzugriffe von Bash und PowerShell
außerhalb des Projekts werden nicht eingeschränkt; die Schreibsperre im Autonomous-Profil gilt nur für die Datei-Tools. Autonomous ist trotzdem der Standard
(Entscheidung in ADR 0004). Für Projekte mit erhöhtem Risiko gibt es das Tag `sandbox-only`.

## Commits

`git.commit` committet ausschließlich die im UI ausgewählten Dateien (`git commit --only -- <pfade>`).
Vorher wird geprüft: keine Konflikte, Dateien haben tatsächlich Änderungen, keine sensiblen Dateien
(`.env`, Schlüssel, Zertifikate, Credentials) und keine Build-Artefakte. Geprüft werden nur Dateinamen und
Pfade, nicht der Inhalt: Die Inhaltsprüfung brauchte einen git-Aufruf pro Datei und machte Commits zu langsam.
Bei Treffern fragt FORGE nach, ob trotzdem committet werden soll, und zeigt die betroffenen Dateien mit Grund.
Committet wird nur nach ausdrücklicher Bestätigung.
Von sich aus pusht FORGE nur in Projekten mit dem Tag `auto-push`. Pushes von Claude auf geschützte Branches
(`main`, `master`) kann die Sperrliste blockieren (Regel `git-push-protected`, standardmäßig aus).

**Branches löschen** (`git.deleteBranch`) ist eine Aktion im Git-Bereich, nicht für Claude: Die Sperrliste blockiert
`git branch -d/-D` weiterhin für Claudes Shell. Gelöscht wird nur lokal. Der aktuelle Branch, `main`, `master` und der
Standard-Branch von `origin` sind gesperrt, ebenso Branches, die in einem Worktree ausgecheckt sind. Branches mit Commits,
die in keinem anderen Branch stehen, löscht FORGE erst nach einer zweiten Bestätigung. Beim Entfernen eines Agenten kann
sein Branch auf ausdrücklichen Wunsch ohne Merge mitgelöscht werden.

**Wiederherstellen** (`git.restoreTo`) holt die Dateien des Projektordners auf den Stand eines Commits zurück
(`git restore --source=<commit> --staged --worktree -- .`). Branch und Verlauf bleiben unverändert, das Ergebnis
sind neue, nicht committete Änderungen. Offene Änderungen inklusive neuer Dateien sichert FORGE vorher als Git-Stash.
Die Commit-Kennung muss hexadezimal sein; während eine Session im Projekt arbeitet, ist Wiederherstellen gesperrt.

## Redaction

Tool-Eingaben und -Ausgaben werden vor dem Speichern durch `policy/redact.ts` geschickt (API-Keys inkl.
`sk-proj-`/`sk-svcacct-`, GitHub-/GitLab-/Slack-Tokens, AWS-Keys, Bearer-Header, `password=`-Muster auch als
JSON-Schlüssel, Zuweisungen an `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD`, Passwörter in URLs, Private Keys).
Textfelder in Tool-Eingaben werden vor dem Speichern auf 20.000 Zeichen gekürzt; die Freigabe gilt trotzdem
für die vollständige Eingabe. Die Diagnose zeigt keine
E-Mail-Adresse oder Org-Daten der Claude-Anmeldung.

## Bekannte Restrisiken

- Repository-eigene `.claude/settings.json` kann Claude-Berechtigungen (`permissions.allow`) erweitern; das ist
  natives Claude-Code-Verhalten. FORGE setzt den Permission-Modus immer explizit, ein `defaultMode` aus dem
  Repo kann also keinen Bypass auslösen. Erlaubnisregeln aus dem Repo prüft FORGE in Phase 1 nicht.
- Der Sidecar läuft mit den Rechten des Nutzers, ebenso die Claude-CLI.

## Ergänzungen (Einrichtung, GitHub, KI-Commit, Usage)

- **Mitgelieferte Werkzeuge** (Node, Git, gh, Python) stammen aus den offiziellen Releases und werden beim Build
  per SHA-256 geprüft, Python per SHA-512 aus dem Katalog von nuget.org (`scripts/prepare-runtime.mjs`). Siehe [ADR 0006](adr/0006-mitgelieferte-laufzeit.de.md).
- **Claude-Code-Installation** aus der App führt den offiziellen Installer von claude.ai aus. Das passiert
  nur auf ausdrücklichen Klick und nur, wenn keine CLI gefunden wird.
- **Claude-Anmeldung:** FORGE startet `claude auth login`, öffnet die Anmeldeseite und reicht den vom
  Nutzer eingefügten Code an die CLI weiter. FORGE speichert den Code nicht.
- **GitHub-Anmeldung:** Device Flow über `gh auth login --web`. gh speichert das Token im
  Windows-Anmeldeinformationsspeicher; FORGE liest es nie (`gh auth status` ohne `--show-token`).
  gh kopiert den Einmal-Code zusätzlich in die Zwischenablage.
- **KI-Commit-Nachricht:** Der Diff der ausgewählten Dateien geht an Claude (gleiche Anmeldung wie
  Sessions, keine Tools, keine Session-Speicherung). Sensible Dateien (`.env`, Schlüssel, Credentials)
  werden ausgelassen, der restliche Diff durchläuft den Secret-Redactor.
- **Usage-Anzeige** nutzt eine als experimentell markierte SDK-Methode. FORGE prüft vor dem Aufruf, ob es
  sie gibt. Fällt sie weg, zeigt die Anzeige „nicht verfügbar“; Sessions sind nicht betroffen. Dasselbe gilt
  für Remote Control. Einmal-Aufrufe der CLI (Prüfung, Befehlsliste, Commit-Nachricht, Usage) brechen nach
  45 Sekunden ab.

## Ergänzungen Phase 2/3

- **Schreibzugriffe auf Claude-Konfiguration** (CLAUDE.md, Skills, Subagenten, Hooks) nur nach Klick auf
  Speichern, atomar (temporäre Datei, dann Umbenennen), mit `.bak` und Konfliktprüfung; Pfade berechnet der
  Sidecar, die UI übergibt keine Pfade. Gelöschte Skills wandern als Ordner nach `<Datenordner>/trash/skills/`,
  gelöschte Subagenten werden zu `<name>.md.bak`.
- **Marketplace-Plugins** installiert und entfernt FORGE nur über `claude plugin install|uninstall --scope user`
  mit geprüfter ID (`name@marketplace`), ohne `-y`: Plugins, die Claude Code vor dem Installieren bestätigen
  lassen will, schlagen mit dessen Meldung fehl. Der Browser weist darauf hin, dass Hooks und MCP-Server eines
  Plugins Befehle ausführen.
- **Max-Stufe (5x/20x)** liest FORGE aus `oauthAccount` in `.claude.json`, nur die Felder `userRateLimitTier`
  und `organizationRateLimitTier`. `.credentials.json` bleibt tabu.
- **Hooks** führen Befehle aus. FORGE prüft nur die Struktur, nicht den Inhalt; ein Hook aus einem
  fremden Repository in `.claude/settings.json` wird von Claude Code selbst ausgeführt (natives Verhalten).
- **Remote Control** gilt global: Eingeschaltet ist jede laufende FORGE-Session (alle Projekte, wie die
  Session-Tabs) ein eigener Eintrag in claude.ai und der Claude-App (dein Konto). Sessions, die danach starten
  oder fortgesetzt werden, kommen automatisch dazu; FORGE startet dafür keine eigene Session. Nachrichten von
  dort laufen durch dieselbe Session: Profil, Freigaben und Sperrliste gelten. Eine beendete Session fällt
  heraus. Ausschalten trennt alle Verbindungen, die Sessions laufen lokal weiter.
- **Automatisches Weitermachen nach dem Nutzungslimit** sendet Nachrichten ohne dich, aber eng begrenzt:
  nur nachdem ein Nutzungslimit einen Durchlauf dieser Session gestoppt hat, nur an diese eine Session und
  immer mit demselben festen Text. Die Session läuft mit ihrem normalen Profil, ihren Freigaben und der
  Sperrliste; es gibt keine Ausnahme und keinen höheren Permission-Modus. Offene Freigaben bleiben offen,
  bis du antwortest. Höchstens drei automatische Fortsetzungen ohne deine Eingabe, dann ist Schluss.
  Eine eigene Nachricht, Stopp, Löschen oder „Nicht automatisch weitermachen“ heben den Plan auf;
  in den Einstellungen lässt sich die Funktion ganz abschalten (Standard: an).
- **Terminal**: nur Shell oder Claude-CLI startbar, kein Netzwerkzugang zum PTY.
- **Testbefehle** laufen mit deinen Rechten im Projektordner.
- **Projekt löschen** mit Ordner oder GitHub-Repository verlangt das Eintippen des Projektnamens. Gesperrt sind
  Laufwerke, das Benutzerverzeichnis, Punkt-Ordner und Standardordner direkt darunter (auch OneDrive), die
  Claude-Konfiguration, Credential-Ordner, AppData, Programme, ProgramData, das Windows-Verzeichnis,
  FORGE-Daten und Ordner mit weiteren Projekten. Gesperrt heißt: der Ordner,
  alles darin und seine übergeordneten Ordner. Sessions, Terminals und Dev-Server des Projekts und seiner Worktrees werden vorher beendet.
  Die GitHub-Berechtigung `delete_repo` fragt FORGE erst an, wenn sie gebraucht wird.
- **Auto-Commit/Auto-Push** commiten nur Dateien aus dem aktuellen Durchlauf, nie sensible Dateien, pushen nie
  auf main/master und nie mit Force. Neue Nachrichten aus FORGE warten, bis Tests und Auto-Commit des letzten
  Durchlaufs fertig sind. Hat sich eine Datei seit dem Ende des Durchlaufs geändert oder hat inzwischen ein
  neuer Durchlauf begonnen (etwa aus der Claude-App), entfällt der Auto-Commit. Der Inhalt der Dateien wird
  nicht auf Schlüssel oder Passwörter geprüft.

## Telefon (Phase 5, ADR 0010)

- **Wer anrufen darf:** nur Nummern aus der Liste „Erlaubte Anrufer“. Leere Liste heißt: niemand. Kurze Nummern
  (Durchwahlen) müssen exakt passen. Lange Nummern werden vor dem Vergleich vereinheitlicht (+49…, 0049…, 0… mit
  Ländervorwahl 49) und müssen danach exakt gleich sein. Andere Anrufe weist FORGE mit 403 ab und protokolliert sie.
  FORGE nimmt SIP nur von der Adresse der Anlage an; Pakete anderer Absender werden verworfen und protokolliert.
  Anfragen innerhalb eines Gesprächs müssen das Tag von FORGE tragen.
- **PIN fürs Steuern:** Alles außer Status, Nutzung und Auflegen braucht standardmäßig die PIN. Sie wird
  über die Telefontastatur (DTMF, RFC 4733 oder SIP INFO) eingegeben und mit # bestätigt. Sie läuft nie durch das
  Sprachmodell und wird nicht vorgelesen. Gespeichert ist nur ein scrypt-Hash. Nach drei falschen Versuchen legt
  FORGE auf; danach werden keine Ziffern mehr geprüft. Fünf Fehlversuche einer Nummer oder zehn insgesamt innerhalb
  einer Stunde sperren die PIN-Eingabe für eine Stunde, auch über Neustarts hinweg. Jeder Fehlversuch wird später
  beantwortet (1 s, verdoppelt, höchstens 16 s). Eine neue PIN in FORGE hebt die Sperre auf. Ohne PIN nennt
  `status` nur Anzahlen, `details` ist gesperrt. Grund: Anrufernummern lassen sich fälschen.
- **Keine Bestätigung per Taste (seit 2026-10-11):** Nach der PIN führt FORGE steuernde Aktionen sofort aus, wenn
  der Anrufer sie verlangt. Die frühere Bestätigung mit Taste 1 war im Gespräch zu umständlich und wurde auf Wunsch
  des Nutzers entfernt. Text aus Sessions erhält Claude weiter als markierte Daten, nicht als Anweisung, und der
  System-Prompt verbietet, ihretwegen Werkzeuge zu benutzen. Restrisiko: Bringt Session-Text Claude trotzdem dazu,
  ein Werkzeug aufzurufen, gibt es keine zweite Hürde mehr. Die Werkzeuge haben deshalb eigene Grenzen: Commits
  lassen sensible Dateien und Build-Artefakte immer aus, Push nie mit Force, Pull nur fast-forward.
- **Was Claude am Telefon kann:** nur die FORGE-Werkzeuge: Status, Details, Senden, Starten, Antworten auf
  Freigaben, Stoppen, Schließen, Modell/Denkaufwand/Modus einer Session, automatisches Weitermachen abbrechen,
  Remote Control, Dev-Server, Git (Status, Commit, Push, Pull), Projekte, Nutzung, Auflegen. Keine Datei-, Shell-
  oder Web-Werkzeuge (`tools: []`, eigene Werkzeuge per MCP im Prozess). Gestartete oder fortgesetzte Sessions
  laufen wie immer mit Profil, Freigaben und Sperrliste des Projekts. Push auf `main`/`master` geht am Telefon nur,
  wenn der Anrufer es ausdrücklich verlangt (Parameter `allow_protected`); am Rechner braucht es das Eintippen des
  Branch-Namens.
- **Geheimnisse:** SIP-Passwort, OpenAI- und Gemini-Key und das Web-Passwort des Tischtelefons liegen unter `<Datenordner>/secrets`, mit DPAPI für das
  Windows-Benutzerkonto verschlüsselt (PowerShell, Übergabe per stdin). Die UI sieht nur, ob sie gesetzt sind.
- **Datenfluss:** Mit Gemini Live (Standard) geht das Gesprächsaudio an Google; Gemini bekommt dazu die Ergebnisse
  der FORGE-Werkzeuge (Session-Titel, Kurzfassungen, offene Freigaben), markiert als Daten. Mit Claude als
  Gesprächspartner führt Claude (Haiku) das Gespräch über das Abo; Audio geht zur Erkennung und die Antworttexte zur
  Sprachausgabe an OpenAI oder Google, je nach Einstellung. Transkripte stehen lokal im Anrufprotokoll.
- **Gemini als Gesprächspartner (ADR 0011):** dieselben Werkzeuge und Grenzen wie für Claude. Aufrufe kommen als
  JSON und werden vor der Ausführung geprüft; unbekannte Werkzeuge und ungültige Angaben gehen als Fehlertext zurück.
  Die PIN läuft auch hier nur über die Tastatur. Session-Text bekommt Gemini als markierte Daten mit demselben Verbot
  im System-Prompt; das Restrisiko „keine zweite Hürde nach der PIN“ gilt genauso.
- **Tischtelefon (ADR 0011):** FORGE öffnet einen HTTP-Port (Standard 8766) nur auf der Schnittstelle zum Telefon.
  Er antwortet nur der eingetragenen IP des Telefons, und jede URL enthält ein zufälliges Token (96 Bit), das nur in
  der Provisioning-Datei steht. Über diesen Weg gehen Tastendrücke (Session wählen, FORGE anrufen) und Antworten auf
  Freigabe-Menüs; Freigaben am Tischtelefon brauchen keine PIN, wie Freigaben am Rechner. Wer im LAN die IP des
  Telefons übernimmt und das Token kennt, kann Freigaben erteilen. Die Provisioning-Datei enthält keine Passwörter.
  Für LEDs und Display meldet sich FORGE mit dem Web-Login am Telefon an (Basic oder Digest, unverschlüsselt im LAN).
- **Restrisiken:** SIP über UDP und RTP sind unverschlüsselt (kein TLS, kein SRTP). Im eigenen Netz oder über ein
  VPN zur Anlage betreiben. Die Windows-Firewall fragt beim ersten Anruf nach Zugriff für Node.js. Wer im Netz die
  Absenderadresse der Anlage fälschen kann, kommt an der Adressprüfung vorbei; dagegen hilft nur TLS. Audio nimmt
  FORGE nur von der SDP-Adresse oder der Anlage an.
