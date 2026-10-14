---
title: "Synchronisierung über GitHub und Einrichtungsassistent"
summary: "Verschlüsselter Abgleich fast aller FORGE-Daten über das private Repo forge-data (Sync-Passwort, Drei-Wege, nur lokal, hart zurücksetzen, Versionen als Backup) und wann Assistent und Sync-Frage kommen. Wichtig bei neuen Einstellungen, Geheimnissen oder Projektfeldern."
tags: ["sync","github","verschluesselung","backup","einstellungen","einrichtung","stolperfalle"]
updated: "2026-10-14T15:15:01.103Z"
---

## Aufbau (Stand 2026-10-14)
- Sidecar: `packages/sidecar/src/sync/sync.ts` (`SyncService`), `sync/crypto.ts` (scrypt + AES-256-GCM), verdrahtet in `app.ts` (Start nur in der Desktop-App: `sync.start()` im `FORGE_APP_VERSION`-Block; Events über den `emit`-Fan-out `sync.onServerEvent`).
- Repo: `<login>/forge-data` (privat, legt FORGE selbst an; ein öffentliches wird abgelehnt). Eine Datei `forge-sync.json`: Klartext nur `updatedAt`, `device`, `appVersion`, `kdf` (Salt + scrypt-Parameter); alles andere steckt verschlüsselt in `box`. Items darin flach: `setting:<key>`, `git:identity`, `project:<schlüssel>`, `devtools:<schlüssel>`, `phone:config`, `secret:<name>`, `claude:<pfad unter ~/.claude>`, `mcp:<server>`.
- Zugriff nur über `gh api` (`GitHubService.repoInfo/createPrivateRepo/readRepoFile(ref?)/writeRepoFile/repoFileHistory`); FORGE sieht nie ein Token. Schreiben mit blob-sha; geändert in der Zwischenzeit -> `ForgeError CONFLICT` -> neu lesen und mergen (max. 3). Body per `--input` aus Temp-Datei.
- Zustand pro Rechner in `<dataDir>/sync/state.json` (nicht im Repo): `base`, `localKeys`, `localOnly`.

## Sync-Passwort
- Mindestens 12 Zeichen. Der daraus abgeleitete Schlüssel liegt DPAPI-verschlüsselt im SecretStore als `sync-key` (nicht das Passwort). Der Schlüssel darf nie ins Repo: sonst schützt die Verschlüsselung nichts.
- `sync.setPassphrase`: mit Daten auf GitHub muss es sie öffnen (GCM schlägt sonst fehl), sonst wird es das Passwort des Repos. Status `needs-passphrase`, wenn kein Schlüssel da ist oder der Salt nicht passt (auf anderem PC mit `sync.resetRemote` neu angefangen).
- `sync-key` geht nicht in lokale Backups und wird beim Telefon-Restore nicht gelöscht (`restoreEncrypted(files, keep)` in app.ts).
- Am Telefon bewusst nicht: Passwort eingeben und `resetRemote` (`NOT_ON_PHONE`).

## Was synchronisiert wird
- Einstellungen: alle außer `LOCAL_SETTINGS` (`claudePath`, `defaultProjectDir`, `setupDone`, `syncEnabled`, `syncAsked`). **Neue Einstellungen werden automatisch synchronisiert**; rechnerspezifische gehören in `LOCAL_SETTINGS`.
- Projekte (ohne Agent-Worktrees) mit Einstellungen und Dev-Tools (`dev_tools`-Zeile, inkl. Test-Umgebung). Schlüssel: `github.com/owner/repo`, sonst Remote-URL ohne Zugangsdaten, sonst `folder:<ordnername>`. Pfade gehen nie ins Repo.
- Telefon: `PhoneService.syncConfig()` ohne `enabled`, `desk.enabled`, `deskToken`, `pinGuard`, `callbacks` (zwei Registrierungen würden beide klingeln, Rückrufe doppelt). `applySyncConfig` verweigert während eines Anrufs; der Eintrag gilt dann als nicht übernommen und kommt beim nächsten Abgleich.
- Geheimnisse: jeder Name im SecretStore außer `sync-key` (SIP, OpenAI, Gemini, Tischtelefon).
- Claude: CLAUDE.md, settings.json, Textdateien in agents/commands/skills/rules/output-styles, MCP-Server aus `~/.claude.json` (pro Server gemergt, Rest der Datei bleibt). Aus dem Repo werden nur diese Pfade geschrieben (kein `..`, keine anderen Dateien wie `.credentials.json`).
- Nie: Chats, Anrufprotokolle, Projektdateien.

## Abgleich
- `mergeItems`: Drei-Wege pro Item gegen `base`; beide geändert -> Repo gewinnt; erster Abgleich (kein base) -> Repo gewinnt, nur lokal Vorhandenes kommt dazu.
- Fehlt ein Item hier, gilt es nur als hier gelöscht, wenn es in `localKeys` war. Projekte anderer PCs erscheinen in `status.available` („Holen“ klont in `defaultProjectDir`, übernimmt Einstellungen und Dev-Tools).
- Auf einem anderen PC entfernt: hier wird nichts gelöscht, das Item kommt in `localOnly` (`status.localOnly` mit Label und projectId). Entscheidung pro Eintrag: `sync.keep` (wieder abgleichen) oder `sync.forceLocal({key})` (hier entfernen; Projekte nur aus FORGE, Ordner bleibt).
- `sync.forceLocal()` ohne key: ganzer PC hart auf GitHub-Stand. Werte von GitHub überschreiben lokale; entfernt wird, was `localOnly` ist oder in `base` stand und auf GitHub fehlt. Neu hier Angelegtes bleibt und geht danach hoch. Legt vorher ein lokales Backup an. Am Telefon nur nach Tastatur-Code (wie Löschen).
- Nicht übernommene Items (Fehler, Telefon im Gespräch): in `base` bleibt der lokale Wert, damit der nächste Abgleich es erneut versucht und nicht den alten Wert hochschiebt.
- Auslöser: Start (3 s), alle 10 min, GitHub-Anmeldung fertig, von Hand. Nach `settings.updated`/`project.updated` prüft `scheduleCheck()` nach 1,5 s, ob sich Synchronisiertes geändert hat (`localChanged()`; viele Projekt-Events sind nur Git). Nur dann `status.pending = true` und Abgleich 10 s später.
- **Push nur bei Änderung:** Start, Intervall und „Jetzt abgleichen“ lesen nur (`account`, `repoInfo`, `readRepoFile`). Ein Commit entsteht nur, wenn `merged.result` vom entschlüsselten Repo-Stand abweicht (`sameItems` mit `stable()`, Schlüsselreihenfolge egal); der Chiffretext selbst wird nie verglichen (zufälliger IV). Wer neue synchronisierte Daten einführt, darf darin nichts haben, das sich von selbst ändert (Zeitstempel, Zähler, Laufzeitstatus wie `pinGuard`), sonst entsteht bei jedem Lauf ein Commit bzw. Pingpong zwischen PCs. Tests: „only writes when something changed“ und „does not write back and forth once two computers agree“ in `sync.test.ts`.
- Ein Lauf zur Zeit; `exclusive()` für setPassphrase/resetRemote/forceLocal/keep/restoreVersion.

## Backups und Versionen
- Lokale Backups bleiben unverändert (Telefon-Geheimnisse dort DPAPI-verschlüsselt, unabhängig von GitHub).
- Jeder Abgleich mit Änderung ist ein Commit. `sync.versions` = Commits von `forge-sync.json`, `sync.restoreVersion(sha, parts)` holt Teile (BackupPart -> Item-Arten, `PART_KINDS`) eines älteren Stands zurück, nach lokalem Sicherheits-Backup. Danach weichen sie von `base` ab und gehen mit dem nächsten Abgleich an alle PCs. Ältere Stände mit einem früheren Sync-Passwort lassen sich nicht öffnen.

## Oberfläche
- Einstellungen → **GitHub** (Section-Id `github`, `GitHubSection` in `views/SettingsView.tsx`): Konto (`GitHubSettings`), Synchronisierung mit Sync-Passwort, „Nur auf diesem PC“, Projekte von anderen PCs, Hart abgleichen (`SyncSettings.tsx`), Versionen auf GitHub (`GitHubVersions` aus `BackupSettings.tsx`). Alles Neue mit GitHub-Bezug gehört in diesen Reiter.
- Einstellungen → Backup: oben `GitHubBackupStatus` (ob auch auf GitHub gesichert, zuletzt wann, aktuell oder nicht).
- Kopfzeile: `components/layout/SyncButton.tsx` (blaue Wolke vor Pin und Telefon, in `Page.tsx` und zweimal in `WorkspaceHeader.tsx`), nur bei aktivem Sync; Farbe/Icon über `syncLook()`, Tooltip mit letztem Abgleich, Schreiber, Repo, nur lokal, zum Holen. Klick öffnet den GitHub-Reiter.
- Nur auf diesem PC: Wolken-Symbol an der Projektkarte (`LocalOnlyBadge`), Hinweis im Projekt (`LocalOnlyBanner`).

## Einrichtungsassistent und Sync-Frage (Desktop)
- `components/setup/SetupWizard.tsx`: öffnet sich, solange `settings.setupDone` false ist (oder `ui.setupWizard`, Palette „Einrichtungsassistent öffnen“). Schritte: Willkommen, Claude Code, GitHub + Sync (`SyncOffer` mit Sync-Passwort; vorausgewählt, wenn `sync.probe` Daten findet; `useEnableSync`: erst `sync.setPassphrase`, dann `syncEnabled`, dann `sync.now`), Grundlagen, Fertig.
- Migration in `db.ts`: Datenbanken mit Projekten, Sessions oder Einstellungen (außer `knownModels`) bekommen `setupDone = true`.
- `components/setup/SyncPrompt.tsx`: einmal für eingerichtete Installationen mit `syncAsked = false`.
- Tests: `packages/sidecar/test/sync.test.ts` (zwei simulierte PCs, `FakeGitHub` mit Commits und `writes`-Zähler, `kdfN: 1024` für schnelle Schlüssel), `apps/desktop/src/components/setup/SetupWizard.test.tsx`, `components/settings/SyncLocalOnly.test.tsx`, `components/layout/SyncButton.test.tsx`.
