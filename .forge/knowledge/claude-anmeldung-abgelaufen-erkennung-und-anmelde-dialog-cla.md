---
title: "Claude-Konto: abgelaufene Anmeldung, Anmelden, Abmelden, Konto wechseln (claude.authRequired, claude.logout)"
summary: "Wie FORGE merkt, dass Claude Code die Anmeldung ablehnt, und wie Anmelde-Dialog, Abmelden und Kontowechsel (Seitenleiste, Rechtsklick, Palette, Telefon) aufgebaut sind; wichtig bei Änderungen an Login, Fehlertexten oder dem Session-Stream."
tags: ["sessions","sidecar","ui","telefon","stolperfalle"]
updated: "2026-10-15T06:07:49.981Z"
---

## Erkennung einer abgelaufenen Anmeldung (Sidecar)
- `claude auth status` meldet auch bei abgelaufenem oder widerrufenem Token oft noch `loggedIn: true`. Verlässlich ist erst die Ablehnung in einer Session.
- `sessions/stream.ts`: Eine Hauptagent-`assistant`-Nachricht mit `error: "authentication_failed"` (SDK-Typ `SDKAssistantMessageError`) markiert den Durchlauf. Beim `turn.result` geht `claude.authRequired` ({ sessionId }) raus, wenn markiert oder wenn `is_error` und der Text zu `isAuthFailure` passt. Höchstens ein Event pro Durchlauf, nicht nach einem Stop.
- `sessions/lifecycle.ts` `onEnd`: Endet der Prozess mit einem Fehler, der zu `isAuthFailure` passt, ebenfalls `claude.authRequired`.
- `isAuthFailure` (`sessions/live-session.ts`) ist dieselbe Regex, die `describeRuntimeError` für die deutsche Fehlermeldung nutzt.

## Abmelden (Sidecar)
- RPC `claude.logout` → `ClaudeSetupService.logout()` (`claude/setup.ts`): `claude auth logout`, nicht während einer laufenden Anmeldung/Installation (`ensureIdle`). Setzt den Setup-Zustand auf idle, damit ein altes `login done` nicht als aktueller Stand gilt. Der Handler leert `diagCache` und `invalidateRuntimeInfo()`.
- Telefon: `forge_system` Aktion `claude_logout`, nur über `askKeypad` (neu anmelden geht nur am Rechner im Browser). `claude.login`/`submitLoginCode`/`cancelSetup` bleiben auf `NOT_ON_PHONE`.

## Dialoge (Desktop, `components/settings/ClaudeLoginDialog.tsx`, in `App.tsx` Shell)
- `ClaudeLoginDialog`: Gründe `expired` (Event), `manual`, `switch` (Konto wechseln) über `useUi.openClaudeLogin(reason)`. Nutzt `ClaudeLoginForm` aus `ClaudeSetupCard.tsx` (`claude auth login --claudeai`, URL öffnen, Code einfügen). `expired`/`manual` erscheinen nicht über dem Einrichtungsassistenten (der hat einen eigenen Anmeldeschritt), `switch` schon, weil die Einstellungskarte dort auch „Konto wechseln“ anbietet. Ein offener Dialog bleibt bestehen, wenn mehrere Sessions gleichzeitig scheitern. Schließen während einer laufenden Anmeldung ruft `claude.cancelSetup`. Ein `done` von einer früheren Anmeldung zählt nicht als Erfolg (`started`).
- Kontowechsel meldet nicht vorher ab: `claude auth login` überschreibt die Zugangsdaten. Ist im Browser noch das alte claude.ai-Konto angemeldet, muss man es dort wechseln.
- `ClaudeLogoutDialog`: `ConfirmDialog` über `useUi.setClaudeLogout(true)`, danach `logoutClaude(qc)` (Diagnose neu, Nutzung und runtimeInfo invalidiert).
- `server-events.ts`: `claude.authRequired` lädt die Diagnose neu und öffnet den Dialog nur im Hauptfenster (Chat-Fenster würden sonst die Anmeldeseite mehrfach öffnen; `openedUrl` ist pro Fenster).

## Einstiege
- Seitenleiste unten links (`ClaudeStatusCard` in `Sidebar.tsx`): Klick öffnet ein Dropdown, Rechtsklick dasselbe als Kontextmenü; beide aus `claudeAccountItems(diag, openSettings)`: angemeldet „Konto wechseln“, „Abmelden“, „Claude-Einstellungen“; nicht angemeldet „Anmelden“. Früher öffnete der Klick direkt die Einstellungen.
- Einstellungen > Claude Code (`ClaudeSetupCard`): Knöpfe „Konto wechseln“ und „Abmelden“.
- Befehlspalette: `claude-login`, `claude-switch`, `claude-logout`. Startseite: Hinweis „nicht angemeldet“ mit Knopf „Anmelden“.

## Offen
- Stand 2026-10-15, nicht geprüft: ob ein laufender CLI-Prozess neue Zugangsdaten nach Anmeldung oder Kontowechsel selbst übernimmt. Die Texte sagen deshalb „Nachricht erneut senden“ bzw. „spätestens nach einem Neustart“.
- Die Diagnose verwirft E-Mail und Organisation absichtlich (`readAuth`), deshalb zeigt das Menü nur das Abo, nicht das angemeldete Konto.
