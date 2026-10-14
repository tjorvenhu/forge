---
title: "Tempo und Verbrauch: was FORGE pro Durchlauf zusätzlich tut"
summary: "Wo FORGE neben Claude selbst Zeit und Abo-Nutzung kostet (Auto-Commit, Git-Status, Refreshs, Haiku-Aufrufe) und was bereits optimiert ist; wichtig bei Beschwerden über Langsamkeit oder hohen Verbrauch."
tags: ["performance","git","auto-commit","usage","sidecar","desktop"]
updated: "2026-10-14T16:09:07.847Z"
---

Stand: 2026-10-14. Analyse per Code-Lesen, nicht gemessen.

## Die API-Anfragen selbst bremst FORGE nicht
Gleiches Modell/Effort wie im Terminal (Einstellung defaultModel/defaultEffort), angehängter Kontext ca. 2–3k Token (Wissensindex max. 60 Einträge/6000 Zeichen) plus ca. 2k Token Werkzeug-Schemas, gecacht.

## Zeit kostet die Arbeit drumherum
1. **Auto-Commit hält die nächste Nachricht zurück** (`sessions/turn-automation.ts` schedule/afterTurn, `turns.ts` „Wartet auf Tests und Auto-Commit…“): git status, Haiku-Aufruf für die Commit-Nachricht (`claude-assist.ts` suggestCommitMessage, neuer claude.exe-Prozess), Commit, ggf. Push. Typisch 5–20 s. Nur in Projekten mit Tag auto-commit.
2. **git status vor jeder Nachricht** (`turns.ts` captureBaseline): 3 Git-Prozesse.
3. **Desktop-Refreshs** (`apps/desktop/src/lib/server-events.ts`).
4. **PreToolUse-Hook ohne Matcher** (`runtime.ts`): jede Werkzeug-Nutzung geht durch die Sidecar-Policy (wenige ms).
5. Jedes Event: redact + synchrones SQLite-Insert mit FTS-Trigger.

## Bereits optimiert (2026-10-14)
- `GitEngine.diff(cwd, file, staged, known?)`: suggestCommitMessage gibt den schon gelesenen Status mit, statt pro Datei erneut `status` (3 Prozesse) zu starten.
- `createGitRefresher` merkt sich tool.use-IDs von Lese-Werkzeugen (READ_ONLY_TOOLS); deren tool.result löst keinen Git-Refresh aus.
- Session idle/stopped: `refreshProjectInList` lädt nur dieses Projekt neu und setzt es in die Projektliste, statt `projects.list` (git status in allen Projekten) neu zu holen.

## Verbrauch (Abo)
Hauptsächlich die Opus-Sessions selbst. Zusätzlich: `agentProgressSummaries: true` (CLI fasst laufende Subagenten ca. alle 30 s zusammen), FORGE-Agenten (volle neue Session), Auto-Continue nach Limit-Reset und Kontext-Recovery (/compact) mit vollem Kontext, Haiku-Commit-Nachricht pro Durchlauf (Diff bis 30k Zeichen), Titel (max. 1/min). planUsage/probe/commands starten claude.exe ohne Modellaufruf: CPU, kein Verbrauch.

## Worktrees unter .claude/worktrees
Kommen vom Agent-Werkzeug von Claude Code (isolation worktree), FORGE fordert das nirgends an. Siehe [[parallele-agenten-abschliessen-zusammenfuehren-verwerfen]].
