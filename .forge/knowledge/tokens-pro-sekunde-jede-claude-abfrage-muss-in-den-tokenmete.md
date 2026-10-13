---
title: "Tokens pro Sekunde: jede Claude-Abfrage muss in den TokenMeter"
summary: "Wie die Anzeige „Ausgabe … Token/s“ unten links entsteht und was eine neue SDK-Abfrage (query) im Sidecar tun muss, damit sie mitzählt."
tags: ["tokens","sdk","sidebar","stolperfalle"]
updated: "2026-10-13T12:55:26.283Z"
---

- Zähler: `packages/sidecar/src/claude/token-meter.ts` (Singleton `tokenMeter`). Gefüttert in `claude/runtime.ts` (Sessions inkl. Subagenten und parallele Agenten, `complete`, `completeJson`) und `phone/phone-agent.ts`.
- **Neue `query(...)`-Aufrufe** müssen jede Nachricht mit `tokenMeter.observe(meterKey("…"), msg)` melden und am Ende `tokenMeter.forget(key)` aufrufen, sonst fehlt ihr Verbrauch in der Anzeige.
- Rechnung: Bei Streams (includePartialMessages) wird die Länge der Deltas (Text, Thinking, Tool-JSON) grob in Tokens geschätzt (4 Zeichen = 1 Token), `message_delta.usage.output_tokens` korrigiert auf den echten Wert. Ohne Stream zählen `assistant`-Nachrichten je message.id einmal, notfalls `result.usage`. Fenster 4 s (`RATE_WINDOW_MS`).
- Transport: ServerEvent `tokens.rate { perSecond }`, nur bei Änderung, etwa jede Sekunde, zuletzt 0. Kein RPC (die Telefon-Abdeckung prüft jede RPC-Methode). Desktop: `stores/token-rate.ts`, Anzeige `components/layout/TokenRate.tsx` in der Claude-Karte der Seitenleiste. Telefon: das Werkzeug `usage` nennt den Wert mit.
- Gemini Live (Telefon-Engine) zählt nicht mit: es sind keine Claude-Tokens.
