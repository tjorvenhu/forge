---
title: "Screenshot-Tool auf der Druck-Taste (screenshot.rs, ScreenshotOverlay, screenshotKey)"
summary: "Wie FORGEs Snipping-Tool die Druck-Taste vor ShareX und Co. abfängt, den Bildschirm aufnimmt, im Overlay auswählen und markieren lässt und das Bild in Zwischenablage und Chat-Anhang bringt; wichtig bei Änderungen an Overlay, Hook, Anhängen oder Fenstern."
tags: ["screenshot","tauri","windows","anhaenge","ui","stolperfalle"]
updated: "2026-10-15T07:53:08.691Z"
---

Eingebaut 2026-10-15 auf Wunsch des Nutzers („wie das moderne Snipping Tool“, „Forge muss alle Screenshot-Tools überschreiben“, der Nutzer hat ShareX installiert).

## Ablauf
1. **Druck-Taste** (`apps/desktop/src-tauri/src/screenshot.rs`, Modul `hook`): `WH_KEYBOARD_LL`-Hook auf eigenem Thread mit Message-Loop. Schluckt `VK_SNAPSHOT` (Key-down und Key-up), wenn `ENABLED` (Einstellung `screenshotKey`, Standard an; der Hauptfenster-Hook `useScreenshotKey` in `lib/screenshot.ts` meldet sie per `screenshot_set_enabled`). Alt+Druck und Win+Druck bleiben bei Windows. Der Hook muss sofort zurückkehren, die Arbeit geht per Channel an den Thread `forge-screenshot`.
   - **Vor anderen Tools bleiben:** Windows ruft den zuletzt gesetzten Low-Level-Hook zuerst. Der Hook wird deshalb alle 5 s neu gesetzt (Thread-Timer `SetTimer` ohne Fenster, neuen Hook setzen, alten lösen). Das holt FORGE vor später gestartete Tools und bringt den Hook zurück, falls Windows ihn nach einer Zeitüberschreitung still entfernt hat. Tools mit `RegisterHotKey` (ShareX, Greenshot) werden vom Schlucken im Hook übergangen (wie AutoHotkey es macht).
   - **Eingespeiste Tasten zählen mit** (`LLKHF_INJECTED` wird nicht mehr ausgefiltert): Tastatur-Software (PowerToys, Logi Options, AutoHotkey, Fernsteuerung) liefert Tasten als eingespeist. In der ersten Fassung (0.1.70) wurden sie ignoriert, Druck, Esc und Enter kamen deshalb beim Nutzer nicht an.
   - Ausgelöst wird einmal pro Druck: bei Key-down, oder bei Key-up, wenn kein Key-down kam (`PRINT_DOWN`).
   - **Protokoll:** `%LOCALAPPDATA%\de.vanturis.forge\logs\screenshot.log` (`app_log_dir`): Hook gesetzt oder Fehlercode, jede Druck-Taste mit an/alt/win/eingespeist, Einstellung an/aus, Fehler der Aufnahme. Ab 256 KB beginnt die Datei neu. Erste Anlaufstelle, wenn die Taste nicht bei FORGE ankommt.
2. **Aufnahme** (`grab::virtual_screen`): GDI `BitBlt` des ganzen virtuellen Bildschirms (alle Monitore, physische Pixel, `CAPTUREBLT`), Alpha auf 255. Dazu Monitore (Tauri) und sichtbare Top-Level-Fenster in Z-Reihenfolge (`EnumWindows`, ohne unsichtbare/minimierte/cloaked, Rahmen über `DWMWA_EXTENDED_FRAME_BOUNDS`), alles relativ zum Ursprung des Frames.
3. **Overlay-Fenster** `screenshot`: wird beim Einschalten der Einstellung versteckt vorgebaut (Trigger `Prepare`) und danach nur versteckt, damit es sofort erscheint. Bauen nur auf dem Capture-Thread (WebviewWindow aus synchronem Command baut auf Windows Deadlocks). `window.__FORGE_SCREENSHOT__` per initialization_script; `main.tsx` rendert dann nur `ScreenshotOverlay` (kein Sidecar, keine Presence). Capability `capabilities/screenshot.json` (nur `core:event:default`). `set_always_on_top` lässt das Overlay aus.
4. Overlay holt das Bild als BMP (`screenshot_image`, `ipc::Response`) und ruft `screenshot_ready` erst nach dem Zeichnen. Rust zeigt dann das Fenster und fokussiert Fenster **und** Webview (`w.set_focus()` und `w.as_ref().set_focus()`; ein aktives Fenster allein gibt der Seite die Tasten nicht). Die Seite fokussiert danach ihr Wurzel-Element (`tabIndex=-1`).
5. **Esc und Enter** fängt der Hook ab, solange das Overlay offen ist (`OVERLAY_OPEN`), und schickt `screenshot://key` mit `Escape`/`Enter`: Das Overlay hat nicht immer den Tastaturfokus. `special()` im Overlay: Esc schließt das Textfeld, bricht ein laufendes Ziehen ab oder schließt das Overlay; Enter setzt den Text oder sendet an FORGE. Der eigene keydown-Handler der Seite tut dasselbe, falls der Hook nicht läuft.
6. **Fertig**: Das Overlay setzt das Bild selbst zusammen (`components/screenshot/compose.ts`: Canvas mit Ausschnitt, Freihand-Clip, darüber das Markierungs-SVG per XMLSerializer als data-URL) und schickt RGBA als Raw-Body an `screenshot_take` (Header `x-width`, `x-height`, `x-forge`). Rust: RGBA→BGRA (Transparentes wird weiß), **immer** `CF_DIB` in die Zwischenablage (Zeilen von unten), bei `x-forge: 1` BMP merken und `screenshot://taken` an das zuletzt fokussierte FORGE-Fenster (`WindowEvent::Focused` in `lib.rs`, main oder chat-*).
7. **Im Chat**: `startScreenshotReceiver` (jedes FORGE-Fenster) holt die Bytes einmalig (`screenshot_taken`), lädt sie wie eingefügte Bilder hoch (`uploadPasted` aus `useAttachments.ts`, wird zu PNG ≤ 2000 px) und hängt sie an den Entwurf von `screenshotTarget()`: zuletzt fokussierter Composer (`registerComposer`/`composerFocused` in `Composer.tsx`), sonst Hauptchat, sonst Chat des offenen Projekts (`activeDraftKey`). Das X am Anhang entfernt ihn; die Zwischenablage bleibt.

## Overlay (`components/screenshot/`)
- Modi: Rechteck (R), Freihand (F), Fenster (W), Bildschirm (B); Fenster und Bildschirm heben beim Überfahren hervor. Alles außerhalb der Auswahl ist zu 50 % abgedunkelt (SVG-Maske), Lupe mit Pixelposition und Farbwert, Fadenkreuz, Größenanzeige.
- Nach der Auswahl: Auswahl (V, verschieben und Ziehpunkte), Stift (P), Marker (M), Pfeil (A), Rahmen (R), Text (T), Nummer (N), Verpixeln (X), 7 Farben aus Theme-Tokens, Rückgängig/Wiederholen (Strg+Z/Y), Kopieren (Strg+C, nur Zwischenablage), An FORGE (Enter). Modus, Werkzeug und Farbe merkt sich `localStorage` `forge.snip`.
- **Beschriftungen immer sichtbar** (Wunsch des Nutzers): Jeder Knopf zeigt Symbol und Namen (`BarButton`), der Tooltip nennt, was er tut, und die Taste.
- **Tooltips bleiben auf dem Monitor:** Das Overlay spannt über alle Monitore samt Lücken dazwischen; Radix hielt Tooltips nur im Fenster und schob sie so aus dem sichtbaren Bild. Jede Leiste legt ein unsichtbares `MonitorBox`-Element über ihren Monitor und gibt es als `boundary` an `Tooltip` (neue Props `side` und `boundary` in `components/ui/misc.tsx`).
- **Verpixeln** zeigt schon beim Aufziehen die Verpixelung und einen gestrichelten Rahmen (nur in `drawing`, kommt nicht ins Bild).
- Markierungen liegen in physischen Frame-Koordinaten. Alle Stile als SVG-Attribute (keine Klassen), sonst fehlen sie im serialisierten Bild. Schrift `Segoe UI`.
- Stolperfalle Text-Werkzeug: Ohne `preventDefault` im pointerdown nimmt der Klick dem gerade erzeugten Textfeld sofort den Fokus, `onBlur` verwirft es.

## Prüfen ohne Tauri
Overlay im normalen Browser: temporäre HTML-Seite im Projekt (nicht in %TEMP%, Policy) mit `window.__FORGE_SCREENSHOT__ = true` und einem Stub für `window.__TAURI_INTERNALS__` (`invoke`, `transformCallback`, `plugin:event|listen`) sowie `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`; `screenshot_image` darf ein PNG liefern. Mit eigenem Vite (`pnpm exec vite --port …`) und den Vorschau-Werkzeugen klicken und Tasten drücken. Ziehen geht dort nicht, Fenster-Modus, Klick-Werkzeuge, Enter und Esc schon. Danach Seite löschen.

## Rust prüfen
`cargo check` scheitert ohne `runtime/` (Bundle-Ressourcen) am Glob: `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo check` bzw. `cargo test --lib screenshot` in `apps/desktop/src-tauri`.

## Weitere Einstiege
Palette „Screenshot aufnehmen“ (`screenshot_start`) und Schalter „Druck-Taste für Screenshots“ (Einstellungen → Allgemein → Bedienung, Palette, Telefon `forge_settings` mit `screenshot_key`). Die Aufnahme selbst gibt es am Telefon nicht (reiner Shell-Befehl, kein RPC).

## Offen (Stand 2026-10-15)
Ob der Hook ShareX auf dem Rechner des Nutzers wirklich übergeht, ist nach der zweiten Fassung noch nicht bestätigt; das Protokoll zeigt es. Mehrere Monitore mit unterschiedlicher Skalierung sind ungetestet (`screenshot_ready` setzt Position und Größe deshalb zweimal).
