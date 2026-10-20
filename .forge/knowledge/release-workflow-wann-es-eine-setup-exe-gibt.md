---
title: "Release-Workflow: nächtlich, setup.exe, macOS/Linux-Jobs, Signatur, alte Releases aufräumen"
summary: "Wann Releases entstehen, was sie enthalten (Windows, macOS, Linux), welche Releases nicht gelöscht werden dürfen, wie signiert wird (FORGE_<v>.sig, Azure-Authenticode nur für eigene exe) und was bei Fehlern zu tun ist."
tags: ["release","github-actions","installer","stolperfalle","update"]
updated: "2026-10-20T08:44:14.781Z"
---

Repo: `vanturis/forge`.

## Wann es ein Release gibt
- `.github/workflows/release.yml` nachts um 03:00 UTC (schedule; GitHub startet ihn oft Stunden später) und von Hand (`gh workflow run release.yml -R vanturis/forge --ref main`). Kein Lauf bei jedem Push (Entscheidung des Besitzers 2026-10-18: jedes Release wird installierten Apps als Update angeboten).
- Job `changes`: nachts nur, wenn sich seit dem Commit des letzten Releases etwas außer `*.md`, `docs/`, `services/`, `apps/installer/`, `setup.yml`, `ci.yml`, `*.png`, `*.docx`, `.forge/` geändert hat. Von Hand immer.
- Version `v0.1.<run number>`; Lücken sind normal.

## Inhalt
- Windows-Job: `FORGE_<v>_update_<runtime>.zip` (jedes Release), `FORGE_<v>_x64-setup.exe` nur wenn es für den Laufzeit-Schlüssel (`scripts/prepare-runtime.mjs --key`) noch keinen signierten Installer gibt oder mit `-f full=true`; `FORGE_<v>.sig` (Signaturen aller Assets als JSON); zusätzlich in jedem Release die Alt-Signaturen `<asset>.sig` (+ `.runtime`-Markierung beim Installer) für Apps bis 0.1.101, deren `pickRelease` nur das neueste Release ansieht.
- Jobs `macos` (Matrix arm64/x64 auf macos-latest) und `linux` (ubuntu-22.04) laufen nach dem Windows-Job und hängen ihre Dateien an dessen Release, Details in [[macos-und-linux-plattform-vertrag-laufzeit-updates-pruefen-o]]. Ein Fehler dort berührt Windows nicht. Linux-Paketbau vorab prüfen: CI-Job `bundle-linux` in `ci.yml`.
- **Stolperfalle Linux (Release 108, 2026-10-20):** `libgstreamer1.0-dev` braucht `libunwind-dev`, das auf den Ubuntu-22.04-Runnern mit vorinstalliertem `libunwind-14-dev` kollidiert („held broken packages“). Darum `sudo apt-get remove -y libunwind-14-dev` vor der Installation. Ein „Re-run“ eines Release-Jobs nutzt den alten Workflow-Stand: Fixes greifen erst im nächsten Release.

## Welche Releases bleiben müssen (aufgeräumt 2026-10-20 auf Wunsch des Besitzers: „soll nicht nach Entwicklungsumgebung aussehen“)
Gelöscht wurden 97 Releases samt Tags (`gh release delete <tag> --yes --cleanup-tag`). Nie löschen:
1. `installer` (FORGE-Setup.exe, Online-Installer, `setup.yml`).
2. Das **neueste** Release: Update-Zip und Alt-Signaturen für installierte Apps, macOS/Linux-Assets.
3. Das **neueste Release mit `_x64-setup.exe`** für den aktuellen Laufzeit-Schlüssel: FORGE Setup lädt es, die Reparatur unvollständiger Installationen auch, und der Plan-Schritt erkennt daran (setup.exe + Update-Zip mit Schlüssel + `FORGE_<v>.sig`), dass kein neuer signierter Installer nötig ist. Fehlt es, baut das nächste Release einen vollen Installer (kostet Azure-Signaturen, sonst harmlos).
- Download-Zähler der Website (`services/stats/src/lib/downloads.ts`) summiert `_x64-setup.exe`-Downloads über alle Releases; die der gelöschten stehen fest in `DELETED_RELEASE_DOWNLOADS` (26). Beim nächsten Aufräumen dazuzählen.

## Update-Signatur
- Ed25519 über `FORGE-UPDATE-1\n<Dateiname>\n<sha256>` (ADR 0013). Privater Schlüssel: Secret `FORGE_UPDATE_SIGNING_KEY` (fehlt er, bricht der Plan-Schritt ab; eine Kopie hat der Besitzer). Öffentlicher Schlüssel: `packages/sidecar/src/update/signature.ts`. Erst Authenticode, dann Update-Signatur.
- Nachträglich `<asset>.sig` ohne privaten Schlüssel: Werte aus `FORGE_<v>.sig` als Datei hochladen.

## Authenticode (Azure Artifact Signing)
- Secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; Variablen `AZURE_SIGNING_ENDPOINT` (`https://neu.codesigning.azure.net/`), `AZURE_SIGNING_ACCOUNT` (`vanturis-signing`), `AZURE_SIGNING_PROFILE` (`vanturis-public`). `scripts/codesign.mjs` signiert nur `forge-desktop.exe`, `*_x64-setup.exe` und den Deinstaller (`SIGN_ONLY`, Kontingent 5000/Monat); Tauri reicht ~560 Laufzeit-Dateien durch, die bleiben unsigniert. Verbrauch: voller Installer 4, Update-Release 1.
- SmartScreen warnt trotz Signatur, bis der Herausgeber Ruf hat.
- Logs eines laufenden Jobs liefert die API nicht; `gh run view -R vanturis/forge --job <id> --log` geht für fertige Jobs auch während der Rest läuft.

## Installer-Aussehen
NSIS-Bilder `installer/header.bmp`, `installer/sidebar.bmp` (Quellen `installer/*.html`, `installer/render.ps1`). Komplett dunkel ginge nur mit eigenem `nsis.template`.

## Wenn kein Lauf startet
Geplante Läufe schaltet GitHub nach 60 Tagen ohne Aktivität ab: `gh workflow enable release.yml`, dann von Hand starten.
