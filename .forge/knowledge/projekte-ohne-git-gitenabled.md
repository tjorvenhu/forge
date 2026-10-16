---
title: "Projekte ohne Git (gitEnabled)"
summary: "Wie die Projekt-Option „Ohne Git“ umgesetzt ist (Feld gitEnabled), dass Ordner mit .git immer mit Git importiert werden, und was man bei neuen Git- oder Agenten-Funktionen beachten muss."
tags: ["git","projekte","agenten","sessions","telefon","ui"]
updated: "2026-10-16T18:09:54.333Z"
---

Projekte haben das Feld `gitEnabled` (Protokoll `Project` in `packages/protocol/src/models.ts`, DB-Spalte `projects.git_enabled`, Standard 1 für bestehende Projekte). Gewählt beim Anlegen/Importieren (`projects.create`/`projects.import` mit `gitEnabled`), umschaltbar per `projects.update`. Klonen ist immer mit Git, Agent-Worktrees ebenso.

## Import eines Ordners mit .git (seit 2026-10-16)
- Wunsch des Nutzers: Hat der importierte Ordner schon ein `.git` (Ordner oder Datei bei Worktree/Submodul), steht die Auswahl automatisch auf „Mit Git“ und „Ohne Git“ ist ausgegraut. Früher blieb ein vorhandenes .git bei „Ohne Git“ einfach unberührt; das gibt es nicht mehr.
- Sidecar erzwingt es: `ProjectManager.import` setzt `gitEnabled = true`, wenn `<ordner>/.git` existiert, egal was übergeben wurde. Gilt damit auch für das Telefon (`project import` mit `git: false` meldet „Der Ordner hat schon ein Git-Repository, deshalb mit Git.“).
- UI: `projects.inspectFolder({path})` -> `{hasGit}` (fehlender/unlesbarer Ordner = false, kein Fehler), Hook `useFolderInspect` in `lib/queries.ts`. `NewProjectDialog` fragt mit 250 ms Debounce und gibt `hasGit` an `GitChoice`. Steht in `NOT_ON_PHONE` (nur Vorschau).
- Ausschalten später in den Projekt-Einstellungen bleibt möglich (bewusst nicht gesperrt).

## Sidecar
- `ProjectManager.requireGit(id)` wirft `GIT_DISABLED` (neuer ErrorCode). Alle `git.*`-Handler (außer `git.identity`/`git.setIdentity`), `github.publish/pr/suggestPr/createPr` und `worktrees.create` gehen über `gitDir()`/`requireGit` in `rpc/handlers.ts`. **Neue Git-Handler ebenfalls über `gitDir()` führen, nicht `projectDir()`.**
- `withStatus` liefert `git: null` ohne Git (kein `git status` auf dem Ordner).
- `update`: Git aus geht nicht für Worktrees und nicht, solange das Projekt Agenten-Worktrees hat (CONFLICT). Ohne Git entfernt `update` die Tags aus `GIT_TAGS` (auto-commit, auto-push, auto-merge, review-required) und lässt sie nicht wieder zu. `TurnAutomation` prüft `gitEnabled` zusätzlich vor Auto-Commit.
- Session-Kontext: `forgeSessionTools` (`sessions/forge-tools.ts`) gibt ohne Git nur `notify` + Wissen/Dev-Werkzeuge und den Satz „arbeitet bewusst ohne Git … keine git-Befehle“. Wird Git umgeschaltet, ruft der `projects.update`-Handler `SessionService.projectGitChanged`; laufende Sessions bekommen über `TurnAutomation.hint` einmalig einen „[FORGE-Hinweis …]“-Block vor ihrer nächsten Nachricht (gleicher Weg wie die Auto-Commit-Notiz, `takeNote`).
- Backup: `ProjectEntry` setzt `gitEnabled` per Default auf true (ältere Backups).
- Kein Policy-Block für git-Befehle: Claude wird nur angewiesen, nicht hart gesperrt.

## Telefon
Werkzeug `project`: Parameter `git` (create/import: false = ohne Git; settings: ein/aus). `gitOff(p)` in `phone-service.ts` lehnt `git`, `pull_request`, Agent-Start und Git-Tags in `project_automation` ab; `projectText` nennt „mit Git“/„ohne Git“.

## Desktop
- `workspaceTabsFor(project)` in `stores/ui.ts` blendet `agents` und `git` aus; genutzt von `WorkspaceView` (gespeicherter Tab fällt auf Chat zurück), Strg+Zahl (`lib/shortcuts.ts`, nummeriert nach sichtbaren Tabs) und der Befehlspalette (Hinweis `Strg+N` passt dazu).
- Rechte Seitenleiste ohne „Änderungen“. `TAG_INFO` hat `git: true` für Git-Tags; Automatik und Palette blenden sie ohne Git aus.
- Schalter „Mit Git arbeiten“ in Projekt-Einstellungen → Allgemein (nur Hauptprojekte), Palette-Eintrag `project-git`. Auswahl im `NewProjectDialog` über `GitChoice` (Import und Neu, Prop `hasGit` sperrt „Ohne Git“); „Git initialisieren“ gibt es nicht mehr separat: Mit Git = `git init`.
- Neue Git-/Agenten-Oberfläche an `project.gitEnabled` koppeln.
