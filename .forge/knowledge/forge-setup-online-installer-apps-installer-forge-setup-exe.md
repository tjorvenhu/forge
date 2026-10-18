---
title: "FORGE Setup: Online-Installer (apps/installer, FORGE-Setup.exe, Release \"installer\", setup.yml)"
summary: "Wie der immer gleiche Online-Installer FORGE-Setup.exe gebaut, veröffentlicht und lokal gefahrlos getestet wird, was er von GitHub lädt und welche Stellen ihn berücksichtigen müssen (release.yml, Download-Zähler, Code-Signatur)."
tags: ["installer","release","tauri","update","stolperfalle"]
updated: "2026-10-18T21:32:01.961Z"
---

Seit 2026-10-18 (Wunsch des Besitzers: „online immer der gleiche Installer, der alles von GitHub zieht“, mit Hammer-auf-Amboss-Animation und dem App-Logo oben links).

## Was es ist
- `apps/installer`: eigenständige Tauri-2-App (nicht im pnpm-Workspace, eigenes `Cargo.lock`, kein Bundler). Oberfläche statisch in `ui/` (index.html, style.css, app.js, `withGlobalTauri`), Logo ist `forge-logo.png` aus der App, Amboss aus `logo.svg`.
- Ablauf: `resolve` holt `releases?per_page=100` anonym von der GitHub-API und wählt wie `pickInstaller` (app-update.ts): neuester signierter Installer für die Laufzeit des neuesten Update-Zips, danach das neuere Update-Zip. Prüft SHA-256 (GitHub-`digest`) und Ed25519-Signatur (gleicher öffentlicher Schlüssel wie `signature.ts`, Manifest `FORGE_<v>.sig` oder `<asset>.sig`). Dann NSIS-Installer `/S` (bei vorhandener Installation zusätzlich `/UPDATE`) und `/D=<Ordner>` zuletzt, ohne Anführungszeichen (`raw_arg`). Das Update-Zip kopiert es direkt (FORGE läuft da nicht, der Silent-Installer beendet es) und setzt `DisplayVersion` in `HKCU\…\Uninstall\FORGE`.
- In-App-Updates und Reparatur laufen weiter über den NSIS-Installer und die Zips, nicht über das Setup. Deinstallation bleibt das NSIS-`uninstall.exe`.
- Fehlt WebView2, lädt das Setup vor dem Fenster Microsofts Bootstrapper (`/install`); klappt das nicht, Meldungsfenster.
- Log: `%TEMP%\forge-setup.log`.

## Veröffentlichung
- `.github/workflows/setup.yml`: bei Push auf `apps/installer/**` oder von Hand. `cargo test`, `cargo build --release` (~4,6 MB), Code-Signatur (`SIGN_ONLY` in codesign.mjs enthält `FORGE-Setup.exe`, 1 Signatur je Lauf), Upload mit `--clobber` in die **Prerelease `installer`**. Feste Adresse: `https://github.com/vanturis/forge/releases/download/installer/FORGE-Setup.exe` (README-Download-Knopf).
- Stolperfallen, schon berücksichtigt: Das Tag `installer` darf release.yml nicht stören: Job `changes` nimmt nur Releases mit Tag `v*`, Release-Notes nutzen `git describe --match "v*"`, Änderungen unter `apps/installer/` lösen keinen App-Release aus. Die App filtert Prereleases ohnehin.
- Download-Zähler (`services/stats/src/lib/downloads.ts`) zählt nur `*_x64-setup.exe`: das Setup lädt bei jeder Installation den NSIS-Installer, FORGE-Setup.exe selbst zu zählen wäre doppelt.

## Lokal testen, ohne die eigene FORGE-Installation anzufassen
- `cd apps/installer && cargo test` (Auswahl, Namen, echte Signatur von v0.1.103); `cargo test -- --ignored live --nocapture` zeigt die Auswahl gegen die echten Releases.
- `cargo build --release`, dann mit `FORGE_SETUP_DRY_RUN=1` starten: echter Download und Signaturprüfung, Installation nur simuliert. Ohne die Variable würde der Silent-Installer das laufende FORGE beenden und die Session gleich mit.
- Fenster-Screenshot: `(Get-Process forge-setup).MainWindowHandle` + GetWindowRect + CopyFromScreen (FindWindow aus der Bash-Shell findet das Fenster nicht). UI ohne Tauri: `ui/index.html` im Browser hat einen Demo-Modus (`?installed=1`, `?installed=same`, `?offline=1`, `?fail=1`, `?lang=en`).
- Ein echter Installationslauf mit NSIS `/S` ist auf dem Rechner des Besitzers nicht getestet (würde FORGE beenden).

## NSIS-Grafiken
Der NSIS-Installer selbst behält Icon, Kopf- und Seitengrafik (`apps/desktop/src-tauri/installer/`, Seitenleiste mit echtem `logo.svg`); sichtbar bei Reparatur aus der App (`/P`) und bei direktem Start der setup.exe.
