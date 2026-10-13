---
title: "Dateipfade im Chat anklickbar"
summary: "Wie Pfade in Chat-Nachrichten zu Links werden, die die Datei im Dateien-Reiter an der Zeile öffnen (auch aus geteilter Ansicht und Chat-Fenstern), und was man beim Ändern der Erkennung beachten muss."
tags: ["chat","markdown","dateien","chat-fenster","ui"]
updated: "2026-10-13T17:11:34.887Z"
---

Eingebaut 2026-10-13 auf Wunsch des Nutzers ("wie bei Claude Code").

## Erkennung (components/workspace/file-links.tsx)
- Fließtext: `remarkFileLinks` (Remark-Plugin in `Markdown.tsx`) macht Pfade mit mindestens einem Ordner und Dateiendung zu Links mit Schema `forge-file:`. Bloße Dateinamen im Fließtext bewusst nicht (Node.js, Next.js ...). Hosts wie github.com/... und Zahlen (1.5/2.0) sind ausgeschlossen.
- Inline-Code: ganzer Inhalt ein Pfad oder ein bloßer Dateiname mit bekannter Endung (`FILE_EXTENSIONS`, damit `useUi.getState` Code bleibt). Codeblöcke nie (Kontext `InCodeBlock`).
- Markdown-Links mit relativem Ziel (`[x](src/a.ts)`) ebenfalls.
- Zeilen: `:12`, `:12:5`, `#L12`.
- react-markdown filtert unbekannte Schemata: `urlTransform` in `Markdown.tsx` lässt `forge-file:` durch. Wer das Schema ändert, muss das mitziehen.

## Öffnen
- Nur mit `FileLinkContext` (gesetzt in `ChatPanel`: Projekt, Projektordner, Bereich der geteilten Ansicht); sonst bleibt der Pfad Text (Wissen, Dialoge).
- `openFileRef`: absolute Pfade nur innerhalb des Projektordners; Existenz wird per `projects.readFile` geprüft (gleicher Query-Key wie der Dateien-Reiter, also gecacht), sonst Toast "Datei nicht gefunden". Bloße Namen über `crawlFiles` (Cache-Key wie die Palette, `["paletteFiles", projectId]`), mehrere Treffer = Toast.
- Im Nebenbereich der geteilten Ansicht erst `promoteSplitPane`, dann `openFile`.
- `useUi.openFile(projectId, path, line)` setzt `fileJump` ({ ..., n }); `FilesTab` gibt `line`/`jumpKey` an `CodeView`, das die Zeile markiert und mittig scrollt.
- Chat-Fenster (eigene Webviews, eigener Store): `openFileInMain` in `lib/chat-windows.ts` schickt das Event `chat-windows://open-file` an das Hauptfenster und ruft den Tauri-Befehl `show_main_window` (src-tauri/src/chat_windows.rs). Neue Rust-Befehle wirken erst nach Neubau der App.

## Nicht verlinkt
Kopfzeilen der Werkzeug-Karten (Read/Edit): sind selbst Buttons zum Aufklappen, ein Link darin wäre verschachtelt.
