---
title: "Telefon: neue Features anbinden (Abdeckung aller RPC-Methoden)"
summary: "Was man bei jeder neuen RPC-Methode für das Telefon tun muss, damit test/phone-coverage.test.ts grün bleibt, wie Telefon-Werkzeuge FORGE-Funktionen aufrufen und wie unumkehrbares Löschen per Tastatur-Code bestätigt wird."
tags: ["telefon","rpc","tests","projektregel","gemini","loeschen","bestaetigung"]
updated: "2026-10-13T21:01:31.942Z"
---

Projektregel: Das Telefon soll alles steuern können, was FORGE kann.

## Absicherung
- `packages/sidecar/src/phone/coverage.ts`: `PHONE_TOOL_FOR` (RPC-Methode -> Name des Telefon-Werkzeugs) und `NOT_ON_PHONE` (RPC-Methode -> Grund, warum nicht am Telefon).
- `packages/sidecar/test/phone-coverage.test.ts` schlägt fehl, wenn eine Methode aus `methods` in `packages/protocol/src/rpc.ts` in keiner der beiden Listen steht, doppelt steht, eine Ausnahme keinen Grund hat oder ein genanntes Werkzeug nicht in `PHONE_TOOLS` existiert.
- Neue RPC-Methode: zuerst überlegen, ob ein vorhandenes Werkzeug sie per `action` übernehmen kann (Gemini Live verträgt keine sehr lange Werkzeugliste; lieber `action`-Enums wie bei `git`, `project`, `extensions`, `forge_system`). Nur echte UI-/Browser-/Dateidialog-Methoden kommen auf `NOT_ON_PHONE`.

## Wie ein Werkzeug eine FORGE-Funktion aufruft
- `PhoneDeps.rpc` (`PhoneRpc`) ruft die RPC-Handler über `invokeHandler` (`packages/sidecar/src/rpc/handlers.ts`) auf: gleiche zod-Prüfung, Defaults und Nebenwirkungen wie aus der UI (z. B. `settings.update` sendet `settings.updated`, `projects.update` wendet das Profil an). Verdrahtet in `app.ts`; `handlers` existiert erst nach dem PhoneService, deshalb die späte Zuweisung.
- Im PhoneService: `call("methode", params)` in `toolsFor`. Handler, die selbst kein `project.updated` senden (projects.create/import/clone/update/remove), braucht danach `projectChanged(id)`, sonst sieht die UI die Änderung nicht.

## Pro neuem Werkzeug
1. `PhoneToolset` + Eintrag in `PHONE_TOOLS` (`phone/tools.ts`), Systemprompt-Liste „Du kannst:“ ergänzen.
2. Umsetzung in `phone-service.ts` mit `run(true, ...)`: alles, was Daten zeigt oder ändert, braucht die PIN. Ohne PIN gehen nur `status` (nur Zahlen), `usage`, `call_back`, `hang_up`, Lesen von `call_settings` und die status-Varianten. Der Test „locks every tool that reads or steers until the PIN“ in `phone-call.test.ts` ruft jedes Werkzeug vor der PIN auf und erwartet „Gesperrt“; neue PIN-freie Werkzeuge müssen dort bewusst in die Ausnahmeliste.
3. Texte aus Projekten/Sessions mit `asData`/`excerptData` einpacken. Werte von Umgebungsvariablen nie zurückgeben (dev_settings nennt nur Namen).
4. Fakes in `test/phone-live.test.ts` (`toolset()`) und `test/e2e/real-claude.e2e.test.ts` um die neue Methode ergänzen, sonst schlägt der Typecheck fehl.
5. Tests im Stil von `phone-call.test.ts`: `rpcResults[methode] = (params) => ...` setzen, `openCall(id)` öffnet einen Anruf ohne PIN, `rpcCalls` zeigt die Aufrufe, `phoneEnd.digits("123#")` tippt auf der Tastatur.

## Unumkehrbares Löschen: Bestätigung über die Tastatur
- Anlass (2026-10-13): Am Telefon hat das Modell ohne Rückfrage `project remove` mit `delete_github_repo` (und Ordner) ausgeführt; der Systemprompt sagt „keine Rückfrage“, und das Modell kann „Remote-Branch löschen“ mit „Repository löschen“ verwechseln. Eine Rückfrage im Gespräch reicht nicht, das Modell kann sie überspringen.
- Lösung: `project remove` mit `deleteFolder` oder `deleteGitHubRepo` löscht nicht sofort. Es legt `a.confirm` (`PendingConfirm` in `phone-service.ts`: dreistelliger Zufallscode, 2 Minuten gültig, `run`) an und antwortet „Bestätigung nötig …“ mit dem Code. Der Anrufer tippt Code + `#`, `*` bricht ab, falscher Code verwirft die Anfrage. Erst dann läuft `projects.remove`; das Ergebnis kommt als `[FORGE: …]`-Notiz ins Gespräch.
- Weg der Tasten: Beide Controller (`call-controller.ts`, `live-controller.ts`) fragen zuerst `deps.onDigit` (→ `PhoneService.confirmDigit`); nur wenn keine Bestätigung offen ist, gehen die Ziffern ans `PinPad`. Eine offene Bestätigung gibt es nur nach der PIN, weil das Werkzeug vorher gesperrt ist.
- Neue Telefon-Aktionen, die Daten unwiderruflich vernichten (Ordner, Repositorys auf dem Server), sollen denselben Weg nehmen: `a.confirm` setzen statt direkt löschen.

## Bewusste Einschränkungen
- Backup-Wiederherstellung am Telefon lässt den Teil `phone` weg: `phone.reload()` trennt die Leitung und beendet das laufende Gespräch.
- Hooks nur lesen (JSON mit Shell-Befehlen per Diktat ist zu riskant), Skill-Dateien nur anlegen/lesen/löschen, nicht umschreiben.
- Die Berechtigung `delete_repo` für GitHub lässt sich nur am Computer erteilen (Gerätefluss im Browser); am Telefon meldet `project remove` dann einen Fehler.
