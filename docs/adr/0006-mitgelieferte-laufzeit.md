# ADR 0006: Alles in einer Installation (Node, Git, GitHub CLI), Claude-Einrichtung in der App

Datum: 2026-10-10 · Status: angenommen

## Kontext

FORGE soll nach dem Ausführen des Installers ohne weitere Downloads oder Terminalbefehle nutzbar sein.
Bisher mussten Node.js, git und gh vorhanden sein, Logins liefen über `claude auth login` und `gh auth login`.

## Entscheidung

- **Mitgeliefert:** Node.js 24.21.0, PortableGit 2.56.0.2 (enthält Bash, ssh und den Git
  Credential Manager), GitHub CLI 2.102.0. `scripts/prepare-runtime.mjs` lädt die Archive aus den
  offiziellen Quellen, prüft die SHA-256 und legt sie unter `apps/desktop/src-tauri/runtime/` ab.
  Tauri bündelt den Ordner als Ressource. Dokumentation, Manpages, Übersetzungen und Vim werden entfernt.
  Installer: rund 92 MB.
- **Vorrang:** mitgelieferte Werkzeuge vor System-Werkzeugen, damit sich jede Installation gleich verhält.
  Globale git-Konfiguration und Credential Store des Nutzers gelten weiterhin (gleiches HOME, gleicher
  Windows-Anmeldeinformationsspeicher).
- **Claude-Sessions** bekommen `runtime/git/cmd` und `runtime/gh/bin` vorne in den PATH. Hat der Rechner
  kein Git for Windows, zeigt `CLAUDE_CODE_GIT_BASH_PATH` auf die mitgelieferte Bash (Claude Code braucht
  sie unter Windows für sein Bash-Tool).
- **Claude Code wird nicht mitgeliefert**, sondern bei Bedarf über den offiziellen Installer
  (`irm https://claude.ai/install.ps1 | iex`) aus der App installiert. Gründe: Die CLI aktualisiert sich
  selbst, das mitgelieferte SDK-Binary wäre 260 MB groß und veraltet. Die Anmeldung läuft über
  `claude auth login`: FORGE öffnet die Anmeldeseite und gibt den eingefügten Code an die CLI weiter.
- **GitHub-Login** über die mitgelieferte gh im Device Flow: FORGE zeigt den Einmal-Code an und öffnet
  github.com/login/device. Das Token speichert gh im Anmeldeinformationsspeicher, FORGE sieht es nie.
  Danach `gh auth setup-git`, damit git über https dieselben Zugangsdaten nutzt.
  Alternative wäre eine eigene GitHub-OAuth-App gewesen; die bräuchte eine registrierte Client-ID und
  würde Tokens in FORGE verwalten.

## Konsequenzen

- Größerer Installer, längerer Release-Build (rund 4,5 Minuten).
- Lizenzen der mitgelieferten Software: [THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md).
- Versions-Updates: Konstanten in `scripts/prepare-runtime.mjs` anpassen (Version, URL, SHA-256).
