---
title: "Lange Nachrichten und große Anhänge senden"
summary: "Warum Senden früher an der Größe scheiterte und wie FORGE heute große Texte, Bilder und Dateien weitergibt (Upload in Stücken, Verkleinern, Datei statt Text, /compact bei vollem Kontext). Wichtig bei Änderungen an Composer, Anhängen oder dem RPC-Kanal."
tags: ["chat","composer","anhaenge","rpc","tauri","stolperfalle"]
updated: "2026-10-14T15:50:28.054Z"
---

## Grenzen, an denen es früher scheiterte (behoben 2026-10-14)
- Tauri-Shell `apps/desktop/src-tauri/src/lib.rs` `sidecar_send`: jede Protokollzeile UI -> Sidecar hat ein Limit (früher 4 MB, jetzt 16 MB, „Nachricht zu groß“). Eingefügte Bilder reisten als base64 in `sessions.send`, ein großer Screenshot reichte.
- Protokoll: Prompt-Text war auf 200.000 Zeichen begrenzt (zod), jetzt `MAX_PROMPT_CHARS` = 2 Mio.
- Chat-Fenster-Entwurf `chat_windows.rs` (jetzt 6 MB).
- API-Grenzen: Bilder etwa 5 MB und 8000 px, ab mehr als 20 Bildern im Gespräch 2000 px.

## Heute
- Eingefügte Dateien gehen per RPC `attachments.upload` in 1-MB-Stücken an den Sidecar (`packages/sidecar/src/claude/uploads.ts`, Ablage `<dataDir>/uploads`, nach 30 Tagen gelöscht). Der Entwurf hält danach nur den Pfad; keine Protokollzeile trägt base64. Höchstens 100 MB je eingefügter Datei; gezogene Dateien gehen nur als Pfad.
- Bilder werden vor dem Upload auf höchstens 2000 px und 2 MB gebracht (`apps/desktop/src/lib/attachments.ts`: PNG, dann WebP, dann weniger Pixel). Während des Uploads ein Skeleton-Chip; Senden wartet auf laufende Uploads.
- Sidecar `claude/attachments.ts`: Was die API im Inhalt ablehnen würde, bekommt Claude als Pfad mit Hinweis auf das Read-Werkzeug. `imageSize` liest PNG/GIF/WebP/JPEG-Header für die Pixelgröße.
- Texte über 100.000 Zeichen speichert der Sidecar als Datei; Claude bekommt die ersten 30k und letzten 10k Zeichen plus Pfad (`fitMessageText` in `turns.ts`), nichts wird still abgeschnitten. Über 2 Mio. Zeichen lädt der Composer den Text als `nachricht.txt` hoch.
- Der Upload-Ordner wird jeder Session als zusätzliches Verzeichnis gegeben (`runtime.ts`), damit Claude ohne Freigabe lesen kann; Schreiben dort geht weiter durch die Sperrliste.
- „Prompt is too long“ (Kontext voll): `sessions/context-recovery.ts` (aus `stream.ts`) führt einmal `/compact` aus und schickt die fehlgeschlagenen Nachrichten erneut, markiert „Automatisch“. Scheitert es wieder, ein deutscher Hinweis statt Endlosschleife. Annahme: Claude Code beendet den Durchlauf als Fehler mit dieser Phrase (nicht real ausgelöst).
- `attachments.upload` steht in `NOT_ON_PHONE`.
