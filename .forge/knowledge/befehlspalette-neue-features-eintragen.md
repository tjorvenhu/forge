---
title: "Befehlspalette: neue Features eintragen"
summary: "Wie die Suche (Strg+K) aufgebaut ist und was man bei neuen Einstellungen, Tabs, Bereichen oder Aktionen tun muss, damit sie in der Palette landen."
tags: ["suche","befehlspalette","ui","tests"]
updated: "2026-10-13T12:44:51.312Z"
---

Projektregel: Die Suche (Befehlspalette, Strg+K, `components/layout/CommandPalette.tsx`) soll alle Funktionen, Einstellungen, Projekte und Aktionen von FORGE finden und ausführen können.

## Aufbau
- `components/layout/palette-actions.tsx`: `buildActions(ctx)` ist eine reine Funktion und liefert alle Aktionen und Einstellungen (Gruppen „Aktionen“, „Einstellungen“, „Erweiterungen“). Die Aufrufe machen es wie die jeweilige Komponente (Toast bei Fehler, Query-Invalidierung).
- `components/layout/palette-sources.tsx`: geladene Inhalte (Projekte, Sessions, Branches, Wissen, Dateien, MCP-Server, Skills). Ab zwei Zeichen geladen; Dateien per Breitensuche über `projects.listFiles`, gedeckelt (150 Ordner, 3000 Dateien, node_modules/dist usw. übersprungen).
- `components/layout/PaletteDialogs.tsx`: Dialoge, die ein Eintrag öffnet (Session löschen, Zusammenfassung, Agent, Branch, PR). Sie leben in `CommandPalette` außerhalb des Palette-Inhalts, weil die Palette beim Ausführen schließt.
- Bereichslisten stehen als Laufzeit-Arrays in `stores/ui.ts` (`SETTINGS_SECTIONS`, `WORKSPACE_TABS`, `PROJECT_SETTINGS_SECTIONS`, `DEV_TOOLS_SECTIONS`, `EXTENSIONS_TABS`, `SKILLS_TABS`). Labels kommen aus den exportierten `SECTIONS`/`TAG_INFO`/`RULE_GROUPS`/`EXTENSION_TAB_DEFS` der jeweiligen Ansicht, damit sie nicht doppelt gepflegt werden.
- Deep-Links: `openSettings`, `openProjectSettings`, `openDevTools`, `openExtensions(tab, skillsTab)`, `openKnowledge`, `openFile`.

## Absicherung
`palette-actions.test.tsx` baut die Aktionen mit vollem Kontext und schlägt fehl, wenn ein Einstellungsbereich, Workspace-Tab, Projekt-Einstellungsbereich, Dev-Tools-Bereich, Erweiterungs-Tab, NAV-Eintrag, Automatik-Tag, eine Sperrlisten-Regel oder ein boolesches Feld von `Settings` (models.ts) keinen Eintrag hat. Neue boolesche Settings brechen schon den Typecheck (`SETTING_TOGGLES` ist ein Record über alle booleschen Keys); absichtlich ausgelassene stehen mit Begründung in `UNLISTED_SETTINGS` (z. B. `debugLogs`, wird nirgends ausgewertet).

Neue Bereiche in den genannten Listen erscheinen meist automatisch. Neue Aktionen (RPC-Aufrufe mit Knopf) muss man in `buildActions` von Hand ergänzen; dafür gibt es keinen Test.
