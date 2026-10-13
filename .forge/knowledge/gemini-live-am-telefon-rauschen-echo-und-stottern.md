---
title: "Gemini Live am Telefon: Rauschen, Echo und Stottern"
summary: "Warum Gemini Live am Telefon mitten im Satz abbrach und wie Noise Gate, VAD-Einstellungen und Vorpuffer das verhindern; wichtig beim Ändern von live-controller.ts, gemini-live.ts oder vad.ts."
tags: ["telefon","gemini","audio","vad","stolperfalle"]
updated: "2026-10-13T10:32:40.601Z"
---

## Problem

Gemini Live hört bei der Telefon-Engine `gemini-live` alles auf der Leitung. Mit der Standard-Erkennung der Live API
haben Hintergrundgeräusche und das Echo von FORGEs eigener Stimme als „Anrufer spricht“ gezählt. Gemini meldete
`interrupted`, FORGE verwarf die Wiedergabe, Gemini setzte neu an. Das klang wie Stottern und abgebrochene Sätze.

## Lösung (seit 2026-10-13)

1. **VAD der Live API** (`phone/gemini-live.ts`, `setupMessage`): `realtimeInputConfig.automaticActivityDetection`
   mit `startOfSpeechSensitivity: START_SENSITIVITY_LOW`, `prefixPaddingMs: 300`, `silenceDurationMs: 700`.
2. **Noise Gate vor Gemini** (`NoiseGate` in `phone/vad.ts`, genutzt in `phone/live-controller.ts`):
   - Geschlossen geht digitale Stille gleicher Länge hinaus, nicht gar nichts.
   - Es öffnet nach 3 lauten Frames (60 ms). Solange FORGE spielt und 300 ms danach (Echo-Nachlauf) braucht es
     12 Frames (240 ms) und die 2,5-fache Schwelle.
   - Beim Öffnen gehen bis zu 16 zurückgehaltene Frames zuerst hinaus, damit die erste Silbe erhalten bleibt.
   - Es schließt erst nach 600 ms Ruhe, damit Pausen zwischen Wörtern drin bleiben.
   - Die Schwellen sind dieselben wie bei der `Vad` im Claude-Ablauf (minLevel 450, Rauschboden × 3).
3. **Vorpuffer bei der Wiedergabe**: 200 ms sammeln, bevor die Wiedergabe startet oder nach einem Leerlauf wieder
   anläuft. Bei `turnComplete` geht der Rest sofort raus, bei `interrupted` wird er verworfen.

## Hinweise

- Ist der Anrufer zu leise, ist der Ansatzpunkt `minLevel` im `NoiseGate`, nicht die Gemini-Sensitivität.
- Ungetestet gegen die echte Live API: ob der Dienst `realtimeInputConfig` in genau dieser Form annimmt. Bei einem
  Setup-Fehler mit `scripts/gemini-live-smoke.ts` (braucht `GEMINI_API_KEY`) prüfen.
