---
title: "Projektgruppen (group, projects.renameGroup, ProjectGroupDialogs, Drag and Drop, leere Gruppen)"
summary: "Wie Projekte in eigene Gruppen (z. B. nach Kunde) eingeordnet werden: Feld group, Schreibweise ohne Groß/Klein, Umbenennen/Auflösen, Gruppe erstellen, Ziehen auf Gruppen, Sync, Telefon, Palette; wichtig bei Änderungen an der Projektliste."
tags: ["ui","sidecar","telefon","projekte","stolperfalle"]
updated: "2026-10-20T16:38:29.478Z"
---

Projekte haben ein Feld `group: string | null` (Protokoll `Project`, DB-Spalte `projects.group_name`, weil `group` ein SQL-Schlüsselwort ist). Gültiger Name: `ProjectGroup` (getrimmt, 1 bis 60 Zeichen).

## Sidecar
- Gruppen vergleichen ohne Groß/Klein. `ProjectManager.update` übernimmt beim Zuordnen die Schreibweise einer schon bestehenden Gruppe (`groupSpelling`, das eigene Projekt ausgenommen, damit das einzige Mitglied die Schreibweise ändern kann).
- `projects.renameGroup({from, to})`: benennt in allen Projekten um, legt mit einer bestehenden Gruppe zusammen; `to: null` löst auf. Unbekannte Gruppe = NOT_FOUND (gilt auch für leere Gruppen, die es nur im Client gibt).
- Es gibt keine eigene Gruppen-Tabelle: eine Gruppe existiert nur, solange ein Projekt in ihr ist.
- Worktrees bekommen keine eigene Gruppe; sie erscheinen unter der Gruppe ihres Hauptprojekts. Telefon und Ziehen ordnen bei einem Worktree deshalb das Hauptprojekt ein (`parentId ?? id`).
- Sync: `ProjectItem.group` ist optional. Items älterer FORGE-Versionen ohne das Feld lassen die lokale Gruppe unverändert (nicht auf null setzen).
- Backup: `group` defaultet auf null.

## Desktop
- `lib/project-tree.ts`: `groupKey` (lower case, "" = ohne Gruppe), `groupNames`, `groupProjects` (Gruppen alphabetisch, „Ohne Gruppe“ zuletzt), `withEmptyGroups` (leere Gruppen einsortieren).
- `ProjectsView`: Abschnitte nur, wenn mindestens ein Projekt eine Gruppe hat oder eine leere Gruppe existiert, sonst flaches Raster wie früher. Einklappen per `useUi.collapsedProjectGroups` (gespeichert in `forge.ui`), Filter per `useUi.projectGroupFilter` / `showProjectGroup(key)`. Beim Suchen/Filtern sind alle Abschnitte offen und leere Gruppen ausgeblendet.
- Dialoge (Zuordnen, Erstellen/Projekte hinzufügen, Umbenennen, Auflösen) in `components/projects/ProjectGroupDialogs.tsx`, gesteuert über `stores/project-groups.ts`, gemountet in `App.tsx`. Geöffnet von Karte (Rechtsklick + ⋯), Abschnittskopf, Projekt-Einstellungen → Allgemein, Befehlspalette, Knopf „Gruppe erstellen“ im Seitenkopf.
- „Gruppe erstellen“ (`openCreate()`): Name + optionale Projektauswahl. Mit Auswahl `moveProjectsToGroup` (ein Toast für alle). Ohne Auswahl landet der Name in `useProjectGroupDialogs.emptyGroups` (nur im Speicher, nicht gespeichert) und erscheint als leerer Abschnitt zum Hineinziehen; `setProjectGroup`/`moveProjectsToGroup` entfernen ihn, sobald ein Projekt drin ist. `openCreate(name)` = „Projekte hinzufügen“ zu einer Gruppe.
- Palette: `create-group`, `project-group`/`project-ungroup` (Aktionen für das offene Projekt), je Gruppe `group-*`, `group-add-*`, `group-rename-*`, `group-dissolve-*` in `palette-sources.tsx`.

## Ziehen auf Gruppen (components/projects/project-drag.tsx)
- **Stolperfalle:** Kein HTML5-Drag-and-drop (`draggable`, `onDragStart`): das Tauri-Fenster hat den nativen Datei-Drop an (Anhänge im Composer, `onDragDropEvent`), unter Windows/WebView2 kommen HTML5-Drag-Events dann nicht an. Deshalb Pointer-Events wie beim Tauschen der Split-Bereiche (`SplitView.useAreaDrag`).
- `startProjectDrag` auf `onPointerDown` der Karte: erst ab 6 px ein Drag (sonst normaler Klick), Ziel per `elementFromPoint(...).closest("[data-project-drop]")` (Abschnitte setzen `dropTargetProps(key, name)`), Escape bricht ab, der Klick nach dem Loslassen wird geschluckt, Auto-Scroll am Rand des Scroll-Containers. Zustand in `useProjectDrag` (Geist `ProjectDragGhost`, Hervorhebung `useDropState`). Während ein gruppiertes Projekt gezogen wird, erscheint „Ohne Gruppe“ auch leer als Ziel.
- `preview_interact` kann nicht ziehen: Logik in `project-drag.test.tsx` (stubbt `document.elementFromPoint`), Optik in einer Vorschauseite durch direktes Setzen von `useProjectDrag.setState` prüfen.

## Telefon
Werkzeug `project`: Aktionen `group` (Parameter `group`, leer = herausnehmen; ein neuer Name erstellt die Gruppe), `rename_group` (`group` alt, `name` neu), `dissolve_group`. `projects` und `info` nennen die Gruppe. Leere Gruppen gibt es am Telefon nicht (nur im Desktop-Client).

## Test-Falle
`test/db-settings.test.ts` suchte die Sprach-Migration früher per `MIGRATIONS.at(-1)`; jetzt per Inhalt. Neue Migrationen hängen also nicht mehr davon ab.
