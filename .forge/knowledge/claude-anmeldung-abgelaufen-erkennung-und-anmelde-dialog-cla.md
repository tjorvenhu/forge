---
title: "Claude-Konto: Anmeldung ohne Code, Pflicht-Anmeldung, Abmelden, Konto wechseln (claude.authRequired, claude.logout)"
summary: "Wie FORGE Claude Code ohne Code-Eingabe anmeldet (BROWSER-Relay), ohne Anmeldung blockiert, abgelaufene Anmeldungen erkennt und Abmelden/Kontowechsel anbietet; wichtig bei Änderungen an Login, Fehlertexten, Session-Stream oder Nutzungsanzeige."
tags: ["sessions","sidecar","ui","telefon","stolperfalle"]
updated: "2026-10-15T06:27:43.271Z"
---

## Anmeldung ohne Code (BROWSER-Relay, `claude/setup.ts`)
- `claude auth login --claudeai` baut zwei Adressen: eine mit `redirect_uri=http://localhost:<port>/callback` (der CLI-Prozess lauscht dort, die Anmeldung schließt sich von selbst ab, wie im Terminal) und eine mit `redirect_uri=https://platform.claude.com/oauth/code/callback` (zeigt einen Code zum Einfügen; steht in der Ausgabe „If the browser didn't open, visit: …“).
- Die automatische Adresse gibt die CLI nur an das Programm in `BROWSER`. Früher setzte FORGE `BROWSER=none` und bekam nur die Code-Adresse.
- Jetzt: `browserRelay()` legt pro Anmeldung `%TEMP%\forge-login-*\open.cmd` an (`>"…\url.txt" echo %*`), `BROWSER` zeigt darauf. Die CLI ruft es mit der Adresse in Anführungszeichen auf; FORGE pollt `url.txt` (150 ms, erst lesen, wenn die Zeile mit Zeilenumbruch endet), setzt `url` (automatisch) und `codeUrl` (Code-Seite als Ausweg). Ruft die CLI `BROWSER` nicht innerhalb von `BROWSER_WAIT_MS` (3 s) nach der Code-Adresse auf, ist `url` die Code-Adresse und `codeUrl` null. Ordner wird bei Ende/Abbruch gelöscht.
- Geprüft am 2026-10-15 mit Claude Code 2.1.300: Aufruf kommt nach ~0,3 s, funktioniert auch mit Leerzeichen im Pfad.
- UI (`ClaudeLoginForm` in `ClaudeSetupCard.tsx`): mit `codeUrl` „Warte auf die Anmeldung im Browser …“, Knöpfe „Anmeldeseite erneut öffnen“, „Mit Code anmelden“ (öffnet `codeUrl`, zeigt das Code-Feld; `claude.submitLoginCode` geht weiter an stdin), „Abbrechen“.

## Pflicht-Anmeldung
- `useLoginRequired()` (`ClaudeLoginDialog.tsx`): Claude Code gefunden, `auth.checked` und nicht `loggedIn`. Dann zeigt `ClaudeLoginDialog` (Hauptfenster) den Dialog „Bei Claude anmelden“ mit `dismissable={false}` (neue Option von `components/ui/dialog.tsx`: kein X, Escape und Klick daneben wirkungslos). Er verschwindet erst, wenn die Diagnose die Anmeldung zeigt (nach `claude.setup` done lädt `server-events.ts` sie neu; Knopf „Weiter“ prüft erneut, falls das hängt). Ein offener angefragter Dialog (`claudeLogin`) wird dabei geschlossen, sonst käme er nach der Anmeldung wieder.
- Nicht über dem Einrichtungsassistenten (eigener Anmeldeschritt) und nicht, wenn Claude Code fehlt (dann ginge kein Pfad mehr einzustellen).
- Chat-Fenster: `ClaudeLoginRequiredNotice` (nicht schließbar, „Melde dich im FORGE-Hauptfenster an“), damit nicht jedes Fenster die Anmeldeseite öffnet.
- Nach einem Abmelden (auch vom Telefon) sendet der Sidecar `claude.setup` mit `task: null, phase: idle`; `server-events.ts` lädt daraufhin in allen Fenstern die Diagnose neu, der Pflicht-Dialog erscheint.

## Abgelaufene Anmeldung erkennen (Sidecar)
- `claude auth status` meldet auch bei abgelaufenem oder widerrufenem Token oft noch `loggedIn: true`. Verlässlich ist erst die Ablehnung in einer Session.
- `sessions/stream.ts`: Hauptagent-`assistant`-Nachricht mit `error: "authentication_failed"` markiert den Durchlauf; beim `turn.result` geht `claude.authRequired` raus (oder bei `is_error` und Text passend zu `isAuthFailure`). Höchstens einmal pro Durchlauf, nicht nach Stop. `lifecycle.ts` `onEnd` ebenso bei passendem Prozessfehler.
- Desktop öffnet dann den schließbaren Dialog „Claude-Anmeldung abgelaufen“ und lädt die Diagnose neu; zeigt die `loggedIn: false`, übernimmt der Pflicht-Dialog.

## Nutzung nach An-/Abmelden
- `RuntimeCatalog.invalidate()` leert auch `usageCache` (sonst lieferte `system.usage` bis zu 60 s die Werte von vorher). Aufgerufen nach `claude.setup` done (`app.ts`) und in `claude.logout`.

## Abmelden und Konto wechseln
- RPC `claude.logout` → `ClaudeSetupService.logout()`: `claude auth logout`, nicht während eines laufenden Schritts; setzt den Setup-Zustand auf idle. Handler leert `diagCache` und invalidiert den Katalog.
- Telefon: `forge_system` Aktion `claude_logout`, nur über `askKeypad`. Anmelden bleibt `NOT_ON_PHONE` (Browser am Rechner).
- Kontowechsel meldet nicht vorher ab (`claude auth login` überschreibt die Zugangsdaten). Ist im Browser noch das alte claude.ai-Konto angemeldet, muss man es dort wechseln.
- Einstiege: Seitenleiste unten links (Klick = Dropdown, Rechtsklick = gleiche Einträge aus `claudeAccountItems`), Einstellungen > Claude Code, Befehlspalette (`claude-login`, `claude-switch`, `claude-logout`), Startseite.

## Offen
- Nicht geprüft (Stand 2026-10-15): ob ein laufender CLI-Prozess neue Zugangsdaten nach Anmeldung oder Kontowechsel selbst übernimmt. Texte sagen „Nachricht erneut senden“ bzw. „spätestens nach einem Neustart“.
- Die Diagnose verwirft E-Mail und Organisation absichtlich (`readAuth`), das Menü zeigt nur das Abo.
