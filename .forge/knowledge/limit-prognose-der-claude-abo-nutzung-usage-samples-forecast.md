---
title: "Limit-Prognose der Claude-Abo-Nutzung (usage_samples, forecastWindow, UsageForecast)"
summary: "Wie FORGE aus gespeicherten Nutzungs-Messwerten pro Fenster prognostiziert, ob das Limit vor dem Reset erreicht wird, wo die Prognose erscheint und welche Stolperfallen es gibt."
tags: ["usage","sidecar","ui","telefon","forge-tools","stolperfalle"]
updated: "2026-10-17T11:13:39.418Z"
---

# Limit-Prognose der Claude-Abo-Nutzung (usage_samples, forecastWindow, UsageForecast)

## Ablauf
- `RuntimeCatalog.planUsage` (`packages/sidecar/src/sessions/runtime-catalog.ts`) speichert jede echte Abfrage als Messwerte in der SQLite-Tabelle `usage_samples` (window_key, resets_at, at, utilization; Zeiten in ms) und hängt an jedes Fenster `forecast` (`UsageForecast` in `packages/protocol/src/models.ts`, optional). Auch die gecachte Antwort bekommt die Prognose. Kein eigenes RPC: `system.usage` liefert sie mit.
- Aufräumen beim Speichern: Messwerte älter als 7 Tage + 1 h oder von Fenstern, deren Reset vorbei ist.
- Gemessen wird nur, wenn jemand fragt: UI alle 5 Minuten (nur solange FORGE sichtbar ist), nach Turns, Telefon, usage_status.

## Rechnung (`packages/sidecar/src/claude/usage-forecast.ts`, rein, getestet in `test/usage-forecast.test.ts`)
- Fenster-Identität = Reset-Zeit (±2 min Toleranz). Nur Messwerte seit Fensterbeginn (Reset minus 5 h bzw. 7 Tage). Nach einem Rückgang zählt nur, was danach kam.
- Tempo = gewichteter Anstieg / gewichtete Zeit über alle Abschnitte zwischen Messwerten, Gewicht 0,5^(Alter/Halbwertszeit). Halbwertszeit 30 min (5 h) bzw. 24 h (Wochenfenster, sonst wirkt jede Nacht wie eine Pause). Eine frühere Pause verfälscht so nicht; eine Pause gerade eben senkt das Tempo bewusst („bei diesem Tempo“).
- Keine Prognose bei < 3 Messwerten, Spanne < 10 min (5 h) bzw. < 2 h (Woche), keinem Anstieg, Fenster schon voll (das meldet der RateLimit-Zustand) oder Reset vorbei.
- Prozente kommen von Claude Code gerundet (ganze Zahlen); bei kurzen Spannen ist das Tempo daher grob.

## Wo sie erscheint
- Texte Sidecar: `describeUsage` (usage_status), `limitWarning` (Hinweis an start_agent und Telefon-Agentenstart, blockiert nie), `spokenForecast` (Telefon-Werkzeug `usage`).
- Desktop: `lib/usage-forecast.ts` (forecastLabel/forecastSentence/windowsRunningOut), `components/usage/UsageWindows.tsx` (Liste für Einstellungen und /usage, `LimitForecastWarning` im Dialog „Paralleler Agent“, `usageItems` fürs Rechtsklick-Menü), `components/settings/UsageSettings.tsx` (Karte „Nutzung und Prognose“ unter Einstellungen → Claude Code), Sidebar-Balken (Tooltip + „Limit gegen HH:MM“), Palette `usage-forecast`/`usage-refresh`. `Meter` liegt jetzt in `components/ui/meter.tsx`.

## Stolperfallen
- Test-Fakes von `RuntimeCatalog` brauchen `db.addUsageSamples`/`listUsageSamples` (siehe `plan-usage.test.ts`), der SessionService-Fake im Telefon-Test `planUsage`/`rateLimit`.
- Vitest: `beforeEach(() => mock.mockReset())` gibt den Mock zurück, Vitest ruft ihn dann als Aufräum-Funktion ohne Argumente auf. Immer mit Block-Körper schreiben.
- Desktop-Komponenten ohne Tauri ansehen geht auch ohne Brücke: Vorschauseite setzt `window.__TAURI_INTERNALS__` mit `transformCallback` und `invoke` (bei `plugin:event|listen` die Handler-ID für `sidecar://messages` merken, bei `sidecar_send` die Antwortzeile `{id, ok: true, result}` an diesen Callback geben, `sidecar_status` → true), dann `rpc.start()` und Komponenten dynamisch importieren.
