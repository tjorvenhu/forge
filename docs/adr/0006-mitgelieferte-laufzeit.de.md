<a href="0006-mitgelieferte-laufzeit.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

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

## Nachtrag 2026-10-17: Python

Claude scheiterte in Sessions oft an fehlendem Python (unter Windows meldet sich dann nur der Store-Platzhalter).

- **Variante:** das offizielle NuGet-Paket `python` der PSF (3.14.8, rund 15 MB gepackt, 43 MB entpackt). Es ist
  eine vollständige CPython mit pip, venv und ensurepip, ohne Tests, tkinter und IDLE; `include`/`libs` bleiben für
  C-Erweiterungen. Die embeddable-Variante hat kein pip, ignoriert durch `python._pth` Umgebung und User-Site und
  kann keine venvs anlegen. 3.14 statt des gerade erschienenen 3.15, damit Pakete mit C-Erweiterungen Wheels finden.
  Prüfung per SHA-512 aus dem Katalogeintrag von nuget.org (`packageHash`).
- **Ablage:** `runtime/python`, dazu `python3.exe` (Kopie) und `pip`/`pip3` als `.cmd` und Shell-Skript; pips eigene
  exe-Starter enthalten einen absoluten Pfad.
- **pip:** `pip.ini` in `sys.prefix` mit `[install] user = true`. Ohne Angabe landet `pip install` in
  `%APPDATA%\Python\Python314`, nicht im Installationsordner, den der nächste volle Installer ersetzt. Die Datei gilt
  nur für diesen Interpreter, venvs daraus haben ihr eigenes `sys.prefix` und installieren normal. `PIP_USER` als
  Umgebungsvariable wäre falsch, weil pip dann in jedem venv abbricht. `--target`/`--prefix` brauchen `--no-user`.
- **Vorrang:** die mitgelieferte Kopie vor einem System-Python, wie bei git und gh. So gibt es `python3` und `pip`
  immer, und der Platzhalter in WindowsApps gewinnt nie. Ein eigenes Python erreicht man weiter über `py` oder das
  venv des Projekts. Ohne mitgelieferte Laufzeit (Entwicklung) gilt ein System-Python, aber nicht der Platzhalter.
- **PATH** in Sessions, Dev-Servern und Terminal: `runtime/python` und der User-Scripts-Ordner hinter git und gh, vor
  dem Rest. Zusätzlich `PYTHONUTF8=1`, sonst bricht umgeleitete Ausgabe am ersten Zeichen außerhalb der
  ANSI-Codepage ab.
- Der Laufzeit-Schlüssel bekommt `_python-<v>`; Installationen ohne Python behalten den alten Schlüssel und bekommen
  damit den vollen Installer angeboten.

## Nachtrag 2026-10-19: macOS und Linux

Dieser ADR gilt für Windows. Auf macOS und Linux liefert FORGE nur Node.js und die GitHub CLI mit, Git und Python
kommen vom System: [ADR 0014](0014-macos-und-linux.de.md).
