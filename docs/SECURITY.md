# FORGE – Security- und Permission-Konzept

## Grundsätze

1. **Keine Netzwerk-Schnittstelle.** UI und Sidecar sprechen über stdin/stdout. Es gibt keinen localhost-Port.
2. **Webview mit minimalen Rechten.** Tauri-Capabilities: `core:default`, `dialog:allow-open`, `opener:allow-open-url` nur für `https://`. Kein Shell-, FS- oder HTTP-Plugin. CSP ohne externe Quellen (nur GitHub-Avatare als Bilder). `freezePrototype` ist aus, weil Editor- und Terminal-Bibliotheken beim Laden Prototyp-Methoden setzen; es werden keine fremden Inhalte geladen.
3. **Kein Shell-Interpolieren.** Alle Prozesse (`git`, `gh`, `claude`) starten mit `spawn(cmd, args[], {shell:false})` und explizitem `cwd`.
4. **Validierung an der Grenze.** Jede RPC-Anfrage wird im Sidecar mit Zod geprüft. Pfade werden kanonisiert; Datei- und Git-Operationen außerhalb des Projektordners werden abgelehnt.
5. **Keine Credentials in FORGE.** Claude-Anmeldung macht die CLI, GitHub-Anmeldung `gh auth`. FORGE liest weder `~/.claude/.credentials.json` noch Tokens. `ANTHROPIC_API_KEY` wird erkannt, nie angezeigt, und standardmäßig aus Session-Umgebungen entfernt.
6. **Keine Telemetrie.** Alle Daten bleiben lokal. Einzige eigene Netzwerkanfrage: Beim Start und danach alle sechs Stunden liest FORGE die aktuelle Claude-Code-Versionsnummer von `https://downloads.claude.ai/claude-code-releases/<latest|stable>` (derselbe Endpunkt wie der offizielle Installer, Kanal aus `autoUpdatesChannel`). Dabei werden keine Daten mitgeschickt. Das Update selbst führt `claude update` aus.

## Permission-Profile

Siehe [ADR 0004](adr/0004-permission-profile.md). Kurz:

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

- `git push --force` / `-f` / `--force-with-lease` / `+refspec`, Push auf `main`/`master`, Push vom geschützten Branch
- `git reset --hard`, `git branch -d/-D/--delete`, `git clean -f…`
- rekursives Löschen von `/`, `~`, Laufwerkswurzeln; Formatieren von Datenträgern
- Datei-Tools und Befehle auf `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gh`, `~/.git-credentials`, `~/.claude/.credentials.json`, Browserprofilen, Windows-Credential-Store
- im Autonomous-Profil: Schreibzugriffe außerhalb des Projekts

Jede Blockade wird als `policy.blocked`-Event angezeigt und in `approvals` auditiert.

**Grenzen:** Die Sperrliste arbeitet mit Mustern auf Befehlstexten. Sie ist eine Leitplanke, keine Sandbox.
Ein verschleierter Befehl (z. B. per Skript-Datei) kann sie umgehen. Autonomous ist trotzdem der Standard
(Entscheidung in ADR 0004). Für Projekte mit erhöhtem Risiko gibt es das Tag `sandbox-only`.

## Commits

`git.commit` committet ausschließlich die im UI ausgewählten Dateien (`git commit --only -- <pfade>`).
Vorher wird geprüft: keine Konflikte, Dateien haben tatsächlich Änderungen, keine sensiblen Dateien
(`.env`, Schlüssel, Zertifikate, Credentials), keine Build-Artefakte, keine bekannten Token-Muster im
neuen Inhalt. Treffer stoppen den Commit; Überschreiben nur mit expliziter Bestätigung (`COMMIT` eintippen).
FORGE pusht in Phase 1 nie.

## Redaction

Tool-Eingaben und -Ausgaben werden vor dem Speichern durch `policy/redact.ts` geschickt (API-Keys, GitHub-/
GitLab-/Slack-Tokens, AWS-Keys, Bearer-Header, `password=`-Muster, Private Keys). Die Diagnose zeigt keine
E-Mail-Adresse oder Org-Daten der Claude-Anmeldung.

## Bekannte Restrisiken

- Repository-eigene `.claude/settings.json` kann Claude-Berechtigungen (`permissions.allow`) erweitern; das ist
  natives Claude-Code-Verhalten. FORGE setzt den Permission-Modus immer explizit, ein `defaultMode` aus dem
  Repo kann also keinen Bypass auslösen. Erlaubnisregeln aus dem Repo prüft FORGE in Phase 1 nicht.
- Der Sidecar läuft mit den Rechten des Nutzers, ebenso die Claude-CLI.

## Ergänzungen (Einrichtung, GitHub, KI-Commit, Usage)

- **Mitgelieferte Werkzeuge** (Node, Git, gh) stammen aus den offiziellen Releases und werden beim Build
  per SHA-256 geprüft (`scripts/prepare-runtime.mjs`). Siehe [ADR 0006](adr/0006-mitgelieferte-laufzeit.md).
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
- **Usage-Anzeige** nutzt eine als experimentell markierte SDK-Methode. Fällt sie weg, verschwindet nur
  die Anzeige; Sessions sind nicht betroffen.

## Ergänzungen Phase 2/3

- **Schreibzugriffe auf Claude-Konfiguration** (CLAUDE.md, Skills, Subagenten, Hooks) nur nach Klick auf
  Speichern, mit `.bak` und Konfliktprüfung; Pfade berechnet der Sidecar, die UI übergibt keine Pfade.
- **Hooks** führen Befehle aus. FORGE prüft nur die Struktur, nicht den Inhalt; ein Hook aus einem
  fremden Repository in `.claude/settings.json` wird von Claude Code selbst ausgeführt (natives Verhalten).
- **Remote Control** verbindet die laufenden FORGE-Sessions eines Projekts mit claude.ai und der Claude-App
  (dein Konto). Nachrichten von dort laufen durch dieselbe Session: Profil, Freigaben und Sperrliste gelten.
  Ausschalten trennt die Verbindung, die Session läuft lokal weiter.
- **Terminal**: nur Shell oder Claude-CLI startbar, kein Netzwerkzugang zum PTY.
- **Testbefehle** laufen mit deinen Rechten im Projektordner.
- **Projekt löschen** mit Ordner oder GitHub-Repository verlangt das Eintippen des Projektnamens. Laufwerke,
  das Benutzerverzeichnis und seine Standardordner, FORGE-Daten und Ordner mit weiteren Projekten sind gesperrt.
  Die GitHub-Berechtigung `delete_repo` fragt FORGE erst an, wenn sie gebraucht wird.
- **Auto-Commit/Auto-Push** commiten nur Dateien aus dem aktuellen Durchlauf, nie sensible Dateien, pushen nie
  auf main/master und nie mit Force.
