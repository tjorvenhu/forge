---
title: "Abo-Verbrauch FORGE vs. Terminal (Parallelität, Kontextgröße, agentProgressSummaries, Zählung)"
summary: "Pro Prompt verbraucht FORGE etwa so viel wie das Terminal; Mehrverbrauch kommt von parallelen Sessions, langen Kontexten (bis ~970k) und agentProgressSummaries (SDK erzwingt Voll-Fork pro Subagent alle 30 s). Messmethode, Stellschrauben, Zählfehler."
tags: ["usage","tokens","kontext","sessions","stolperfalle"]
updated: "2026-10-21T08:54:00.740Z"
---

Anlass 2026-10-20: Der Nutzer (Max-Abo) meldete, das 5-Stunden-Limit sei in einer halben Stunde voll; im Terminal komme er viel länger aus. Gemessen: 15:00 → 15:30 von 0 auf 67 %. Am 2026-10-21 meldete ein anderer Nutzer: gleiche Aufgaben, mit FORGE 15 % Wochenlimit an einem Tag, im Terminal Wochenende mit 45 % Rest.

## FORGE vs. Terminal (14 Tage, Transkripte in ~/.claude/projects)
`entrypoint` in jeder Zeile: `"sdk-ts"` = FORGE-Session, `"cli"` = Terminal, `"sdk-cli"` = FORGEs Einmalaufrufe (Titel, Commits; je ~31k Kontext, Haiku, vernachlässigbar). API-Aufrufe = assistant-Zeilen mit `message.usage`, nach `message.id` entdoppeln. Subagenten-Transkripte liegen unter `<session>/subagents/`. Cache-Schreiben getrennt auswerten (`cache_creation.ephemeral_1h_input_tokens`): 1h-Schreiben kostet ~20× Cache-Lesen, ein Cache-Bruch bei 400k Kontext wiegt also ~20 normale Aufrufe.
| | FORGE | Terminal |
|---|---|---|
| Aufrufe je Prompt | 13,8 | 16,3 |
| Cache-Lesen je Prompt | 5,3M | 5,4M |
| Kontext je Aufruf Ø | 390k | 338k |
| Cache-Lesen pro aktiver Stunde (5-min-Buckets) | Ø 222M | Ø 72M |
| gleichzeitige Sessions (Median / p90) | 3 / 5 | 1 / 3 |
| Zeit mit ≥ 3 parallel | 82 % | 18 % |
- **FORGE macht nicht mehr Aufrufe pro Nachricht.** FORGE-eigene Werkzeuge ca. 5 % der Werkzeugaufrufe, von FORGE gesendete Nachrichten (Update, Limit, Übergabe) ca. 1 % des Cache-Lesens.
- **Hauptunterschied Parallelität** (meist 3 Sessions statt 1) und **Kontextgröße**: FORGE-Sessions bleiben in der Liste und werden für neue Aufgaben weiterbenutzt; im Terminal startet man oft frisch. Kosten pro Aufruf wachsen linear mit dem Kontext.

## agentProgressSummaries: im SDK teurer als im Terminal (Code-Prüfung 2026-10-21, CLI 2.1.306)
`agentProgressSummaries: true` (runtime.ts) liefert die Einzeiler `task_progress.summary` für laufende Subagenten. Im CLI-Binary (Suche nach `[AgentSummary]`, `agent_summary`): Ist die SDK-Option an, wird die Server-Konfiguration ignoriert und der Standard `{mode:"full", refreshSeconds:[30]}` genommen. „full“ = Fork des **ganzen Subagenten-Verlaufs** mit dessen Modell alle 30 s (nur wenn sich der Verlauf geändert hat; Cache-Lesen, kein Schreiben). Das Terminal bekommt für Opus/Fable per Server-Flag den Modus „short“: nur ~2k Token Notizen, ohne Cache. Außerdem gilt im SDK die Zusammenfassung für alle Subagenten, im Terminal nur für Hintergrund-Agenten. Grob +20–30 % auf den Subagenten-Verbrauch; relevant, wenn Claude viele Explore-/Agent-Aufrufe macht. Ohne die Option fehlt nur die Fortschrittszeile in der UI.

## Geprüft und unauffällig (2026-10-21)
Standard-Modell/Effort `null` = CLI-Standard aus ~/.claude/settings.json (settingSources user/project/local wie im Terminal). Angehängter Start-Kontext ~3k Token, nur beim Prozessstart gebaut (kein Cache-Bruch pro Durchlauf). Notizen (Auto-Commit, Testfehler) kommen als Block in die Nutzernachricht, nicht in den Systemprompt. Haiku-Aufrufe (Commit, Titel ≤ 1/min nur aus Prompts, Telefon, Bericht) klein. Prozess-Neustart (IdleClose 60 min, App-Update, Nachricht bearbeiten) baut den Cache neu auf; bei 60 min wäre der 1h-Cache meist ohnehin abgelaufen. Auto-Continue max. 3×.

## Kontextgröße pro Schritt
Opus 5.5 läuft in Claude Code 2.1.30x mit 1M-Fenster (`autoCompactWindow` "auto"), Auto-Komprimieren erst bei ~967k, in FORGE wie im Terminal. Beispiel: Session mit 878k Kontext, 25 Schritte in 3 min = ~20M Cache-Lesen plus ~0,85M Cache-Schreiben nach Pause → 0 auf 21 % in 2 Minuten.

## Stellschrauben
- Claude Code: `autoCompactWindow` (settings.json) bzw. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ("auto" oder 100k–1M, z. B. `200k`; Variable hat Vorrang). Außerdem `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`.
- FORGE: Hinweis „Lange Session“ (`longSessionTokens`, Standard 600k, [[lange-sessions-hinweis-und-uebergabe-in-neue-session-session]]), Übergabe in neue Session, /compact, Limit-Prognose (`usage_status`).
- Nebenbefund: Das Telefon hat auf „sollen weitermachen“ drei fertige Sessions statt unterbrochener fortgesetzt („Resuming session. Please continue the work to completion.“, ohne `source`).

## Nachmessen in forge.db
Windows `%APPDATA%\forge\forge.db*`, macOS `~/Library/Application Support/forge/forge.db*` (mit -wal) in einen Temp-Ordner kopieren, `node:sqlite` readOnly. `sessions.context` (JSON totalTokens/maxTokens), `events` type `turn.result` (Top-Level = dieser Durchlauf, nur Hauptgespräch; `models` = modelUsage **kumuliert pro Claude-Prozess**, inkl. Subagenten), `usage_samples` (window_key five_hour, utilization, at in ms), `claude_usage` (FORGEs Zählung, Spalte purpose). Zeitstempel UTC.

## Zählfehler (behoben 2026-10-20)
`claude_usage` nahm bei sinkender modelUsage (neuer Claude-Prozess) den ganzen neuen Wert als Durchlauf. Jetzt (`modelDelta` in persistence/db.ts): gesunken oder keine verwertbare frühere Messung → die eigenen Felder des Durchlaufs zählen; nur der erste Durchlauf einer Session nimmt modelUsage ganz; alles 0 zählt nichts. Ältere Zeilen bleiben überhöht.
