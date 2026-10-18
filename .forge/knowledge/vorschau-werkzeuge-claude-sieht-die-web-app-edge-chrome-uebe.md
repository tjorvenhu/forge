---
title: "Vorschau-Werkzeuge: Claude sieht die Web-App (Edge/Chrome über CDP)"
summary: "Wie preview_screenshot, preview_console und preview_interact funktionieren (headless Edge/Chrome per DevTools-Protokoll, ein Browser und ein festes Profil je Projekt), wie der Screenshot in die Chat-Karte kommt und welche Stolperfallen es mit Edge, CDP, Hintergrund-Tabs und Windows gibt."
tags: ["preview","forge-tools","browser","cdp","windows","chat","stolperfalle"]
updated: "2026-10-18T14:24:53.326Z"
---

Stand: 2026-10-18.

## Aufbau (packages/sidecar/src/preview/)
- `url.ts`: `previewUrl({ url, path, base })` löst `path` gegen `url` bzw. die Dev-Server-Adresse auf und erlaubt nur http(s) auf `localhost`, `127.0.0.1`, `[::1]`. Geprüft wird das Ergebnis, also fängt das auch `path: "//fremd.example"` ab. `isLocalUrl` nutzt die Seite für Weiterleitungen.
- `browser.ts`: `findBrowser()` sucht Edge, dann Chrome unter `ProgramFiles(x86)`, `ProgramFiles`, `ProgramW6432`, `LOCALAPPDATA`. `launchBrowser(exe, timeout, keepProfile?)` startet `--headless=new` mit `--remote-debugging-port=0`, liest Port und WS-Pfad aus `DevToolsActivePort` im Profil und verbindet sich mit Nodes globalem `WebSocket`. Unbeantwortete Aufrufe werfen `CdpTimeout` (mit `method`).
- `page.ts` (`PreviewPage`): sammelt Konsole, Ausnahmen, Netzwerkfehler. `navigate` leert die Sammlung; `Page.navigate` darf 60 s dauern (`NAVIGATE_MS`, erster Aufruf eines Dev-Servers kompiliert oft noch). Screenshot JPEG Qualität 70, längste Kante höchstens 1568 px (`MAX_EDGE`). `fullPage()` liefert die ganze Seite (max. 6000 px) in Teilen von höchstens 1568 px Höhe in Viewport-Breite; früher wurde eine lange Seite in ein Bild gequetscht (390x6000 → 102x1568, unlesbar). Klick über echte Mausereignisse, Tippen per `Input.insertText`, Tasten über `parseKey`.
- Selektoren (`FIND_ALL`/`findElement` in page.ts): CSS plus die Playwright-Formen, die Claude gewohnheitsmäßig schreibt: `text=…` (innerstes Element mit dem Text, ohne script/style), `x:has-text("…")`, `xpath=…` bzw. `//…`, angehängtes `>> nth=N`. Texte ohne Groß-/Kleinschreibung.
- JavaScript-Dialoge (`Page.javascriptDialogOpening`): alert und beforeunload bestätigt, confirm und prompt abgelehnt (ein Klick löscht nie von selbst), als Warnung im Log.
- Nur das Fragment anders als die offene Seite (`/seite#abschnitt`): erst `about:blank`, sonst scrollt der Browser nur (kein frisches Laden, HTTP-Status „unbekannt“).
- `preview.ts` (`PreviewService`): ein Browser je Projekt-ID (Worktree = eigenes Projekt), Aufrufe je Projekt nacheinander (`exclusive`), schließt nach 5 Minuten ohne Aufruf. Ohne `url`/`path` nehmen `preview_console` und `preview_interact` die offene Seite, `preview_screenshot` lädt immer neu. Zeitlimits: Laden 20 s, Schritt 5 s (max. 15 s), alle Schritte 90 s.
- Werkzeuge in `sessions/forge-tools.ts` (`previewTools`), nur wenn `ProjectToolDeps.preview` gesetzt ist. `preview_interact` hat `autoAllow: false`.

## Festes Profil je Projekt (seit 2026-10-18)
Vorher bekam jeder Browser ein frisches Profil in TEMP und schloss nach 5 Minuten Leerlauf: Claude musste sich bei Apps mit Login ständig neu anmelden, Vorher/Nachher-Bilder zeigten nur die Anmeldeseite (homeklaus, byte-gleich).
- `app.ts`: `profileDir` = `%APPDATA%\forge\preview-profiles\<projectId>`; beim Start räumt `pruneProfiles` Ordner gelöschter Projekte weg. Ohne `profileDir` (Tests) weiter Wegwerf-Profil.
- `launchBrowser` mit `keepProfile`: löscht vorher ein altes `DevToolsActivePort` (zeigte sonst auf einen toten Port), Cache auf 50 MB begrenzt, Profil wird nie gelöscht.
- Sitzungs-Cookies (ohne Max-Age, häufig bei Logins) wirft ein Browser beim Beenden weg. Darum schreibt `keepCookies` nach jedem Aufruf die Sitzungs-Cookies lokaler Adressen (`Storage.getCookies`) nach `forge-session-cookies.json` im Profil (nur bei Änderung), `restoreCookies` spielt sie beim Start mit `Storage.setCookies` zurück. Dauerhafte Cookies und localStorage liegen ohnehin im Profil.
- Start mit festem Profil bis zu 3 Versuche im Abstand von 500 ms: ein eben beendeter Browser hält das Profil kurz gesperrt.
- Test „keeps logins in the project's profile across browser restarts, not across projects“.

## Stolperfalle Hintergrund-Tab (behoben 2026-10-18)
Die Vorher/Nachher-Bilder (`capture`, ui-compare) laufen in einem zweiten Tab desselben Browsers. Ein headless Browser zeichnet nur den Vordergrund-Tab: In Claudes Tab wartete `Page.captureScreenshot` danach auf ein Bild, das nie kam (30 s, „Browser antwortet nicht“), bei jedem weiteren Aufruf (homeklaus: 9 Fehlschläge in 6 Minuten). Lösung: `PreviewPage.activate()` (`Page.bringToFront`) vor jedem Werkzeug-Aufruf und vor jedem Vergleichsbild.

Zusätzlich: Jeder `CdpTimeout` (außer `Page.navigate`, das eine eigene Meldung hat) beendet den Browser des Projekts (`PreviewService.hung`), der nächste Aufruf startet frisch.

## Screenshot im Chat
- Das Chat-Event `tool.result` speichert nur Text. Die Karte (`PreviewShot.tsx`) holt die Bilder über `sessions.images` mit der seq des `tool.result`-Events aus dem Claude-Code-Transkript (`retry: 4`) und zeigt alle Teile untereinander. Platzhalter-Seitenverhältnis aus der Zeile `Screenshot: <B>x<H> JPEG` (Größe des ersten Teils).
- Die Karten hängen an den Ergebnistexten, siehe [[forge-werkzeuge-im-chat-karten-haengen-an-den-ergebnistexten]].

## Weitere Stolperfallen Windows / Edge / CDP
- Edge kann fehlen, obwohl `Program Files (x86)\Microsoft\Edge\Application` existiert. Deshalb immer auf `msedge.exe` prüfen und Chrome als Ersatz.
- Hartes Beenden lässt ein Profil kurz gesperrt. Beim Sidecar-Shutdown erst `closeAll()`, danach `shutdown()` als harter Rest. `sweepProfiles()` räumt beim Start alte Wegwerf-Profile in TEMP weg.
- Stürzt der Sidecar ab, beendet das Job-Objekt der Desktop-Shell auch den Browser.
- Test: `test/preview.test.ts` startet einen echten Browser gegen einen lokalen node:http-Server und wird übersprungen, wenn `findBrowser()` nichts findet.
