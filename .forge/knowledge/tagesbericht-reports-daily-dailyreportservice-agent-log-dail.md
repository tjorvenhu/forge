---
title: "Tagesbericht (reports.daily, DailyReportService, agent_log, claude_usage, Diagramme)"
summary: "Wie der Tagesbericht Sessions, Agenten, Commits, Offenes, Anrufe, Tokens, Arbeitszeit und den Anteil von FORGE sammelt, warum es agent_log, claude_usage und den Reflog-Rückgriff gibt, warum Cache-Lesen getrennt steht."
tags: ["sidecar","agenten","git","telefon","forge-tools","ui","tokens","stolperfalle"]
updated: "2026-10-22T08:08:25.790Z"
---

Stand 2026-10-16, Texte seit 2026-10-18 zweisprachig.

## Sidecar
- `packages/sidecar/src/reports/daily-report.ts`: `DailyReportService.build({ date?, projectId? })`, `summarize(...)`, `reportText(report, { ref })` für Claude/Telefon. RPC `reports.daily` und `reports.dailySummary` (Telefon: Werkzeug `sessions`, Aktion `day_report` mit `days_back` und `summary`). Lokaler Tag, Ende exklusiv.
- Mit `projectId` gilt das Hauptprojekt samt seinen Worktrees. Anrufe nur bei „alle Projekte“ (`calls: null` sonst).
- Sessions des Tages: Es gibt keinen Index auf `events.ts`; vorgefiltert wird über `sessions.updated_at >= from AND created_at < to` (jeder Durchlauf endet mit Statuswechsel, der updated_at setzt), dann pro Session Aggregat über den PK-Index.
- „Jetzt offen“ ist der aktuelle Stand, nicht der am Tagesende.
- Repositorys (`reposToAsk`): ein Projekt ohne Session am Tag nur, wenn `headMovedSince` (mtime von `.git/logs/HEAD`) nicht `false` sagt: so kein git-Prozess pro untätigem Projekt.
- Commits: `GitEngine.logBetween` mit `--since/--until` im Format `YYYY-MM-DD HH:MM:SS +0000`, weil git ISO mit Millisekunden unzuverlässig liest; `-- .` begrenzt auf den Projektordner im Monorepo.

## Tokens und Arbeitszeit (claude_usage, Migrationen 17 bis 19)
- Warum eine eigene Tabelle: Events einer Session gehen mit ihr, die eines Agenten also beim Merge. `claude_usage` hat keine Fremdschlüssel und bleibt. Agenten-Arbeit vor 2026-10-16 ~23 Uhr ist verloren.
- Schreiben: `Db.appendEvent` legt bei `turn.result` eine Zeile `kind = session` an. Aufrufe außerhalb von Sessions über `tokenMeter.onResult` in app.ts (`complete:<purpose>` = assist, `phone` = phone). Neue SDK-Abfragen mit Tokens müssen über `meterKey(...)` in den TokenMeter, sonst fehlen sie auch hier.
- Das SDK meldet `usage` im `result` pro Durchlauf (nicht kumuliert), summiert über alle API-Anfragen des Durchlaufs.
- **Stolperfalle Cache-Lesen:** `cache_read_input_tokens` ist bei jeder Anfrage der ganze bisherige Kontext. Ein Durchlauf mit 87 Anfragen bei ~184 Tsd. Kontext hat 16 Mio. Cache-Lesen; über einen Tag 72 Mio., 99 % der Summe, der Nutzer hielt das für einen Fehler. Deshalb: „Tokens“ = neue Tokens (Eingabe + Ausgabe + Cache schreiben, `tokensOf` in usage-stats.ts). Cache-Lesen steht getrennt als „Kontext aus dem Cache“ mit Ø je Anfrage.
- Token-Summen bei „alle Projekte“ enthalten auch Aufrufe außerhalb von Sessions; Durchläufe, Arbeitszeit und Parallelität nur Sessions.
- `reports/usage-stats.ts` (rein, `test/usage-stats.test.ts`): Ein Aufruf läuft von `ts - duration_ms` bis `ts`; Arbeitszeit wird auf Tag/Stunde zugeschnitten, Tokens zählen am Ende. `workMs` = Summe (parallele doppelt), `activeMs` = Uhrzeit mit mindestens einem Durchlauf.
- `formatDuration` / `formatTokens` / `forgeUsageLabel()` liegen in `packages/protocol/src/format.ts` (Desktop und Sidecar/Telefon gleich, Sprache über `pick`). `formatTokens` endet auf Deutsch auf „Tsd.“/„Mio.“: im Satz danach kein Punkt, sondern ein Wort („16 Tsd. Tokens.“).

## Was FORGE selbst verbraucht (usage.forge, purpose)
- `ForgeUsagePurpose` (`packages/protocol/src/models.ts`): `auto` = Session-Durchläufe, deren Nachricht FORGE geschickt hat (user.message `source: "auto"`: Weitermachen nach Limit, Neustart nach Update, /compact der Kontext-Rettung, Konflikte an Agenten), dazu die Hilfsaufrufe. NULL = eigener Durchlauf des Nutzers.
- `runtime.complete/completeJson` nehmen `purpose` in `CompleteOptions`; neue Hilfsaufrufe brauchen einen `purpose`, sonst landen sie unter „Sonstiges“.
- Für ein einzelnes Projekt zählt nur `auto` (Hilfsaufrufe tragen kein Projekt).

## Warum agent_log (Migration 15)
Nach Zusammenführen/Verwerfen sind Worktree-Projekt und Sessions des Agenten gelöscht. `AgentFinisher.finish` schreibt deshalb vorher einen Schnappschuss und danach das Ergebnis (merged/discarded/conflict/waiting) in `agent_log`, beim Merge mit den Commits nach dem Rebase. `AgentAutoMerge` schreibt `skipped`. Gleiches Ergebnis direkt hintereinander ergibt keine neue Zeile. Der Bericht ordnet über diese Hashes Commits einem Agenten zu (14 Tage zurück).

## Stolperfalle: „0 zusammengeführt“, obwohl Agenten gemergt wurden
Merges von Hand oder aus einem Build vor agent_log stehen nicht in agent_log. Rückgriff: `GitEngine.mergesBetween(cwd, from, to, "agent/")` liest den Reflog von HEAD (`git log -g --date=unix`, `%gd` ist dann `HEAD@{<unix>}`) und nimmt Einträge `merge refs/heads/agent/<x>: Fast-forward` (FORGE merged mit `--ff-only`). Commits = `<vorheriger Reflog-Eintrag>..<hash>`. agent_log-Zuordnungen überschreiben die aus dem Reflog. Grenze: Der Reflog verfällt (gc, Standard 90 Tage) und gilt nur für den Ordner, in dem gemergt wurde.

## Anbindung
- MCP-Werkzeug `daily_report` (autoAllow), Zusammenfassung über `ClaudeAssist.summarizeDailyReport` (Bericht vorher durch `redactText`).
- Desktop: `views/ReportView.tsx`, Diagramme in `components/report/usage-charts.tsx`, ohne Bibliothek als HTML-Säulen. Andere Tage/Projekte halten den alten Bericht gedimmt (`keepPreviousData`) statt Skeleton.
- Farben: `--color-accent` liegt für dunkle Flächen über dem Helligkeitsband des dataviz-Validators, deshalb `accent-strong` für Werte und `tile-blue` für „neu gelesen“.
- Server-Events `session.done` und `agent.autoMerge` invalidieren `["report"]`, heute zusätzlich alle 60 s.

## Vorschau im Browser
Am schnellsten ohne Tauri-Mock: temporäre Seite in `apps/desktop/.preview-report/` rendert `ReportView` mit vorbefülltem `queryClient` (`staleTime: Infinity`, `setQueryData(keys.report(date, null), report)` und `keys.projects`). Echte Daten: Live-DB nur lesend als Kopie ziehen (`new DatabaseSync(file, { readOnly: true }).exec("VACUUM INTO '<kopie>'")`), darauf `DailyReportService.build()` per `pnpm exec tsx <skript>.mts` (Top-Level-await braucht .mts). Vite mit freiem Port und `--strictPort`; danach TaskStop und Port prüfen, Dateien löschen.
