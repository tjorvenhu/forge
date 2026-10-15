---
title: "Claude-Anmeldung abgelaufen: Erkennung und Anmelde-Dialog (claude.authRequired)"
summary: "Wie FORGE merkt, dass Claude Code die Anmeldung ablehnt (abgelaufen/widerrufen), und den Anmelde-Dialog öffnet; wichtig bei Änderungen an Login, Fehlertexten oder dem Session-Stream."
tags: ["sessions","sidecar","ui","sdk","stolperfalle"]
updated: "2026-10-15T05:54:03.401Z"
---

## Erkennung (Sidecar)
- `claude auth status` meldet auch bei abgelaufenem oder widerrufenem Token oft noch `loggedIn: true`. Verlässlich ist erst die Ablehnung in einer Session.
- `sessions/stream.ts`: Eine Hauptagent-`assistant`-Nachricht mit `error: "authentication_failed"` (SDK-Typ `SDKAssistantMessageError`) markiert den Durchlauf. Beim `turn.result` geht `claude.authRequired` ({ sessionId }) raus, wenn markiert oder wenn `is_error` und der Text zu `isAuthFailure` passt. Höchstens ein Event pro Durchlauf, nicht nach einem Stop.
- `sessions/lifecycle.ts` `onEnd`: Endet der Prozess mit einem Fehler, der zu `isAuthFailure` passt, ebenfalls `claude.authRequired`.
- `isAuthFailure` (`sessions/live-session.ts`) ist dieselbe Regex, die `describeRuntimeError` für die deutsche Fehlermeldung nutzt.

## Dialog (Desktop)
- `lib/server-events.ts`: lädt die Diagnose neu und ruft `useUi.openClaudeLogin("expired")` auf, nur im Hauptfenster. Chat-Fenster würden sonst die Anmeldeseite mehrfach öffnen (`openedUrl` ist pro Fenster).
- `components/settings/ClaudeLoginDialog.tsx` (in `App.tsx` Shell eingehängt): nutzt `ClaudeLoginForm` aus `ClaudeSetupCard.tsx` (dieselbe Logik wie die Karte in den Einstellungen: `claude auth login --claudeai`, URL öffnen, Code einfügen). Wird nicht über dem Einrichtungsassistenten angezeigt. Ein schon offener Dialog bleibt bestehen, wenn mehrere Sessions gleichzeitig scheitern. Schließen während einer laufenden Anmeldung ruft `claude.cancelSetup`. Ein `done` von einer früheren Anmeldung zählt nicht als Erfolg (`started`).
- Weitere Einstiege: Befehlspalette „Bei Claude anmelden“ (`claude-login`) und der Hinweis „nicht angemeldet“ auf der Startseite (Knopf „Anmelden“).
- Offen (Stand 2026-10-15, nicht geprüft): ob ein laufender CLI-Prozess die neuen Zugangsdaten nach der Anmeldung selbst übernimmt. Der Dialog bittet darum, die abgelehnte Nachricht erneut zu senden. Scheitert sie wieder, die Session neu starten. Wer das klärt, bitte hier eintragen.
- Telefon: Für die Anmeldung braucht es den Browser am Rechner, deshalb steht sie auf `NOT_ON_PHONE`.
