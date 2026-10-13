---
title: "Geteilte Ansicht (mehrere Projekte und Sessions im Raster)"
summary: "Aufbau der geteilten Workspace-Ansicht (Steuerleiste, Bereiche mit eigenem Kopf und Chat), wie Seitenleiste und Composer damit umgehen und was neuer Code beachten muss, damit er im richtigen Bereich wirkt."
tags: ["chat","split","ui","sessions","workspace","sidebar","stolperfalle"]
updated: "2026-10-13T16:25:02.761Z"
---

Der ganze Workspace kann in mehrere Bereiche geteilt werden (z. B. zwei über zwei). Jeder Bereich hat eine eigene Kopfzeile (Projekt, Favorit, Tags, Profil) und kann ein anderes Projekt zeigen. Eingebaut 2026-10-13, am selben Tag von "nur Chat geteilt" auf "ganze Ansicht geteilt" umgebaut, dazu Steuerleiste über die ganze Breite, Eintrag in der Seitenleiste und schmale Composer-Leiste (Wünsche des Nutzers).

## Aufbau
- `views/WorkspaceView.tsx`: `WorkspaceView` legt `SplitWorkspace` um `MainArea` (das offene Projekt mit Reitern, Seitenleiste, unterer Leiste). Der Hauptbereich ist immer Zelle 1.
- `components/workspace/SplitView.tsx` (`SplitWorkspace`): misst die ganze Fläche per ResizeObserver und zieht `SPLIT_BAR_HEIGHT` (48px, `lib/split-view.ts`) immer ab, auch ungeteilt. Grund: sonst könnte die beim Teilen erscheinende Steuerleiste die Höhe unter das Minimum drücken, der zweite Bereich verschwindet, die Leiste auch, und das kippt hin und her. Raster als CSS-Grid mit flacher, nach Bereich verschlüsselter Kinderliste (kein Remount beim Umordnen). Jede Zelle ist ein Tailwind-`@container`; Kopfzeilen blenden Beschriftungen per `@2xl:`/`@5xl:` nach Zellbreite aus, nicht nach Fensterbreite. Weitere Bereiche: `PaneProject` = `WorkspaceHeader` mit `pane` + `ChatPanel` mit `pane`; ohne Projekt `PanePicker` (laufende Sessions aller Projekte, alle Projekte).
- Steuerleiste `SplitControlBar` (in `WorkspaceHeader.tsx`): nur bei geteilter Ansicht (mehr als ein Bereich sichtbar) über die ganze Breite. Enthält "Teilung aufheben", die Layout-Schalter des Hauptbereichs (Werkzeugleiste, untere Leiste, rechte Seitenleiste, Ansicht teilen), Remote, Im-Vordergrund und Telefon. Der Hauptbereich-Kopf zeigt dann stattdessen ein Badge "Hauptbereich". Abfrage dafür: `useSplitActive()`. Ungeteilt sitzen die Schalter wie früher im Kopf des Hauptbereichs.
- `components/workspace/WorkspaceHeader.tsx`: Kopfzeile für Haupt- und Nebenbereiche. Nebenbereiche haben Projektwechsel-Menü am Namen, "Zum Hauptbereich machen", Schließen. `useNarrow` richtet sich nach `mainWidth` aus `SplitLayoutContext` (rechte Seitenleiste nur ab 1024px Hauptbereich).
- `lib/split-view.ts`: `paneCapacity` (MIN_PANE_WIDTH 560, MIN_PANE_HEIGHT 430 inkl. Kopfzeile, MAX_PANES 6) und `paneRows`. Full HD ergibt 2×2.
- Bereiche, die nicht passen, bleiben im Store und werden nur ausgeblendet (Hinweisleiste). Freie Plätze: `useUi().splitRoom`.
- Store (`stores/ui.ts`): `splitPanes` (in localStorage `forge.ui`), `addSplitPane(projectId?, active?)`, `setSplitPane(id, projectId, active?)`: ohne `active` (undefined) bekommt der Bereich `pick: true` und `ChatPanel` wählt die neueste Session, die noch nicht auf dem Bildschirm ist, und schreibt sie zurück; `null` heißt bewusst neue Session. `promoteSplitPane` tauscht mit dem Hauptbereich, `closeSplitPanes` schließt alle, `forgetSessions` räumt gelöschte Sessions ab, `shownSessions(state)` liefert alle sichtbaren Sessions. Eine Session erscheint höchstens einmal: `openProject`/`setActiveSession` tauschen per `swapIntoMain`.

## Seitenleiste (components/layout/OpenSessions.tsx)
- `SplitViewEntry` über "Geöffnet": hervorgehoben (accent), solange die geteilte Ansicht zu sehen ist; aus anderen Ansichten führt ein Klick zurück (`setView("workspace")`), das Kreuz hebt die Teilung auf.
- Der Baum listet im Workspace auch die Bereiche: deren Sessions ohne laufenden Prozess (per `useQueries` auf `sessions.get`), deren Projekte als Gruppe und "Neue Session"-Zeilen je Bereich (`data-pane-new-session`, Klick = `promoteSplitPane`). `groupTabs` und `openGroups` nehmen dafür Listen. Strg+Tab (`lib/shortcuts.ts`) geht dieselben Sessions durch (`shownSessionIds`).

## Composer in schmalen Bereichen
- `Composer.tsx` ist ein eigener Container `@container/composer`; die untere Leiste richtet sich nach dessen Breite (`@5xl/composer:` Tastenhinweis, `@4xl/composer:` Effort-Auswahl, `@xl/composer:` Modell-Auswahl, `@2xl/composer:` Text "Planen"). Darunter sitzen Modell und Effort in einem Menü (SlidersHorizontal). Senden/Stopp sind `shrink-0`. Neue Elemente in dieser Leiste brauchen ebenfalls einen Breakpoint, sonst werden Senden/Stopp wieder abgeschnitten.

## Stolperfalle: "dieser Chat" statt Hauptchat
- `components/workspace/chat-slot.ts`: `ChatSlotContext` sagt jeder Komponente im Chat, in welchem Bereich sie sitzt. Wer die Session des eigenen Chats wechselt (Session starten, /clear, Verzweigen), muss `useChatSlot().select(projectId, id)` nehmen, nicht `useUi().setActiveSession`, sonst springt der Hauptbereich um.
- Entwürfe neuer Sessions sind pro Bereich getrennt: `draftKey(projectId, null, ext, slot.pane)`.
- Nur der Hauptchat hat `id="composer-input"` (Strg+N, Palette). Fokus im eigenen Bereich: `focusComposer(slot)`.
- Alles, was am globalen Store hängt (Reiter, Seitenleisten, Projekt-Einstellungen, Fernsteuerung, `activeSession` des Projekts), gehört zum Hauptbereich. Aus einem Nebenbereich dorthin: erst `promoteSplitPane` (so macht es der Tag-Knopf der Kopfzeile).
- "Ist die Session sichtbar?" über `shownSessionIds(ui)` (`lib/session-tabs.ts`) prüfen, nicht `openSessionId` (so macht es `agent-review.ts`). Buffer-Eviction (`server-events.ts`) hält Sessions der Bereiche.
- Neue app-weite Knöpfe (wie Telefon, Im-Vordergrund) in beide Stellen einbauen: Kopf des Hauptbereichs (ungeteilt) und `SplitControlBar`.

## Einstiege
Kopfzeile des Hauptbereichs bzw. Steuerleiste (Knopf "Ansicht teilen"), Seitenleiste (Eintrag "Geteilte Ansicht", Knopf je Session, Umschalt+Klick auf Session oder Projekt), Befehlspalette ("Ansicht teilen: weiteren Bereich öffnen", "Geteilte Ansicht schließen"). Kein Telefon-Werkzeug: reine Bildschirmaufteilung ohne RPC.
