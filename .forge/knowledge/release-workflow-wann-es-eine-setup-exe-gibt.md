---
title: "Release-Workflow: nächtlich, setup.exe, Installer-Namen, Signatur (FORGE_<v>.sig, Azure Code-Signatur)"
summary: "Wann Releases entstehen (nachts oder von Hand), wie der volle Installer gebaut wird, wie Release-Dateien signiert werden (eine FORGE_<v>.sig pro Release, Azure-Authenticode nur für eigene exe) und was bei Fehlern zu tun ist."
tags: ["release","github-actions","installer","stolperfalle"]
updated: "2026-10-18T20:48:36.420Z"
---

Repo seit 2026-10-17: `vanturis/forge` (vorher `tjorvenhu/forge`, GitHub leitet weiter).

## Wann es ein Release gibt (seit 2026-10-18)
- `.github/workflows/release.yml` läuft **nachts um 03:00 UTC** (schedule) und von Hand (`gh workflow run release.yml -R vanturis/forge --ref main`). Kein Lauf mehr bei jedem Push. Grund (Entscheidung des Besitzers zum öffentlichen Start 2026-10-18): installierte Apps bieten jedes Release als Update an; vorher waren es bis zu 15 am Tag.
- Job `changes` (ubuntu): nachts baut er nur, wenn sich seit dem Commit des letzten Releases (`target_commitish`) etwas außer `*.md`, `docs/`, `services/`, `*.png`, `*.docx`, `.forge/` geändert hat. Von Hand baut er immer.
- Version `v0.1.<run number>`; übersprungene Nachtläufe erhöhen die Nummer trotzdem (Lücken sind normal).

## Was ein Release enthält (seit 0.1.103, Wunsch des Besitzers: wenige Dateien)
- `FORGE_<v>_update_<runtime>.zip` (jedes Release; nur App + Sidecar, wenige MB; installierte Apps aktualisieren damit).
- `FORGE_<v>_x64-setup.exe` nur, wenn es für den Laufzeit-Schlüssel (`scripts/prepare-runtime.mjs --key`) noch keinen signierten Installer gibt, oder von Hand mit `-f full=true`. Seine Laufzeit ist die des Update-Zips im selben Release (`releaseInstallerKey` fällt auf `patchRuntimeKey` zurück).
- `FORGE_<v>.sig`: Signaturen aller Assets als JSON (`sign-update.mjs --manifest`, `SIG_MANIFEST`/`signatureFrom` in `signature.ts`). Der Plan-Schritt erkennt einen vorhandenen Installer an setup.exe + Update-Zip mit dem Schlüssel + `FORGE_<v>.sig` im selben Release.
- Altes Format bis 0.1.101: `<asset>.sig` je Datei und Markierung `FORGE_<v>_x64-setup.<runtime>.runtime`. Die App liest beides weiter. **v0.1.102 ist das Brücken-Release** (Workflow-Eingabe `legacy_signatures=true`, nur Update-Zip): Installationen bis 0.1.101 sehen nur Assets mit eigener `.sig` und kommen darüber ins neue Format. Nicht löschen; es muss in den ersten 100 Releases der Liste bleiben (`releases?per_page=100`), sonst brauchen sehr alte Installationen den Installer von Hand.
- Für Neuinstallationen das neueste Release mit setup.exe nehmen, nicht einfach „latest“. Finden: `gh api "repos/vanturis/forge/releases?per_page=100" --jq '.[] | select(any(.assets[]; .name | endswith("setup.exe"))) | .tag_name'`.
- Der Schritt „Build app“ gibt den Laufzeit-Schlüssel als `FORGE_RUNTIME_KEY` in die exe (Erkennung unvollständiger Installationen). Der Installer (NSIS) ist zweisprachig (`languages` English/German, `displayLanguageSelector`).
- Ältere Installer-Namen: 0.1.8 bis 0.1.8x `FORGE_<v>_<runtime>_x64-setup.exe` (die App liest sie), bis 0.1.7 kurze Namen mit alter Laufzeit (`SHORT_NAMES_SINCE` in full-install.ts).

## Update-Signatur (seit 2026-10-17)
- Ed25519 über `FORGE-UPDATE-1\n<Dateiname>\n<sha256>` (Format in ADR 0013). Die App bietet nur signierte Assets an; Releases bis v0.1.5x sind für sie unsichtbar.
- Privater Schlüssel: Repo-Secret `FORGE_UPDATE_SIGNING_KEY`. Fehlt es, bricht der Workflow schon im Schritt Plan ab. Eine Kopie hat der Besitzer gesichert; geht sie verloren und das Secret auch, braucht es einen neuen Schlüssel und alle Installationen den Installer von Hand.
- Öffentlicher Schlüssel: `packages/sidecar/src/update/signature.ts`.
- Reihenfolge: erst Authenticode, dann die Update-Signatur (die Code-Signatur ändert die Bytes der exe).

## Code-Signatur Authenticode (Azure Artifact Signing, eingebaut 2026-10-18)
- Secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` (App-Registrierung `forge-github-signing`), `AZURE_CLIENT_SECRET`; Variablen `AZURE_SIGNING_ENDPOINT` = `https://neu.codesigning.azure.net/` (North Europe, muss zur Region des Kontos passen, sonst 403), `AZURE_SIGNING_ACCOUNT` = `vanturis-signing`, `AZURE_SIGNING_PROFILE` = `vanturis-public`. Die App-Registrierung braucht auf dem Profil die Rolle „Artifact Signing Certificate Profile Signer“.
- `scripts/codesign.mjs`: signtool aus dem Windows SDK (>= 10.0.22621) plus Microsofts dlib aus dem NuGet-Paket `Microsoft.ArtifactSigning.Client` (Version und SHA-512 gepinnt, Werkzeuge in `.codesign/`, gitignored). `--setup` lädt und schreibt `metadata.json`; sonst signiert es die übergebenen Dateien, mit 3 Versuchen und Zeitstempel `http://timestamp.acs.microsoft.com` (Zertifikate gelten nur 3 Tage).
- **Nur eigene Programme signieren (Entscheidung des Besitzers 2026-10-18, Kontingent 5000 Signaturen/Monat):** `SIGN_ONLY` in codesign.mjs erlaubt nur `forge-desktop.exe`, `*_x64-setup.exe` und den Deinstaller (`nstXXXX.tmp`, den NSIS als Temp-Datei signieren lässt). Tauri gibt **jede unsignierte exe/dll** an den signCommand: ~560 Dateien der Laufzeit (Git for Windows, Python, Node, gh) und die NSIS-Plugin-DLLs. Die bleiben unsigniert; im Log steht je Datei „nicht signiert (keine Signatur verbraucht)“. Die Zeilen „SignTool Error: No signature found“ davor sind Tauris lokale Prüfung (`signtool verify`) und kosten nichts. Verbrauch gemessen (v0.1.103): voller Installer 4 (forge-desktop.exe zweimal, weil Tauri nach dem Bundling die unsignierte exe wiederherstellt und die fürs Update-Zip danach noch einmal signiert wird, Deinstaller, setup.exe), nächtliches Update-Release 1. Gezählt wird nur, was signtool mit „Successfully signed“ meldet.
- SmartScreen warnt trotz gültiger Signatur, bis der Herausgeber genug Ruf hat (keine Abkürzung mehr seit 2024, auch nicht mit EV). Hilft: Downloads und Einreichen unter microsoft.com/wdsi/filesubmission.
- Workflow: Ohne Secret `AZURE_CLIENT_ID` baut er unsigniert mit Warnung. Sonst: Schritt „Code signing tools“, `tauri.ci.json` bekommt `bundle.windows.signCommand = {cmd: node, args: [codesign.mjs, %1]}`, nach dem Build wird `target/release/forge-desktop.exe` fürs Update-Zip signiert, „Package and publish“ prüft mit `Get-AuthenticodeSignature` exe und setup.exe (ein umbenannter Installer, der nicht mehr zu `SIGN_ONLY` passt, fällt dort auf).
- Lokal testen: mit gesetzten `AZURE_SIGNING_*` und `az login` (ohne `AZURE_CLIENT_SECRET` lässt metadata.json alle Credential-Arten zu).
- SignPath Foundation (kostenlos für Open Source) passt nicht: verlangt keine proprietären Bestandteile, der Sidecar bündelt aber `@anthropic-ai/claude-agent-sdk` („All rights reserved“).
- Logs eines laufenden Jobs liefert die GitHub-API nicht (`actions/jobs/<id>/logs` ist leer); erst nach Ende oder Abbruch mit `gh run view <id> --log`.

## Stolperfalle: Update-Zip statt Installer (2026-10-17)
Wer das Update-Zip statt der setup.exe startet, hat kein `runtime/` mit git und gh. FORGE zeigt das als Banner „FORGE ist nicht vollständig installiert“ mit Knopf zum Nachinstallieren.

## Wenn kein Lauf startet (2026-10-14)
- Symptom: Workflow steht in der API auf `active`, aber `actions/runs` ist leer. GitHub schaltet geplante Läufe außerdem nach 60 Tagen ohne Aktivität im Repo ab.
- Behoben mit `gh workflow enable release.yml` und einem Lauf per `gh workflow run release.yml --ref main`.
- Prüfen: `gh api "repos/vanturis/forge/actions/runs?per_page=5"`, `gh release view <tag> -R vanturis/forge --json assets`.
