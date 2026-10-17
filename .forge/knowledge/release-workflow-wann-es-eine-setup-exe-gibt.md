---
title: "Release-Workflow: wann es eine setup.exe gibt"
summary: "Warum Releases meist nur ein Update-Zip haben, wie man den vollen Installer baut, was passiert, wenn jemand das Update-Zip statt des Installers nimmt, und was zu tun ist, wenn ein Push keinen Release-Lauf mehr auslöst."
tags: ["release","github-actions","installer","stolperfalle"]
updated: "2026-10-17T11:44:02.557Z"
---

## Wann gibt es eine setup.exe
- `.github/workflows/release.yml` läuft bei jedem Push auf `main` (ohne reine md/docs-Änderungen) und veröffentlicht `v0.1.<run number>`.
- Jedes Release bekommt `FORGE_<v>_update_<runtime>.zip` (nur App + Sidecar, wenige MB; installierte Apps aktualisieren damit).
- Die volle `FORGE_<v>_<runtime>_x64-setup.exe` (mit node, git, gh) entsteht **nur**, wenn sich die mitgelieferte Laufzeit ändert (Schlüssel aus `scripts/prepare-runtime.mjs`) oder von Hand angefordert: `gh workflow run release.yml --ref main -f full=true` (bzw. Actions → Run workflow → full). Sonst hängt der letzte Installer an einem älteren Release (Stand 2026-10-17: v0.1.56; davor v0.1.9).
- Für Neuinstallationen also das neueste Release mit setup.exe nehmen, nicht einfach „latest“. Finden: `gh api "repos/tjorvenhu/forge/releases?per_page=100" --jq '.[] | select(any(.assets[]; .name | endswith("setup.exe"))) | .tag_name'`.
- Der Schritt „Build app“ gibt den Laufzeit-Schlüssel als `FORGE_RUNTIME_KEY` in die exe; damit erkennt die App eine unvollständige Installation (Eintrag unvollstaendige-installation-erkennen-und-nachinstallieren-f).

## Stolperfalle: Update-Zip statt Installer (2026-10-17)
Der Nutzer hat auf einem neuen Rechner das Update-Zip entpackt/gestartet statt der setup.exe. Ergebnis: kein `runtime/` mit git und gh, der Einrichtungsassistent meldet „Die GitHub-Anbindung fehlt in dieser Installation“. Es lag nicht am Installer: v0.1.56 enthält gh (`runtime/gh/bin/gh.exe`). Seit 2026-10-17 zeigt FORGE das selbst als Banner „FORGE ist nicht vollständig installiert“ mit Knopf zum Nachinstallieren.

## Wenn ein Push keinen Lauf auslöst (2026-10-14)
- Symptom: Workflow steht in der API auf `active`, aber `actions/runs` ist leer (die alte Lauf-Historie war weg) und Pushes starten nichts.
- Behoben mit `gh workflow enable release.yml` und einem Lauf per `gh workflow run release.yml --ref main`. Danach liefen die Läufe wieder.
- Prüfen: `gh api "repos/tjorvenhu/forge/actions/runs?per_page=5"`, `gh release view <tag> --json assets`.
