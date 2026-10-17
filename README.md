# FORGE: Claude Development Studio

FORGE ist eine Windows-Desktop-App für Claude Code. Sie startet echte Claude-Code-Sessions in deinen Projekten,
zeigt die Antworten live, fragt Freigaben ab und zeigt Git-Status, Diffs und Commits in derselben Ansicht.
Die Anmeldung läuft über dein Claude-Abo. Ein API-Schlüssel ist nicht nötig.

Was FORGE kann, kurz:

- Projekte importieren, neu anlegen oder von GitHub klonen
- Claude-Sessions mit Streaming, Werkzeug-Karten, Freigaben, Plan-Modus und Rückfragen
- Rechteprofile (Safe, Balanced, Autonomous) und eine Sperrliste für gefährliche Befehle
- Git: Diffs, Commits nur der ausgewählten Dateien, Branches, Push und Pull, Pull Requests
- Parallele Agenten in eigenen Git-Worktrees
- Dev-Server, lokale Test-Datenbank (PostgreSQL) und Vorschau der Web-App für Claude
- Projektwissen, das jede Session beim Start bekommt
- Anzeige der Abo-Nutzung (5-Stunden- und Wochenfenster)
- Optional: Telefon über SIP, mit dem du FORGE anrufen und steuern kannst
- Optional: verschlüsselte Synchronisierung über ein privates GitHub-Repository

## Voraussetzungen

- Windows 10 oder 11, 64 Bit (x64)
- Ein eigenes Claude-Abo mit Zugang zu Claude Code (zum Beispiel Pro oder Max). Die Anmeldung machst du in FORGE.
- Optional: ein GitHub-Konto, für GitHub-Funktionen, Updates und die Synchronisierung

Node.js, Git (mit Bash), die GitHub CLI und Python liefert der Installer mit. Fehlt Claude Code, installiert FORGE
es beim ersten Start über den offiziellen Installer von Anthropic.

## Installation

1. Öffne die [Releases](https://github.com/tjorvenhu/forge/releases).
2. Nimm das neueste Release, das eine Datei `FORGE_<Version>_<Laufzeit>_x64-setup.exe` hat. Nicht jedes Release
   hat einen Installer. Die Dateien `FORGE_<Version>_update_<Laufzeit>.zip` sind nur für Updates bestehender
   Installationen gedacht und reichen für eine Neuinstallation nicht.
3. Lade die `setup.exe` herunter und starte sie.
4. Der Installer ist nicht signiert. Windows zeigt deshalb eine SmartScreen-Warnung. Klicke auf
   „Weitere Informationen“ und dann auf „Trotzdem ausführen“.
5. Beim ersten Start führt dich ein Assistent durch die Anmeldung bei Claude und, wenn du willst, bei GitHub.

## Updates

FORGE sucht selbst nach Updates: kurz nach dem Start und danach alle 30 Minuten. Ist eines da, zeigt FORGE die
Änderungen an und installiert das Update auf Wunsch mit einem Klick. Updates sind signiert, FORGE prüft die
Signatur vor der Installation. Die Suche lässt sich unter Einstellungen > Über FORGE abschalten.

## Datenschutz

Deine Projekte, Chatverläufe und Einstellungen liegen auf deinem Rechner (unter `%APPDATA%\forge`).
Daten gehen nur an diese Stellen:

- **Anonyme Nutzungsstatistik (abschaltbar):** Alle 5 Minuten schickt FORGE Summen an
  [forge-stats.vanturis.de](https://forge-stats.vanturis.de): eine zufällige Kennung der Installation (ohne
  Bezug zu Konto oder Rechner), die FORGE- und Windows-Version und Zählerstände (Tokens, Claude-Arbeitszeit,
  Sessions, angelegte Projekte, gestartete und zusammengeführte Agenten, Telefonate). Keine Inhalte, keine
  Projektnamen, keine Pfade. Der Dienst speichert keine IP-Adressen. FORGE fragt beim ersten Start danach, ohne
  Antwort ist die Statistik an. Ausschalten unter Einstellungen > Über FORGE > Datenschutz; dann löscht FORGE
  die gesendeten Daten beim Dienst. Die Gesamtzahlen aller Nutzer sind auf derselben Seite öffentlich.

- **Anthropic:** Claude Code schickt deine Prompts und den Projektkontext mit deinem eigenen Konto an Anthropic.
  Das gilt auch für Hilfsaufgaben wie Commit-Nachrichten, Sessiontitel oder den Changelog im Update-Fenster.
  FORGE liest dabei keine Zugangsdaten. Die Anmeldung speichert Claude Code selbst.
- **Claude Code installieren und aktualisieren:** Fehlt Claude Code, lädt FORGE den offiziellen Installer von
  `claude.ai`. Für den Hinweis auf neue Claude-Code-Versionen liest FORGE die aktuelle Versionsnummer von
  `downloads.claude.ai`. Dabei werden keine Daten mitgeschickt.
- **Telefon (optional, standardmäßig aus):** Das Gesprächsaudio geht je nach Einstellung an Google (Gemini) oder
  an OpenAI, jeweils mit deinen eigenen API-Schlüsseln. Die SIP-Verbindung läuft zu deiner Telefonanlage
  bzw. deinem SIP-Anbieter.
- **GitHub:** Für Updates fragt FORGE die Releases dieses Repositorys ab und lädt das Update von GitHub.
  Profilbilder in Commits kommen von GitHub. Die Synchronisierung (optional) legt deine FORGE-Daten verschlüsselt
  in einem privaten Repository deines GitHub-Kontos ab. Alle anderen GitHub-Funktionen laufen mit deinem
  eigenen Konto über die GitHub CLI.
- **npm-Registry:** Startest du in den Dev-Tools zum ersten Mal eine Test-Datenbank, lädt FORGE PostgreSQL einmalig
  als npm-Paket (`@embedded-postgres/windows-x64`) von `registry.npmjs.org`.

## Unterstützen

- Spenden: [paypal.me/tjorvenhu](https://paypal.me/tjorvenhu)
- Vorschläge und Fehler: [neues Issue auf GitHub](https://github.com/tjorvenhu/forge/issues/new). Bei Fehlern
  helfen die FORGE-Version und die Angaben aus Einstellungen > Über FORGE > Diagnose.
- Sicherheitslücken bitte nicht als Issue melden, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Lizenz

FORGE steht unter der [PolyForm Noncommercial License 1.0.0](LICENSE.md).

- Private und andere nichtkommerzielle Nutzung ist frei.
- Kommerzielle Nutzung ist nur mit schriftlicher Erlaubnis gestattet. Frag dafür über GitHub an, per Issue oder
  über das Profil [tjorvenhu](https://github.com/tjorvenhu).

Der Copyright-Hinweis steht in [NOTICE](NOTICE). Mitgelieferte Software von Drittanbietern und ihre Lizenzen:
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) und [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Entwickeln

FORGE ist ein pnpm-Monorepo:

- `apps/desktop`: Tauri-App (Rust) mit React-Oberfläche
- `packages/sidecar`: Node-Prozess, der Claude Code, Git, Telefon und Datenbank steuert
- `packages/protocol`: gemeinsame Typen und RPC-Methoden (Zod)

Werkzeuge:

| Werkzeug | Version |
|---|---|
| Node.js | 22.13 oder neuer |
| pnpm | 10.x |
| Rust und Cargo | stable (MSVC) |
| Visual Studio Build Tools | 2022, Workload „C++ Build Tools“ |

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
```

Befehle:

```bash
pnpm install
pnpm dev              # baut den Sidecar und startet die App (Tauri dev)
pnpm lint             # ESLint über alle Pakete
pnpm typecheck        # TypeScript strict für protocol, sidecar und desktop
pnpm test             # Unit- und Integrationstests ohne echte Claude-Aufrufe
pnpm test:e2e         # E2E mit echter Claude-Session (verbraucht etwas Abo-Kontingent)
pnpm build            # Release mit Installer (lädt beim ersten Mal Node, Git, gh und Python)
pnpm prepare:runtime  # nur die mitgelieferte Laufzeit vorbereiten
pnpm notices          # THIRD_PARTY_NOTICES.md neu erzeugen (nach Änderungen an Abhängigkeiten)
```

Umgebungsvariablen für Sonderfälle: `FORGE_NODE` (Pfad zu node), `FORGE_SIDECAR` (Pfad zu `sidecar.mjs`),
`FORGE_DATA_DIR` (Datenordner), `FORGE_E2E=0` (E2E überspringen), `FORGE_E2E_MODEL` (Modell für E2E).

Releases baut `.github/workflows/release.yml` bei jedem Push auf `main`.

Weitere Dokumentation:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Prozesse, Module, Statusmaschine
- [docs/SECURITY.md](docs/SECURITY.md): Rechte- und Sicherheitskonzept
- [docs/TESTING.md](docs/TESTING.md): Tests und was sie abdecken
- [docs/adr/](docs/adr): Architekturentscheidungen
- `.forge/knowledge/`: Projektwissen (Abläufe, Stolperfallen)
