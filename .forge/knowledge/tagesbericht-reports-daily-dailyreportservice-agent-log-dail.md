---
title: "Tagesbericht (reports.daily, DailyReportService, agent_log, claude_usage, Diagramme)"
summary: "Wie der Tagesbericht Sessions, Agenten, Commits, Offenes, Anrufe, Tokens, Arbeitszeit und den Anteil von FORGE sammelt, warum es agent_log, claude_usage und den Reflog-Rückgriff gibt, warum Cache-Lesen getrennt steht."
tags: ["sidecar","agenten","git","telefon","forge-tools","ui","tokens","stolperfalle"]
updated: "2026-10-17T11:12:47.286Z"
---

# Tagesbericht (reports.daily, DailyReportService, agent_log, claude_usage, Diagramme)

Stand 2026-10-16.

## Sidecar
- `packages/sidecar/src/reports/daily-report.ts`: `DailyReportService.build({ date?, projectId? })` und `summarize(...)`, `reportText(report, { ref })` für Claude/Telefon, `dayRange`/`localDate` (lokaler Tag, Ende exklusiv). RPC `reports.daily` und `reports.dailySummary` (Telefon: Werkzeug `sessions`, Aktion `day_report` mit `days_back` und `summary`).
- Mit `projectId` gilt das Hauptprojekt samt seinen Worktrees (ein Worktree-Projekt meldet für sein Hauptprojekt). Anrufe nur bei „alle Projekte“ (`calls: null` sonst).
- Sessions des Tages: `Db.sessionActivity(from, to, ...)`. Es gibt keinen Index auf `events.ts`; vorgefiltert wird über `sessions.updated_at >= from AND created_at < to` (jeder Durchlauf endet mit Statuswechsel, der updated_at setzt), dann pro Session Aggregat über den PK-Index (session_id).
- „Jetzt offen“ ist der aktuelle Stand, nicht der am Tagesende: offene approval.request (nach der letzten user.message, ohne approval.resolved) in Sessions mit Status waiting_approval, Sessions des Tages mit Status error, geplante auto_continue.
- Welche Repositorys gefragt werden (`reposToAsk`): nur Hauptprojekte mit Git; ein Projekt ohne Session am Tag nur, wenn `headMovedSince` (mtime von `.git/logs/HEAD`, bei Worktrees über die `gitdir:`-Datei) nicht `false` sagt: so kein git-Prozess pro untätigem Projekt.
- Commits: `GitEngine.logBetween` (`--since/--until` im Format `YYYY-MM-DD HH:MM:SS +0000`, git liest ISO mit Millisekunden unzuverlässig; `-- .` begrenzt auf den Projektordner im Monorepo).
- Auto-Commit-Kennzeichnung: Hash oder Betreff aus `automation`-Events (action commit) der Sessions des Tages.

## Tokens und Arbeitszeit (claude_usage, Migrationen 17 bis 19)
- Warum eine eigene Tabelle: Events einer Session gehen mit ihr, die eines Agenten also beim Merge. `claude_usage` hat keine Fremdschlüssel und bleibt. Migration 17 hat alle noch vorhandenen `turn.result`-Events übernommen, 18 `api_calls` (= `numTurns` des Ergebnisses), 19 `purpose` (siehe unten). Was Agenten vor dem 2026-10-16 ~23 Uhr gearbeitet haben, ist verloren (deshalb "Agenten 0 min" an diesem Tag).
- Schreiben: `Db.appendEvent` legt bei `turn.result` eine Zeile `kind = session` an (root_id = parent_id des Projekts oder das Projekt selbst; Agent = project_id ≠ root_id). Aufrufe außerhalb von Sessions über `tokenMeter.onResult` in app.ts: Schlüssel-Präfix `complete:<purpose>` = assist, `phone` = phone. Neue SDK-Abfragen mit Tokens müssen deshalb über `meterKey(...)` in den TokenMeter, sonst fehlen sie auch hier.
- Das SDK meldet `usage` im `result` pro Durchlauf (nicht kumuliert über die Session), summiert über alle API-Anfragen des Durchlaufs. `turn.result` hat seit 2026-10-16 `cacheWriteTokens` (optional, alte Events ohne: dort fehlt der Cache-Aufbau in "neu gelesen").
- **Stolperfalle Cache-Lesen:** `cache_read_input_tokens` ist bei jeder Anfrage der ganze bisherige Kontext. Ein Durchlauf mit 87 Anfragen bei ~184 Tsd. Kontext hat 16 Mio. Cache-Lesen. Über einen Tag kamen so 72 Mio. zusammen, 99 % der Summe; der Nutzer hielt das für einen Fehler. Deshalb: "Tokens" in Bericht, Stunden, Tagen und Projekten = neue Tokens (Eingabe + Ausgabe + Cache schreiben, `tokensOf` in usage-stats.ts). Cache-Lesen steht getrennt als "Kontext aus dem Cache" mit Ø je Anfrage (`cacheReadTokens / apiCalls`).
- Die Token-Summen des Tages enthalten bei "alle Projekte" auch die Aufrufe außerhalb von Sessions; Durchläufe, Arbeitszeit und Parallelität nur Sessions.
- Rechnung `reports/usage-stats.ts` (`usageStats`, rein, getestet in `test/usage-stats.test.ts`): Ein Aufruf läuft von `ts - duration_ms` bis `ts`. Arbeitszeit wird auf den Tag bzw. die Stunde zugeschnitten (ein Durchlauf über Mitternacht zählt auf beiden Tagen), Tokens zählen am Tag/zur Stunde des Endes. `workMs` = Summe (parallele zählen doppelt), `activeMs` = Uhrzeit mit mindestens einem laufenden Durchlauf, `peakParallel` per Sweep. `days` = 14 Tage bis zum Berichtstag; geladen wird ab einem Tag davor.
- `formatDuration` / `formatTokens` / `FORGE_USAGE_LABEL` liegen in `packages/protocol/src/format.ts` (Desktop und Sidecar/Telefon gleich). `formatTokens` endet auf "Tsd."/"Mio.": im Satz danach kein Punkt, sondern ein Wort ("16 Tsd. Tokens.").

## Was FORGE selbst verbraucht (usage.forge, purpose)
- `ForgeUsagePurpose` (`packages/protocol/src/models.ts`): `auto` (Session-Durchläufe, deren Nachricht FORGE geschickt hat: user.message `source: "auto"`, also Weitermachen nach dem Limit, Neustart nach Update, /compact der Kontext-Rettung, Konflikte an Agenten über `AgentFinisher.handBack` → `SessionService.send(..., "auto")`), `commit`, `title`, `summary`, `report`, `knowledge`, `pr`, `changelog`, `phone`, `other`. NULL = eigener Durchlauf des Nutzers.
- `runtime.complete/completeJson` nehmen `purpose` in `CompleteOptions`; der Zweck reist im Meter-Schlüssel `complete:<purpose>` zu `tokenMeter.onResult`. Neue Hilfsaufrufe brauchen einen `purpose`, sonst landen sie unter "Sonstiges".
- `appendEvent` setzt `auto`, wenn die letzte user.message der Session `source: "auto"` hat. Migration 19 hat das rückwirkend gesetzt, Hilfsaufrufe von davor sind `other`.
- Für ein einzelnes Projekt zählt nur `auto` (Hilfsaufrufe tragen kein Projekt). UI: Karte "Durch FORGE" (`ForgeCard` in usage-charts.tsx), ein Balken je Zweck nach neuen Tokens; in der Token-Karte "Davon durch FORGE selbst". Telefon/Claude: Zeile "Durch FORGE selbst: … Davon: …" in `reportText`.

## Warum agent_log (Migration 15)
Nach Zusammenführen/Verwerfen sind Worktree-Projekt und Sessions des Agenten gelöscht. `AgentFinisher.finish` schreibt deshalb vorher einen Schnappschuss und danach das Ergebnis (merged/discarded/conflict/waiting) in `agent_log`, beim Merge mit den Commits, die der Ziel-Branch bekommt (Hashes nach dem Rebase, `auto` über den Betreff der Auto-Commits des Agenten). `AgentAutoMerge` schreibt `skipped`. Gleiches Ergebnis direkt hintereinander (waiting alle 2 Minuten, skipped nach jedem Durchlauf) ergibt keine neue Zeile. Der Bericht ordnet über diese Hashes Commits einem Agenten zu (14 Tage zurück).
- Zustand noch vorhandener Agenten: Session arbeitet = running; letzter Log waiting/skipped/conflict und nicht älter als die letzte Session-Aktivität = dieser; sonst done (fertig, nicht zusammengeführt). Am heutigen Tag zählt jeder vorhandene Agent.

## Stolperfalle: "0 zusammengeführt", obwohl Agenten gemergt wurden
Merges eines FORGE-Builds vor agent_log (oder von Hand im Terminal) stehen nicht in agent_log. Rückgriff: `GitEngine.mergesBetween(cwd, from, to, "agent/")` liest den Reflog von HEAD (`git log -g --date=unix --format=%H%x1f%gd%x1f%gs`; `%gd` ist dann `HEAD@{<unix>}`) und nimmt Einträge `merge refs/heads/agent/<x>: Fast-forward` (FORGE merged mit `merge --ff-only refs/heads/<branch>`). Commits des Merges = `<vorheriger Reflog-Eintrag>..<hash>`; Titel = Betreff des neuesten Commits (ohne "Restliche Änderungen"). Ein Branch, den agent_log oder ein vorhandener Worktree schon nennt, kommt nicht doppelt (Schlüssel rootId + branch); agent_log-Zuordnungen von Commits überschreiben die aus dem Reflog. Reflog-Agenten haben `worktreeId` `reflog:<rootId>:<branch>`, `exists: false`. Grenze: Der Reflog verfällt (gc, Standard 90 Tage) und gilt nur für den Ordner, in dem gemergt wurde.

## Anbindung
- MCP-Werkzeug `daily_report` (autoAllow, in `common` von `forgeSessionTools`), verdrahtet über `SessionService.useDailyReport` in app.ts. `reportText` enthält Arbeitszeit, Anfragen, neue Tokens, Cache-Kontext, Projekte und den Anteil von FORGE.
- Zusammenfassung: `ClaudeAssist.summarizeDailyReport` mit `runtime.complete` (ASSIST_MODEL, purpose report), Bericht vorher durch `redactText`.
- Desktop: Ansicht `view: "report"` (`views/ReportView.tsx`), Statistik in `components/report/usage-charts.tsx`: `UsageHeadline` (Arbeitszeit und neue Tokens als große Zahlen, Balken "von Claude geschrieben" / "neu gelesen", daneben getrennt "Kontext aus dem Cache"), `UsageCharts` (Stunden des Tages, 14 Tage mit hervorgehobenem Berichtstag und Umschalter Zeit/Tokens, Klick auf eine Säule öffnet den Tag, Projekte und "Durch FORGE" als waagrechte Balken). Jede Karte hat eine Tabellenansicht (Knopf und Rechtsklick) und "Werte kopieren". Andere Tage/Projekte halten den alten Bericht gedimmt (`keepPreviousData`) statt Skeleton.
- Diagramme ohne Bibliothek, als HTML-Säulen (bis 24px breit, 2px Abstand, 4px runde Oberkante, Haarlinien-Gitter). Farben: `accent-strong` für Werte, `border-strong` für die übrigen Tage, `tile-blue` für "neu gelesen". `--color-accent` (#f97316) liegt für dunkle Flächen über dem Helligkeitsband des dataviz-Validators, `accent-strong` (#ea580c) + `tile-blue` (#4f86f0) bestehen gegen `#1a1e25`.
- Befehlspalette: `report`, `report-project`. Rechtsklick: Projektkarte, Projektzeile der Seitenleiste, jede Zeile im Bericht, jede Diagrammkarte. Server-Events `session.done` und `agent.autoMerge` invalidieren `["report"]`, heute zusätzlich alle 60 s.

## Vorschau im Browser
Am schnellsten ohne Tauri-Mock: temporäre Seite in `apps/desktop/.preview-report/` rendert `ReportView` mit vorbefülltem `queryClient` (`setDefaultOptions({ queries: { staleTime: Infinity } })`, `setQueryData(keys.report(date, null), report)` und `keys.projects`). Echte Daten: Live-DB nur lesend als Kopie ziehen (`new DatabaseSync(file, { readOnly: true }).exec("VACUUM INTO '<kopie>'")`), darauf `DailyReportService.build()` per `pnpm exec tsx <skript>.mts` (Top-Level-await braucht .mts). Vite mit freiem Port und `--strictPort`; danach TaskStop und Port prüfen (siehe Eintrag zu Hintergrund-Servern), Dateien löschen.
