---
title: "Eigene Hintergrund-Server beenden (TaskStop, danach Port prüfen)"
summary: "Wie Claude einen selbst gestarteten Hintergrund-Server (z. B. Vite für eine Vorschau) zuverlässig beendet: TaskStop lässt den node-Prozess manchmal weiterlaufen, netstat-Statussuche greift auf deutschem Windows nicht."
tags: ["hintergrund","windows","stolperfalle","preview"]
updated: "2026-10-16T21:33:41.617Z"
---

## Problem 1 (2026-10-15): netstat auf deutschem Windows
Für die Vorschau des Screenshot-Overlays lief `pnpm exec vite --port 1437` als Hintergrundaufgabe (Bash mit run_in_background). Zum Aufräumen suchte Claude den Prozess mit `netstat -ano | grep LISTENING`. Das Windows hier ist deutsch: netstat schreibt `ABHÖREN` statt `LISTENING` (und `HERGESTELLT`, `FIN_WARTEN_2` …). Die Suche fand nichts, Vite lief weiter, und im FORGE-Chat stand die Hintergrundaufgabe offen, bis der Nutzer die Session schloss.

## Problem 2 (2026-10-16): TaskStop lässt node übrig
`TaskStop` auf `pnpm exec vite --port 1437 --strictPort` meldete Erfolg und schloss die Aufgabe, der node-Prozess (`...\vite\bin\vite.js --port 1437`) lief aber weiter. Der nächste Start auf demselben Port scheiterte mit Exit 1 (Port belegt); die Vorschau zeigte trotzdem die neuen Dateien, weil der alte Vite dasselbe Verzeichnis ausliefert.

## So geht es
- Selbst gestartete Hintergrundaufgaben mit **TaskStop** und ihrer Task-ID beenden (schließt die Aufgabe in FORGE).
- **Danach immer den Port prüfen** (PowerShell): `Get-NetTCPConnection -LocalPort <port> -State Listen` und zum Besitzer `Get-CimInstance Win32_Process -Filter "ProcessId = <OwningProcess>"`. Nur wenn die CommandLine der eigene Vite mit diesem Port ist: `Stop-Process -Id <pid> -Confirm:$false`.
- Ports nicht über die netstat-Statusspalte suchen; wenn doch, nach `ABH` (ABHÖREN) filtern.
- Verbindungen in `FIN_WARTEN_2`/`SCHLIESSEN_WARTEN` zu einem schon beendeten Prozess sind nur auslaufende Sockets; der zweite Prozess daran ist meist der Browser der Vorschau-Werkzeuge (schließt nach 5 Minuten ohne Aufruf selbst).
