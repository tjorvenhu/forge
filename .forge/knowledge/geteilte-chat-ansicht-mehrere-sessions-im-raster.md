---
title: "Geteilte Ansicht (mehrere Projekte und Sessions im Raster)"
summary: "Wie die geteilte Workspace-Ansicht aufgebaut ist (Hauptbereich plus weitere Bereiche mit eigenem Projekt-Kopf und Chat, Anzahl nach Fenstergröße) und was neuer Code im Chat oder Workspace beachten muss, damit er im richtigen Bereich wirkt."
tags: ["chat","split","ui","sessions","workspace","stolperfalle"]
updated: "2026-10-13T15:27:32.569Z"
---

Der ganze Workspace kann in mehrere Bereiche geteilt werden (z. B. zwei über zwei). Jeder Bereich hat eine eigene Kopfzeile (Projekt, Favorit, Tags, Profil) und kann ein anderes Projekt zeigen. Eingebaut 2026-10-13, am selben Tag von "nur Chat geteilt" auf "ganze Ansicht geteilt" umgebaut.

## Aufbau
- `views/WorkspaceView.tsx`: `WorkspaceView` legt `SplitWorkspace` um `MainArea` (das offene Projekt mit Reitern, Seitenleiste, unterer Leiste). Der Hauptbereich ist immer Zelle 1.
- `components/workspace/SplitView.tsx` (`SplitWorkspace`): misst die Fläche per ResizeObserver, Raster als CSS-Grid mit flacher, nach Bereich verschlüsselter Kinderliste (kein Remount beim Umordnen). Jede Zelle ist ein Tailwind-`@container`; Kopfzeilen blenden Beschriftungen per `@2xl:`/`@5xl:` nach Zellbreite aus, nicht nach Fensterbreite. Weitere Bereiche: `PaneProject` = `WorkspaceHeader` mit `pane` + `ChatPanel` mit `pane`; ohne Projekt `PanePicker` (laufende Sessions aller Projekte, alle Projekte).
- `components/workspace/WorkspaceHeader.tsx`: Kopfzeile für Haupt- und Nebenbereiche. Nur der Hauptbereich hat Layout-Schalter (inkl. "Ansicht teilen"), Fernsteuerung, Im-Vordergrund und Telefon; Nebenbereiche haben Projektwechsel-Menü am Namen, "Zum Hauptbereich machen", Schließen. `useNarrow` richtet sich nach `mainWidth` aus `SplitLayoutContext` (rechte Seitenleiste nur ab 1024px Hauptbereich).
- `lib/split-view.ts`: `paneCapacity` (MIN_PANE_WIDTH 560, MIN_PANE_HEIGHT 430 inkl. Kopfzeile, MAX_PANES 6) und `paneRows`. Full HD ergibt 2×2.
- Bereiche, die nicht passen, bleiben im Store und werden nur ausgeblendet (Hinweisleiste). Freie Plätze: `useUi().splitRoom`.
- Store (`stores/ui.ts`): `splitPanes` (in localStorage `forge.ui`), `addSplitPane(projectId?, active?)`, `setSplitPane(id, projectId, active?)`: ohne `active` (undefined) bekommt der Bereich `pick: true` und `ChatPanel` wählt die neueste Session, die noch nicht auf dem Bildschirm ist; `null` heißt bewusst neue Session. `promoteSplitPane` tauscht mit dem Hauptbereich, `forgetSessions` räumt gelöschte Sessions ab, `shownSessions(state)` liefert alle sichtbaren Sessions. Eine Session erscheint höchstens einmal: `openProject`/`setActiveSession` tauschen per `swapIntoMain`.

## Stolperfalle: "dieser Chat" statt Hauptchat
- `components/workspace/chat-slot.ts`: `ChatSlotContext` sagt jeder Komponente im Chat, in welchem Bereich sie sitzt. Wer die Session des eigenen Chats wechselt (Session starten, /clear, Verzweigen), muss `useChatSlot().select(projectId, id)` nehmen, nicht `useUi().setActiveSession`, sonst springt der Hauptbereich um.
- Entwürfe neuer Sessions sind pro Bereich getrennt: `draftKey(projectId, null, ext, slot.pane)`.
- Nur der Hauptchat hat `id="composer-input"` (Strg+N, Palette). Fokus im eigenen Bereich: `focusComposer(slot)`.
- Alles, was am globalen Store hängt (Reiter, Seitenleisten, Projekt-Einstellungen, Fernsteuerung, `activeSession` des Projekts), gehört zum Hauptbereich. Aus einem Nebenbereich dorthin: erst `promoteSplitPane` (so macht es der Tag-Knopf der Kopfzeile).
- "Ist die Session sichtbar?" über `shownSessionIds(ui)` (`lib/session-tabs.ts`) prüfen, nicht `openSessionId` (so macht es `agent-review.ts`). Buffer-Eviction (`server-events.ts`) hält Sessions der Bereiche.

## Einstiege
Kopfzeile des Hauptbereichs (Knopf "Ansicht teilen"), Seitenleiste (Knopf je Session, Umschalt+Klick auf Session oder Projekt), Befehlspalette ("Ansicht teilen: weiteren Bereich öffnen", "Geteilte Ansicht schließen"). Kein Telefon-Werkzeug: reine Bildschirmaufteilung ohne RPC.
