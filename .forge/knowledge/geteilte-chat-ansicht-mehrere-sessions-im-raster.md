---
title: "Geteilte Ansicht (mehrere Projekte und Sessions im Raster)"
summary: "Aufbau der geteilten Workspace-Ansicht (Steuerleiste, Bereiche mit eigenem Kopf und Chat), wie Seitenleiste und Composer damit umgehen und was neuer Code beachten muss, damit er im richtigen Bereich wirkt."
tags: ["chat","split","ui","sessions","workspace","sidebar","stolperfalle"]
updated: "2026-10-13T16:41:44.359Z"
---

Der ganze Workspace kann in mehrere Bereiche geteilt werden (z. B. zwei über zwei). Jeder Bereich hat eine eigene Kopfzeile (Projekt, Favorit, Tags, Profil) und kann ein anderes Projekt zeigen. Eingebaut 2026-10-13, am selben Tag mehrfach nach Wünschen des Nutzers erweitert (ganze Ansicht geteilt, Steuerleiste, Seitenleisten-Eintrag, schmale Composer-Leiste, Verschieben per Drag and Drop, Öffnen-Verhalten).

## Aufbau
- `views/WorkspaceView.tsx`: `WorkspaceView` legt `SplitWorkspace` um `MainArea` (das offene Projekt mit Reitern, Seitenleiste, unterer Leiste). Der Hauptbereich ist immer Zelle 1 (Bereichs-Id `MAIN_AREA` = "main").
- `components/workspace/SplitView.tsx` (`SplitWorkspace`): misst die ganze Fläche per ResizeObserver und zieht `SPLIT_BAR_HEIGHT` (48px, `lib/split-view.ts`) immer ab, auch ungeteilt. Grund: sonst könnte die beim Teilen erscheinende Steuerleiste die Höhe unter das Minimum drücken, der zweite Bereich verschwindet, die Leiste auch, und das kippt hin und her. Raster als CSS-Grid mit flacher, nach Bereich verschlüsselter Kinderliste (kein Remount beim Umordnen). Jede Zelle ist ein Tailwind-`@container` mit `data-split-area`; Kopfzeilen blenden Beschriftungen per `@2xl:`/`@5xl:` nach Zellbreite aus. Weitere Bereiche: `PaneProject` = `WorkspaceHeader` mit `pane` + `ChatPanel` mit `pane`; ohne Projekt `PanePicker`.
- Steuerleiste `SplitControlBar` (in `WorkspaceHeader.tsx`): nur bei geteilter Ansicht über die ganze Breite. "Teilung aufheben", Layout-Schalter des Hauptbereichs, Remote, Im-Vordergrund, Telefon. Der Hauptbereich-Kopf zeigt dann ein Badge "Hauptbereich". Abfrage: `useSplitActive()`.
- `lib/split-view.ts`: `paneCapacity` (MIN_PANE_WIDTH 560, MIN_PANE_HEIGHT 430 inkl. Kopfzeile, MAX_PANES 6) und `paneRows`. Full HD ergibt 2×2. Bereiche, die nicht passen, bleiben im Store und werden nur ausgeblendet. Freie Plätze: `useUi().splitRoom`.
- Store (`stores/ui.ts`): `splitPanes` (localStorage `forge.ui`), `addSplitPane`, `setSplitPane` (ohne `active` bekommt der Bereich `pick: true`, `ChatPanel` wählt die neueste nicht sichtbare Session und schreibt sie zurück; `null` = bewusst neue Session), `promoteSplitPane`, `closeSplitPanes`, `forgetSessions`, `shownSessions`. `setActiveSession` (Session-Auswahl im Hauptchat) tauscht per `swapIntoMain`, wenn ein Bereich die Session schon zeigt.

## Öffnen-Verhalten (Wunsch des Nutzers)
- `openProject(projectId, sessionId?)` bei geteilter Ansicht: Ist der Chat schon in einem Bereich zu sehen (`onScreen`: Projekt-Klick = Projekt in irgendeinem Bereich; Session; `null` = Neue Session des Projekts), ändert sich an der Aufteilung nichts (nur `view: "workspace"`). Sonst öffnet er sich einzeln, die Aufteilung wandert nach `splitStash` ({ main, panes }, auch in localStorage).
- `restoreSplit()` stellt sie wieder her (Hauptchat inklusive). `addSplitPane` verwirft eine gemerkte Aufteilung (neue Teilung ersetzt sie). `forgetSessions` räumt auch den Stash ab.
- `openChat(projectId, sessionId)` in `chat-slot.ts`: `openProject` plus Fokus in den Bereich, der den Chat zeigt. Seitenleiste und Strg+Tab nutzen das; Strg+Tab nimmt in der geteilten Ansicht den Bereich mit dem Cursor als aktuellen.

## Verschieben per Drag and Drop
- `AreaGrip` (WorkspaceHeader.tsx): Griff (GripHorizontal) oben mittig in jeder Bereichs-Kopfzeile, auch beim Picker; nur bei geteilter Ansicht.
- `useAreaDrag` (SplitView.tsx) arbeitet mit Pointer-Events, nicht HTML5-Drag-and-Drop (das Desktop-Fenster nutzt Drag and Drop für Dateien; auch das Herausziehen von Session-Tabs geht so, `lib/tab-drag.ts`). Ziel per `elementFromPoint` → `[data-split-area]`, Esc bricht ab.
- `swapSplitAreas(a, b)`: zwei Nebenbereiche tauschen ihre Reihenfolge in `splitPanes`; mit dem Hauptbereich = `promoteSplitPane`. `canSwapAreas`: ein Picker (ohne Projekt) kann nicht Hauptbereich werden.

## Seitenleiste (components/layout/OpenSessions.tsx)
- `SplitViewEntry` über "Geöffnet": hervorgehoben, solange die geteilte Ansicht zu sehen ist; auch bei gemerkter Aufteilung sichtbar, Klick = `restoreSplit`, Kreuz = `closeSplitPanes`.
- Der Baum listet im Workspace auch die Bereiche: deren Sessions ohne laufenden Prozess (`useQueries` auf `sessions.get`), deren Projekte und "Neue Session"-Zeilen je Bereich (`data-pane-new-session`, Klick fokussiert nur den Bereich). Sessions in Bereichen sind leicht hinterlegt und tragen ein Teilungs-Symbol. `groupTabs` und `openGroups` nehmen dafür Listen.

## Composer in schmalen Bereichen
- `Composer.tsx` ist ein eigener Container `@container/composer`; die untere Leiste richtet sich nach dessen Breite (`@5xl/composer:` Tastenhinweis, `@4xl/composer:` Effort-Auswahl, `@xl/composer:` Modell-Auswahl, `@2xl/composer:` Text "Planen"). Darunter sitzen Modell und Effort in einem Menü (SlidersHorizontal). Senden/Stopp sind `shrink-0`. Neue Elemente in dieser Leiste brauchen ebenfalls einen Breakpoint.

## Stolperfalle: "dieser Chat" statt Hauptchat
- `ChatSlotContext` (`chat-slot.ts`) sagt jeder Komponente im Chat, in welchem Bereich sie sitzt. Wer die Session des eigenen Chats wechselt (Session starten, /clear, Verzweigen), muss `useChatSlot().select(projectId, id)` nehmen, nicht `useUi().setActiveSession` oder `openProject`.
- Entwürfe neuer Sessions sind pro Bereich getrennt: `draftKey(projectId, null, ext, slot.pane)`.
- Nur der Hauptchat hat `id="composer-input"`. Fokus im eigenen Bereich: `focusComposer({ pane })`.
- Alles am globalen Store (Reiter, Seitenleisten, Projekt-Einstellungen, Fernsteuerung) gehört zum Hauptbereich. Aus einem Nebenbereich dorthin: erst `promoteSplitPane`.
- "Ist die Session sichtbar?" über `shownSessionIds(ui)` prüfen, nicht `openSessionId`.
- Neue app-weite Knöpfe in beide Stellen einbauen: Kopf des Hauptbereichs (ungeteilt) und `SplitControlBar`.

## Einstiege
Steuerleiste/Kopfzeile ("Ansicht teilen"), Seitenleiste (Eintrag "Geteilte Ansicht", Knopf je Session, Umschalt+Klick), Befehlspalette ("Ansicht teilen: weiteren Bereich öffnen", "Geteilte Ansicht schließen", "Geteilte Ansicht wieder öffnen"). Kein Telefon-Werkzeug: reine Bildschirmaufteilung ohne RPC.
