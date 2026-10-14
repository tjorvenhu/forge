---
title: "Herkunft von Chat-Nachrichten (source: forge, remote, auto, claude)"
summary: "Wer eine Nutzer-Nachricht im Chat geschickt hat (Nutzer, Claude-App, FORGE automatisch, Claude aus einer anderen Session) und was neuer Code tun muss, der selbst Prompts an Sessions schickt."
tags: ["chat","sessions","agenten","ui","konvention"]
updated: "2026-10-14T17:01:19.010Z"
---

`user.message` hat ein optionales Feld `source` (`packages/protocol/src/models.ts`):

- fehlt / `forge`: im FORGE-Composer oder per Telefon getippt. Blase mit „Du“-Avatar.
- `remote`: in der Claude-App geschrieben (Remote Control, `remote-bridge.ts`). Kleiner Hinweis „App“.
- `auto`: von FORGE selbst gesendet: Weitermachen nach Nutzungslimit (`auto-continue.ts`), nach Update (`update-resume`), `/compact` bei vollem Kontext (`context-recovery.ts`), Konflikt-Auftrag beim Zusammenführen (`agent-finish.ts` handBack). Zählt nicht für Titel und beendet keinen Weitermach-Plan.
- `claude`: von Claude aus einer anderen Session geschickt (`start_agent`-Auftrag, `message_agent`). Gesetzt in `session-service.ts` bei den Deps für `forgeSessionTools`.

Darstellung (`apps/desktop/src/components/workspace/UserMessage.tsx`, `SENDERS`): `auto` und `claude` bekommen eine gestrichelte Akzent-Blase, ein eigenes Symbol statt des Nutzer-Avatars (Bot bzw. TimerReset) und eine Kopfzeile „Von Claude“ / „Von FORGE“. Grund: Nutzer hielten Agenten-Aufträge sonst für eigene Nachrichten.

**Regel für neuen Code:** Wer einer Session einen Prompt schickt, den nicht der Nutzer getippt hat, gibt die Quelle mit: `sessions.send(id, text, [], "auto")` bzw. `sessions.start({ ..., source: "auto" })` (`StartParams.source`, `MessageSource` in `sessions/turns.ts`). Neue Quellen in Protokoll-Enum, `MessageSource`, `TitleMessageSource` (`titles.ts`), `chat-items.ts` und `SENDERS` ergänzen.
