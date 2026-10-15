---
title: "Eigene Hintergrund-Server beenden (TaskStop statt netstat-Suche)"
summary: "Wie Claude einen selbst gestarteten Hintergrund-Server (z. B. Vite für eine Vorschau) zuverlässig beendet; die Suche über netstat nach LISTENING greift auf diesem deutschen Windows nicht, und die offene Hintergrundaufgabe blieb im FORGE-Chat stehen."
tags: ["hintergrund","windows","stolperfalle","preview"]
updated: "2026-10-15T07:54:52.232Z"
---

## Problem (2026-10-15)
Für die Vorschau des Screenshot-Overlays lief `pnpm exec vite --port 1437` als Hintergrundaufgabe (Bash mit run_in_background). Zum Aufräumen suchte Claude den Prozess mit `netstat -ano | grep LISTENING` und beendete ihn mit `taskkill`. Das Windows hier ist deutsch: netstat schreibt `ABHÖREN` statt `LISTENING` (und `HERGESTELLT`, `FIN_WARTEN_2` …). Die Suche fand nichts, `xargs -r` tat still nichts, Vite lief weiter. Im FORGE-Chat stand danach die Hintergrundaufgabe „Start Vite dev server for overlay preview“ offen, bis der Nutzer die Session schloss.

## So geht es
- Selbst gestartete Hintergrundaufgaben mit dem Werkzeug **TaskStop** und ihrer Task-ID beenden. Das beendet den ganzen Prozessbaum (bash, pnpm, cmd, node) und schließt die Aufgabe in FORGE.
- Danach prüfen, dass nichts übrig ist, z. B. PowerShell: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vite' -and $_.CommandLine -match '<port>' }`.
- Ports nicht über die netstat-Statusspalte suchen; wenn doch, nach `ABH` (ABHÖREN) filtern oder `Get-NetTCPConnection -LocalPort <port> -State Listen` nehmen.
- Verbindungen in `FIN_WARTEN_2`/`SCHLIESSEN_WARTEN` zu einem schon beendeten Prozess sind nur auslaufende Sockets; der zweite Prozess daran ist meist der Browser der Vorschau-Werkzeuge (schließt nach 5 Minuten ohne Aufruf selbst).
