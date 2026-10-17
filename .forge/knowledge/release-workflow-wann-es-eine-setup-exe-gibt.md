---
title: "Release-Workflow: wann es eine setup.exe gibt, Signatur der Updates (FORGE_UPDATE_SIGNING_KEY)"
summary: "Warum Releases meist nur ein Update-Zip haben, wie man den vollen Installer baut, wie Release-Dateien signiert werden und was bei fehlendem Schlüssel oder ausbleibendem Lauf zu tun ist."
tags: ["release","github-actions","installer","stolperfalle"]
updated: "2026-10-17T19:50:07.180Z"
---

## Wann gibt es eine setup.exe
- `.github/workflows/release.yml` läuft bei jedem Push auf `main` (ohne reine md/docs-Änderungen) und veröffentlicht `v0.1.<run number>`. So gewollt, auch nach der Veröffentlichung des Repos (Entscheidung 2026-10-17).
- Jedes Release bekommt `FORGE_<v>_update_<runtime>.zip` (nur App + Sidecar, wenige MB; installierte Apps aktualisieren damit).
- Die volle `FORGE_<v>_<runtime>_x64-setup.exe` (mit node, git, gh, python) entsteht nur, wenn es für den Laufzeit-Schlüssel (`scripts/prepare-runtime.mjs --key`) noch keinen **signierten** Installer gibt, oder von Hand: `gh workflow run release.yml --ref main -f full=true`. Sonst hängt der letzte Installer an einem älteren Release.
- Für Neuinstallationen das neueste Release mit setup.exe nehmen, nicht einfach „latest“. Finden: `gh api "repos/tjorvenhu/forge/releases?per_page=100" --jq '.[] | select(any(.assets[]; .name | endswith("setup.exe"))) | .tag_name'`.
- Der Schritt „Build app“ gibt den Laufzeit-Schlüssel als `FORGE_RUNTIME_KEY` in die exe (Erkennung unvollständiger Installationen).

## Signatur (seit 2026-10-17)
- Jedes Asset bekommt `<asset>.sig` (`scripts/sign-update.mjs`, Ed25519, Format in ADR 0013). Die App bietet nur signierte Assets an; Releases davor (bis v0.1.5x) sind für sie unsichtbar.
- Privater Schlüssel: Repo-Secret `FORGE_UPDATE_SIGNING_KEY`. Fehlt es, bricht der Workflow schon im Schritt Plan ab („Secret FORGE_UPDATE_SIGNING_KEY fehlt“). Eine Kopie liegt beim Besitzer außerhalb des Repos (`~/.forge-release/update-signing-key.pem`); geht sie verloren und das Secret auch, braucht es einen neuen Schlüssel und alle Installationen den Installer von Hand.
- Öffentlicher Schlüssel: `packages/sidecar/src/update/signature.ts`.

## Stolperfalle: Update-Zip statt Installer (2026-10-17)
Wer das Update-Zip statt der setup.exe startet, hat kein `runtime/` mit git und gh. FORGE zeigt das als Banner „FORGE ist nicht vollständig installiert“ mit Knopf zum Nachinstallieren.

## Wenn ein Push keinen Lauf auslöst (2026-10-14)
- Symptom: Workflow steht in der API auf `active`, aber `actions/runs` ist leer und Pushes starten nichts.
- Behoben mit `gh workflow enable release.yml` und einem Lauf per `gh workflow run release.yml --ref main`.
- Prüfen: `gh api "repos/tjorvenhu/forge/actions/runs?per_page=5"`, `gh release view <tag> --json assets`.
