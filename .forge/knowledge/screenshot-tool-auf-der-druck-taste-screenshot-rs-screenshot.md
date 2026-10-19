---
title: "Screenshot-Tool auf der Druck-Taste (screenshot.rs, ScreenshotOverlay, screenshotKey, ShareX)"
summary: "Wie FORGEs Snipping-Tool die Druck-Taste vor ShareX und Co. bekommt (Hook plus RegisterHotKey), warum ShareX bei Admin-Fenstern trotzdem gewinnt, Overlay, Zwischenablage, Chat-Anhang, macOS/Linux; wichtig bei Änderungen an Overlay, Hook, Anhängen oder Fenstern."
tags: ["screenshot","tauri","windows","anhaenge","stolperfalle"]
updated: "2026-10-19T18:37:23.055Z"
---

# Screenshot-Tool auf der Druck-Taste

Eingebaut 2026-10-15 („wie das moderne Snipping Tool“, „Forge muss alle Screenshot-Tools überschreiben“; der Nutzer hat ShareX mit Druck-Taste installiert). Code: `apps/desktop/src-tauri/src/screenshot.rs`, `apps/desktop/src/components/screenshot/`, `lib/screenshot.ts`.

## Wie die Taste zu FORGE kommt (Windows)
1. **Low-Level-Hook** (`WH_KEYBOARD_LL`, Modul `hook`, eigener Thread, `THREAD_PRIORITY_TIME_CRITICAL`, ohne Energiespar-Drosselung, alle 2 s neu gesetzt). Schluckt `VK_SNAPSHOT`, solange die Einstellung `screenshotKey` an ist; Alt/Win+Druck bleiben bei Windows. Ein geschluckter Tastendruck erzeugt kein `WM_HOTKEY`, deshalb gewinnt FORGE gegen ShareX (`RegisterHotKey`).
2. **Zusätzlich `RegisterHotKey(VK_SNAPSHOT, MOD_NOREPEAT)`** auf demselben Thread (seit 2026-10-19), bei jedem 2-s-Takt erneut versucht, freigegeben wenn die Einstellung aus ist. `WM_HOTKEY` kommt nur, wenn der Hook die Taste nicht gesehen hat.
- **Stolperfalle, Ursache für „öffnet nur manchmal, ShareX kommt“ (2026-10-19):** Windows ruft Low-Level-Hooks normaler Programme **nicht** auf, solange ein Fenster mit Administratorrechten vorne ist (Task-Manager, Admin-Terminal). Im Protokoll fehlte bei jedem ShareX-Auslöser die Zeile „Druck gedrückt“. Ein registrierter Hotkey kommt auch dann an, aber nur einer kann die Taste registrieren: hält ShareX sie (`RegisterHotKey` scheitert mit 1409 `ERROR_HOTKEY_ALREADY_REGISTERED`), gewinnt ShareX in diesem Fall. Abhilfe nur beim Nutzer: Druck-Taste in ShareX austragen.
- `screenshot_key_status` meldet das (`takenByOther`, `other` = laufendes bekanntes Tool aus `TOOLS` per ToolHelp-Prozessliste: ShareX, Greenshot, Lightshot, Snagit, …, Dropbox, OneDrive). Die Einstellung zeigt es als Warnung (`ScreenshotKeyRow.tsx`, fragt alle 5 s).
- Prüfen von Hand: PowerShell `Add-Type` mit `RegisterHotKey(0, id, 0x4000, 0x2C)`; `False` + 1409 = ein anderes Programm hält die Taste.
- **Protokoll:** `%LOCALAPPDATA%\de.vanturis.forge\logs\screenshot.log` (Unix-Sekunden): Hook gesetzt, jede Druck-Taste mit `verzögert=…ms`, „Druck über das Tastenkürzel, der Hook wurde nicht aufgerufen“, Registrierung bei FORGE/anderem Programm, Overlay-Neuladen, Fehler. ShareX-Protokoll: `%USERPROFILE%\Documents\ShareX\Logs\ShareX-Log-<Jahr>-<Monat>.txt` („Hotkey triggered“, Ortszeit). Abgleich: ShareX-Zeit in Unix-Sekunden umrechnen (`[DateTimeOffset]::FromUnixTimeSeconds(..).LocalDateTime`) und nebeneinanderlegen.

## macOS und Linux
Tastenkürzel über `tauri-plugin-global-shortcut` (zur Laufzeit per `app.plugin` registriert): macOS ⌘⇧2 (3 bis 6 belegt macOS selbst), Linux Druck (unter Wayland keine globalen Kürzel: Registrierung scheitert, Hinweis in der Einstellung, Befehlspalette geht). Aufnahme mit `xcap`, nur der Monitor unter dem Mauszeiger (keine gemeinsame Pixelfläche bei unterschiedlicher Skalierung; xcap zählt auf macOS in Punkten, auf X11 in Pixeln, `grab::virtual_screen` gleicht das ab). macOS braucht die Erlaubnis „Bildschirmaufnahme“; Fehler gehen als `screenshot://error` ans Fenster und erscheinen als Meldung. Overlay auf macOS über `NSScreenSaverWindowLevel` (über Menüleiste und Dock), auf Linux `set_fullscreen_on_monitor`. Zwischenablage mit `arboard` (Linux: Instanz bleibt in einem static, sonst ist der Inhalt weg).

## Ablauf nach dem Tastendruck
- Aufnahme Windows: GDI `BitBlt` des ganzen virtuellen Bildschirms (`CAPTUREBLT`), Monitore aus Tauri, Fenster per `EnumWindows` + `DWMWA_EXTENDED_FRAME_BOUNDS`.
- Overlay-Fenster `screenshot` wird beim Einschalten versteckt vorgebaut (nur auf dem Capture-Thread bauen: WebviewWindow aus synchronem Command baut auf Windows Deadlocks). `main.tsx` rendert dort nur `ScreenshotOverlay`. Es holt das Bild als BMP (`screenshot_image`) und ruft `screenshot_ready` erst nach dem Zeichnen; Rust zeigt dann Fenster und fokussiert Fenster **und** Webview.
- **Wächter:** Zeichnet das Overlay nicht innerhalb von 3 s (`SHOWN` ≠ Frame-Id), wird es einmal neu geladen (die Seite fragt den Frame selbst mit `screenshot_frame`), danach Meldung an den Nutzer.
- Esc/Enter fängt der Hook ab, solange das Overlay offen ist (`screenshot://key`); die Seite hat denselben keydown-Handler für macOS/Linux.
- Fertig: Overlay setzt das Bild zusammen (`compose.ts`) und schickt RGBA an `screenshot_take`; Rust legt es immer in die Zwischenablage (`CF_DIB` auf Windows) und bei `x-forge: 1` per `screenshot://taken` an das zuletzt fokussierte FORGE-Fenster; `startScreenshotReceiver` hängt es an den zuletzt benutzten Composer.

## Overlay-Bedienung
Modi Rechteck/Freihand/Fenster/Bildschirm, Werkzeuge Auswahl/Stift/Marker/Pfeil/Rahmen/Text/Nummer/Verpixeln, 7 Farben, Rückgängig/Wiederholen/Kopieren mit Strg (Mac: ⌘, Wiederholen ⌘⇧Z über `hasPrimaryModifier`). Beschriftungen immer sichtbar (Wunsch des Nutzers). Tooltips bleiben per `MonitorBox`-boundary auf dem Monitor. Markierungen als SVG mit Stil-Attributen (keine Klassen, sonst fehlen sie im Bild). Text-Werkzeug braucht `preventDefault` im pointerdown.

## Prüfen
- Rust: `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --lib screenshot` in `apps/desktop/src-tauri`; macOS-Cross-Check siehe [[macos-und-linux-plattform-vertrag-laufzeit-updates-pruefen-o]].
- Overlay im Browser: temporäre HTML-Seite im Projekt mit `window.__FORGE_SCREENSHOT__ = true` und Stub für `window.__TAURI_INTERNALS__` (`invoke`, `transformCallback`, `plugin:event|listen`) und `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`; eigener Vite, Vorschau-Werkzeuge; danach Seite löschen, Vite mit TaskStop beenden.
- Weitere Einstiege: Palette „Screenshot aufnehmen“ (`screenshot_start`), Schalter in Einstellungen > Allgemein > Bedienung, Telefon `forge_settings` mit `screenshot_key`. Die Aufnahme selbst gibt es am Telefon nicht.
