---
title: "Vorher/Nachher-Bilder bei UI-Änderungen (UiCompareService, ui.compare, uiCompare.*)"
summary: "Wie FORGE vor und nach einem Durchlauf Screenshots der Web-App macht, wenn Claude UI-Dateien ändert: Auslöser, Ablage im Datenordner, Chat-Karte, RPCs, Telefon, Grenzen. Wichtig beim Ändern von Turn-Start/-Ende, Vorschau oder der Karte."
tags: ["preview","chat","sessions","einstellungen","telefon"]
updated: "2026-10-16T18:53:43.136Z"
---

## Ablauf (packages/sidecar/src/preview/ui-compare.ts, `UiCompareService`)
- Turn-Start: `TurnAutomation.noteTurnStart` ruft `host.turnStarted` → `uiCompare.turnStarted`. Läuft der Session schon eine Beobachtung (Nachricht mitten im Durchlauf), passiert nichts. Vorher-Bild im Hintergrund (`track`, also von `drain()` abgewartet), nur wenn Einstellung `uiCompare` an, Dev-Server `running` mit Adresse und Edge/Chrome gefunden. Sonst still nichts.
- Seite: die zuletzt per Vorschau-Werkzeug in dieser Session angesehene (`PreviewService.lastViewed(sessionId)`, gesetzt in `header()` über `PreviewTarget.viewer`), sonst die Dev-Server-Adresse.
- Geänderte UI-Dateien: aus `tool.use`-Events (`SessionCore.onRecord` in session-service.ts) der Werkzeuge Edit/MultiEdit/Write mit `file_path` innerhalb des Session-Ordners und Endung .tsx .jsx .vue .svelte .css .scss .sass .less .html .astro. **Änderungen per Bash (sed, Codegeneratoren) werden nicht erkannt.** Bewusst kein git-status-Vergleich: auch Projekte ohne Git, und kein zusätzlicher Git-Prozess pro Durchlauf.
- Turn-Ende (`turn.result`, auch gestoppt/fehlgeschlagen): ohne UI-Dateien wird das Vorher-Bild gelöscht. Mit: Event `ui.compare` (nur compareId, url, files) wird nach dem Turn-Ergebnis geschrieben, dann `SETTLE_MS` (1,5 s) warten, Seite frisch laden (Next kompiliert beim Laden, Vite-HMR ist egal, weil neu navigiert wird), Nachher-Bild. Status `capturing` → `ready`/`failed` per Server-Event `uiCompare.updated` (ganzes `UiCompare`).
- Status `stopped`/`error` der Session oder Löschen der Session verwirft eine laufende Beobachtung (`drop`).
- Aufnahme: `PreviewService.capture` nutzt einen **eigenen Tab** (`Instance.compare`) im Projekt-Browser, in der Projekt-Warteschlange (`exclusive`). Claudes offene Seite, Log und Viewport bleiben unberührt. Immer 1280x800.

## Ablage und Aufräumen
- `<dataDir>/ui-compare/<id>/before.jpg, after.jpg, meta.json`. id = Zeit base36 + Zufall (sortierbar, Regex im RPC `^[a-z0-9-]{1,64}$`, weil Ordnername).
- `prune()` beim Start (app.ts) und nach jedem Vergleich: älter als 14 Tage, mehr als 100, oder Ordner ohne meta.json älter als 6 h.
- Bilder stehen nie im Event und gehen nie an Claude (kein Hinweis-Text, keine Tokens).

## RPC / UI
- `uiCompare.get`, `uiCompare.image` (Base64 aus Datei), `uiCompare.retake` (nimmt nur das Nachher-Bild neu auf, kehrt sofort mit `capturing` zurück), `uiCompare.latest` (Session oder Projekt).
- Desktop: `chat-items.ts` Kind `uiCompare`, Karte `components/workspace/UiCompareCard.tsx` (Ansichten Nebeneinander, Schieber, Vorher, Nachher; Klick öffnet `UiCompareDialog`; Rechtsklick: Bild öffnen, im Explorer zeigen, neu aufnehmen, Seite im Browser öffnen, Adresse kopieren). Bild-Query-Key enthält `takenAt`, damit ein neu aufgenommenes Bild neu geladen wird. Skeletons mit dem Seitenverhältnis des Vorher-Bilds.
- „Bild öffnen“ öffnet FORGEs eigene Vergrößerung, nicht das Windows-Bildprogramm: Dafür bräuchte es einen neuen Tauri-Befehl zum Öffnen beliebiger Dateien.
- Einstellung `uiCompare` (Claude-Bereich, Standard an), Palette: Schalter automatisch über `SETTING_TOGGLES`, Aktion „Letzten Vorher-Nachher-Vergleich öffnen“ (`PaletteDialog` kind `ui-compare`).
- Telefon: `forge_settings` `ui_compare`, `sessions` Aktionen `ui_compare` (Stand ansagen) und `ui_compare_retake`. `uiCompare.image` steht auf `NOT_ON_PHONE`.

## Kosten
Pro Durchlauf mit laufendem Dev-Server ein Seitenaufruf plus Screenshot (Browser startet einmal, bleibt 5 min offen). Ohne Dev-Server kein Aufwand außer einem `devServers.state`-Aufruf.
