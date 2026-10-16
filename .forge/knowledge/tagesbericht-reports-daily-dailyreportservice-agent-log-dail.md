---
title: "Tagesbericht (reports.daily, DailyReportService, agent_log, daily_report)"
summary: "Wie der Tagesbericht seine Fakten sammelt (Sessions, Agenten, Commits, Offenes, Anrufe), warum es die Tabelle agent_log gibt und wo Desktop, MCP-Werkzeug und Telefon ihn anbinden."
tags: ["sidecar","agenten","git","telefon","forge-tools","ui"]
updated: "2026-10-16T18:57:28.165Z"
---

Stand 2026-10-16.

## Sidecar
- `packages/sidecar/src/reports/daily-report.ts`: `DailyReportService.build({ date?, projectId? })` und `summarize(...)`, `reportText(report, { ref })` für Claude/Telefon, `dayRange`/`localDate` (lokaler Tag, Ende exklusiv). RPC `reports.daily` und `reports.dailySummary` (Telefon: Werkzeug `sessions`, Aktion `day_report` mit `days_back` und `summary`).
- Mit `projectId` gilt das Hauptprojekt samt seinen Worktrees (ein Worktree-Projekt meldet für sein Hauptprojekt). Anrufe nur bei „alle Projekte“ (`calls: null` sonst).
- Sessions des Tages: `Db.sessionActivity(from, to, ...)`. Es gibt keinen Index auf `events.ts`; vorgefiltert wird über `sessions.updated_at >= from AND created_at < to` (jeder Durchlauf endet mit Statuswechsel, der updated_at setzt), dann pro Session Aggregat über den PK-Index (session_id).
- „Jetzt offen“ ist der aktuelle Stand, nicht der am Tagesende: offene approval.request (nach der letzten user.message, ohne approval.resolved) in Sessions mit Status waiting_approval, Sessions des Tages mit Status error, geplante auto_continue.
- Commits: `GitEngine.logBetween` (`--since/--until` im Format `YYYY-MM-DD HH:MM:SS +0000`, git liest ISO mit Millisekunden unzuverlässig; `-- .` begrenzt auf den Projektordner im Monorepo). Nur Hauptprojekte mit Git. Ein Projekt ohne Session am Tag wird nur gefragt, wenn `headMovedSince` (mtime von `.git/logs/HEAD`, bei Worktrees über die `gitdir:`-Datei) nicht `false` sagt: so kein git-Prozess pro untätigem Projekt.
- Auto-Commit-Kennzeichnung: Hash oder Betreff aus `automation`-Events (action commit) der Sessions des Tages.

## Warum agent_log (Migration 15)
Nach Zusammenführen/Verwerfen sind Worktree-Projekt und Sessions des Agenten gelöscht. `AgentFinisher.finish` schreibt deshalb vorher einen Schnappschuss und danach das Ergebnis (merged/discarded/conflict/waiting) in `agent_log`, beim Merge mit den Commits, die der Ziel-Branch bekommt (Hashes nach dem Rebase, `auto` über den Betreff der Auto-Commits des Agenten). `AgentAutoMerge` schreibt `skipped`. Gleiches Ergebnis direkt hintereinander (waiting alle 2 Minuten, skipped nach jedem Durchlauf) ergibt keine neue Zeile. Der Bericht ordnet über diese Hashes Commits einem Agenten zu (14 Tage zurück).
- Zustand noch vorhandener Agenten: Session arbeitet = running; letzter Log waiting/skipped/conflict und nicht älter als die letzte Session-Aktivität = dieser; sonst done (fertig, nicht zusammengeführt). Am heutigen Tag zählt jeder vorhandene Agent.

## Anbindung
- MCP-Werkzeug `daily_report` (autoAllow, in `common` von `forgeSessionTools`, also auch für Agenten und Projekte ohne Git), verdrahtet über `SessionService.useDailyReport` in app.ts.
- Zusammenfassung: `ClaudeAssist.summarizeDailyReport` mit `runtime.complete` (ASSIST_MODEL, zählt im TokenMeter), Bericht vorher durch `redactText`.
- Desktop: Ansicht `view: "report"` (`views/ReportView.tsx`, NAV-Eintrag „Tagesbericht“), `useUi.openReport(projectId | null)`, Tagesauswahl über `components/report/report-days.ts` (Select mit 30 Tagen plus Pfeile). Befehlspalette: `report`, `report-project`. Rechtsklick: Projektkarte, Projektzeile der Seitenleiste, jede Zeile im Bericht. Knopf auf der Startseite. Server-Events `session.done` und `agent.autoMerge` invalidieren `["report"]`, heute zusätzlich alle 60 s.

## Vorschau im Browser
Wie im Git-Eintrag: temporäre Seite mit `window.__TAURI_INTERNALS__`. Beim Mock von `plugin:event|listen` nur den Callback für `sidecar://messages` behalten (`args.event`), sonst landen Antworten beim Exit-Listener und die UI meldet „Hintergrunddienst beendet“. Port 1431 war belegt (anderer Agent); freien Port mit `--strictPort` wählen.
