---
title: "Spracheingabe im Composer: Dialoge dürfen sie nicht unterbrechen (useDictationActivity, useDictationQuiet)"
summary: "Warum Dialoge, die von selbst aufgehen (Update-Angebot), auf eine laufende Spracheingabe warten müssen und wie das im Desktop-Client umgesetzt ist."
tags: ["composer","chat","ui","update","stolperfalle"]
updated: "2026-10-18T10:34:22.296Z"
---

# Spracheingabe im Composer: Dialoge dürfen sie nicht unterbrechen

## Problem (gemeldet 2026-10-18)
Die Spracheingabe läuft über gehaltene Leertaste im Composer (`useDictation.ts`, `Composer.tsx`). Das Textfeld beendet die Aufnahme bei `onBlur` (`releaseHold` → `dictation.stop()`). Ein Dialog, der von selbst aufgeht (Update-Angebot `AppUpdateDialog`), nimmt den Fokus: die Aufnahme bricht mitten im Satz ab. Die automatische Installation (zweiter Schritt eines Updates) startet FORGE neu und würde sie ebenso abschneiden.

## Lösung
- `apps/desktop/src/stores/dictation.ts`: `useDictationActivity` zählt laufende Spracheingaben (`hold()` gibt eine Freigabe-Funktion zurück). `useDictation` hält, solange `state !== "idle"` (Aufnahme und Transkription).
- `useDictationQuiet(ms = 2000)`: true, wenn keine Spracheingabe läuft und die letzte mindestens 2 s vorbei ist (der Text landet, der Nutzer spricht oft gleich weiter).
- `AppUpdateDialog` zeigt sich und startet `autoInstall` erst bei `quiet`. Test: `components/layout/AppUpdate.test.tsx`.

## Regel
Jeder neue Dialog oder Vorgang, der ohne Klick des Nutzers aufgeht oder den Fokus nimmt (Hinweise nach dem Start, Abfragen, Neustarts), prüft `useDictationQuiet()`. Kandidaten, die das noch nicht tun: `UsageStatsPrompt`, Anmelde-Dialog bei abgelaufener Claude-Anmeldung.
