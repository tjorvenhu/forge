---
title: "Projektgruppen (group, projects.renameGroup, ProjectGroupDialogs)"
summary: "Wie Projekte in eigene Gruppen (z. B. nach Kunde) eingeordnet werden: Feld group, Schreibweise ohne Groß/Klein, Umbenennen/Auflösen, Sync, Telefon, Palette; wichtig bei Änderungen an der Projektliste."
tags: ["ui","sidecar","telefon","sync","projekte"]
updated: "2026-10-20T16:04:40.737Z"
---

Projekte haben ein Feld `group: string | null` (Protokoll `Project`, DB-Spalte `projects.group_name`, weil `group` ein SQL-Schlüsselwort ist). Gültiger Name: `ProjectGroup` (getrimmt, 1 bis 60 Zeichen).

## Sidecar
- Gruppen vergleichen ohne Groß/Klein. `ProjectManager.update` übernimmt beim Zuordnen die Schreibweise einer schon bestehenden Gruppe (`groupSpelling`, das eigene Projekt ausgenommen, damit das einzige Mitglied die Schreibweise ändern kann).
- `projects.renameGroup({from, to})`: benennt in allen Projekten um, legt mit einer bestehenden Gruppe zusammen; `to: null` löst auf. Unbekannte Gruppe = NOT_FOUND.
- Worktrees bekommen keine eigene Gruppe; sie erscheinen unter der Gruppe ihres Hauptprojekts. Das Telefon ordnet bei einem Worktree deshalb das Hauptprojekt ein.
- Sync: `ProjectItem.group` ist optional. Items älterer FORGE-Versionen ohne das Feld lassen die lokale Gruppe unverändert (nicht auf null setzen).
- Backup: `group` defaultet auf null.

## Desktop
- `lib/project-tree.ts`: `groupKey` (lower case, "" = ohne Gruppe), `groupNames`, `groupProjects` (Gruppen alphabetisch, „Ohne Gruppe“ zuletzt).
- `ProjectsView`: Abschnitte nur, wenn mindestens ein Projekt eine Gruppe hat, sonst flaches Raster wie früher. Einklappen per `useUi.collapsedProjectGroups` (gespeichert in `forge.ui`), Filter per `useUi.projectGroupFilter` / `showProjectGroup(key)`. Beim Suchen/Filtern sind alle Abschnitte offen.
- Dialoge (Zuordnen, Umbenennen, Auflösen) in `components/projects/ProjectGroupDialogs.tsx`, gesteuert über `stores/project-groups.ts`, gemountet in `App.tsx`. Geöffnet von Karte (Rechtsklick + ⋯), Abschnittskopf, Projekt-Einstellungen → Allgemein, Befehlspalette.
- Palette: `project-group`/`project-ungroup` (Aktionen für das offene Projekt), je Gruppe `group-*`, `group-rename-*`, `group-dissolve-*` in `palette-sources.tsx`.

## Telefon
Werkzeug `project`: Aktionen `group` (Parameter `group`, leer = herausnehmen), `rename_group` (`group` alt, `name` neu), `dissolve_group`. `projects` und `info` nennen die Gruppe.

## Test-Falle
`test/db-settings.test.ts` suchte die Sprach-Migration früher per `MIGRATIONS.at(-1)`; jetzt per Inhalt. Neue Migrationen hängen also nicht mehr davon ab.
