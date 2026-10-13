---
title: "Gemini Live am Telefon: Rauschen, Echo und Stottern"
summary: "Wo man ansetzt, wenn Gemini Live am Telefon mitten im Satz abbricht, stottert oder den Anrufer überhört; die Maßnahmen selbst stehen in ADR 0011."
tags: ["telefon","gemini","audio","vad","stolperfalle"]
updated: "2026-10-13T11:43:32.743Z"
---

Hintergrund und die drei Gegenmaßnahmen (VAD-Einstellungen der Live API, `NoiseGate`, 200 ms Vorpuffer) stehen in
`docs/adr/0011-gemini-live-tischtelefon.md`, Nachtrag „Rauschen und Echo“ (2026-10-13). Die Zahlen stehen in
`GATE_DEFAULTS` (`packages/sidecar/src/phone/vad.ts`) und `setupMessage` (`phone/gemini-live.ts`).

## Hinweise beim Nachjustieren

- Ist der Anrufer zu leise und wird abgeschnitten: `minLevel` im `NoiseGate` senken, nicht die
  Gemini-Sensitivität (`START_SENSITIVITY_LOW`) ändern. Die Gemini-Erkennung soll weiter unempfindlich bleiben.
- Bricht FORGE wieder durch Echo ab: `bargeInFrames` bzw. den Faktor 2,5 während der Wiedergabe erhöhen.
- Ungetestet gegen die echte Live API: ob der Dienst `realtimeInputConfig` in genau dieser Form annimmt. Bei einem
  Setup-Fehler mit `packages/sidecar/scripts/gemini-live-smoke.ts` prüfen (braucht `GEMINI_API_KEY`).
