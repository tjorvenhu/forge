---
title: "Screenshot-Tool auf der Druck-Taste (screenshot.rs, ScreenshotOverlay, screenshotKey)"
summary: "Wie FORGEs Snipping-Tool die Druck-Taste abfängt, den Bildschirm aufnimmt, im Overlay auswählen und markieren lässt und das Bild in Zwischenablage und Chat-Anhang bringt; wichtig bei Änderungen an Overlay, Hook, Anhängen oder Fenstern."
tags: ["screenshot","tauri","windows","anhaenge","ui","stolperfalle"]
updated: "2026-10-15T07:35:33.526Z"
---

Eingebaut 2026-10-15 auf Wunsch des Nutzers („wie das moderne Snipping Tool“).

## Ablauf
1. **Druck-Taste** (`apps/desktop/src-tauri/src/screenshot.rs`, Modul `hook`): `WH_KEYBOARD_LL`-Hook auf eigenem Thread mit Message-Loop. Schluckt `VK_SNAPSHOT` (auch Key-up, sonst öffnet Windows sein Snipping Tool), nur wenn `ENABLED` (Einstellung `screenshotKey`, Standard an; der Hauptfenster-Hook `useScreenshotKey` in `lib/screenshot.ts` meldet sie per `screenshot_set_enabled`). Alt+Druck, Win+Druck und injizierte Tasten bleiben bei Windows. Der Hook muss sofort zurückkehren, die Arbeit geht per Channel an den Thread `forge-screenshot`.
2. **Aufnahme** (`grab::virtual_screen`): GDI `BitBlt` des ganzen virtuellen Bildschirms (alle Monitore, physische Pixel, `CAPTUREBLT`), Alpha auf 255 gesetzt. Dazu Monitore (Tauri) und sichtbare Top-Level-Fenster in Z-Reihenfolge (`EnumWindows`, ohne unsichtbare/minimierte/cloaked, Rahmen über `DWMWA_EXTENDED_FRAME_BOUNDS`), alles relativ zum Ursprung des Frames.
3. **Overlay-Fenster** `screenshot`: wird beim Einschalten der Einstellung versteckt vorgebaut (Trigger `Prepare`) und danach nur versteckt, damit es sofort erscheint. Bauen nur auf dem Capture-Thread (WebviewWindow aus synchronem Command baut auf Windows Deadlocks). `window.__FORGE_SCREENSHOT__` per initialization_script; `main.tsx` rendert dann nur `ScreenshotOverlay` (kein Sidecar, keine Presence). Capability `capabilities/screenshot.json` (nur `core:event:default`). `set_always_on_top` lässt das Overlay aus.
4. Overlay holt das Bild als BMP (`screenshot_image`, `ipc::Response`, keine Kodierung in Rust) und ruft `screenshot_ready` erst nach dem Zeichnen, dann zeigt Rust das Fenster (kein leeres Aufblitzen). Ein Frame, der kam, während die Seite noch lud, holt sie über `screenshot_frame`.
5. **Fertig**: Das Overlay setzt das Bild selbst zusammen (`components/screenshot/compose.ts`: Canvas mit Ausschnitt, Freihand-Clip, darüber das Markierungs-SVG des Overlays per XMLSerializer als data-URL) und schickt RGBA als Raw-Body an `screenshot_take` (Header `x-width`, `x-height`, `x-forge`). Rust: RGBA→BGRA (Transparentes wird weiß), **immer** `CF_DIB` in die Zwischenablage (Zeilen von unten), bei `x-forge: 1` BMP merken und `screenshot://taken` an das zuletzt fokussierte FORGE-Fenster (`WindowEvent::Focused` in `lib.rs`, main oder chat-*).
6. **Im Chat**: `startScreenshotReceiver` (jedes FORGE-Fenster) holt die Bytes einmalig (`screenshot_taken`), lädt sie wie eingefügte Bilder hoch (`uploadPasted` aus `useAttachments.ts`, wird zu PNG ≤ 2000 px) und hängt sie an den Entwurf von `screenshotTarget()`: zuletzt fokussierter Composer (`registerComposer`/`composerFocused` in `Composer.tsx`), sonst Hauptchat, sonst Chat des offenen Projekts (`activeDraftKey`). Das X am Anhang entfernt ihn; die Zwischenablage bleibt.

## Overlay (`components/screenshot/`)
- Modi: Rechteck (R), Freihand (F), Fenster (W), Bildschirm (B); Fenster und Bildschirm heben beim Überfahren hervor (animierte SVG-Maske). Alles außerhalb der Auswahl ist zu 50 % abgedunkelt (SVG-Maske, Ein- und Ausblenden per Transition), Lupe mit Pixelposition und Farbwert, Fadenkreuz, Größenanzeige.
- Nach der Auswahl: Ziehpunkte und Verschieben (Werkzeug Auswahl, V), Stift (P), Textmarker (M), Pfeil (A), Rahmen (R), Text (T), Nummer (N), Verpixeln (X, verkleinerte Kopie als data-URL, `image-rendering: pixelated`), 7 Farben aus Theme-Tokens (`resolveColor`), Rückgängig/Wiederholen (Strg+Z/Y), „Nur in die Zwischenablage“ (Strg+C), „An FORGE“ (Enter). Modus, Werkzeug und Farbe merkt sich `localStorage` `forge.snip`.
- Markierungen liegen in physischen Frame-Koordinaten, damit sie beim Verschieben der Auswahl an ihrer Stelle bleiben. Alle Stile als SVG-Attribute (keine Klassen), sonst fehlen sie im serialisierten Bild. Schrift `Segoe UI` (das SVG-Bild kann keine App-Fonts laden).
- **Esc** fängt der Hook ab, solange das Overlay offen ist, und schickt `screenshot://escape` (das Overlay hat nicht immer den Tastaturfokus): offenes Textfeld schließen, laufendes Ziehen abbrechen, sonst Overlay schließen.
- Stolperfalle Text-Werkzeug: Ohne `preventDefault` im pointerdown nimmt der Klick dem gerade erzeugten Textfeld sofort den Fokus, `onBlur` verwirft es.

## Prüfen ohne Tauri
Overlay im normalen Browser: temporäre HTML-Seite im Projekt (nicht in %TEMP%, Policy) mit `window.__FORGE_SCREENSHOT__ = true` und einem Stub für `window.__TAURI_INTERNALS__` (`invoke`, `transformCallback`, `plugin:event|listen`) sowie `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`; `screenshot_image` darf ein PNG liefern. Mit eigenem Vite (`pnpm exec vite --port …`) und den Vorschau-Werkzeugen klicken. Ziehen geht dort nicht, Fenster-Modus und Klick-Werkzeuge schon. Danach Seite löschen.

## Rust prüfen
`cargo check` scheitert ohne `runtime/` (Bundle-Ressourcen) am Glob: `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo check` bzw. `cargo test --lib screenshot` in `apps/desktop/src-tauri`.

## Weitere Einstiege
Palette „Screenshot aufnehmen“ (`screenshot_start`) und Schalter „Druck-Taste für Screenshots“ (Einstellungen → Allgemein → Bedienung, Palette, Telefon `forge_settings` mit `screenshot_key`). Die Aufnahme selbst gibt es am Telefon nicht (reiner Shell-Befehl, kein RPC).

## Offen (Stand 2026-10-15)
Nur mit Stub im Browser und Unit-Tests geprüft, nicht im echten Tauri-Fenster: Fokus des Overlays aus dem Hintergrund, Monitore mit unterschiedlicher Skalierung (Fenster über alle Monitore, Windows könnte es nach dem Zeigen umskalieren; `screenshot_ready` setzt Position und Größe deshalb zweimal).
