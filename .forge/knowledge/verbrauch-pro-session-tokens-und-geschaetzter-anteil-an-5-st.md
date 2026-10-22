---
title: "Verbrauch pro Session: Tokens und geschätzter Anteil an 5-Stunden- und Wochenlimit (sessions.usage, sessionShare)"
summary: "Wie FORGE die Limits auf einzelne Sessions verteilt (Schätzung aus usage_samples und claude_usage), wo die Anzeige sitzt und warum laufende Durchläufe erst am Ende zählen."
tags: ["usage","tokens","sessions","sidecar","ui","telefon"]
updated: "2026-10-22T16:05:03.833Z"
---

Gebaut 2026-10-22 auf Wunsch des Besitzers: pro Session sehen, wie viele Tokens sie verbraucht hat und wie viel Prozent vom 5-Stunden-Limit, Wochenlimit usw.

## Warum es eine Schätzung ist
Claude Code meldet pro Fenster nur einen ganzzahligen Prozentwert für das ganze Konto, kein Token-Budget. FORGE kennt aber jeden eigenen Durchlauf mit Kosten (`claude_usage`, `cost_usd`/`models` aus modelUsage) und speichert die Fenster-Messwerte (`usage_samples`, siehe [[limit-prognose-der-claude-abo-nutzung-usage-samples-forecast]]).

## Rechnung (`packages/sidecar/src/claude/session-usage.ts`, Tests `test/session-usage.test.ts`)
- Messpunkte des Fensters (gleiche Reset-Zeit ±2 min), davor ein virtueller Punkt 0 % am Fensterbeginn.
- Jeder Anstieg zwischen zwei Messwerten wird auf die seit dem letzten Anstieg gezählten FORGE-Aufrufe verteilt, **nach Kosten** (nicht Tokens: Cache-Lesen dominiert die Tokens, die Limits folgen eher den Kosten). Anstieg ohne FORGE-Aufrufe = Terminal/claude.ai, zählt keiner Session.
- **Stolperfalle:** Ein Durchlauf wird erst an seinem Ende in `claude_usage` geschrieben. Deshalb werden seine Kosten über die Laufzeit (`duration_ms`) verteilt. Ohne das bekam ein 1-stündiger Durchlauf fast nichts, weil die Anstiege während seiner Laufzeit „außerhalb von FORGE“ landeten. Ein noch laufender Durchlauf fehlt, bis er endet; danach wird rückwirkend richtig verteilt (Rechnung läuft bei jeder Abfrage komplett neu).
- Aufrufe nach dem letzten Messwert zählen mit der bisherigen Rate des Fensters (Anstieg/Kosten).
- Modellfenster (`seven_day_opus`, `seven_day_sonnet`, `model:<Name>`) zählen nur Kosten der Modell-IDs, die den Namen enthalten. Zeilen ohne `models` (alt) werden nach Tokens mit API-Preisverhältnissen gewichtet.
- Geprüft mit echten Daten: Wochenfenster 33 %, Summe der Sessions 32,1 %.

## Wo es erscheint
- RPC `sessions.usage` → `SessionService.sessionUsage` (Lebenssumme aus `Db.sessionUsageTotals`, Fenster aus `planUsage(false)` + `Db.claudeCallsSince`).
- Desktop `components/usage/SessionUsage.tsx`: `SessionUsageMeter` im Composer neben dem ContextMeter (Anteil am ersten Fenster, Tooltip alle Fenster, Klick öffnet Dialog, Rechtsklick), `SessionUsageDetails` im Dialog und als Abschnitt „Diese Session“ in `/usage`, `SessionUsageDialogHost` (Store `stores/session-usage.ts`) in App und ChatWindowView. Palette `session-usage`, Rechtsklick auf Session in der Seitenleiste.
- Query `keys.sessionUsage(id)`: neu nach Ende eines Durchlaufs (server-events) und nach `refreshUsage`.
- Telefon: Werkzeug `details` nennt Tokens und Anteile (Coverage `sessions.usage` → details).
- Test-Attrappen in `Composer.test.tsx`, die für unbekannte Methoden `{ models: [] }` liefern, brauchen eine Antwort für `sessions.usage`.
