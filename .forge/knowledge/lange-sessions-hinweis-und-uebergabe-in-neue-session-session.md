---
title: "Lange Sessions: Hinweis und Übergabe in neue Session (sessions.handoff, longSessionTokens)"
summary: "Wie FORGE vor langen Sessions warnt (Standard 600k Tokens, Ausblenden bleibt über Neustart) und eine neue Session mit dem Wissen der alten startet (Fork + /compact); wichtig bei Änderungen an Composer-Hinweisen, Fork, Kontextanzeige oder Telefon-sessions."
tags: ["sessions","kontext","tokens","telefon","ui"]
updated: "2026-10-19T17:59:49.429Z"
---

Eingebaut 2026-10-18 auf Wunsch des Nutzers: Lange Sessions verbrauchen pro Nachricht immer mehr Tokens, weil jeder Durchlauf den ganzen Verlauf mitschickt.

## Schwelle (geändert 2026-10-19)
- Der Hinweis richtet sich nach `session.context.totalTokens` (aus `getContextUsage`: nur Kategorien `used`, also System-Prompt, Werkzeuge, Memory, Skills, Nachrichten; ohne deferred, Puffer, frei) gegen die Einstellung `longSessionTokens`. Nicht nach Prozent: bei 1M-Kontext wären 70 % schon 700k.
- Standard war 200 000; der Besitzer fand den Hinweis „viel zu oft“. Echte Werte seiner Sessions (1M-Kontext, viele Screenshots): Median ~265k, 75 % ~550k. Deshalb Standard **600 000** (`DEFAULT_SETTINGS` in persistence/db.ts), Auswahl `LONG_SESSION_CHOICES` = 0, 100k, 200k, 400k, 600k, 800k (packages/protocol/src/models.ts). Einstellungen werden pro Schlüssel nur gespeichert, wenn der Nutzer sie ändert: wer nie gewählt hat, bekommt den neuen Standard ohne Migration.
- Ausblenden: kommt erst wieder, wenn der Kontext um eine **ganze** Schwelle gewachsen ist (vorher die halbe), und gilt über Neustarts (localStorage `forge.longSessionHidden`, Session-ID → Tokens beim Ausblenden, höchstens 200 Einträge). Vorher lag es nur im `useCardState` und der Hinweis kam nach jedem Start sofort wieder.

## Übergabe (Sidecar, `SessionService.handoff`)
- RPC `sessions.handoff { sessionId }` → neue Session. Verweigert während Claude arbeitet (`BUSY`) oder ohne `claudeSessionId`.
- Ablauf: `runtime.forkTranscript(..., null, title)` kopiert das ganze Claude-Transkript, die neue FORGE-Session (Titel „… (Fortsetzung)“, Suffix wird nicht verdoppelt) bekommt **keine** Chat-Ereignisse kopiert. Danach schickt FORGE `HANDOFF_COMPACT` (`/compact` mit Übergabe-Anweisung) mit `source: "auto"`.
- Warum Fork + /compact statt Zusammenfassung aus dem FORGE-Verlauf: Claude Code fasst mit dem vollen Kontext zusammen, einschließlich Werkzeug-Ausgaben und gelesener Dateien. Die alte Session bleibt unberührt. Kosten: einmal ein Durchlauf über den vollen Kontext.
- Ereignis `session.handoff` (`direction` "from"/"to", `otherSessionId`, `otherTitle`, `contextTokens`). Desktop: Karte `HandoffCard` mit „Öffnen“ und Rechtsklick.

## Desktop (apps/desktop/src/components/workspace/handoff.tsx)
- `LongSessionHint` über dem Composer: „In neuer Session weiter“, „Komprimieren“ (/compact hier), Ausblenden.
- `handoffSession(session, draftKey?)` verschiebt den Entwurf (Text und Dateien) in die neue Session und öffnet sie.
- Einstiege: Hinweis, Befehlspalette („In neuer Session weitermachen“ und `long-session-*`), Rechtsklick auf eine Session in der Seitenleiste, Einstellungen → Claude → Verhalten „Lange Sessions melden“.
- Test: handoff.test.tsx; „Neustart“ im Test = `cleanup()` + `useCardStore` leeren + neu rendern (derselbe gemountete Baum behält den Startwert im Ref von `useCardState`).

## Telefon
`sessions` Aktion `handoff`, `forge_settings` `long_session_tokens`.
