---
title: "Demo-Instanz für Videos neben der installierten FORGE (.forge-demo, FORGE_DATA_DIR, WEBVIEW2_USER_DATA_FOLDER)"
summary: "Wie man die installierte FORGE ein zweites Mal mit eigenen Daten und Demo-Projekten startet und mit echter Aktivität befüllt, z. B. für Launch-Videos, und was sich beide Instanzen trotzdem teilen."
tags: ["release","tauri","windows","stolperfalle","preview"]
updated: "2026-10-20T11:16:45.807Z"
---

Angelegt 2026-10-20 für das Launch-Video (Aufnahme mit Cap).

## Aufbau
- Ordner `.forge-demo/` im Repo, nur lokal ignoriert über `.git/info/exclude` (nicht in .gitignore, nicht committen). Grund: Im Autonomous-Profil blockiert die FORGE-Policy `write-outside-project` Schreibzugriffe außerhalb des Projekts, also auch nach `C:\tmp`.
- `start-demo.ps1` / `FORGE Demo starten.cmd`: startet `%LOCALAPPDATA%\FORGE\forge-desktop.exe` mit `FORGE_DATA_DIR=.forge-demo\data` und `WEBVIEW2_USER_DATA_FOLDER=.forge-demo\webview`. Es gibt kein Single-Instance-Plugin, die zweite Instanz läuft parallel; der Sidecar erbt die Umgebung (sidecar.rs setzt nur zusätzliche Variablen).
- Skripte mit `%LOCALAPPDATA%\FORGE\runtime\node\node.exe` ausführen; sie starten den installierten Sidecar (nicht `packages/sidecar/dist`, sonst migriert eine neuere Version die DB) und sprechen JSON-Zeilen über stdio wie `packages/sidecar/test/e2e/client.ts`. Vorher die Demo-FORGE schließen, damit nicht zwei Sidecars dieselbe DB nutzen. Die eigene FORGE dabei nicht treffen: Prozess über die Elternkette der eigenen Shell ausschließen.
  - `seed.mjs`: `settings.update` (language en, setupDone/syncAsked/usageStatsAsked true, updateChecks/desktopNotifications/screenshotKey/learnTemplates false), importiert `projects/nimbus` und die Stubs aus `C:\tmp\demo\`.
  - `fill.mjs`: echte Sessions mit Modell `sonnet` (kostet Abo-Kontingent, Lauf ca. 15 min): nimbus Überblick + Wissenseintrag, Meta-Tags; orbit-api Validierung, eine Session startet per `start_agent` zwei Agenten (Pagination, DELETE) mit Auto-Merge, danach Review ohne Code. Profil während des Laufs `autonomous`, Freigaben beantwortet das Skript (AskUserQuestion: deny mit Hinweis), danach `balanced`.
  - `check.mjs`: gibt `reports.daily` des Tages aus.
- `projects/nimbus`: statische Landingpage ohne Abhängigkeiten (Port 4173) mit absichtlichem Fehler `.button.primary { color: var(--accent) }` (Text unsichtbar) für die Vorschau-Szene; fill.mjs lässt ihn bewusst stehen. `projects/orbit-api`: Node-API ohne Abhängigkeiten, `npm test` (node --test), Routen je Datei unter `src/routes/`, damit Agenten konfliktfrei parallel arbeiten. Git-Historie zurückdatiert (14. bis 19.10.).
- Tag `demo-start` in beiden Repos = Stand nach fill.mjs. `reset-nimbus.ps1` setzt nimbus darauf zurück und löscht Worktrees und Branches. Agenten-Worktrees liegen unter `projects/.forge-worktrees/`.

## Was beide Instanzen teilen
- `%APPDATA%\de.vanturis.forge\language` (Sprache der nativen Menüs, i18n.rs): eine englische Demo-Instanz überschreibt sie. start-demo.ps1 stellt den alten Wert nach dem Schließen wieder her.
- Claude-Anmeldung und Abo-Kontingent (`~/.claude`), `gh`-Anmeldung, globale Git-Identität.
- Druck-Taste: deshalb `screenshotKey` aus, sonst kollidiert der globale Shortcut.
- Beide Fenster heißen "FORGE": bei Cap Bildschirm aufnehmen und die normale Instanz minimieren.

## Tagesbericht
Füllt sich nur mit echter Aktivität des Tages (claude_usage, Commits, agent_log). Die 14-Tage-Säulen zeigen deshalb nur heute; zurückdatierte Commits zählen nicht als Arbeitszeit. Agenten-Sessions verschwinden nach dem Merge aus der Session-Liste, bleiben aber im Bericht.

## Agenten-Szene ohne Merge-Konflikte
Alle Agenten in nimbus ändern `index.html`. Sie dürfen nur an weit auseinanderliegenden Stellen einfügen (nach Hero, nach Features, nach Pricing) und ihr CSS in einem `<style>` im eigenen Abschnitt halten. Neue `<link>`-Zeilen im head von mehreren Agenten oder ein Footer direkt neben einem Abschnitt vor `</main>` führen zu Konflikten beim Auto-Merge.
