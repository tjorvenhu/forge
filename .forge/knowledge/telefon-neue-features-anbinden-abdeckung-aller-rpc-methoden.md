---
title: "Telefon: neue Features anbinden (Abdeckung aller RPC-Methoden)"
summary: "Was man bei jeder neuen RPC-Methode für das Telefon tun muss, damit test/phone-coverage.test.ts grün bleibt, wie Telefon-Werkzeuge FORGE-Funktionen aufrufen und welche Aktionen nur nach Tastatur-Code laufen (askKeypad)."
tags: ["telefon","rpc","tests","projektregel","gemini","loeschen","bestaetigung"]
updated: "2026-10-14T15:49:20.549Z"
---

Projektregel: Das Telefon soll alles steuern können, was FORGE kann.

## Absicherung
- `packages/sidecar/src/phone/coverage.ts`: `PHONE_TOOL_FOR` (RPC-Methode -> Name des Telefon-Werkzeugs) und `NOT_ON_PHONE` (RPC-Methode -> Grund, warum nicht am Telefon).
- `packages/sidecar/test/phone-coverage.test.ts` schlägt fehl, wenn eine Methode aus `methods` in `packages/protocol/src/rpc.ts` in keiner der beiden Listen steht, doppelt steht, eine Ausnahme keinen Grund hat oder ein genanntes Werkzeug nicht in `PHONE_TOOLS` existiert.
- Neue RPC-Methode: zuerst überlegen, ob ein vorhandenes Werkzeug sie per `action` übernehmen kann (Gemini Live verträgt keine sehr lange Werkzeugliste; lieber `action`-Enums wie bei `git`, `project`, `extensions`, `forge_system`). Nur echte UI-/Browser-/Dateidialog-Methoden kommen auf `NOT_ON_PHONE`.

## Wie ein Werkzeug eine FORGE-Funktion aufruft
- `PhoneDeps.rpc` (`PhoneRpc`) ruft die RPC-Handler über `invokeHandler` (`packages/sidecar/src/rpc/handlers.ts`) auf: gleiche zod-Prüfung, Defaults und Nebenwirkungen wie aus der UI. Verdrahtet in `app.ts`; `handlers` existiert erst nach dem PhoneService, deshalb die späte Zuweisung.
- Im PhoneService: `call("methode", params)` in `toolsFor`. Handler, die selbst kein `project.updated` senden (projects.create/import/clone/update/remove), braucht danach `projectChanged(id)`, sonst sieht die UI die Änderung nicht. Ändert das Telefon Daten direkt über einen Dienst (z. B. DevToolsService in dev_settings), ebenfalls `project.updated` senden.

## Pro neuem Werkzeug
1. `PhoneToolset` + Eintrag in `PHONE_TOOLS` (`phone/tools.ts`), Systemprompt-Liste „Du kannst:“ ergänzen.
2. Umsetzung in `phone-service.ts` mit `run(true, ...)`: alles, was Daten zeigt oder ändert, braucht die PIN. Ohne PIN gehen nur `status` (nur Zahlen), `usage`, `call_back`, `hang_up`, Lesen von `call_settings` und die status-Varianten. Der Test „locks every tool that reads or steers until the PIN“ in `phone-call.test.ts` ruft jedes Werkzeug vor der PIN auf und erwartet „Gesperrt“.
3. Texte aus Projekten/Sessions mit `asData`/`excerptData` einpacken, auch alles, was in den Systemprompt geht (der Anlass eines ausgehenden Anrufs enthält Session-Titel und Rückruf-Texte). Werte von Umgebungsvariablen nie zurückgeben; sensible Dateien (`isSensitiveFile`: .env, Schlüssel, credentials) werden weder vorgelesen noch als Diff gezeigt.
4. Fakes in `test/phone-live.test.ts` (`toolset()`) und `test/e2e/real-claude.e2e.test.ts` um die neue Methode ergänzen, sonst schlägt der Typecheck fehl.
5. Tests im Stil von `phone-call.test.ts`: `rpcResults[methode] = (params) => ...` setzen, `openCall(id)` öffnet einen Anruf ohne PIN, `rpcCalls` zeigt die Aufrufe, `phoneEnd.digits("123#")` tippt, `keypad(conv, antwort)` tippt den Code einer Rückfrage und liefert die Ergebnis-Notiz.

## Unumkehrbares nur nach Tastatur-Code (askKeypad)
- Anlass (2026-10-13): Am Telefon hat das Modell ohne Rückfrage `project remove` mit `delete_github_repo` ausgeführt. Eine Rückfrage im Gespräch reicht nicht, das Modell kann sie überspringen oder missverstehen.
- `askKeypad(what, act, nothingYet?)` in `toolsFor` legt `a.confirm` an (`PendingConfirm`: dreistelliger Zufallscode, 2 Minuten) und antwortet „Bestätigung nötig, … Sag dem Anrufer: <what>. Zum Bestätigen tippt er … <Code> und dann Raute …“. Erst Code + `#` führt `act` aus; das Ergebnis kommt als `[FORGE: Über die Tastatur bestätigt. Ergebnis: …]`. `*` bricht ab, falscher Code verwirft, abgelaufener Code meldet sich beim `#`. Ein offener Code wird nie still ersetzt (zweite Anfrage bekommt einen Fehler).
- Über askKeypad laufen (Stand 2026-10-14): `project remove` (immer, auch nur aus FORGE: die Session-Historie geht mit), `sessions delete`/`delete_all`, `git delete_branch` mit force, `remove_agent` mit force oder delete_branch, `finish_agent` discard, `forge_system sync_force` (mit `expectRemove`: hat sich bis zum Code geändert, welche Projekte entfernt würden, passiert nichts).
- Neue Telefon-Aktionen, die Daten unwiderruflich vernichten, gehören ebenfalls über askKeypad.
- Weg der Tasten: Beide Controller fragen zuerst `deps.onDigit` (→ `PhoneService.confirmDigit`), sonst geht es ans `PinPad`. Eine Bestätigung gibt es nur nach der PIN. DTMF zählt pro Anruf nur aus der ersten Quelle (RTP-Event oder SIP INFO), manche Telefone senden beides.

## Gemini Live
- Werkzeug-Ergebnisse während einer Neuverbindung (`goAway`) gehen als FORGE-Notiz in die Warteschlange, sonst ruft das Modell das Werkzeug erneut auf.
- Zieht Gemini einen Werkzeugaufruf zurück (Unterbrechung), lief er meist schon: Das Ergebnis kommt als Notiz.

## Bewusste Einschränkungen
- Backup-Wiederherstellung und `sync_restore` am Telefon lassen den Teil `phone` weg: `phone.reload()` trennt die Leitung und beendet das laufende Gespräch. Synchronisierte Telefon-Einstellungen und Geheimnisse greifen erst nach dem Gespräch.
- Hooks nur lesen, Skill-Dateien nur anlegen/lesen/löschen, nicht umschreiben.
- Die Berechtigung `delete_repo` für GitHub und das Sync-Passwort gibt es nur am Computer.
- Bei belegter Leitung wird ein Benachrichtigungsanruf nach der Pause erneut versucht (und verfällt, wenn der Anlass vorbei ist).
