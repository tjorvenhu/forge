---
title: "Abo-Verbrauch: warum das 5-Stunden-Limit schnell voll ist (FORGE vs. Terminal, Parallelität, Kontextgröße, Zählung)"
summary: "Messung 2026-10-20: Pro Prompt verbraucht FORGE so viel wie das Terminal; das Limit ist schneller voll, weil in FORGE meist 3 Sessions parallel laufen und Kontexte bis ~970k wachsen. Messmethode, Stellschrauben, behobener Zählfehler."
tags: ["usage","tokens","kontext","sessions","stolperfalle"]
updated: "2026-10-20T13:50:26.506Z"
---

Anlass 2026-10-20: Der Nutzer (Max-Abo) meldete, das 5-Stunden-Limit sei in einer halben Stunde voll; im Terminal komme er viel länger aus. Gemessen: 15:00 → 15:30 von 0 auf 67 %.

## FORGE vs. Terminal (14 Tage, Transkripte in ~/.claude/projects)
`entrypoint` in jeder Zeile: `"sdk-ts"` = FORGE-Session, `"cli"` = Terminal, `"sdk-cli"` = FORGEs Einmalaufrufe (Titel, Commits; je ~31k Kontext, vernachlässigbar). API-Aufrufe = assistant-Zeilen mit `message.usage`, nach `message.id` entdoppeln (mehrere Zeilen je Antwort).
| | FORGE | Terminal |
|---|---|---|
| Aufrufe je Prompt | 13,8 | 16,3 |
| Cache-Lesen je Prompt | 5,3M | 5,4M |
| Kontext je Aufruf Ø | 390k | 338k |
| Cache-Lesen pro aktiver Stunde (5-min-Buckets) | Ø 222M | Ø 72M |
| gleichzeitige Sessions (Median / p90) | 3 / 5 | 1 / 3 |
| Zeit mit ≥ 3 parallel | 82 % | 18 % |
- **Ergebnis: FORGE macht nicht mehr Aufrufe pro Nachricht.** FORGE-eigene Werkzeuge (knowledge_*, preview_*, ToolSearch, dev_environment, agent_status) sind ca. 5 % der Werkzeugaufrufe. Von FORGE selbst gesendete Nachrichten (auto: Update, Limit, Übergabe) ca. 1 % des Cache-Lesens.
- **Der Unterschied ist die Parallelität:** Im Terminal läuft meist eine Session, in FORGE meist drei. FORGE-Agenten (Worktrees) sind davon nur 14 % des FORGE-Verbrauchs, der Rest sind mehrere normale Sessions gleichzeitig. Dazu leben FORGE-Sessions etwas länger (max. Kontext je Session Median 264k vs. 210k).
- `agentProgressSummaries: true` (runtime.ts) forkt laufende Subagenten alle ~30 s mit deren Modell und Cache; im Terminal nicht gesetzt. Subagenten (Agent-Werkzeug) sind in FORGE selten, daher kaum relevant.

## Kontextgröße pro Schritt
Jeder API-Aufruf liest den ganzen Verlauf aus dem Cache. Opus 5.5 läuft in Claude Code 2.1.30x mit 1M-Fenster (`autoCompactWindow` "auto"), Auto-Komprimieren erst bei ~967k (`context.compacted` preTokens 966–968k), in FORGE wie im Terminal. Beispiel: Session mit 878k Kontext, 25 Schritte in 3 min = ~20M Cache-Lesen plus ~0,85M Cache-Schreiben beim Fortsetzen nach Pause (Cache abgelaufen) → 0 auf 21 % in 2 Minuten.

## Stellschrauben
- Claude Code: `autoCompactWindow` (settings.json) bzw. Umgebung `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ("auto" oder 100k–1M, z. B. `200k`; Variable hat Vorrang). Kleiner = jeder Schritt billiger, dafür öfter komprimieren (eine Komprimierung liest den Verlauf einmal, Details gehen verloren). Außerdem `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT`, `CLAUDE_CODE_DISABLE_1M_CONTEXT` (per `grep -a` in `%USERPROFILE%\.local\bin\claude.exe` gefunden).
- FORGE: Hinweis „Lange Session“ (`longSessionTokens`, [[lange-sessions-hinweis-und-uebergabe-in-neue-session-session]]), Übergabe in neue Session, /compact, Limit-Prognose (`usage_status`).
- Nebenbefund: Das Telefon hat auf „sollen weitermachen“ drei fertige Sessions statt unterbrochener fortgesetzt („Resuming session. Please continue the work to completion.“, ohne `source`).

## Nachmessen in forge.db
`%APPDATA%\forge\forge.db*` (mit -wal) in einen Temp-Ordner kopieren, Skript im Projektordner (Policy), `node:sqlite` readOnly. `sessions.context` (JSON totalTokens/maxTokens), `events` type `turn.result` (Top-Level-Felder = dieser Durchlauf, nur Hauptgespräch; `models` = modelUsage **kumuliert pro Claude-Prozess**, inkl. Subagenten), `usage_samples` (window_key five_hour, utilization, at in ms), `claude_usage` (FORGEs Zählung, Spalte purpose). Zeitstempel UTC.

## Zählfehler (behoben 2026-10-20)
`claude_usage` nahm bei sinkender modelUsage (neuer Claude-Prozess) den ganzen neuen Wert als Durchlauf. Ein fortgesetzter Prozess trägt aber fast die ganze bisherige Summe mit (915M → 886M), daher „1 Mrd. Tokens aus dem Cache“ im Tagesbericht. Jetzt (`modelDelta` in persistence/db.ts): gesunken oder keine verwertbare frühere Messung → die eigenen Felder des Durchlaufs zählen; nur der erste Durchlauf einer Session nimmt modelUsage ganz; alles 0 (Absturz) zählt nichts. Ältere Zeilen bleiben überhöht.
