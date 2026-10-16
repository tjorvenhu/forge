---
title: "Tagesbericht (reports.daily, DailyReportService, agent_log, daily_report)"
summary: "Wie der Tagesbericht seine Fakten sammelt (Sessions, Agenten, Commits, Offenes, Anrufe), warum es die Tabelle agent_log und den Reflog-Rückgriff gibt und wo Desktop, MCP-Werkzeug und Telefon ihn anbinden."
tags: ["sidecar","agenten","git","telefon","forge-tools","ui","stolperfalle"]
updated: "2026-10-16T20:13:51.872Z"
---

Stand 2026-10-16.

## Sidecar
- `packages/sidecar/src/reports/daily-report.ts`: `DailyReportService.build({ date?, projectId? })` und `summarize(...)`, `reportText(report, { ref })` für Claude/Telefon, `dayRange`/`localDate` (lokaler Tag, Ende exklusiv). RPC `reports.daily` und `reports.dailySummary` (Telefon: Werkzeug `sessions`, Aktion `day_report` mit `days_back` und `summary`).
- Mit `projectId` gilt das Hauptprojekt samt seinen Worktrees (ein Worktree-Projekt meldet für sein Hauptprojekt). Anrufe nur bei „alle Projekte“ (`calls: null` sonst).
- Sessions des Tages: `Db.sessionActivity(from, to, ...)`. Es gibt keinen Index auf `events.ts`; vorgefiltert wird über `sessions.updated_at >= from AND created_at < to` (jeder Durchlauf endet mit Statuswechsel, der updated_at setzt), dann pro Session Aggregat über den PK-Index (session_id).
- „Jetzt offen“ ist der aktuelle Stand, nicht der am Tagesende: offene approval.request (nach der letzten user.message, ohne approval.resolved) in Sessions mit Status waiting_approval, Sessions des Tages mit Status error, geplante auto_continue.
- Welche Repositorys gefragt werden (`reposToAsk`): nur Hauptprojekte mit Git; ein Projekt ohne Session am Tag nur, wenn `headMovedSince` (mtime von `.git/logs/HEAD`, bei Worktrees über die `gitdir:`-Datei) nicht `false` sagt: so kein git-Prozess pro untätigem Projekt.
- Commits: `GitEngine.logBetween` (`--since/--until` im Format `YYYY-MM-DD HH:MM:SS +0000`, git liest ISO mit Millisekunden unzuverlässig; `-- .` begrenzt auf den Projektordner im Monorepo).
- Auto-Commit-Kennzeichnung: Hash oder Betreff aus `automation`-Events (action commit) der Sessions des Tages.

## Warum agent_log (Migration 15)
Nach Zusammenführen/Verwerfen sind Worktree-Projekt und Sessions des Agenten gelöscht. `AgentFinisher.finish` schreibt deshalb vorher einen Schnappschuss und danach das Ergebnis (merged/discarded/conflict/waiting) in `agent_log`, beim Merge mit den Commits, die der Ziel-Branch bekommt (Hashes nach dem Rebase, `auto` über den Betreff der Auto-Commits des Agenten). `AgentAutoMerge` schreibt `skipped`. Gleiches Ergebnis direkt hintereinander (waiting alle 2 Minuten, skipped nach jedem Durchlauf) ergibt keine neue Zeile. Der Bericht ordnet über diese Hashes Commits einem Agenten zu (14 Tage zurück).
- Zustand noch vorhandener Agenten: Session arbeitet = running; letzter Log waiting/skipped/conflict und nicht älter als die letzte Session-Aktivität = dieser; sonst done (fertig, nicht zusammengeführt). Am heutigen Tag zählt jeder vorhandene Agent.

## Stolperfalle: "0 zusammengeführt", obwohl Agenten gemergt wurden
Merges eines FORGE-Builds vor agent_log (oder von Hand im Terminal) stehen nicht in agent_log. Am 2026-10-16 zeigte der Bericht deshalb 0, obwohl der laufende alte Build fünf Agenten gemergt hatte. Rückgriff: `GitEngine.mergesBetween(cwd, from, to, "agent/")` liest den Reflog von HEAD (`git log -g --date=unix --format=%H%x1f%gd%x1f%gs`; `%gd` ist dann `HEAD@{<unix>}`) und nimmt Einträge `merge refs/heads/agent/<x>: Fast-forward` (FORGE merged mit `merge --ff-only refs/heads/<branch>`). Commits des Merges = `<vorheriger Reflog-Eintrag>..<hash>`; Titel = Betreff des neuesten Commits (ohne "Restliche Änderungen"). Ein Branch, den agent_log oder ein vorhandener Worktree schon nennt, kommt nicht doppelt (Schlüssel rootId + branch); agent_log-Zuordnungen von Commits überschreiben die aus dem Reflog. Reflog-Agenten haben `worktreeId` `reflog:<rootId>:<branch>`, `exists: false`. Grenze: Der Reflog verfällt (gc, Standard 90 Tage) und gilt nur für den Ordner, in dem gemergt wurde.

## Anbindung
- MCP-Werkzeug `daily_report` (autoAllow, in `common` von `forgeSessionTools`, also auch für Agenten und Projekte ohne Git), verdrahtet über `SessionService.useDailyReport` in app.ts.
- Zusammenfassung: `ClaudeAssist.summarizeDailyReport` mit `runtime.complete` (ASSIST_MODEL, zählt im TokenMeter), Bericht vorher durch `redactText`.
- Desktop: Ansicht `view: "report"` (`views/ReportView.tsx`, NAV-Eintrag „Tagesbericht“), `useUi.openReport(projectId | null)`, Tagesauswahl über `components/report/report-days.ts` (Select mit 30 Tagen plus Pfeile). Befehlspalette: `report`, `report-project`. Rechtsklick: Projektkarte, Projektzeile der Seitenleiste, jede Zeile im Bericht. Knopf auf der Startseite. Server-Events `session.done` und `agent.autoMerge` invalidieren `["report"]`, heute zusätzlich alle 60 s.

## Vorschau im Browser
Wie im Git-Eintrag: temporäre Seite mit `window.__TAURI_INTERNALS__`. Beim Mock von `plugin:event|listen` nur den Callback für `sidecar://messages` behalten (`args.event`), sonst landen Antworten beim Exit-Listener und die UI meldet „Hintergrunddienst beendet“. Port 1431 war belegt (anderer Agent); freien Port mit `--strictPort` wählen.
