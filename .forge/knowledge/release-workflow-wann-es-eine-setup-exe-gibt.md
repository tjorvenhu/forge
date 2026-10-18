---
title: "Release-Workflow: nächtlich, setup.exe, Installer-Namen, Signatur (Update-Signatur, Azure Code-Signatur)"
summary: "Wann Releases entstehen (nachts oder von Hand), warum meist nur ein Update-Zip, wie der volle Installer heißt und gebaut wird, wie Release-Dateien signiert werden (Update-Signatur und Authenticode über Azure Artifact Signing) und was bei fehlendem Schlüssel oder ausbleibendem Lauf zu tun ist."
tags: ["release","github-actions","installer","stolperfalle"]
updated: "2026-10-18T19:31:09.208Z"
---

Repo seit 2026-10-17: `vanturis/forge` (vorher `tjorvenhu/forge`, GitHub leitet weiter).

## Wann es ein Release gibt (seit 2026-10-18)
- `.github/workflows/release.yml` läuft **nachts um 03:00 UTC** (schedule) und von Hand (`gh workflow run release.yml -R vanturis/forge --ref main`). Kein Lauf mehr bei jedem Push. Grund (Entscheidung des Besitzers zum öffentlichen Start 2026-10-18): installierte Apps bieten jedes Release als Update an; vorher waren es bis zu 15 am Tag.
- Job `changes` (ubuntu): nachts baut er nur, wenn sich seit dem Commit des letzten Releases (`target_commitish`) etwas außer `*.md`, `docs/`, `services/`, `*.png`, `*.docx`, `.forge/` geändert hat. Von Hand baut er immer.
- Version `v0.1.<run number>`; übersprungene Nachtläufe erhöhen die Nummer trotzdem (Lücken sind normal).

## Wann gibt es eine setup.exe
- Jedes Release bekommt `FORGE_<v>_update_<runtime>.zip` (nur App + Sidecar, wenige MB; installierte Apps aktualisieren damit).
- Der volle Installer (mit node, git, gh, python) entsteht nur, wenn es für den Laufzeit-Schlüssel (`scripts/prepare-runtime.mjs --key`) noch keinen **signierten** Installer gibt, oder von Hand: `gh workflow run release.yml -R vanturis/forge --ref main -f full=true`. Sonst hängt der letzte Installer an einem älteren Release.
- Für Neuinstallationen das neueste Release mit setup.exe nehmen, nicht einfach „latest“. Finden: `gh api "repos/vanturis/forge/releases?per_page=100" --jq '.[] | select(any(.assets[]; .name | endswith("setup.exe"))) | .tag_name'`.
- Der Schritt „Build app“ gibt den Laufzeit-Schlüssel als `FORGE_RUNTIME_KEY` in die exe (Erkennung unvollständiger Installationen).
- Der Installer (NSIS) ist zweisprachig: `bundle.windows.nsis.languages` English/German mit `displayLanguageSelector`.

## Installer-Namen (Wunsch des Besitzers 2026-10-17: kurz)
- Seit 2026-10-17: `FORGE_<v>_x64-setup.exe` plus Markierung `FORGE_<v>_x64-setup.<runtime>.runtime`. Deren **Name** trägt den Laufzeit-Schlüssel (Inhalt: derselbe Schlüssel), die App liest ihn ohne Download (`RUNTIME_MARKER` in app-update.ts). Beides wird signiert wie jedes Asset; ohne `.sig` filtert `signedOnly` die Markierung weg.
- Vorher (0.1.8 bis 0.1.8x): `FORGE_<v>_<runtime>_x64-setup.exe`; die App liest beide Formen. Bis 0.1.7: kurze Namen mit alter Laufzeit; `SHORT_NAMES_SINCE` in full-install.ts trennt sie von den neuen kurzen.
- Versionen vor der Umstellung kennen die Markierung nicht: Ändert sich die Laufzeit, finden sie den neuen Installer nicht selbst und brauchen ihn einmal von Hand. Kleine Updates betrifft das nicht.

## Update-Signatur (seit 2026-10-17)
- Jedes Asset bekommt `<asset>.sig` (`scripts/sign-update.mjs`, Ed25519, Format in ADR 0013). Die App bietet nur signierte Assets an; Releases davor (bis v0.1.5x) sind für sie unsichtbar.
- Privater Schlüssel: Repo-Secret `FORGE_UPDATE_SIGNING_KEY` (ist beim Übertrag nach `vanturis` mitgezogen). Fehlt es, bricht der Workflow schon im Schritt Plan ab. Eine Kopie hat der Besitzer gesichert; geht sie verloren und das Secret auch, braucht es einen neuen Schlüssel und alle Installationen den Installer von Hand.
- Öffentlicher Schlüssel: `packages/sidecar/src/update/signature.ts`.
- Reihenfolge: erst Authenticode, dann `.sig` (die Code-Signatur ändert die Bytes der exe).

## Code-Signatur Authenticode (Azure Artifact Signing, eingebaut 2026-10-18)
- `scripts/codesign.mjs`: signtool aus dem Windows SDK (>= 10.0.22621, sucht die neueste unter `Windows Kits\10\bin`) plus Microsofts dlib aus dem NuGet-Paket `Microsoft.ArtifactSigning.Client` (Version und SHA-512 gepinnt, Werkzeuge landen in `.codesign/`, gitignored). `--setup` lädt und schreibt `metadata.json`; sonst signiert es die übergebenen Dateien, mit 3 Versuchen und Zeitstempel `http://timestamp.acs.microsoft.com` (Zertifikate gelten nur 3 Tage).
- Workflow: Ohne Secret `AZURE_CLIENT_ID` baut er unsigniert mit Warnung. Sonst: Schritt „Code signing tools“ (früher Abbruch bei falschen Variablen), `tauri.ci.json` bekommt `bundle.windows.signCommand = {cmd: node, args: [codesign.mjs, %1]}`, nach dem Build wird `target/release/forge-desktop.exe` fürs Update-Zip signiert, „Package and publish“ prüft mit `Get-AuthenticodeSignature` exe und setup.exe.
- Secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (App-Registrierung mit Rolle „Artifact Signing Certificate Profile Signer“ auf dem Zertifikatsprofil), Variablen `AZURE_SIGNING_ENDPOINT` (regional, muss zur Region des Kontos passen, sonst 403), `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`.
- Stolperfalle Tauri: der Bundler gibt **jede unsignierte exe/dll der Ressourcen** an den signCommand, also hunderte Dateien aus Git for Windows und Python in `runtime/`. codesign.mjs überspringt alles unter dem Laufzeit-Ordner `runtime` der Ressourcen bzw. `target/<profil>/runtime` (Fremdsoftware soll nicht die Vanturis-Signatur tragen, Signaturen pro Monat sind begrenzt). Tauri kann Pfade als `\\?\C:\…` übergeben, deshalb wird das Präfix vor dem Vergleich entfernt.
- Stolperfalle Tauri: Nach dem Bundling stellt Tauri die unsignierte exe in `target/release` wieder her; in der setup.exe steckt die signierte. Mit `--no-bundle` signiert Tauri gar nichts.
- Lokal testen: mit gesetzten `AZURE_SIGNING_*` und `az login` (ohne `AZURE_CLIENT_SECRET` lässt metadata.json alle Credential-Arten zu).
- SignPath Foundation (kostenlos für Open Source) passt nicht: verlangt keine proprietären Bestandteile, der Sidecar bündelt aber `@anthropic-ai/claude-agent-sdk` („All rights reserved“).

## Stolperfalle: Update-Zip statt Installer (2026-10-17)
Wer das Update-Zip statt der setup.exe startet, hat kein `runtime/` mit git und gh. FORGE zeigt das als Banner „FORGE ist nicht vollständig installiert“ mit Knopf zum Nachinstallieren.

## Wenn kein Lauf startet (2026-10-14)
- Symptom: Workflow steht in der API auf `active`, aber `actions/runs` ist leer. GitHub schaltet geplante Läufe außerdem nach 60 Tagen ohne Aktivität im Repo ab.
- Behoben mit `gh workflow enable release.yml` und einem Lauf per `gh workflow run release.yml --ref main`.
- Prüfen: `gh api "repos/vanturis/forge/actions/runs?per_page=5"`, `gh release view <tag> -R vanturis/forge --json assets`.
