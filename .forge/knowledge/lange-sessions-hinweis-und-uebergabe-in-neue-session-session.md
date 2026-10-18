---
title: "Lange Sessions: Hinweis und Übergabe in neue Session (sessions.handoff, longSessionTokens)"
summary: "Wie FORGE vor langen Sessions warnt und eine neue Session mit dem Wissen der alten startet (Fork des Transkripts + /compact als Übergabe); wichtig bei Änderungen an Composer-Hinweisen, Fork, Kontextanzeige oder Telefon-sessions."
tags: ["sessions","kontext","tokens","telefon","ui"]
updated: "2026-10-18T16:03:02.546Z"
---

Eingebaut 2026-10-18 auf Wunsch des Nutzers: Lange Sessions verbrauchen pro Nachricht immer mehr Tokens, weil jeder Durchlauf den ganzen Verlauf mitschickt.

## Warum nach absoluten Tokens und nicht nach Prozent
Die Kontextanzeige (`ContextMeter`) warnt ab 70 % des Fensters. Bei 1M-Kontext sind 70 % schon 700k Tokens pro Anfrage. Der Hinweis richtet sich deshalb nach `session.context.totalTokens` gegen die Einstellung `longSessionTokens` (Standard 200 000, 0 = aus, Auswahl `LONG_SESSION_CHOICES` in packages/protocol/src/models.ts).

## Übergabe (Sidecar, `SessionService.handoff`)
- RPC `sessions.handoff { sessionId }` → neue Session. Verweigert während Claude arbeitet (`BUSY`) oder ohne `claudeSessionId`.
- Ablauf: `runtime.forkTranscript(..., null, title)` kopiert das ganze Claude-Transkript, die neue FORGE-Session (Titel „… (Fortsetzung)“, Suffix wird nicht verdoppelt) bekommt **keine** Chat-Ereignisse kopiert. Danach schickt FORGE `HANDOFF_COMPACT` (`/compact` mit Übergabe-Anweisung) mit `source: "auto"`.
- Warum Fork + /compact statt Zusammenfassung aus dem FORGE-Verlauf (wie `sessions.summarize`): Claude Code fasst mit dem vollen Kontext zusammen, einschließlich Werkzeug-Ausgaben und gelesener Dateien. Das Transkript-Exzerpt wäre lückenhaft. Die alte Session bleibt unberührt. Kosten: einmal ein Durchlauf über den vollen Kontext.
- Ereignis `session.handoff` (`direction` "from" in der neuen, "to" in der alten Session, `otherSessionId`, `otherTitle`, `contextTokens`). Desktop: Chat-Item `handoff`, Karte `HandoffCard` mit „Öffnen“ und Rechtsklick.

## Desktop (apps/desktop/src/components/workspace/handoff.tsx)
- `LongSessionHint` über dem Composer: „In neuer Session weiter“, „Komprimieren“ (/compact hier), Ausblenden. Ausgeblendet kommt der Hinweis wieder, sobald der Kontext um die halbe Schwelle gewachsen ist (`useCardState`, nur bis zum Neustart).
- `handoffSession(session, draftKey?)` verschiebt den Entwurf (Text und Dateien) in die neue Session und öffnet sie (`openChat`). Nachrichten während der Komprimierung warten wie üblich.
- Einstiege: Hinweis, Befehlspalette („In neuer Session weitermachen“ und die Schwellwerte `long-session-*`), Rechtsklick auf eine Session in der Seitenleiste (`OpenSessions.tsx`), Einstellungen → Claude → Verhalten „Lange Sessions melden“.

## Telefon
`sessions` Aktion `handoff` (setzt den Fokus auf die neue Session), `forge_settings` `long_session_tokens`.
