---
title: "Demo-Instanz für Videos neben der installierten FORGE (.forge-demo, FORGE_DATA_DIR, WEBVIEW2_USER_DATA_FOLDER)"
summary: "Wie man die installierte FORGE ein zweites Mal mit eigenen Daten und Demo-Projekten startet, z. B. für Launch-Videos, und was sich beide Instanzen trotzdem teilen."
tags: ["release","tauri","windows","stolperfalle","preview"]
updated: "2026-10-20T11:03:33.402Z"
---

Angelegt 2026-10-20 für das Launch-Video (Aufnahme mit Cap).

## Aufbau
- Ordner `.forge-demo/` im Repo, nur lokal ignoriert über `.git/info/exclude` (nicht in .gitignore, nicht committen). Grund: Im Autonomous-Profil blockiert die FORGE-Policy `write-outside-project` Schreibzugriffe außerhalb des Projekts, also auch nach `C:\tmp`.
- `start-demo.ps1` / `FORGE Demo starten.cmd`: startet `%LOCALAPPDATA%\FORGE\forge-desktop.exe` mit `FORGE_DATA_DIR=.forge-demo\data` und `WEBVIEW2_USER_DATA_FOLDER=.forge-demo\webview`. Es gibt kein Single-Instance-Plugin, die zweite Instanz läuft parallel; der Sidecar erbt die Umgebung (sidecar.rs setzt nur zusätzliche Variablen).
- `seed.mjs` (mit `runtime\node\node.exe` ausführen): startet den installierten Sidecar (nicht `packages/sidecar/dist`, sonst migriert eine neuere Version die DB) und setzt per RPC `settings.update` (language en, setupDone/syncAsked/usageStatsAsked true, updateChecks/desktopNotifications/screenshotKey/learnTemplates false), importiert `projects/nimbus` (Tags auto-commit, auto-merge, devCommand `npm run dev`) und die Stubs aus `C:\tmp\demo\`.
- `projects/nimbus`: statische Landingpage ohne Abhängigkeiten (`node server.mjs`, Port 4173) mit absichtlichem Fehler `.button.primary { color: var(--accent) }` (Text unsichtbar) für die Vorschau-Szene. `reset-nimbus.ps1` setzt auf den ersten Commit zurück und löscht Worktrees und Branches.

## Was beide Instanzen teilen
- `%APPDATA%\de.vanturis.forge\language` (Sprache der nativen Menüs, i18n.rs): eine englische Demo-Instanz überschreibt sie. start-demo.ps1 stellt den alten Wert nach dem Schließen wieder her.
- Claude-Anmeldung und Abo-Kontingent (`~/.claude`), `gh`-Anmeldung, globale Git-Identität.
- Druck-Taste: deshalb `screenshotKey` aus, sonst kollidiert der globale Shortcut.
- Beide Fenster heißen "FORGE": bei Cap Bildschirm aufnehmen und die normale Instanz minimieren.

## Agenten-Szene ohne Merge-Konflikte
Alle Agenten ändern `index.html`. Sie dürfen nur an weit auseinanderliegenden Stellen einfügen (nach Hero, nach Features, nach Pricing) und ihr CSS in einem `<style>` im eigenen Abschnitt halten. Neue `<link>`-Zeilen im head von mehreren Agenten oder ein Footer direkt neben einem Abschnitt vor `</main>` führen zu Konflikten beim Auto-Merge.
