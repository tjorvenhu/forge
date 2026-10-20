---
title: "Abo-Verbrauch: warum das 5-Stunden-Limit schnell voll ist (Kontextgröße, autoCompactWindow, Zählung)"
summary: "Analyse vom 2026-10-20 (Max-Abo in 30 min von 0 auf 67 %): Ursache sind große Kontexte bis ~970k (Opus 5.5 mit 1M-Fenster, Komprimieren erst kurz vor dem Ende) und parallele Opus-Sessions; wie man das in forge.db nachmisst und welche Stellschrauben es gibt."
tags: ["usage","tokens","kontext","sessions","stolperfalle"]
updated: "2026-10-20T13:39:45.674Z"
---

Anlass 2026-10-20: Der Nutzer (Max-Abo) meldete, das 5-Stunden-Limit sei in einer halben Stunde voll. Gemessen: 15:00 → 15:30 von 0 auf 67 %.

## Ursache
- **Kontextgröße pro Schritt.** Jeder API-Aufruf (jeder Werkzeugschritt) liest den ganzen Verlauf aus dem Cache. Opus 5.5 läuft in Claude Code 2.1.30x mit 1M-Fenster (`autoCompactWindow` "auto"), Auto-Komprimieren erst bei ~967k (`context.compacted` preTokens 966–968k). Sessions laufen deshalb mit 300–900k Kontext. Beispiel: Session mit 878k Kontext, 25 Schritte in 3 min = ~20M Cache-Lesen plus ~0,85M Cache-Schreiben beim Fortsetzen nach Pause (Cache abgelaufen, der ganze Verlauf wird neu geschrieben) → 0 auf 21 % in 2 Minuten.
- **Parallele Opus-Sessions/Agenten**: drei gleichzeitig mit je 120–150 Schritten zu 150–250k Kontext (~20–27M Cache-Lesen je Durchlauf).
- **Nicht** die Ausgabe (0,2M an diesem Tag) und nicht FORGEs Zusatzaufrufe (Haiku-Commits, Titel: wenige Tausend Tokens). FORGE setzt kein 1M-Modell und keine Komprimier-Variable; im Terminal wäre es gleich.
- Nebenbefund: Das Telefon hat morgens auf „sollen weitermachen“ drei fertige Sessions (statt unterbrochener) mit „Resuming session. Please continue the work to completion.“ fortgesetzt (Nachricht ohne `source`). Kostete je einen Durchlauf über großen Kontext.

## Stellschrauben (Claude Code)
- `autoCompactWindow` in settings.json bzw. Umgebung `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (Werte "auto" oder 100k–1M, z. B. `200k`, `500000`; die Variable hat Vorrang). Die CLI warnt: von „auto“ abweichen kann viel Verbrauch bedeuten, „especially when resuming long sessions“ (gemeint: größer als auto). Kleiner = jeder Schritt billiger, dafür öfter komprimieren (eine Komprimierung liest den Verlauf einmal, Details gehen verloren).
- Außerdem in der CLI: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`. Gefunden per `grep -a` in `%USERPROFILE%\.local\bin\claude.exe`.
- In FORGE: Hinweis „Lange Session“ (`longSessionTokens`, siehe [[lange-sessions-hinweis-und-uebergabe-in-neue-session-session]]), Übergabe in neue Session, /compact.

## Nachmessen
`%APPDATA%\forge\forge.db*` (mit -wal) in einen Temp-Ordner kopieren, Skript im Projektordner (Policy), `node:sqlite` readOnly. `sessions.context` (JSON: totalTokens/maxTokens), `events` type `turn.result` (Top-Level-Felder = dieser Durchlauf, nur Hauptgespräch; `models` = modelUsage **kumuliert pro Claude-Prozess**, inkl. Subagenten), `usage_samples` (window_key five_hour, utilization, at in ms) für den Verlauf des Limits, `claude_usage` für FORGEs Zählung. Zeitstempel sind UTC.

## Zählfehler (behoben 2026-10-20)
`claude_usage` nahm bei sinkender modelUsage (neuer Claude-Prozess) den ganzen neuen Wert als Durchlauf. Ein fortgesetzter Prozess beginnt aber nicht bei 0, sondern trägt fast die ganze bisherige Summe mit (915M → 886M), dadurch stand im Tagesbericht „1 Mrd. Tokens aus dem Cache, 2,1 Mio. je Anfrage“. Jetzt (`modelDelta` in persistence/db.ts): gesunken oder keine verwertbare frühere Messung → die eigenen Felder des Durchlaufs zählen; nur der allererste Durchlauf einer Session nimmt modelUsage ganz; alles 0 (Absturz) zählt nichts. Ältere Zeilen in `claude_usage` bleiben überhöht.
