---
title: "Dateipfade im Chat anklickbar"
summary: "Wie Pfade in Chat-Nachrichten, Werkzeug-Karten und Aktivität zu Links werden: Projektdateien öffnen im Dateien-Reiter an der Zeile, Ordner und Dateien außerhalb im Explorer; wie bloße Dateinamen gesucht werden (projects.allFiles, matchingFiles)."
tags: ["chat","markdown","dateien","explorer","chat-fenster","ui","stolperfalle"]
updated: "2026-10-16T18:40:21.672Z"
---

Eingebaut 2026-10-13 auf Wunsch des Nutzers ("wie bei Claude Code"), am selben Tag auf Werkzeug-Karten, Ausgaben und Ordner erweitert.

## Erkennung (components/workspace/file-links.tsx)
- Fließtext und Klartext: `findFileRefs` erkennt Pfade mit Ordner und Dateiendung (`src/a.ts:12`) sowie absolute Windows-Ordner (`C:\x\y`, Git-Bash `/c/x/y`, wird zu `C:/x/y`). Bloße Dateinamen im Fließtext bewusst nicht (Node.js, Next.js ...). Hosts (github.com/...) und Zahlen (1.5/2.0) ausgeschlossen; der Satzpunkt nach einem Ordner gehört nicht dazu.
- Inline-Code und Markdown-Link-Ziele: `parseFileRef` auf den ganzen Text; dort auch Pfade mit Leerzeichen (`C:\Program Files\Git`) und bloße Dateinamen mit bekannter Endung (`FILE_EXTENSIONS`). Codeblöcke nie (Kontext `InCodeBlock` in `Markdown.tsx`).
- Fließtext läuft über das Remark-Plugin `remarkFileLinks` mit Link-Schema `forge-file:`; `urlTransform` in `Markdown.tsx` muss das Schema durchlassen (react-markdown filtert sonst).
- `FileRef.isFile` = hat Dateiendung.

## Wohin ein Klick geht (`destination`)
- Projektdatei (isFile, im Projektordner oder relativ, `FileLinkContext` vorhanden) → Dateien-Reiter: `openFileRef` prüft per `projects.readFile` (retry: false, sonst 1 s Verzögerung durch das globale retry: 1); fehlt sie, oder ist es ein bloßer Name, sucht `matchingFiles` (packages/protocol/src/files.ts) in der Dateiliste des Projekts: Name gleich bzw. Pfad endet auf `/<pfad>` (Claude schreibt oft relativ zu einem Unterordner, z. B. src-tauri/Cargo.toml), erst exakt, dann ohne Groß-/Kleinschreibung. Mehrere Treffer oder keiner = Toast.
- Sonst absoluter Pfad → Explorer über den Tauri-Befehl `show_in_explorer` (src-tauri/src/lib.rs): Ordner werden geöffnet, Dateien nur im Ordner markiert, nie mit ihrem Programm gestartet (ein .exe-Pfad im Chat darf nichts ausführen). Der Befehl läuft in Rust, damit das Fenster keine breiten opener-Rechte braucht. Geht auch ohne `FileLinkContext`.
- Im Nebenbereich der geteilten Ansicht vorher `promoteSplitPane`. In Chat-Fenstern (eigener Store) `openFileInMain` (Event `chat-windows://open-file` + Befehl `show_main_window`).
- `useUi.openFile(projectId, path, line)` setzt `fileJump`; `CodeView` markiert die Zeile und scrollt sie in die Mitte.

## Dateiliste des Projekts (projects.allFiles)
- Stolperfalle (behoben 2026-10-16): Früher lief die Suche im Desktop Ordner für Ordner über `projects.listFiles` und hörte nach 150 Ordnern auf. FORGE selbst hat rund 750, tiefer liegende Dateien kamen als "Datei nicht gefunden". Außerdem lagen unter `.claude/worktrees` Kopien des Projekts (Claude-Code-Subagenten), jeder Name passte doppelt.
- Jetzt ein Aufruf: `ProjectManager.allFiles` im Sidecar, breitenweise, bis 50 000 Dateien / 10 000 Ordner, folgt keinen Junctions/Symlinks. Ausgelassen: `SKIP_DIRS` (node_modules, dist, build, target ...), Punkt-Ordner außer `DOT_DIRS` (.github, .claude, .forge, .vscode) und `SKIP_PATHS` (.claude/worktrees).
- Desktop: `projectFilesQuery(projectId)` in components/layout/palette-sources.tsx (Query-Key `paletteFiles`), geteilt von Befehlspalette und Datei-Links.
- Telefon: Werkzeug `files` action `find` (Name oder Pfadende), nutzt ebenfalls `matchingFiles`.

## Wo Pfade verlinkt sind
- Markdown im Chat (`ChatPanel` setzt `FileLinkContext`).
- Werkzeug-Karten (`ToolCard.tsx`): Kopfzeile über `ToolTarget` (Read/Write/Edit: die Datei, Read an `offset`; Bash/Grep/Glob: Pfade im Befehl). Die Kopfzeile ist ein `div` mit unterlegtem, absolut positioniertem Aufklapp-Button; Links liegen mit `relative z-10` darüber (kein Link im Button). Ausgabe-Vorschau, Details und Freigabe-Block über `LinkedText`.
- Aktivität (`ActivityFeed`) mit eigenem `FileLinkContext` (Hauptbereich).
- Stil außerhalb von Markdown: Klasse `.file-link` in `styles.css`.

## Explorer-Knöpfe außerhalb des Chats
- `revealPath(abs)` und `revealInProject(root, rel)` (file-links.tsx, Fehler als Toast) sind der gemeinsame Weg in den Explorer.
- Dateien-Reiter: Knopf in der Pfadzeile der geöffneten Datei (`FilesTab` → `FileViewer`). Rechte Spalte (`FileTree`): Knopf im Kopf öffnet den Projektordner.
- Befehlspalette: `explorer-project` (Projektordner) und `explorer-file` (die im Dateien-Reiter gewählte Datei, `selectedFile`).
- Telefon: Explorer bewusst nicht angebunden, weil er ein Tauri-Befehl im Desktop-Fenster ist und das Telefon nur Sidecar-RPC aufruft.

## Hinweise
- Rust-Befehle (`show_in_explorer`, `show_main_window`) brauchen einen Neubau; `pnpm dev` (tauri dev) baut bei Änderungen in src-tauri selbst neu.
