---
title: "Spracheingabe im Composer: Halten, Strg+Leertaste, Dialoge (useDictationActivity, useDictationQuiet, DictationToggleBar)"
summary: "Wie die Spracheingabe im Composer bedient wird (Leertaste halten, Strg+Leertaste/Klick eingeschaltet bis Enter sendet) und warum Dialoge, die von selbst aufgehen, auf eine laufende Spracheingabe warten müssen."
tags: ["composer","chat","ui","diktat","update","stolperfalle"]
updated: "2026-10-19T20:06:24.712Z"
---

# Spracheingabe im Composer

## Bedienung (Composer.tsx, useDictation.ts, DictationButton.tsx)
- **Leertaste halten** (`HOLD_MS` 380 ms oder Tastenwiederholung): Aufnahme, solange die Taste unten ist; Loslassen fügt den Text ein. Bleibt bewusst so.
- **Eingeschaltet** (seit 2026-10-19, Wunsch des Nutzers): **Strg+Leertaste** im Eingabefeld oder Klick auf das Mikrofon schaltet ein (`toggled`). Danach:
  - **Enter** (ohne Umschalt) beendet und sendet (`sendDictation` → `sendAfter`). Gesendet wird erst, wenn der Zustand wieder `idle` ist und der erkannte Text im Feld steht (Effekt mit `submitNow`-Ref). So geht nie ein halber Text raus. Ohne Text wird nichts gesendet.
  - **Strg+Leertaste** erneut beendet ohne zu senden, der Text bleibt im Feld.
  - **Esc** verwirft (`discardDictation`).
  - Die Leiste `DictationToggleBar` über dem Composer zeigt „Diktat eingeschaltet“, Laufzeit und die drei Tasten (auch als Knöpfe), nach Enter „Text wird erkannt und dann gesendet …“. Platzhalter `speakToggle`.
- Strg+Leertaste prüft `e.ctrlKey` auf allen Systemen (Cmd+Leertaste ist auf dem Mac Spotlight).
- Befehlspalette: „Diktieren (eingeschaltet lassen)“ (`dictate-toggle`) → `toggleDictationSoon()` in `stores/dictation.ts`: wartet, bis kein Dialog offen ist, fokussiert den fokussierten (sonst Haupt-)Composer und schickt ihm das Event `DICTATION_TOGGLE_EVENT`.
- Telefon: nicht anwendbar (Mikrofon am Rechner).

## Dialoge dürfen die Spracheingabe nicht unterbrechen
- Problem (gemeldet 2026-10-18): Das Textfeld beendet eine gehaltene Aufnahme bei `onBlur` (`releaseHold`). Ein Dialog, der von selbst aufgeht (Update-Angebot `AppUpdateDialog`), nimmt den Fokus: Die Aufnahme bricht mitten im Satz ab. Die automatische Installation startet FORGE neu und würde sie ebenso abschneiden. (Eine eingeschaltete Aufnahme endet bei Blur nicht, Enter erreicht dann aber das Feld nicht.)
- `apps/desktop/src/stores/dictation.ts`: `useDictationActivity` zählt laufende Spracheingaben (`hold()` gibt eine Freigabe-Funktion zurück). `useDictation` hält, solange `state !== "idle"` (Aufnahme und Transkription).
- `useDictationQuiet(ms = 2000)`: true, wenn keine Spracheingabe läuft und die letzte mindestens 2 s vorbei ist.
- `AppUpdateDialog` zeigt sich und startet `autoInstall` erst bei `quiet`. Test: `components/layout/AppUpdate.test.tsx`.
- Regel: Jeder neue Dialog oder Vorgang, der ohne Klick des Nutzers aufgeht oder den Fokus nimmt, prüft `useDictationQuiet()`. Kandidaten, die das noch nicht tun: `UsageStatsPrompt`, Anmelde-Dialog bei abgelaufener Claude-Anmeldung.

## Tests
`Composer.test.tsx` (describe "dictation": Halten, Live-Text, Enter sendet nach der Erkennung, Strg+Leertaste an/aus, Verwerfen über die Leiste).
