---
title: "Update ohne Session-Verlust: Sessions über den Neustart retten"
summary: "Wie FORGE beim Installieren eines Updates offene Claude-Sessions merkt und nach dem Neustart fortsetzt, und was man bei Änderungen am Update- oder Shutdown-Ablauf beachten muss."
tags: ["update","sessions","neustart","sidecar","stolperfalle"]
updated: "2026-10-13T14:29:48.567Z"
---

Details und Begründung: ADR 0013, Abschnitt „Nachtrag 2026-10-13: Sessions überstehen das Update“.

## Warum nicht einfach weiterlaufen lassen
Die CLI-Prozesse hängen per stdio am Sidecar; Freigaben (`canUseTool`), die Sperrliste (PreToolUse-Hook) und die FORGE-Werkzeuge (In-Process-MCP) laufen im Sidecar. Ein neuer Sidecar kann das nicht übernehmen. Darum: anhalten, merken, nach dem Start per `resume` fortsetzen.

## Ablauf
- UI: `apps/desktop/src/lib/app-install.ts` `installUpdate(qc)`. Reihenfolge ist wichtig: Download, dann `app.prepareInstall`, dann `invoke("install_update")`. Scheitert `invoke`, ruft es `app.prepareInstall { cancel: true }`. Einziger Weg zum Installieren; Dialog, Seitenleisten-Karte, Befehlspalette und das Ereignis `update.install` (Telefon) nutzen ihn.
- Sidecar: `packages/sidecar/src/sessions/update-resume.ts`. `prepare(true)` gilt 2 Minuten. `SessionService.shutdown()` ruft `noteShutdown()` **vor** `lifecycle.shutdown()` (danach ist `core.live` leer) und nach dem Drain in `app.ts`, damit nur wirklich noch laufende Durchläufe als `working` gelten.
- Tabelle `update_resume` (Migration in `persistence/db.ts`). Beim Start nach 3 s: ruhende Sessions ohne Prompt öffnen, arbeitende mit Ereignis `app.updated` und `UPDATE_CONTINUE_PROMPT` als `source: "auto"`. Marken älter als 30 Minuten verfallen.
- Zweistufiges Update: `AppUpdateService.holdsResume()` hält die Sessions zurück, solange der zweite Schritt sich selbst installieren könnte.
- Chat-Fenster: Session-IDs in `localStorage` (`forge.reopenChatWindows`), `reopenChatWindows()` in `Shell` (App.tsx).

## Stolperfallen
- Tests: Die Marken bekommen ihren Zeitstempel aus der injizierten Uhr der `SessionService`, nicht aus `now()` in db.ts, sonst passt der Altersvergleich mit Test-Uhr nicht.
- `FORGE_APP_VERSION` ist gesetzt, wenn Tests aus einer FORGE-Session laufen; Erwartungen zu Versionen aus der Umgebung lesen.
- Das Fortsetzen läuft über `automation.track`, Tests warten mit `svc.drain()` darauf (`git status` in `captureBaseline` ist echte I/O).
- Nicht abgedeckt: Terminals im unteren Panel, Dev-Server und laufende Anrufe überstehen das Update nicht.

E2E: „keeps a working session going through a restart for an update“ in `test/e2e/real-claude.e2e.test.ts`.
