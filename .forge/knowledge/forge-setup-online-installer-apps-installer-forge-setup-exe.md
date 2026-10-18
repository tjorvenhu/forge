---
title: "FORGE Setup: Online-Installer (apps/installer, FORGE-Setup.exe, Release \"installer\", setup.yml)"
summary: "Wie der immer gleiche Online-Installer FORGE-Setup.exe aussieht, gebaut, veröffentlicht und lokal gefahrlos getestet wird, was er von GitHub lädt und welche Stellen ihn berücksichtigen müssen (release.yml, Download-Zähler, Code-Signatur)."
tags: ["installer","release","tauri","update","stolperfalle"]
updated: "2026-10-18T21:57:59.583Z"
---

Seit 2026-10-18 (Wunsch des Besitzers: „online immer der gleiche Installer, der alles von GitHub zieht“, mit dem App-Logo oben links).

## Aussehen (Entscheidungen des Besitzers 2026-10-18)
- Wie der Einrichtungsassistent der App (`SetupWizard.tsx`): Spalte mit `forge-logo.png` und Schrittliste (StepItem-Stil), Kopf mit Icon-Kachel, Karten, Fußleiste. Tokens aus `apps/desktop/src/styles.css`, Knöpfe wie `button.tsx`, Schrift Geist offline (`ui/assets/geist-*.woff2`).
- Abgelehnt: eine Fassung mit großem orangem Schein, Riesenüberschrift und leuchtendem Knopf („KI-like“) und eine Hammer-auf-Amboss-Animation („sieht scheiße aus, komisch platziert“). Stattdessen eine schlichte Übersichtskarte (Version, Download, Enthält, Quelle) und am Ende ein Konfetti-Schuss aus beiden unteren Ecken (`confetti()` in app.js, Canvas über allem, Farben der App, aus bei `prefers-reduced-motion`).
- **Standardsprache Englisch** (auch auf deutschem Windows), Deutsch über den Umschalter; die UI ruft `set_lang`, damit Rust-Fehlertexte (`t()`) dieselbe Sprache haben.
- „a product by Vanturis“ und die Lizenz sind Links (`open_url`, nur https).
- Zielordner immer änderbar, auch bei bestehender Installation (Hinweis, dass der alte Ordner bleibt). `pick_dir` hängt `FORGE` an, wenn der gewählte Ordner nicht so heißt.

## Was es tut
- `apps/installer`: eigenständige Tauri-2-App (nicht im pnpm-Workspace, eigenes `Cargo.lock`, kein Bundler). Oberfläche statisch in `ui/` (`withGlobalTauri`); ESLint-Block für `apps/installer/ui/**/*.js` mit Browser-Globals in `eslint.config.js`.
- `resolve` holt `releases?per_page=100` anonym von der GitHub-API und wählt wie `pickInstaller` (app-update.ts): neuester signierter Installer für die Laufzeit des neuesten Update-Zips, danach das neuere Update-Zip. Prüft SHA-256 (GitHub-`digest`) und Ed25519-Signatur (gleicher öffentlicher Schlüssel wie `signature.ts`, Manifest `FORGE_<v>.sig` oder `<asset>.sig`). Dann NSIS-Installer `/S` (bei vorhandener Installation im Zielordner zusätzlich `/UPDATE`) und `/D=<Ordner>` zuletzt, ohne Anführungszeichen (`raw_arg`). Das Update-Zip kopiert es direkt (FORGE läuft da nicht, der Silent-Installer beendet es) und setzt `DisplayVersion` in `HKCU\…\Uninstall\FORGE`.
- In-App-Updates und Reparatur laufen weiter über den NSIS-Installer und die Zips, nicht über das Setup. Deinstallation bleibt das NSIS-`uninstall.exe`.
- Fehlt WebView2, lädt das Setup vor dem Fenster Microsofts Bootstrapper (`/install`); klappt das nicht, Meldungsfenster.
- Log: `%TEMP%\forge-setup.log`.

## Veröffentlichung
- `.github/workflows/setup.yml`: bei Push auf `apps/installer/**` oder von Hand. `cargo test`, `cargo build --release` (~4,7 MB), Code-Signatur (`SIGN_ONLY` in codesign.mjs enthält `FORGE-Setup.exe`, 1 Signatur je Lauf), Upload mit `--clobber` in die **Prerelease `installer`**. Feste Adresse: `https://github.com/vanturis/forge/releases/download/installer/FORGE-Setup.exe` (README-Download-Knopf).
- Das Tag `installer` darf release.yml nicht stören: Job `changes` nimmt nur Releases mit Tag `v*`, Release-Notes nutzen `git describe --match "v*"`, Änderungen unter `apps/installer/` lösen keinen App-Release aus. Die App filtert Prereleases ohnehin.
- Download-Zähler (`services/stats/src/lib/downloads.ts`) zählt nur `*_x64-setup.exe`: das Setup lädt bei jeder Installation den NSIS-Installer, FORGE-Setup.exe selbst zu zählen wäre doppelt.

## Lokal testen, ohne die eigene FORGE-Installation anzufassen
- `cd apps/installer && cargo test` (Auswahl, Namen, echte Signatur von v0.1.103); `cargo test -- --ignored live --nocapture` zeigt die Auswahl gegen die echten Releases.
- `cargo build --release`, dann mit `FORGE_SETUP_DRY_RUN=1` starten: echter Download und Signaturprüfung, Installation nur simuliert. Ohne die Variable würde der Silent-Installer das laufende FORGE beenden und die Session gleich mit.
- Fenster-Screenshot: `(Get-Process forge-setup).MainWindowHandle` + GetWindowRect + CopyFromScreen, Klicks per SetCursorPos/mouse_event relativ zum Fenster (FindWindow aus der Bash-Shell findet das Fenster nicht). Ordnerdialog heißt „Folder for FORGE“, schließen mit WScript.Shell `AppActivate` + `{ESC}`.
- UI ohne Tauri: `python -m http.server 4321` in `apps/installer/ui`, dann preview_interact mit 760x500; Demo-Modus (`?installed=1`, `?installed=same`, `?offline=1`, `?fail=1`, `?lang=de`), Konfetti: auf `.app[data-screen="done"]` warten, dann ~400 ms.
- Ein echter Installationslauf mit NSIS `/S` ist auf dem Rechner des Besitzers nicht getestet (würde FORGE beenden).

## NSIS-Grafiken
Der NSIS-Installer selbst behält Icon, Kopf- und Seitengrafik (`apps/desktop/src-tauri/installer/`, Seitenleiste mit echtem `logo.svg`); sichtbar bei Reparatur aus der App (`/P`) und bei direktem Start der setup.exe.
