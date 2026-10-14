---
title: "Vorschau-Werkzeuge: Claude sieht die Web-App (Edge/Chrome über CDP)"
summary: "Wie preview_screenshot, preview_console und preview_interact funktionieren (headless Edge/Chrome per DevTools-Protokoll, ein Browser je Projekt), wie der Screenshot in die Chat-Karte kommt und welche Stolperfallen es mit Edge, CDP und Windows gibt."
tags: ["preview","forge-tools","browser","cdp","windows","chat","stolperfalle"]
updated: "2026-10-14T18:06:36.735Z"
---

## Aufbau (packages/sidecar/src/preview/)
- `url.ts`: `previewUrl({ url, path, base })` löst `path` gegen `url` bzw. die Dev-Server-Adresse auf und erlaubt nur http(s) auf `localhost`, `127.0.0.1`, `[::1]`. Geprüft wird das Ergebnis, also fängt das auch `path: "//fremd.example"` ab. `isLocalUrl` nutzt die Seite für Weiterleitungen.
- `browser.ts`: `findBrowser()` sucht Edge, dann Chrome unter `ProgramFiles(x86)`, `ProgramFiles`, `ProgramW6432`, `LOCALAPPDATA`. `launchBrowser()` startet `--headless=new` mit eigenem `--user-data-dir` (`%TEMP%/forge-preview-*`) und `--remote-debugging-port=0`, liest Port und WS-Pfad aus `DevToolsActivePort` im Profil und verbindet sich mit Nodes globalem `WebSocket` (keine Abhängigkeit, bündelt sauber in sidecar.mjs). `Cdp` ist ein minimaler Client; Seiten laufen als flache Sessions (`Target.attachToTarget` mit `flatten: true`).
- `page.ts` (`PreviewPage`): sammelt Konsole (`Runtime.consoleAPICalled`, `Log.entryAdded` ohne source network), Ausnahmen (`Runtime.exceptionThrown`), Netzwerkfehler (`responseReceived` mit Status >= 400, `loadingFailed`). `navigate` leert die Sammlung. Screenshot als JPEG (Qualität 70), längste Kante höchstens 1568 px über `clip.scale`, ganze Seite höchstens 6000 CSS-Pixel hoch. Klick über echte Mausereignisse an der Elementmitte, Tippen per `Input.insertText` (React bekommt das input-Event), Tasten über `parseKey` ("Control+a", "Shift+Tab", "Enter").
- `preview.ts` (`PreviewService`): ein Browser je Projekt-ID (Worktree = eigenes Projekt), Aufrufe je Projekt nacheinander (`exclusive`), schließt nach 5 Minuten ohne Aufruf (`Browser.close`). Ohne `url`/`path` nehmen `preview_console` und `preview_interact` die offene Seite, `preview_screenshot` lädt immer neu (Dev-Server-Adresse, sonst die offene Seite). Zeitlimits: Laden 20 s, Schritt 5 s (max. 15 s), alle Schritte 90 s.
- Werkzeuge in `sessions/forge-tools.ts` (`previewTools`), nur wenn `ProjectToolDeps.preview` gesetzt ist (app.ts). `preview_interact` hat `autoAllow: false` (Klicks können in der Dev-App Daten ändern), die anderen beiden laufen ohne Freigabe.
- `SessionTool.run` darf `ToolOutput { text, images }` liefern; `forgeServer` (claude/runtime.ts) macht daraus MCP-Inhalte `text` + `image`.

## Sicherheit
- Nur lokale Adressen. Zusätzlich fängt `Fetch.enable` mit `resourceType: "Document"` jede Navigation (auch Weiterleitungen und iframes) ab und lässt nur lokale Dokumente durch; Skripte, Fonts und API-Aufrufe der App laden normal. Eine Weiterleitung nach außen meldet `ERR_BLOCKED_BY_CLIENT` → deutsche Meldung „leitet auf eine Adresse außerhalb dieses Rechners um“.

## Screenshot im Chat
- Das Chat-Event `tool.result` speichert nur Text (Bilder werden zu „[Bild]“). Die Karte (`PreviewShot.tsx`) holt das Bild über `sessions.images` mit der seq des `tool.result`-Events aus dem Claude-Code-Transkript (`transcriptToolImages`). Das Ergebnis landet dort einen Moment nach dem Event, daher `retry: 4`. Platzhalter-Skeleton mit dem Seitenverhältnis aus der Zeile `Screenshot: <B>x<H> JPEG`.
- Die Karten hängen an den Ergebnistexten (Zeilen `Adresse:`, `Konsole:`, `Zusammenfassung:`, `Screenshot: BxH`, `Abgebrochen nach Schritt X von Y.`), siehe Eintrag forge-werkzeuge-im-chat-karten-haengen-an-den-ergebnistexten.

## Stolperfallen Windows / Edge / CDP
- Edge kann fehlen, obwohl `Program Files (x86)\Microsoft\Edge\Application` existiert (auf dem Entwicklungsrechner liegen dort nur `pwahelper.exe` und ein Versionsordner, Edge wurde entfernt). Deshalb immer auf `msedge.exe` prüfen und Chrome als Ersatz.
- Hartes Beenden (`taskkill /T /F`) lässt das Profil für einen Moment gesperrt; ein sofortiges `rmSync` scheitert dann komplett (auch mit `maxRetries`). Lösung: Beim Sidecar-Shutdown erst `closeAll()` (sauberes `Browser.close`, auf Prozessende warten, dann löschen; läuft im 5-s-Rennen von `app.shutdown`), danach `shutdown()` als harter Rest mit bis zu 20 Löschversuchen à 100 ms. `sweepProfiles()` räumt bei jedem Start leere und über 6 Stunden alte Profile weg (vorher `lockfile` löschen; das scheitert, solange ein Browser es offen hält).
- Stürzt der Sidecar ab, beendet das Job-Objekt der Desktop-Shell auch den Browser (er ist Kindprozess des Sidecars).
- `--remote-allow-origins` ist nicht nötig: Nodes WebSocket schickt keinen Origin-Header.
- Test: `test/preview.test.ts` startet einen echten Browser gegen einen lokalen node:http-Server und wird übersprungen, wenn `findBrowser()` nichts findet.
