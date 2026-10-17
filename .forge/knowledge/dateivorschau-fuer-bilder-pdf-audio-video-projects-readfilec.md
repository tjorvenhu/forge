---
title: "Dateivorschau für Bilder, PDF, Audio, Video (projects.readFileChunk, MediaPreview)"
summary: "Wie der Dateien-Reiter Binärdateien anzeigt: Typ nach Endung, Bytes in Stücken vom Sidecar, Object-URL, CSP-Einträge; wichtig bei Änderungen an FileViewer, CSP oder neuen Formaten."
tags: ["dateien","vorschau","csp","tauri","ui"]
updated: "2026-10-17T20:02:43.185Z"
---

Eingebaut 2026-10-17, vorher zeigte der Dateien-Reiter bei jeder Binärdatei nur „Binärdatei, keine Vorschau“.

## Ablauf
- `apps/desktop/src/components/workspace/FilePreview.tsx`: `mediaType(path)` entscheidet **nach Endung** (Tabelle `MEDIA`), nicht nach dem NUL-Byte-Test von `projects.readFile`. Grund: PDFs haben oft kein NUL in den ersten 8000 Bytes und gingen sonst als Text durch.
- `MediaPreview` holt die Bytes über RPC `projects.readFileChunk` (`offset`, je Aufruf `CHUNK_BYTES` = 4 MB als base64, `packages/sidecar/src/projects/project-manager.ts`), baut einen Blob und eine Object-URL und gibt sie beim Wechsel oder Schließen wieder frei. Über `MAX_PREVIEW_BYTES` (200 MB) meldet der Sidecar einen Fehler.
- Kleine Stücke, weil jede Protokollzeile durch die Tauri-Shell geht (siehe Eintrag zu großen Anhängen).
- Pfadprüfung wie bei `readFile` über `resolveInside`, also keine Symlinks/Junctions nach außen.
- Bilder: eingepasst, ein Klick zeigt die Originalgröße; Schachbrett für Transparenz; Statuszeile mit Pixelmaß und Größe. SVG läuft als `<img>` (Skripte laufen dort nicht), der Knopf „Code“ zeigt den Quelltext im CodeView.
- PDF: `<iframe>` mit Blob-URL, der eingebaute PDF-Viewer von WebView2/Edge zeigt sie an.
- Audio/Video: native `<audio>`/`<video controls>`.
- Andere Binärdateien: `NoPreview` mit dem Knopf „Im Explorer zeigen“.

## CSP (src-tauri/tauri.conf.json)
- Nötig: `media-src 'self' blob:` und `frame-src blob:`, `img-src` hatte `blob:` schon.
- `object-src 'none'` kann bleiben: In Edge mit derselben CSP gerendert (headless über die Vorschau-Werkzeuge, Muster wie im Eintrag zum Git-Reiter: Testseite mit gefälschtem `__TAURI_INTERNALS__`; wichtig ist `await rpc.start()`, sonst kommen keine Antworten an).

## Telefon
`projects.readFileChunk` steht auf `NOT_ON_PHONE`, rohe Bytes lassen sich nicht vorlesen.

## Offen
Der Git-Diff (`components/git/DiffView.tsx`) zeigt bei Binärdateien weiter nur einen Hinweis, eine Bildansicht vorher/nachher gibt es dort nicht.
