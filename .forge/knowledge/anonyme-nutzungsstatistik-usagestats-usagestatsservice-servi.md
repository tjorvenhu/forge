---
title: "Anonyme Nutzungsstatistik und Token-Erfassung (usageStats, modelUsage, services/stats)"
summary: "Wie FORGE Tokens erfasst (modelUsage statt usage), welche Summen (ab Stichtag 17.10.2026) und welches Abo anonym an forge-stats.vanturis.de gehen, wie Zustimmung und Abschalten laufen; nötig vor Änderungen an Token-Zählung, Zählern oder dem Dienst."
tags: ["sidecar","tokens","sdk","stolperfalle","einstellungen","telefon"]
updated: "2026-10-18T10:11:05.833Z"
---

## Token-Erfassung: modelUsage, nicht usage (Stolperfalle, behoben 2026-10-18)
- Im Ergebnis der Agent SDK ist `usage` **nur die Hauptschleife** (ohne Task-Subagenten, Nebenläufe, Komprimierung). Vollständig ist `modelUsage` (pro Modell, inkl. `costUSD`). Vorher zählte FORGE nur `usage`: Subagenten-Tokens fehlten in Tagesbericht, Nutzungsanzeige und Statistik. Alte `claude_usage`-Zeilen bleiben so (nicht nachrechenbar, die alten `turn.result`-Ereignisse haben kein `models`).
- `modelUsage` ist **kumulativ über die Durchläufe eines Claude-Prozesses**. `normalize.ts` legt es als `turn.result.models` ins Ereignis; `Db.appendEvent` bildet die Differenz zum letzten `turn.result` derselben Session mit Tokens (`lastModelTotals`, überspringt abgestürzte Läufe mit Nullen) über `modelDelta`: sinkt der Stand eines Modells (neuer Prozess ohne gespeicherte Summen, `/clear`), zählt der neue Wert ganz. Fortgesetzte Sessions bringen ihre gespeicherten Summen mit, die Differenz stimmt dann.
- `claude_usage` hat dafür `models` (JSON je Modell, Delta des Durchlaufs) und `cost_usd`. Einmal-Aufrufe (`recordClaudeUsage`, Titel, Commit-Nachrichten, Telefon) nehmen `modelUsage` direkt, dort ist es die Summe der Abfrage.
- Modell-IDs mit `[1m]` (1M-Kontext, z. B. `claude-opus-5-5[1m]`) kommen so aus dem SDK, wenn ein Nutzer das 1M-Modell gewählt hat. Die App schickt sie roh, die Statistikseite fasst sie zusammen.
- Tests: `packages/sidecar/test/usage-stats.test.ts` (Subagent-Modell, Absturz, neuer Prozess, Kosten, Stichtag, Modell-Filter, `readPlan`).

## Statistik (Entscheidungen 2026-10-17/18, vom Besitzer)
- Eigener Dienst unter `https://forge-stats.vanturis.de` (`USAGE_STATS_URL` in `packages/protocol/src/support.ts`), Code in `services/stats` (Next.js + Postgres per docker-compose, nicht im pnpm-Workspace, von ESLint und release.yml ausgenommen). Vor Coolify steht ein HAProxy, der TLS beendet: Domain in Coolify mit `http://…:3000`, Client-IP über `CLIENT_IP_HEADER`. Der Dienst wird nicht automatisch deployt: nach Änderungen in Coolify neu deployen.
- **Stichtag**: gezählt wird ab `USAGE_STATS_SINCE` = 2026-10-17T00:00Z (Veröffentlichung mit v0.1.81) in `persistence/db.ts`. Alles davor war Entwicklung/Test. `usageTotals(since)` filtert `claude_usage.ts`, `phone_calls.started_at`, `agent_log` (`COALESCE(started_at, ts)`, merged über `ts`) und Worktree-Projekte über `created_at`; eine Migration setzt `stats_counters.projectsCreated` auf die Hauptprojekte seit dem Stichtag. Installationen mit älterer App melden noch den Stand seit Installation; nach dem Update sinken ihre Zähler einmal (der Dienst wertet den Rückgang als 0 Zuwachs).
- Zustimmung: einmal fragen (`UsageStatsPrompt`), ohne Antwort an (`usageStats` Standard true), auch nach Updates. `usageStatsAsked` merkt die Antwort.
- Senden **alle 5 Minuten**; der Dienst nimmt höchstens eine Meldung je Installation alle 4 Minuten an. Beide Werte zusammen ändern.
- Gesamtzahlen öffentlich auf der Startseite des Dienstes (im Stil der App, mit Diagrammen, Impressum von Vanturis). Das README-Badge „Downloads“ zählt nur Installer über `GET /api/v1/downloads` des Dienstes.

## Client (`packages/sidecar/src/stats/usage-stats.ts`)
- Nur in der installierten App (`FORGE_RUNTIME_DIR`). Tick jede Minute, Versand wenn der letzte mindestens 5 Minuten her ist: `POST /api/v1/report` mit kumulativen `counters`, `models` ({ Modell-ID: { tokens, costUsdCents } }) und `plan`. Aus und schon gesendet: einmal `DELETE`. 429 gilt als gesendet.
- `models`: nur IDs, die das Muster des Dienstes erfüllen (`MODEL_ID`), die 20 mit den meisten Tokens. Grund: eine ungültige ID (z. B. `<synthetic>`) ließe den Dienst die ganze Meldung mit 400 ablehnen, und zwar bei jedem Versuch. Kosten je Modell werden erst am Ende auf Cent gerundet.
- `plan` (seit 2026-10-18) kommt aus `readPlan()` in `claude/diagnostics.ts`: `oauthAccount.organizationType` (`claude_max` → `max`) plus Multiplikator aus `userRateLimitTier ?? organizationRateLimitTier` (`default_claude_max_20x` → `max_20x`), null ohne claude.ai-Anmeldung. Bewusst aus `.claude.json` statt `claude auth status`: kein Prozess alle 5 Minuten, keine E-Mail/Org-Namen.
- Installations-ID in `<dataDir>/usage-stats.json`, bewusst nicht in den Einstellungen (Backup und Sync würden sie auf andere PCs kopieren).
- `Db.usageTotals()`: Tokens, Durchläufe, Arbeitszeit, Sessions aus `claude_usage`; `userTurns` = Session-Durchläufe ohne `purpose`; `costUsdCents` und `models` nur aus Zeilen mit `modelUsage`; Projekte aus `stats_counters.projectsCreated` (nicht für Worktrees und Backup-Restore); gestartete Agenten = `agent_log` ∪ vorhandene Worktree-Projekte (laufende zählen mit), zusammengeführte aus `agent_log`. Alles ab Stichtag.
- Prüfen mit echten Daten: Kopie von `%APPDATA%\forge\forge.db` plus `-wal` in einen Temp-Ordner, `new Db(kopie).usageTotals()` in einer temporären Vitest-Datei; Ausgabe in eine Datei schreiben (console.log erscheint im Vitest-Lauf nicht).
- Neuer Zähler oder neues Feld: `UsageTotals` + `usageTotals()` (mit Stichtag-Filter) bzw. Dep in `UsageStatsDeps`, im Dienst (Schema in `report.ts`, Obergrenzen, Spalte, Seite), Texte in `UsageStatsPrompt`, Datenschutz in `SettingsView`, README, `services/stats/README.md`, „Was erfasst wird“ auf der Seite und `docs/SECURITY.md`.

## Überall angebunden
Einstellungen > Über FORGE > Datenschutz, Befehlspalette, Tagesbericht (Knopf „FORGE gesamt“), Telefon `forge_settings usage_stats`, Unterstützen-Dialog hinter dem roten Herz neben der Suche.
