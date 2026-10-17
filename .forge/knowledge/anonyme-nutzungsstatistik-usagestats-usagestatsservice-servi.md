---
title: "Anonyme Nutzungsstatistik (usageStats, UsageStatsService, services/stats, forge-stats.vanturis.de)"
summary: "Wie FORGE anonyme Summen an den eigenen Statistik-Dienst schickt, welche Zähler es gibt, wie Zustimmung und Abschalten laufen und wo der Server liegt; nötig, bevor man Zähler ergänzt oder den Dienst ändert."
tags: ["sidecar","einstellungen","telefon","konvention","stolperfalle"]
updated: "2026-10-17T20:02:07.509Z"
---

## Entscheidungen (2026-10-17, vom Besitzer)
- Eigener Dienst in Coolify unter `https://forge-stats.vanturis.de` (`USAGE_STATS_URL` in `packages/protocol/src/support.ts`), Code in `services/stats` (Next.js + Postgres, nicht im pnpm-Workspace, von ESLint und release.yml ausgenommen).
- Zustimmung: FORGE fragt einmal (`UsageStatsPrompt`, nach Einrichtungsassistent und Sync-Frage). Ohne Antwort an (`usageStats` Standard true), auch für Installationen, die per Update kommen. `usageStatsAsked` merkt die Antwort; „Später“/Schließen fragt beim nächsten Start wieder.
- Gesamtzahlen sind öffentlich (Startseite des Dienstes).

## Client (`packages/sidecar/src/stats/usage-stats.ts`)
- Nur in der installierten App (`FORGE_RUNTIME_DIR`), sonst würden Dev-Zahlen die echten verfälschen.
- Stündlicher Tick: an und letzter Versand > 24 h her: `POST /api/v1/report` mit kumulativen Zählern (nie Differenzen). Aus und schon gesendet: einmal `DELETE /api/v1/report/<id>`. 429 gilt als gesendet. Nach Fehler 15 Minuten Pause.
- Installations-ID und letzter Versand in `<dataDir>/usage-stats.json`, bewusst nicht in den Einstellungen: Backup und Sync kopieren die auf andere PCs, dann hätten zwei Rechner dieselbe ID und überschrieben sich.
- Zähler aus `Db.usageTotals()`: nur aus Tabellen, die Löschungen überleben (`claude_usage`, `agent_log`, `phone_calls`). Projekte zählt `stats_counters.projectsCreated` (Migration startet mit den vorhandenen Hauptprojekten); `insertProject` erhöht ihn, außer für Agenten-Worktrees (`parentId`) und Backup-Restore (`restored`).
- Neuen Zähler ergänzen: `UsageTotals` + `usageTotals()`, im Dienst (Whitelist und Obergrenzen) und auf seiner Seite, Texte in `UsageStatsPrompt`, Datenschutz-Abschnitt in `SettingsView` und README.

## Überall angebunden
Einstellungen > Über FORGE > Datenschutz (Schalter setzt auch `usageStatsAsked`), Befehlspalette (Schalter + „Gesamtzahlen aller FORGE-Nutzer ansehen“), Telefon `forge_settings usage_stats`, Unterstützen-Seite (Link zur Statistik).
