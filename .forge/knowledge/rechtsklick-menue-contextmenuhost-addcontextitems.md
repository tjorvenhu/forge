---
title: "Rechtsklick-Menü (ContextMenuHost, addContextItems)"
summary: "Wie FORGEs eigenes Kontextmenü statt des Browser-Menüs funktioniert und wie neue Bereiche eigene Rechtsklick-Einträge anbieten; wichtig bei neuen Listen, Karten oder Bereichen mit Aktionen."
tags: ["ui","kontextmenue","rechtsklick","konvention"]
updated: "2026-10-14T17:30:49.917Z"
---

FORGE ersetzt das Rechtsklick-Menü der WebView durch ein eigenes (`components/layout/ContextMenuHost.tsx`), eingehängt in `App.tsx` (Shell) und `ChatWindowView.tsx` (dort `search={false}`, weil Chat-Fenster keine Befehlspalette haben).

## Aufbau
- Globaler `contextmenu`-Listener auf `window`. Ruft ein Element selbst `preventDefault()` auf, bleibt das Menü zu (Ausweg für Bereiche mit eigenem Menü).
- Darstellung: Radix DropdownMenu mit unsichtbarem Anker an der Mausposition (`modal={false}`, damit ein weiterer Rechtsklick woanders sofort ein neues Menü öffnet). Gleiches Aussehen wie alle Dropdowns: `MENU_CONTENT_CLASS` und `MenuEntry` aus `components/ui/dropdown.tsx`.
- Reihenfolge der Gruppen (durch Trennlinien getrennt): Einträge der Elemente (innerstes zuerst), dann Link (nur https/http), dann Textfeld-Gruppe (Rückgängig, Wiederholen, Ausschneiden, Kopieren, Einfügen, Alles auswählen) oder bei markiertem Text „Kopieren“, zuletzt „Suchen und Befehle“ (Strg+K).
- Textfeld-Aktionen: Das Menü nimmt den Fokus, darum stellt jede Aktion Fokus und Auswahl wieder her und nutzt `document.execCommand` (behält die Undo-Historie, löst React-onChange aus). Einfügen liest `navigator.clipboard.readText()`; schlägt das fehl, kommt ein Hinweis auf Strg+V.
- `data-context-plain` an einem Bereich unterdrückt Textfeld- und Auswahl-Gruppe (Terminal: xterm hat ein verstecktes Textfeld, Kopieren/Einfügen laufen dort über `terminalMenu(key)` in `lib/terminal-registry.ts`).

## Eigene Einträge anbieten
```tsx
import { contextItems, copyText } from "@/lib/context-menu";
<div onContextMenu={contextItems(() => [{ label: "…", icon: <X className="h-3.5 w-3.5" />, onSelect: () => … }])}>
```
Die Einträge werden erst beim Klick gebaut (aktueller Zustand). Leere Liste = keine eigene Gruppe. Bereits eingebaut: Chat-Nachrichten (kopieren, bearbeiten, verzweigen, Dateien zurücksetzen), Antworten (kopieren), Dateipfad-Links, Projektkarten, Seitenleiste (Projekte und Sessions), Terminal.

**Konvention:** Neue Listen, Karten oder Einträge, die Aktionen haben (Buttons, ⋯-Menü), bieten dieselben Aktionen auch per Rechtsklick an.
