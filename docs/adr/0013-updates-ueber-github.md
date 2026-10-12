# ADR 0013: Updates über GitHub-Releases

Datum: 2026-10-12 · Status: angenommen

## Ziel

Neue Versionen ohne manuelles Neuinstallieren: Sobald auf GitHub ein Update liegt, bietet FORGE es an.

## Entscheidungen

**Bauen:** `.github/workflows/release.yml` läuft bei jedem Push auf `main` (nicht bei reinen Doku-Änderungen) auf
`windows-latest`: Version `0.1.<run_number>` in `tauri.conf.json`, Lint und Typecheck, `pnpm build`, dann
`gh release create v0.1.<n>` mit dem NSIS-Installer und den Commit-Betreffs seit dem letzten Tag als Notizen.
Unit-Tests laufen dort nicht: zwei Tests scheitern unter Windows an verzögert gelöschten Dateien (siehe HANDOFF).

**Prüfen und Laden** (`packages/sidecar/src/update/app-update.ts`): über das mitgelieferte `gh` mit der Anmeldung
des Nutzers (`gh api repos/tjorvenhu/forge/releases/latest`, `gh release download`). Grund: Das Repository ist
privat; der Tauri-Updater kann private Release-Dateien nicht ohne Token laden, und ein öffentliches Release-Repo würde
die App für alle sichtbar machen. Wer FORGE aktualisieren will, braucht also Lesezugriff auf das Repository.
Erste Prüfung 20 s nach dem Start, dann alle 30 Minuten (Einstellung `updateChecks`), nur in der Desktop-App
(`FORGE_APP_VERSION` gesetzt). Der Installer landet in `%TEMP%orge-update` und wird gegen den SHA-256 geprüft,
den GitHub für die Datei meldet (`digest`); bei Abweichung verworfen.

**Installieren** (Rust-Befehl `install_update`): nur Installer aus `%TEMP%orge-update`, Name `*-setup.exe`.
Die Hülle beendet Terminals und Sidecar sauber (offene Sessions werden wie beim Schließen unterbrochen und lassen
sich fortsetzen), startet den Installer selbst mit `/P /UPDATE /R` (ohne Rückfragen, Einstellungen bleiben,
FORGE startet danach neu) und beendet sich. Nicht der Sidecar startet ihn: dessen Job-Objekt würde den Installer
beim Beenden von FORGE mit beenden.

**Keine Updater-Signatur (minisign):** Installer kommen per TLS aus dem eigenen privaten Repository mit
GitHub-Prüfsumme; wer dort Releases anlegen kann, kann auch den Code ändern. Code-Signing (SmartScreen) fehlt
weiterhin.

## Tests

`app-update.test.ts`: Versionsvergleich, Update gefunden, Download mit Prüfsumme, falsche Prüfsumme, aktuell,
fehlender Login, noch kein Release.
