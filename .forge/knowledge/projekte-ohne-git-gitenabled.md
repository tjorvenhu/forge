---
title: "Projekte ohne Git (gitEnabled) und ohne parallele Agenten (agentsEnabled)"
summary: "Wie die Projekt-Optionen „Ohne Git“ (gitEnabled) und „Keine parallelen Agenten“ (agentsEnabled) umgesetzt sind, wo sie überall greifen und was man bei neuen Git- oder Agenten-Funktionen beachten muss."
tags: ["git","projekte","agenten","sessions","telefon","ui"]
updated: "2026-10-21T06:59:27.377Z"
---

Projekte haben das Feld `gitEnabled` (Protokoll `Project` in `packages/protocol/src/models.ts`, DB-Spalte `projects.git_enabled`, Standard 1 für bestehende Projekte). Gewählt beim Anlegen/Importieren (`projects.create`/`projects.import` mit `gitEnabled`), umschaltbar per `projects.update`. Klonen ist immer mit Git, Agent-Worktrees ebenso.

## Import eines Ordners mit .git (seit 2026-10-16)
- Wunsch des Nutzers: Hat der importierte Ordner schon ein `.git` (Ordner oder Datei bei Worktree/Submodul), steht die Auswahl automatisch auf „Mit Git“ und „Ohne Git“ ist ausgegraut.
- Sidecar erzwingt es: `ProjectManager.import` setzt `gitEnabled = true`, wenn `<ordner>/.git` existiert. Gilt auch für das Telefon (`project import` mit `git: false` meldet „Der Ordner hat schon ein Git-Repository, deshalb mit Git.“).
- UI: `projects.inspectFolder({path})` -> `{hasGit}`, Hook `useFolderInspect`. `NewProjectDialog` fragt mit 250 ms Debounce und gibt `hasGit` an `GitChoice`. Steht in `NOT_ON_PHONE`.
- Ausschalten später in den Projekt-Einstellungen bleibt möglich (bewusst nicht gesperrt).

## Sidecar
- `ProjectManager.requireGit(id)` wirft `GIT_DISABLED`. Alle `git.*`-Handler (außer `git.identity`/`git.setIdentity`), `github.publish/pr/suggestPr/createPr` gehen über `gitDir()`/`requireGit` in `rpc/handlers.ts`. **Neue Git-Handler ebenfalls über `gitDir()` führen, nicht `projectDir()`.**
- `withStatus` liefert `git: null` ohne Git.
- `update`: Git aus geht nicht für Worktrees und nicht, solange das Projekt Agenten-Worktrees hat (CONFLICT). Ohne Git entfernt `update` die Tags aus `GIT_TAGS`. `TurnAutomation` prüft `gitEnabled` zusätzlich vor Auto-Commit.
- Session-Kontext: `forgeSessionTools` (`sessions/forge-tools.ts`) gibt ohne Git nur `notify` + Wissen/Dev-Werkzeuge und den Satz „arbeitet bewusst ohne Git …“. Wird Git umgeschaltet, ruft der `projects.update`-Handler `SessionService.projectGitChanged`; laufende Sessions bekommen über `TurnAutomation.hint` einmalig einen „[FORGE-Hinweis …]“-Block vor ihrer nächsten Nachricht.
- Backup: `ProjectEntry` setzt `gitEnabled` per Default auf true (ältere Backups).
- Kein Policy-Block für git-Befehle: Claude wird nur angewiesen, nicht hart gesperrt.

## Keine parallelen Agenten (agentsEnabled, seit 2026-10-21)
Wunsch: pro Projekt abschaltbar, dass Agenten mit eigenen Worktrees/Branches entstehen. Feld `agentsEnabled` (DB `agents_enabled`, Standard 1), nur am Hauptprojekt; Worktrees folgen ihrem Hauptprojekt (`update` an einem Worktree mit `agentsEnabled` -> CONFLICT). Sync-Item und Backup haben es optional bzw. mit Default true (ältere Versionen).
- `ProjectManager.requireAgents(id)` (= requireGit + `AGENTS_DISABLED`), genutzt von `worktrees.create`. Bestehende Agenten bleiben beim Ausschalten bestehen und lassen sich abschließen (bewusst kein CONFLICT wie bei Git aus).
- forge-tools: Die Werkzeugliste wird nur beim Session-Start gebaut. Deshalb zweistufig: ist es beim Start aus, bekommt Claude kein `start_agent` und statt `startAgentLine` die Zeile `agentsOffLine` (auch „keine Subagenten mit Worktree-Isolation“, weil Claude Codes Agent-Werkzeug `isolation: worktree` kennt). Wird es während der Session ausgeschaltet, lehnt `start_agent.run` mit `agentsOffRefused` ab (prüft den aktuellen Stand über `d.projects.all()`), dazu Hinweis über `SessionService.projectAgentsChanged`. `agent_status`/`message_agent`/`finish_agent` bleiben für bestehende Agenten.
- Telefon: `project settings` mit Parameter `agents` (false = aus). Bei Ausschalten hängt die Antwort die Warnung an (weniger effizient, nacheinander statt gleichzeitig); Bestätigung per Tastatur gibt es nicht, weil umkehrbar. `start_session` mit `agent: true` wird abgelehnt. `projectText` nennt „ohne parallele Agenten“ nur, wenn aus (sonst würden alle exakten Antworttexte in den Tests länger).
- Desktop: Bestätigung vor dem Ausschalten zentral über `stores/agents-switch.ts` + `components/projects/AgentsSwitch.tsx` (`switchProjectAgents(qc, p, enabled)`: Erlauben speichert sofort, Ausschalten öffnet `AgentsOffDialog`, in `App.tsx` gemountet). Genutzt von Projekt-Einstellungen (Karte „Parallele Agenten“, nur Hauptprojekt mit Git, Schalter invertiert), Palette (`project-agents`, aus einem Worktree das Hauptprojekt; `agent-new` fehlt dann) und Rechtsklick der `ProjectCard`. Agenten-Reiter bleibt sichtbar, „Paralleler Agent“ ist deaktiviert, mit Hinweis und Link „Zur Einstellung“ (öffnet bei Worktrees erst das Hauptprojekt).

## Telefon (Git)
Werkzeug `project`: Parameter `git` (create/import: false = ohne Git; settings: ein/aus). `gitOff(p)` in `phone-service.ts` lehnt `git`, `pull_request`, Agent-Start und Git-Tags in `project_automation` ab; `projectText` nennt „mit Git“/„ohne Git“.

## Desktop (Git)
- `workspaceTabsFor(project)` in `stores/ui.ts` blendet `agents` und `git` aus; genutzt von `WorkspaceView`, Strg+Zahl (`lib/shortcuts.ts`) und der Befehlspalette.
- Rechte Seitenleiste ohne „Änderungen“. `TAG_INFO` hat `git: true` für Git-Tags; Automatik und Palette blenden sie ohne Git aus.
- Schalter „Mit Git arbeiten“ in Projekt-Einstellungen → Allgemein (nur Hauptprojekte), Palette-Eintrag `project-git`. Auswahl im `NewProjectDialog` über `GitChoice`.
- Neue Git-/Agenten-Oberfläche an `project.gitEnabled` und `agentsEnabled` des Hauptprojekts koppeln.

## UI im Browser prüfen ohne Sidecar
Für reine Oberflächen reicht eine temporäre Seite unter `apps/desktop/.preview-*/` mit einer Fake-`__TAURI_INTERNALS__` (`transformCallback` merkt Callbacks, `plugin:event|listen` merkt die Callback-ID je Event, `sidecar_status` -> true, `sidecar_send` beantwortet die RPC aus einem In-Memory-Objekt und ruft den `sidecar://messages`-Callback mit `payload: [line]`). Sprache: `localStorage["forge.language"]` im zuerst importierten Modul setzen (Imports werden gehoistet). `pnpm exec vite --port 1431` in `apps/desktop`.
