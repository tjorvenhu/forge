<a href="README.md"><img src=".github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src=".github/assets/flags/de.svg" height="14" alt=""> Deutsch

<p align="center">
  <img src=".github/assets/banner.png" alt="FORGE: Die Desktop-App für Claude Code" width="100%">
</p>

<p align="center">
  <a href="https://github.com/vanturis/forge/releases/latest"><img src="https://img.shields.io/github/v/release/vanturis/forge?style=for-the-badge&label=Version&color=f97316" alt="Neueste Version"></a>
  <a href="https://github.com/vanturis/forge/releases/latest"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fforge.vanturis.de%2Fapi%2Fv1%2Fdownloads&query=%24.downloads&label=Downloads&style=for-the-badge&color=21262e" alt="Downloads des Installers"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/Lizenz-AGPL--3.0-21262e?style=for-the-badge" alt="Lizenz AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-21262e?style=for-the-badge" alt="Windows, macOS und Linux">
  <a href="https://forge.vanturis.de/stats"><img src="https://img.shields.io/badge/FORGE-in%20Zahlen-21262e?style=for-the-badge&logo=googleanalytics&logoColor=white" alt="FORGE in Zahlen"></a>
</p>

<p align="center">
  <a href="https://forge.vanturis.de/download"><img src="https://img.shields.io/badge/Download-Windows%20%7C%20macOS%20%7C%20Linux-f97316?style=for-the-badge" alt="Download für Windows, macOS und Linux" height="42"></a>
  &nbsp;
  <a href="https://buy.stripe.com/9B64gBc4e5j80vg1WxbV600"><img src="https://img.shields.io/badge/FORGE-unterst%C3%BCtzen-e11d48?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="FORGE unterstützen" height="42"></a>
</p>

<p align="center">
  <b>FORGE</b> startet echte Claude-Code-Sessions in deinen Projekten, zeigt die Antworten live, fragt Freigaben ab<br>
  und bringt Git, Agenten, Vorschau und Projektwissen in ein Fenster. Mit deinem eigenen Claude-Abo, ohne API-Schlüssel.
</p>

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/start.png" alt="Startseite: was gerade läuft und zuletzt bearbeitete Sessions"></td>
    <td width="50%"><img src=".github/assets/screenshots/projekte.png" alt="Projekte mit Git-Status, Tags und parallelen Agenten"></td>
  </tr>
  <tr>
    <td align="center"><sub>Start: was gerade läuft, zuletzt bearbeitete Sessions, Abo-Nutzung</sub></td>
    <td align="center"><sub>Projekte mit Git-Status, Technologien und laufenden Agenten</sub></td>
  </tr>
</table>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#was-forge-kann">Funktionen</a> ·
  <a href="#datenschutz">Datenschutz</a> ·
  <a href="#unterstützen">Unterstützen</a> ·
  <a href="#entwickeln">Entwickeln</a>
</p>

---

## Was FORGE kann

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Claude-Sessions</h3>
      Streaming, Werkzeug-Karten, Freigaben, Plan-Modus und Rückfragen. Mehrere Sessions nebeneinander in der geteilten Ansicht.
    </td>
    <td width="50%" valign="top">
      <h3>Parallele Agenten</h3>
      Jeder Agent arbeitet in einem eigenen Git-Worktree auf eigenem Branch. Fertige Arbeit führt FORGE auf Wunsch automatisch zusammen.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Git eingebaut</h3>
      Diffs, Commits nur der ausgewählten Dateien, Branches, Push und Pull, Pull Requests. Commit-Nachrichten schreibt Claude.
    </td>
    <td valign="top">
      <h3>Vorschau und Dev-Tools</h3>
      Dev-Server, lokale PostgreSQL-Testdatenbank und Screenshots der Web-App, die Claude selbst ansehen kann.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Sicher arbeiten</h3>
      Rechteprofile (Safe, Balanced, Autonomous) und eine Sperrliste, die gefährliche Befehle immer blockiert.
    </td>
    <td valign="top">
      <h3>Projektwissen</h3>
      Abläufe, Entscheidungen und Stolperfallen, die jede Session beim Start bekommt. Veraltetes erkennt FORGE selbst.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Abo im Blick</h3>
      Nutzung im 5-Stunden- und Wochenfenster mit Prognose, Tagesbericht mit Tokens, Commits und Agenten.
    </td>
    <td valign="top">
      <h3>Telefon und Sync (optional)</h3>
      FORGE per Telefon anrufen und steuern (SIP). Daten verschlüsselt über ein privates GitHub-Repository auf mehreren PCs.
    </td>
  </tr>
</table>

## Installation

**[forge.vanturis.de/download](https://forge.vanturis.de/download)** wählt den passenden Installer für dein
System. Unter Windows startet der Download von FORGE Setup sofort, unter macOS und Linux zeigt die Seite den
Befehl zum Installieren. Beide Installer bleiben für jede Version dieselben: Sie holen die neueste Version von
GitHub und prüfen sie.

### Windows

1. Lade **[FORGE-Setup.exe](https://forge.vanturis.de/download)** herunter (etwa 5 MB).
2. Starte sie. FORGE Setup sucht die neueste Version auf GitHub, lädt sie herunter (etwa 110 MB), prüft ihre
   Signatur und installiert sie. Solange FORGE neu ist, kann Windows eine SmartScreen-Warnung zeigen: auf
   **Weitere Informationen** und dann **Trotzdem ausführen** klicken.
3. Beim ersten Start wählst du die Sprache. Danach führt dich ein Assistent durch die Anmeldung bei Claude und,
   wenn du willst, bei GitHub.

**Voraussetzungen:** Windows 10 oder 11 (x64) und ein Claude-Abo mit Zugang zu Claude Code, zum Beispiel Pro
oder Max. Node.js, Git, die GitHub CLI und Python bringt der Installer mit. Fehlt Claude Code, installiert FORGE
es beim ersten Start über den offiziellen Installer von Anthropic.

### macOS

1. Öffne das Terminal und führe aus:

   ```sh
   curl -fsSL https://forge.vanturis.de/install.sh | sh
   ```

   Das Skript ([scripts/install.sh](scripts/install.sh)) nimmt aus dem neuesten Release die Version für Apple
   Silicon oder Intel, prüft ihre SHA-256-Prüfsumme, legt FORGE in **Programme** (oder `~/Applications`) und
   startet es. So installiert, blockiert macOS den ersten Start nicht.
2. macOS fragt nach Berechtigungen, sobald eine Funktion sie zum ersten Mal braucht: **Bildschirmaufnahme** für das
   Screenshot-Werkzeug und **Mikrofon** für die Spracheingabe. Hast du abgelehnt, erlaube es FORGE später unter
   Systemeinstellungen > Datenschutz & Sicherheit.

<details>
<summary>Ohne Terminal: die dmg</summary>

Lade `FORGE_<Version>_darwin-arm64.dmg` (Apple Silicon) oder `FORGE_<Version>_darwin-x64.dmg` (Intel) von
[forge.vanturis.de/download](https://forge.vanturis.de/download), öffne sie und zieh FORGE in **Programme**. Starte
es von dort: Nur in diesem Ordner kann FORGE sich selbst aktualisieren. FORGE ist nicht von Apple notarisiert
(dafür fehlt ein Apple-Entwicklerkonto). Darum blockiert macOS den ersten Start einer heruntergeladenen dmg: FORGE
einmal starten, dann **Systemeinstellungen > Datenschutz & Sicherheit** öffnen und auf **Dennoch öffnen** klicken,
oder im Terminal `xattr -dr com.apple.quarantine /Applications/FORGE.app`. Das ist nur einmal nötig, Updates fragen
nicht wieder.
</details>

**Voraussetzungen:** macOS 13.5 oder neuer, ein Claude-Abo wie oben sowie `git` und `python3`. Beide kommen mit
den Xcode Command Line Tools (`xcode-select --install`; macOS bietet sie beim ersten Aufruf von `git` an) oder über
Homebrew. Node.js und die GitHub CLI bringt FORGE mit.

### Linux

Im Terminal ausführen:

```sh
curl -fsSL https://forge.vanturis.de/install.sh | sh
```

Das Skript lädt das AppImage des neuesten Releases, prüft seine SHA-256-Prüfsumme und installiert es als
`~/.local/bin/forge` mit Eintrag im Anwendungsmenü. Das AppImage aktualisiert FORGE selbst. AppImages brauchen
FUSE 2 (`sudo apt install libfuse2t64`, auf älterem Ubuntu `libfuse2`); ohne startet FORGE trotzdem, nur langsamer.

Von Hand, über [forge.vanturis.de/download](https://forge.vanturis.de/download):

- **AppImage** (jede Distribution): `FORGE_<Version>_linux-x64.AppImage` laden, dann
  `chmod +x FORGE_<Version>_linux-x64.AppImage` und starten.
- **deb** (Debian, Ubuntu und Ableger): `sudo apt install ./FORGE_<Version>_linux-x64.deb`. FORGE meldet neue
  Versionen, installiert werden sie auf demselben Weg.

**Voraussetzungen:** x64 mit glibc 2.35 oder neuer (zum Beispiel Ubuntu 22.04, Debian 12, Fedora 36), WebKitGTK 4.1
(`libwebkit2gtk-4.1-0`, das deb-Paket installiert es mit), `git` und `python3` aus deiner Distribution und ein
Claude-Abo wie oben. Node.js und die GitHub CLI bringt FORGE mit.

**Sprache:** FORGE gibt es auf Englisch und Deutsch. Die Sprache wählst du beim ersten Start, später kannst du
sie in den Einstellungen ändern.

<details>
<summary>Welche Datei ist die richtige?</summary>

FORGE Setup ist für jede Version dieselbe Datei. Ohne Setup gilt: Nicht jedes Release hat einen Installer. „Latest“ zeigt immer auf das neueste Release mit Installer. Ältere
Installer heißen `FORGE_<Version>_<Laufzeit>_x64-setup.exe`. Die Dateien `FORGE_<Version>_update_<Laufzeit>.zip`
sind nur für Updates bestehender Installationen und reichen für eine Neuinstallation nicht. Die Datei
`FORGE_<Version>.sig` braucht FORGE selbst zum Prüfen der Updates (Releases bis 0.1.101 haben je Datei eine `.sig`
und eine `.runtime`-Datei).

macOS und Linux: Die Dateien `.dmg`, `.AppImage` und `.deb` sind zum Installieren. `FORGE_<Version>_darwin-*.app.tar.gz`
ist das Update für installierte Macs, `FORGE_<Version>_<Plattform>.sig` enthält die Signaturen der Dateien dieser
Plattform. Diese Dateien kommen etwas später als die Windows-Dateien ins Release.
</details>

**Updates** holt FORGE selbst: kurz nach dem Start und danach alle 30 Minuten. Du siehst die Änderungen und
installierst mit einem Klick. Jedes Update ist signiert, FORGE prüft die Signatur vor der Installation.

## Datenschutz

Projekte, Chatverläufe und Einstellungen bleiben auf deinem Rechner (`%APPDATA%\forge`).

- **Anonyme Nutzungsstatistik (standardmäßig aus):** FORGE fragt beim ersten Start einmal danach und bittet
  darum, sie einzuschalten. Die Gesamtzahlen zeigen uns, wie FORGE genutzt wird. Ohne Antwort ist sie aus.
  Eingeschaltet gehen alle 5 Minuten Summen an [forge.vanturis.de](https://forge.vanturis.de): eine
  zufällige Kennung der Installation, FORGE- und Windows-Version, die Sprache der Oberfläche, die Art des Claude-Abos (z. B. Pro oder Max 5x)
  und Zählerstände wie Tokens je Claude-Modell, geschätzte API-Kosten, Sessions, Projekte und Agenten. Keine
  Inhalte, keine Projektnamen, keine Pfade, keine IP-Adressen. Ein- und ausschalten unter Einstellungen > Über
  FORGE > Datenschutz; beim Ausschalten löscht FORGE die gesendeten Daten beim Dienst.
- **Anthropic:** Claude Code schickt deine Prompts und den Projektkontext mit deinem eigenen Konto an Anthropic.
  FORGE liest keine Zugangsdaten.

<details>
<summary>Alle Verbindungen im Detail</summary>

- **Claude Code installieren und aktualisieren:** Fehlt Claude Code, lädt FORGE den offiziellen Installer von
  `claude.ai`. Für den Hinweis auf neue Versionen liest FORGE die Versionsnummer von `downloads.claude.ai`.
- **Hilfsaufgaben:** Commit-Nachrichten, Sessiontitel und der Changelog im Update-Fenster laufen ebenfalls über
  dein Claude-Konto.
- **Telefon (optional, standardmäßig aus):** Gesprächsaudio geht je nach Einstellung an Google (Gemini) oder an
  OpenAI, jeweils mit deinen eigenen API-Schlüsseln. Die SIP-Verbindung läuft zu deiner Telefonanlage bzw.
  deinem SIP-Anbieter.
- **GitHub:** Updates und Profilbilder in Commits kommen von GitHub. Die Synchronisierung (optional) legt deine
  FORGE-Daten verschlüsselt in einem privaten Repository deines GitHub-Kontos ab. Alle anderen GitHub-Funktionen
  laufen mit deinem eigenen Konto über die GitHub CLI.
- **npm-Registry:** Startest du in den Dev-Tools zum ersten Mal eine Test-Datenbank, lädt FORGE PostgreSQL einmalig
  als npm-Paket (`@embedded-postgres/windows-x64`) von `registry.npmjs.org`.
- **Nutzungsstatistik (nur wenn eingeschaltet):** FORGE fragt beim ersten Start danach, ohne Antwort ist sie aus. Zum Schutz vor Missbrauch
  hält der Dienst nur einen gesalzenen Hash der IP-Adresse im Arbeitsspeicher, längstens einen Tag. Die
  Gesamtzahlen aller Nutzer sind auf [forge.vanturis.de/stats](https://forge.vanturis.de/stats) öffentlich.

Mehr in der [Datenschutzerklärung von Vanturis](https://vanturis.de/datenschutz).
</details>

## Unterstützen

<a href="https://buy.stripe.com/9B64gBc4e5j80vg1WxbV600"><img src="https://img.shields.io/badge/FORGE-unterst%C3%BCtzen-e11d48?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="FORGE unterstützen"></a>

Wenn dir FORGE hilft, freuen wir uns über einen freiwilligen Beitrag. Den Betrag wählst du selbst. Das Geld geht
an die Vanturis UG (haftungsbeschränkt), die FORGE entwickelt. Sie ist nicht gemeinnützig, eine
Spendenquittung gibt es deshalb nicht.

- **Vorschläge und Fehler:** [neues Issue auf GitHub](https://github.com/vanturis/forge/issues/new/choose), gern auf Deutsch oder Englisch. Bei
  Fehlern helfen die FORGE-Version und die Angaben aus Einstellungen > Über FORGE > Diagnose.
- **Sicherheitslücken** bitte nicht als Issue melden, sondern wie in [SECURITY.de.md](SECURITY.de.md) beschrieben.
- **Mitmachen:** Beiträge sind willkommen, siehe [CONTRIBUTING.de.md](CONTRIBUTING.de.md).

## Lizenz

FORGE ist ein Open-Source-Produkt der [Vanturis UG (haftungsbeschränkt)](https://vanturis.de) unter der
[GNU Affero General Public License, Version 3](LICENSE.md) (AGPL-3.0-only).

- Nutzen, ändern und weitergeben ist frei, auch beruflich und in Firmen.
- Wer eine veränderte Fassung weitergibt oder als Dienst über ein Netzwerk anbietet, muss deren Quellcode unter
  der AGPL offenlegen.
- Für die Kombination mit der Claude-Agent-SDK und Claude Code von Anthropic gilt eine Zusatzerlaubnis nach
  Abschnitt 7 der AGPL, siehe [NOTICE](NOTICE).
- Eine kommerzielle Lizenz ohne die Pflichten der AGPL gibt es bei [Vanturis](https://vanturis.de).

Mitgelieferte Software von Drittanbietern und ihre Lizenzen: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
und [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Entwickeln

FORGE ist ein pnpm-Monorepo:

| Ordner | Inhalt |
|---|---|
| `apps/desktop` | Tauri-App (Rust) mit React-Oberfläche |
| `apps/installer` | FORGE Setup: Online-Installer, der die neueste Version von GitHub lädt (Tauri, eigenständig) |
| `packages/sidecar` | Node-Prozess, der Claude Code, Git, Telefon und Datenbank steuert |
| `packages/protocol` | gemeinsame Typen und RPC-Methoden (Zod) |
| `services/stats` | Statistik-Dienst hinter forge.vanturis.de (Next.js, eigenständig) |

<details>
<summary>Werkzeuge und Befehle</summary>

| Werkzeug | Version |
|---|---|
| Node.js | 22.13 oder neuer |
| pnpm | 10.x |
| Rust und Cargo | stable (unter Windows MSVC) |
| Visual Studio Build Tools | 2022, Workload „C++ Build Tools“ (nur Windows) |

Unter macOS braucht es die Xcode Command Line Tools, unter Linux die Systembibliotheken aus
`.github/workflows/ci.yml` (WebKitGTK 4.1 und weitere). Unter Windows:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
```

```bash
pnpm install
pnpm dev              # baut den Sidecar und startet die App (Tauri dev)
pnpm lint             # ESLint über alle Pakete
pnpm typecheck        # TypeScript strict für protocol, sidecar und desktop
pnpm test             # Unit- und Integrationstests ohne echte Claude-Aufrufe
pnpm test:e2e         # E2E mit echter Claude-Session (verbraucht etwas Abo-Kontingent)
pnpm build            # Release mit Installer (lädt beim ersten Mal die mitgelieferte Laufzeit)
pnpm prepare:runtime  # nur die mitgelieferte Laufzeit vorbereiten
pnpm notices          # THIRD_PARTY_NOTICES.md neu erzeugen (nach Änderungen an Abhängigkeiten)
```

Umgebungsvariablen für Sonderfälle: `FORGE_NODE` (Pfad zu node), `FORGE_SIDECAR` (Pfad zu `sidecar.mjs`),
`FORGE_DATA_DIR` (Datenordner), `FORGE_E2E=0` (E2E überspringen), `FORGE_E2E_MODEL` (Modell für E2E).

Releases baut `.github/workflows/release.yml` jede Nacht, wenn sich `main` geändert hat (erst Windows, dann macOS
und Linux, siehe [ADR 0014](docs/adr/0014-macos-und-linux.de.md)). `.github/workflows/ci.yml` prüft Typen und Tests
auf allen drei Systemen bei Pull Requests.
</details>

Weitere Dokumentation: [Architektur](docs/ARCHITECTURE.de.md) · [Sicherheitskonzept](docs/SECURITY.de.md) ·
[Tests](docs/TESTING.de.md) · [Architekturentscheidungen](docs/adr) · Projektwissen in `.forge/knowledge/`

---

<p align="center">
  <sub>Ein Produkt der <a href="https://vanturis.de">Vanturis UG (haftungsbeschränkt)</a> · <a href="https://vanturis.de/impressum">Impressum</a> · <a href="https://vanturis.de/datenschutz">Datenschutz</a></sub>
</p>
