<a href="0014-macos-and-linux.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0014: FORGE für macOS und Linux

Datum: 2026-10-19 · Status: angenommen

## Ziel

FORGE gibt es auch für macOS (Apple Silicon und Intel) und Linux (x64). Das Windows-Release bleibt genau so,
wie es ist: gleiche Jobs, gleiche Dateien, gleiche Signaturen.

## Entscheidungen

**Plattformen.** Jede Plattform hat eine feste Kennung: `win32-x64` (Windows, wie bisher), `darwin-arm64`,
`darwin-x64` und `linux-x64`. Andere Kombinationen (Linux auf ARM, Windows auf ARM) baut FORGE nicht.

**Was mitgeliefert wird.** `scripts/prepare-runtime.mjs` legt wie unter Windows alles in
`apps/desktop/src-tauri/runtime/` ab, Tauri bündelt den Ordner als Ressource.

| | Windows | macOS und Linux |
|---|---|---|
| Node.js 24.21.0 | nur `node.exe` | der ganze offizielle Ordner (`node/bin/node`, npm, npx) |
| GitHub CLI 2.102.0 | `gh/bin/gh.exe` | das offizielle Archiv ohne Manpages (`gh/bin/gh`) |
| Git | PortableGit | nein, vom System |
| Python | NuGet-Paket | nein, vom System |
| Sidecar | `sidecar/sidecar.mjs` | `sidecar/sidecar.mjs` |

Alle Archive sind mit Version und SHA-256 fest eingetragen (Node aus `SHASUMS256.txt`, gh aus
`gh_<v>_checksums.txt`). Auf macOS und Linux bleiben die Rechte für ausführbare Dateien erhalten. npm, npx
und corepack sind im Archiv symbolische Links. Tauri kopiert Ressourcen Datei für Datei und löst Links
dabei auf. Darum ersetzt das Skript diese drei Links durch kleine Shell-Skripte. Danach darf der Ordner
keine Links mehr enthalten, sonst bricht das Skript ab.

**Warum kein Git und kein Python auf macOS und Linux.** Unter Windows fehlen beide oft, und ohne Git Bash
läuft Claude Code dort nicht. Auf macOS kommen `git` und `python3` mit den Xcode Command Line Tools: Der
erste Aufruf bietet die Installation an. Auf Linux gehören beide zum Paketmanager der Distribution. Eigene
Kopien wären groß. Sie müssten für jedes System eigens gebaut werden, und Python bräuchte dort andere
Wege für pip und venv als unter Windows. Node und gh bleiben dabei, weil der Sidecar Node braucht und FORGE
die GitHub-Anmeldung über gh fest einplant.

**Laufzeit-Schlüssel.** Windows: unverändert `node-<v>_git-<v>_gh-<v>_python-<v>`. macOS und Linux:
`<Kennung>_node-<v>_gh-<v>`, zum Beispiel `darwin-arm64_node-24.21.0_gh-2.102.0`. `prepare-runtime.mjs
--key` gibt ihn für den Rechner aus, `--target <Kennung>` für eine andere Architektur desselben Systems.
`VERSIONS.json` hat dieselbe Form wie unter Windows, nur ohne `git` und `python`.

**Release-Dateien.** `release.yml` behält die Jobs `changes` und `release` (Windows). Danach bauen die Jobs
`macos` (Matrix: `aarch64-apple-darwin` und `x86_64-apple-darwin`, beide auf dem arm64-Runner) und `linux`
(`ubuntu-22.04`, damit das AppImage auch mit älterer glibc läuft) dieselbe Version und laden ihre Dateien
mit `gh release upload --clobber` in dasselbe Release:

- `FORGE_<v>_darwin-arm64.app.tar.gz` und `FORGE_<v>_darwin-x64.app.tar.gz`: `FORGE.app` als oberster Ordner,
  für Updates in der App.
- `FORGE_<v>_darwin-arm64.dmg` und `FORGE_<v>_darwin-x64.dmg`: für Neuinstallationen.
- `FORGE_<v>_linux-x64.AppImage` und `FORGE_<v>_linux-x64.deb`.
- `FORGE_<v>_<Kennung>.sig`: die Signaturen der Dateien dieser Plattform, im selben JSON-Format wie
  `FORGE_<v>.sig` (`sign-update.mjs --manifest`, Secret `FORGE_UPDATE_SIGNING_KEY`). Es wird zuletzt
  hochgeladen, damit die App keine halb hochgeladenen Dateien anbietet.

Keine `.sig` je Datei und keine `.runtime`-Markierung: Diese Formen gibt es nur für Windows-Installationen
bis 0.1.101. Jeder Lauf baut macOS und Linux komplett, auch nachts. Kleine Updates nur mit App und Sidecar
gibt es dort nicht. Ein Fehler in diesen Jobs ändert am Windows-Release nichts.

**Updates.** Die App bietet nur Dateien mit gültiger Signatur an. Auf macOS und Linux nimmt sie das neueste
Release, das eine Datei für ihre Plattform hat. So darf ein Release für kurze Zeit nur Windows-Dateien haben,
oder dauerhaft, wenn der macOS- oder Linux-Job scheitert.

| Art der Installation | Update |
|---|---|
| Windows (NSIS) | wie bisher: Update-Zip oder Installer |
| macOS `.app` | lädt `.app.tar.gz`, ersetzt `FORGE.app` und startet neu |
| Linux AppImage | lädt das neue AppImage und ersetzt die Datei |
| Linux `.deb` | meldet die neue Version, installiert wird über die Paketverwaltung |

**Signatur unter macOS.** Ohne Apple-Entwicklerkonto gibt es keine Notarisierung. Die App ist nur ad hoc
signiert (`signingIdentity: "-"`), damit sie auf Apple Silicon überhaupt startet. Gatekeeper blockiert den
ersten Start. Nutzer öffnen FORGE einmal über Rechtsklick > Öffnen, ab macOS 15 über Systemeinstellungen >
Datenschutz & Sicherheit > Dennoch öffnen, oder mit `xattr -dr com.apple.quarantine /Applications/FORGE.app`.
Der Release-Job prüft die Signatur mit `codesign --verify --deep`. Dateien, die FORGE für ein Update selbst
lädt, bekommen keine Quarantäne-Markierung. Updates brauchen diesen Schritt deshalb nicht.

**Nur Windows.** Der Online-Installer `FORGE-Setup.exe` (`setup.yml`), die Authenticode-Signatur über Azure
Artifact Signing, die kleinen Update-Zips und der NSIS-Installer.

## Konsequenzen

- Drei Release-Jobs mehr. Ein Release ist erst nach dem langsamsten Job vollständig. Bis dahin finden
  macOS und Linux das vorige Release.
- Ohne Notarisierung bleibt der erste Start auf macOS umständlich. Ein Apple-Entwicklerkonto würde das lösen.
- FORGE hängt auf macOS und Linux von `git` und `python3` des Systems ab.
- `.github/workflows/ci.yml` prüft Typen und Tests auf Windows, macOS und Linux, bei Pull Requests und von Hand.
- Neue Versionen von Node oder gh: in `prepare-runtime.mjs` für alle vier Plattformen eintragen. Mit
  `node scripts/prepare-runtime.mjs --check-hashes` lassen sich alle Archive auf jedem System laden und prüfen.
