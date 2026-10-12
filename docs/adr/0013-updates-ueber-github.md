# ADR 0013: Updates über GitHub-Releases

Datum: 2026-10-12 · Status: angenommen

## Ziel

Neue Versionen ohne manuelles Neuinstallieren: Sobald auf GitHub ein Update liegt, bietet FORGE es an.

## Entscheidungen

**Bauen:** `.github/workflows/release.yml` läuft bei jedem Push auf `main` (nicht bei reinen Doku-Änderungen) auf
`windows-latest`: Version `0.1.<run_number>` in `tauri.conf.json`, Lint und Typecheck, Sidecar und Frontend
(einmal, `beforeBuildCommand` leer über `tauri.ci.json`), dann `gh release create v0.1.<n>` mit den
Commit-Betreffs seit dem letzten Tag als Notizen. Ein neuerer Push bricht einen laufenden Build ab.

**Zwei Arten von Releases** (Nachtrag 2026-10-12, vorher dauerte jeder Build 9,5 Minuten): node, git und gh sind
476 MB und ändern sich fast nie; allein das LZMA-Packen im NSIS-Installer kostete 2 Minuten.

- `FORGE_<v>_update_<laufzeit>.zip` bei jedem Release: nur `forge-desktop.exe`, `runtime/sidecar/sidecar.mjs`
  und `update.json`, etwa 4 MB. Gebaut mit `tauri build --no-bundle`, ohne Laufzeit-Download und ohne NSIS.
- `FORGE_<v>_<laufzeit>_x64-setup.exe` nur, wenn es für den Laufzeit-Schlüssel noch keinen Installer gibt (neue
  node-, git- oder gh-Version in `scripts/prepare-runtime.mjs`) oder auf Wunsch (Run workflow → full).

Der Laufzeit-Schlüssel ist `node-<v>_git-<v>_gh-<v>` (`prepare-runtime.mjs --key`); die installierte App liest
ihn aus `runtime/VERSIONS.json`. Rust baut mit Thin-LTO statt vollem LTO (eine Minute schneller, kaum größer),
die Toolchain wird nicht mehr aktualisiert. „Latest“ auf GitHub bleibt beim neuesten vollen Installer
(`--latest=false` für die anderen): Download für Neuinstallationen, und ältere FORGE-Versionen, die nur
`releases/latest` lesen, finden dort immer einen Installer.
Unit-Tests laufen dort nicht: zwei Tests scheitern unter Windows an verzögert gelöschten Dateien (siehe HANDOFF).

**Prüfen und Laden** (`packages/sidecar/src/update/app-update.ts`): über das mitgelieferte `gh` mit der Anmeldung
des Nutzers (`gh api repos/tjorvenhu/forge/releases?per_page=30`, `gh release download`). Grund: Das Repository ist
privat; der Tauri-Updater kann private Release-Dateien nicht ohne Token laden, und ein öffentliches Release-Repo würde
die App für alle sichtbar machen. Wer FORGE aktualisieren will, braucht also Lesezugriff auf das Repository.
Erste Prüfung 20 s nach dem Start, dann alle 30 Minuten (Einstellung `updateChecks`), nur in der Desktop-App
(`FORGE_APP_VERSION` gesetzt). Der Installer landet in `%TEMP%\forge-update` und wird gegen den SHA-256 geprüft,
den GitHub für die Datei meldet (`digest`); bei Abweichung verworfen. Auswahl (`pickRelease`): Hat das neueste
Release ein kleines Update für den installierten Laufzeit-Schlüssel, wird es genommen; sonst der neueste volle
Installer. Danach folgen wieder kleine Updates. Die Oberfläche zeigt Art und Größe.

**Installieren** (Rust-Befehl `install_update`, `src-tauri/src/update.rs`): nur Dateien aus
`%TEMP%\forge-update`. `*-setup.exe` wie unten. `*_update_*.zip` wird mit `tar.exe` nach `staged` entpackt
und darf genau die drei erwarteten Dateien enthalten; die Version in `update.json` nur Ziffern und Punkte. Ein
PowerShell-Skript (außerhalb des Job-Objekts gestartet) wartet, bis FORGE beendet ist, benennt die alten Dateien
in `.forge-old` um, kopiert die neuen, stellt bei einem Fehler die alten wieder her, setzt `DisplayVersion` im
Uninstall-Eintrag und startet FORGE neu. Protokoll: `%TEMP%\forge-update\apply-update.log`. Der Installer:
Die Hülle beendet Terminals und Sidecar sauber (offene Sessions werden wie beim Schließen unterbrochen und lassen
sich fortsetzen), startet den Installer selbst mit `/P /UPDATE /R` (ohne Rückfragen, Einstellungen bleiben,
FORGE startet danach neu) und beendet sich. Nicht der Sidecar startet ihn: dessen Job-Objekt würde den Installer
beim Beenden von FORGE mit beenden.

**Keine Updater-Signatur (minisign):** Installer kommen per TLS aus dem eigenen privaten Repository mit
GitHub-Prüfsumme; wer dort Releases anlegen kann, kann auch den Code ändern. Code-Signing (SmartScreen) fehlt
weiterhin.

## Tests

`app-update.test.ts`: Versionsvergleich, Update gefunden, Download mit Prüfsumme, falsche Prüfsumme, aktuell,
fehlender Login, noch kein Release, Wahl zwischen kleinem Update und vollem Installer, Download des kleinen Updates.
Das Austausch-Skript ist von Hand geprüft (Erfolg und Rückbau bei gesperrter Datei).
