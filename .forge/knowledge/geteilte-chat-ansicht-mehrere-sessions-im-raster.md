---
title: "Geteilte Chat-Ansicht (mehrere Sessions im Raster)"
summary: "Wie die geteilte Ansicht im Chat-Reiter aufgebaut ist (Hauptchat plus weitere Bereiche, Anzahl nach Fenstergröße) und was neuer Code im Chat beachten muss, damit er im richtigen Bereich wirkt."
tags: ["chat","split","ui","sessions","stolperfalle"]
updated: "2026-10-13T15:06:21.150Z"
---

Der Chat-Reiter des Workspace kann mehrere Sessions gleichzeitig zeigen (z. B. zwei über zwei). Eingebaut 2026-10-13.

## Aufbau
- `components/workspace/SplitView.tsx` (`SplitChat`): misst die Chat-Fläche per ResizeObserver, Raster als CSS-Grid mit flacher, nach Bereich verschlüsselter Kinderliste (kein Remount beim Umordnen). Zelle 1 ist immer der Hauptchat (`activeSession` des offenen Projekts), danach `useUi().splitPanes`.
- `lib/split-view.ts`: `paneCapacity` (wie viele passen: MIN_PANE_WIDTH 560, MIN_PANE_HEIGHT 380, MAX_PANES 6) und `paneRows` (Aufteilung pro Zeile; gewinnt das Raster, dessen kleinster Chat einer bequemen Größe am nächsten kommt). Full HD ergibt 2×2. Werte bewusst so gewählt, dass Full HD nicht 3×2 bekommt.
- Bereiche, die nicht passen, bleiben im Store und werden nur ausgeblendet (Hinweisleiste); beim Vergrößern kommen sie zurück. Freie Plätze stehen in `useUi().splitRoom` (von SplitChat gesetzt, 0 außerhalb des Chats) und steuern den Knopf in der Seitenleiste.
- Store (`stores/ui.ts`): `splitPanes` (in localStorage `forge.ui` gespeichert), `addSplitPane`, `setSplitPane`, `closeSplitPane(s)`, `promoteSplitPane` (tauscht mit dem Hauptchat), `forgetSessions` (gelöschte Sessions aus allen Bereichen). Eine Session erscheint höchstens einmal: `openProject`/`setActiveSession` tauschen per `swapIntoMain`, wenn der Hauptchat eine Session öffnet, die ein Bereich zeigt.
- Bereich ohne `projectId` zeigt eine Auswahl (laufende Sessions aller Projekte, letzte des offenen Projekts, neue Session).

## Stolperfalle: "dieser Chat" statt Hauptchat
- `components/workspace/chat-slot.ts`: `ChatSlotContext` sagt jeder Komponente im Chat, in welchem Bereich sie sitzt. Wer die Session des eigenen Chats wechselt (Session starten, /clear, Verzweigen), muss `useChatSlot().select(projectId, id)` nehmen, nicht `useUi().setActiveSession`, sonst springt der Hauptchat um.
- Entwürfe neuer Sessions sind pro Bereich getrennt: `draftKey(projectId, null, ext, slot.pane)`.
- Nur der Hauptchat hat `id="composer-input"` (Strg+N, Palette fokussieren den). Fokus im eigenen Bereich: `focusComposer(slot)`.
- Logik, die "die sichtbare Session" braucht, sollte `shownSessionIds(ui)` (`lib/session-tabs.ts`) statt `openSessionId` prüfen (so macht es `agent-review.ts`). Buffer-Eviction (`server-events.ts`) hält Sessions der Bereiche.

## Einstiege
SessionBar des Hauptchats (Knopf "Chat daneben öffnen"), Seitenleiste (Knopf je Session, Umschalt+Klick), Befehlspalette ("Chat daneben öffnen", "Geteilte Ansicht schließen"). Kein Telefon-Werkzeug: reine Bildschirmaufteilung ohne RPC.
