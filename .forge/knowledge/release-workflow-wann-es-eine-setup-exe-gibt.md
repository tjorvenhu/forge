---
title: "Release-Workflow: wann es eine setup.exe gibt"
summary: "Warum Releases meist nur ein Update-Zip haben, wie man den vollen Installer baut und was zu tun ist, wenn ein Push keinen Release-Lauf mehr auslöst."
tags: ["release","github-actions","installer","stolperfalle"]
updated: "2026-10-14T05:26:54.790Z"
---

## Wann gibt es eine setup.exe
- `.github/workflows/release.yml` läuft bei jedem Push auf `main` (ohne reine md/docs-Änderungen) und veröffentlicht `v0.1.<run number>`.
- Jedes Release bekommt `FORGE_<v>_update_<runtime>.zip` (nur App + Sidecar, wenige MB; installierte Apps aktualisieren damit).
- Die volle `FORGE_<v>_<runtime>_x64-setup.exe` (mit node, git, gh) entsteht **nur**, wenn sich die mitgelieferte Laufzeit ändert (Schlüssel aus `scripts/prepare-runtime.mjs`) oder von Hand angefordert: `gh workflow run release.yml --ref main -f full=true` (bzw. Actions → Run workflow → full). Sonst hängt der letzte Installer an einem älteren Release (Stand 2026-10-14: v0.1.56; davor v0.1.9).
- Für Neuinstallationen also das neueste Release mit setup.exe nehmen, nicht einfach „latest“.

## Wenn ein Push keinen Lauf auslöst (2026-10-14)
- Symptom: Workflow steht in der API auf `active`, aber `actions/runs` ist leer (die alte Lauf-Historie war weg) und Pushes starten nichts.
- Behoben mit `gh workflow enable release.yml` und einem Lauf per `gh workflow run release.yml --ref main`. Danach liefen die Läufe wieder.
- Prüfen: `gh api "repos/tjorvenhu/forge/actions/runs?per_page=5"`, `gh release view <tag> --json assets`.
