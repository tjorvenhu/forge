---
title: "Demo-Instanz für Videos neben der installierten FORGE (.forge-demo, FORGE_DATA_DIR, WEBVIEW2_USER_DATA_FOLDER)"
summary: "Wie man die installierte FORGE ein zweites Mal mit eigenen Daten und Demo-Projekten startet, befüllt und nach einer Aufnahme zurücksetzt, und was sich beide Instanzen trotzdem teilen."
tags: ["release","tauri","windows","stolperfalle","preview","agenten"]
updated: "2026-10-20T11:49:53.762Z"
---

Angelegt 2026-10-20 für das Launch-Video (Aufnahme mit Cap, der Nutzer nimmt selbst auf).

## Aufbau
- Ordner `.forge-demo/` im Repo, nur lokal ignoriert über `.git/info/exclude` (nicht in .gitignore, nicht committen). Grund: Im Autonomous-Profil blockiert die FORGE-Policy `write-outside-project` Schreibzugriffe außerhalb des Projekts, also auch nach `C:\tmp`.
- `start-demo.ps1` / `FORGE Demo starten.cmd`: startet `%LOCALAPPDATA%\FORGE\forge-desktop.exe` mit `FORGE_DATA_DIR=.forge-demo\data` und `WEBVIEW2_USER_DATA_FOLDER=.forge-demo\webview`. Es gibt kein Single-Instance-Plugin, die zweite Instanz läuft parallel; der Sidecar erbt die Umgebung.
- Skripte mit `%LOCALAPPDATA%\FORGE\runtime\node\node.exe` ausführen; sie starten den installierten Sidecar (nicht `packages/sidecar/dist`, sonst migriert eine neuere Version die DB) und sprechen JSON-Zeilen über stdio wie `packages/sidecar/test/e2e/client.ts`. Vorher die Demo-FORGE schließen, damit nicht zwei Sidecars dieselbe DB nutzen. Die eigene FORGE dabei nicht treffen (Prozess-ID der Demo steht in `demo/pid.txt`).
  - `seed.mjs`: Einstellungen (language en, setupDone/syncAsked/usageStatsAsked true, updateChecks/desktopNotifications/screenshotKey/learnTemplates false) und Import der Projekte.
  - `fill.mjs`: echte Sessions mit Modell `sonnet` (ca. 15 min), am Ende `sessions.close`, sonst stehen sie nach dem Beenden des Sidecars auf "Interrupted" (`shutdown` in sessions/lifecycle.ts).
  - `demo/reset-take.ps1`: nach einer Aufnahme: schließt die Demo, verwirft Agenten (`agents.finish` discard), löscht Sessions, die nicht in `demo/keep.json` stehen, setzt nimbus auf `refs/demo/start` (eigene Ref statt Tag, damit sie im Git-Reiter nicht auftaucht), startet die Demo neu.
- Demo-Projekte haben eine `CLAUDE.md` mit "Always answer in English": sonst antwortet Claude wegen der deutschen globalen `~/.claude/CLAUDE.md` auf Deutsch.
- `projects/nimbus`: statische Landingpage (Port 4173) mit absichtlichem Fehler `.button.primary { color: var(--accent) }` (Text unsichtbar). Opus findet und behebt ihn in ca. 30 s inklusive Vorher/Nachher-Bild. `projects/orbit-api`: Node-API, `npm test`, Routen je Datei, damit Agenten konfliktfrei parallel arbeiten.

## Stolperfalle: Agenten bekommen das globale Standardprofil
Worktree-Projekte von Agenten bekommen bei `projects.import` `defaultProfile()` aus den Einstellungen, nicht das Profil des Hauptprojekts (projects/project-manager.ts). In "Balanced" hängen Agenten dann an Freigaben (z. B. `mcp__forge__dev_control`), die in einem Video niemand bestätigt. Demo: `defaultProfile: autonomous`, nimbus selbst `balanced` (zeigt Freigabe-Karten für start_agent).

## Was beide Instanzen teilen
- `%APPDATA%\de.vanturis.forge\language` (Sprache der nativen Menüs, i18n.rs): start-demo.ps1 stellt den alten Wert nach dem Schließen wieder her.
- Claude-Anmeldung und Abo-Kontingent, `gh`-Anmeldung, globale Git-Identität.
- Druck-Taste: deshalb `screenshotKey` aus.
- Beide Fenster heißen "FORGE": bei Cap Bildschirm aufnehmen und die normale Instanz minimieren.

## Fernsteuerung (verworfen)
Per `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` lässt sich die WebView über CDP steuern und screenshotten; Reiter (Radix) reagieren nur auf echte Mausereignisse (`Input.dispatchMouseEvent`), nicht auf `el.click()`. Der Nutzer wollte das Video lieber selbst aufnehmen.

## Tagesbericht
Füllt sich nur mit echter Aktivität des Tages. Die 14-Tage-Säulen zeigen deshalb nur heute.
