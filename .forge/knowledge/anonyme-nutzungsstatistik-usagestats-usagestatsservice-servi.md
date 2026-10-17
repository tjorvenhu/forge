---
title: "Anonyme Nutzungsstatistik und Token-Erfassung (usageStats, modelUsage, services/stats)"
summary: "Wie FORGE Tokens erfasst (modelUsage statt usage), welche Summen anonym an forge-stats.vanturis.de gehen, wie Zustimmung und Abschalten laufen; nötig vor Änderungen an Token-Zählung, Zählern oder dem Dienst."
tags: ["sidecar","tokens","sdk","stolperfalle","einstellungen","telefon"]
updated: "2026-10-17T23:24:58.814Z"
---

## Token-Erfassung: modelUsage, nicht usage (Stolperfalle, behoben 2026-10-18)
- Im Ergebnis der Agent SDK ist `usage` **nur die Hauptschleife** (ohne Task-Subagenten, Nebenläufe, Komprimierung). Vollständig ist `modelUsage` (pro Modell, inkl. `costUSD`). Vorher zählte FORGE nur `usage`: Subagenten-Tokens fehlten in Tagesbericht, Nutzungsanzeige und Statistik. Alte `claude_usage`-Zeilen bleiben so (nicht nachrechenbar).
- `modelUsage` ist **kumulativ über die Durchläufe eines Claude-Prozesses**. `normalize.ts` legt es als `turn.result.models` ins Ereignis; `Db.appendEvent` bildet die Differenz zum letzten `turn.result` derselben Session mit Tokens (`lastModelTotals`, überspringt abgestürzte Läufe mit Nullen) über `modelDelta`: sinkt der Stand eines Modells (neuer Prozess ohne gespeicherte Summen, `/clear`), zählt der neue Wert ganz. Fortgesetzte Sessions bringen ihre gespeicherten Summen mit, die Differenz stimmt dann.
- `claude_usage` hat dafür `models` (JSON je Modell, Delta des Durchlaufs) und `cost_usd`. Einmal-Aufrufe (`recordClaudeUsage`, Titel, Commit-Nachrichten, Telefon) nehmen `modelUsage` direkt, dort ist es die Summe der Abfrage.
- Tests: `packages/sidecar/test/usage-stats.test.ts` (Subagent-Modell, Absturz, neuer Prozess, Kosten).

## Statistik (Entscheidungen 2026-10-17, vom Besitzer)
- Eigener Dienst unter `https://forge-stats.vanturis.de` (`USAGE_STATS_URL` in `packages/protocol/src/support.ts`), Code in `services/stats` (Next.js + Postgres per docker-compose, nicht im pnpm-Workspace, von ESLint und release.yml ausgenommen). Vor Coolify steht ein HAProxy, der TLS beendet: Domain in Coolify mit `http://…:3000`, Client-IP über `CLIENT_IP_HEADER`.
- Zustimmung: einmal fragen (`UsageStatsPrompt`), ohne Antwort an (`usageStats` Standard true), auch nach Updates. `usageStatsAsked` merkt die Antwort.
- Senden **alle 5 Minuten**; der Dienst nimmt höchstens eine Meldung je Installation alle 4 Minuten an. Beide Werte zusammen ändern.
- Gesamtzahlen öffentlich auf der Startseite des Dienstes (im Stil der App, mit Diagrammen, Impressum von Vanturis). Das README-Badge „Downloads“ zählt nur Installer über `GET /api/v1/downloads` des Dienstes.

## Client (`packages/sidecar/src/stats/usage-stats.ts`)
- Nur in der installierten App (`FORGE_RUNTIME_DIR`). Tick jede Minute, Versand wenn der letzte mindestens 5 Minuten her ist: `POST /api/v1/report` mit kumulativen `counters` und `models` ({ Modell-ID: { tokens, costUsdCents } }, höchstens 20). Aus und schon gesendet: einmal `DELETE`. 429 gilt als gesendet.
- Installations-ID in `<dataDir>/usage-stats.json`, bewusst nicht in den Einstellungen (Backup und Sync würden sie auf andere PCs kopieren).
- `Db.usageTotals()`: Tokens, Durchläufe, Arbeitszeit, Sessions aus `claude_usage`; `userTurns` = Session-Durchläufe ohne `purpose`; `costUsdCents` und `models` nur aus Zeilen mit `modelUsage`; Projekte aus `stats_counters.projectsCreated` (nicht für Worktrees und Backup-Restore); gestartete Agenten = `agent_log` ∪ vorhandene Worktree-Projekte (laufende zählen mit), zusammengeführte aus `agent_log`.
- Neuer Zähler: `UsageTotals` + `usageTotals()`, im Dienst (Whitelist, Obergrenzen, Seite), Texte in `UsageStatsPrompt`, Datenschutz in `SettingsView`, README und `docs/SECURITY.md`.

## Überall angebunden
Einstellungen > Über FORGE > Datenschutz, Befehlspalette, Tagesbericht (Knopf „FORGE gesamt“), Telefon `forge_settings usage_stats`, Unterstützen-Dialog hinter dem roten Herz neben der Suche.
