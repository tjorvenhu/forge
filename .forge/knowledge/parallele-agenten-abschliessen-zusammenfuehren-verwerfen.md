---
title: "Parallele Agenten abschließen (Zusammenführen/Verwerfen)"
summary: "Wie FORGE fertige Agenten-Worktrees zusammenführt (Rebase, sonst Merge-Commit, sonst Konflikt an den Agenten) oder verwirft, wann auto-merge wartet, welche Branches gelöscht werden und was bei Windows-Pfaden und Subagenten-Worktrees zu beachten ist."
tags: ["agenten","worktree","git","merge","auto-merge","windows"]
updated: "2026-10-17T10:35:58.940Z"
---

Kern: `packages/sidecar/src/automation/agent-finish.ts` (`AgentFinisher`), RPC `agents.review` / `agents.finish`, MCP-Werkzeug `finish_agent` (autoAllow false), Telefon-Werkzeug `finish_agent` (discard dort nur nach Tastatur-Code).

`finish_agent` in Sessions erreicht alle Agenten des Projekts: eigene über ihr Kürzel, fremde (Agenten-Reiter, Telefon, andere Sessions) über ihren Branch, mit oder ohne `agent/`. `agent_status` ohne Argument listet die fremden mit. Die eigene Worktree-Session kann sich nicht selbst abschließen. Neue Werkzeuge bekommt eine Session erst nach ihrem (Neu-)Start, also nach einem FORGE-Neustart mit neuem Build.

Agenten brauchen ein Git-Repository mit mindestens einem Commit (`WorktreeService.create` wirft sonst GIT_NOT_REPO bzw. GIT_FAILED). Ohne Git gibt es keine Agenten.

## Unterschied zu Claude Code ohne FORGE
Im Terminal führt die Claude-Session, die Subagenten (Agent-Werkzeug mit isolation worktree) gestartet hat, deren Branch selbst zusammen, mitten in ihrem Durchlauf. FORGE-Agenten (`start_agent`) sind eigene Sessions; zusammengeführt wird von FORGE selbst, mit Tag auto-merge automatisch, sonst über den Prüfdialog.

## Ablauf Zusammenführen
1. Nicht committete Änderungen im Worktree werden committet ("Restliche Änderungen von <branch>").
2. Hat der Ziel-Branch neue Commits: `git rebase refs/heads/<ziel>` im Worktree. Scheitert er: `rebase --abort`, dann `mergeCommit`: `git merge-tree --write-tree` beider Enden; sauber → `git commit-tree <tree> -p <ziel> -p <branch>` ("Merge branch '<branch>' into <ziel>"), ohne Arbeitsbaum. Der Ziel-Branch geht dann auf diesen Merge-Commit. Grund (2026-10-17): Ein Rebase spielt Commit für Commit ab und scheitert an Zwischenständen, die das Endergebnis nicht mehr hat; vorher ging jeder solche Fall als "Konflikt" an den Agenten zurück, was lange dauerte. Nur wenn auch merge-tree Konflikte meldet, bekommt der Agent per `sessions.send(..., "auto")` den Auftrag (`conflictPrompt`: `git merge <ziel>`, nicht rebase, damit er jeden Konflikt nur einmal löst); ohne Session: neue Session im Worktree. Ergebnis `outcome: "conflict"`, Worktree bleibt.
3. Im Zielordner `fastForward(dir, branch, ziel, <branch oder Merge-Commit>)`: erst `git merge --ff-only <rev>`. Scheitert das an nicht committeten Änderungen dort ("would be overwritten", auch "untracked working tree files"):
   - Arbeitet eine Session im Zielordner: **warten**, nichts anfassen.
   - Neue, nicht committete Datei mit demselben Namen wie eine Datei des Agenten: warten (Pfade dafür mit `diff --name-only --relative`, sonst passen sie in Unterordner-Projekten nicht zu status/ls-files).
   - Sonst Probelauf ohne Änderung am Arbeitsbaum: `git stash create` und `git merge-tree --write-tree --name-only --no-messages --merge-base=HEAD <rev> <stash>`. Sauber: `stash push`, `merge --ff-only`, `stash pop`. Konflikt: warten.
   - Warten = `outcome: "waiting"`, Worktree und Zielordner unverändert.
4. Danach Worktree entfernen (Session beendet, Ordner und FORGE-Eintrag weg) und den Branch löschen, aber nur, wenn er FORGE gehört (siehe unten).

## Welche Branches FORGE löscht (seit 2026-10-14)
- `WorktreeService.create` merkt sich für neue Branches `branch.<b>.forgeOriginDir`/`forgeOriginBranch` und zusätzlich `branch.<b>.forgeWorktree` (Ordner des Checkouts). Wird ein Agent auf einem schon vorhandenen Branch gestartet, gibt es keinen `forgeWorktree`-Eintrag.
- `branchOwner()`: Branch mit passendem `forgeWorktree` = von FORGE für diesen Worktree angelegt, wird mit `-D` gelöscht. Nur `forgeOriginDir` (ältere Agenten): `-d`, also nur wenn gemergt. Alles andere (vorhandener Branch des Nutzers, Branch, auf den der Agent gewechselt ist) bleibt, mit Hinweis. Gilt für Verwerfen, Zusammenführen, Agenten-Reiter, Telefon und forge-tools.
- Hat der Worktree-Ordner keine `.git`, fragt `branchOf()` nicht weiter (sonst antwortet ein umgebendes Repository) und löscht keinen Branch.

## Unterordner-Projekte (Monorepo)
Ist das Projekt ein Unterordner eines größeren Repositorys, legt `create()` den Checkout neben das Repository-Toplevel und registriert `path.join(checkout, prefix)` als Projekt. `worktreeRoot()` findet aus `.forge-worktrees/<repo>/<slug>` den ganzen Checkout für Dirty-Check, Löschen, branchOf, Rest-Commit und den `.git`-Check von auto-merge. Ältere Worktrees im alten Layout funktionieren weiter.

## Stolperfalle: zu lange Pfade (Windows)
Agenten-Worktrees haben eigenes `node_modules` (pnpm) mit Pfaden über 260 Zeichen. `GitEngine.exec` setzt immer `-c core.longpaths=true`; `WorktreeService.deleteFolder` löscht bei „Filename too long“ mit Node `rm`, danach `worktree prune`. `AgentAutoMerge.run`: Hat der Worktree-Ordner keine `.git` mehr, sind es Reste; sie werden still per discard aufgeräumt.

## Stolperfalle: leere node_modules-Gerippe nach erfolgreichem Entfernen
`git worktree remove` lässt unter Windows trotz Exit 0 manchmal Ordner mit nur noch pnpm-`node_modules` (Junctions) stehen. `deleteFolder` löscht einen noch vorhandenen Ordner danach mit Node `rm`. Alte Reste ohne `.git` und ohne Dateien außerhalb von `node_modules` können gefahrlos weg.

## Claude-Code-Subagenten unter .claude/worktrees
`<projekt>/.claude/worktrees/agent-<hex>` (Branches `worktree-agent-<hex>`) sind Worktrees von Claude-Code-Subagenten (Agent-Werkzeug mit isolation worktree), nicht von FORGE. Solange `git worktree list` sie als `locked` zeigt, arbeitet dort ein Subagent. Claude Code räumt sie nur selbst weg, wenn der Subagent nichts geändert hat; mit Änderungen bleiben Worktree und Branch auch nach dem Merge liegen. FORGE räumt gemergte selbst auf (`pruneSubagentWorktrees`). Von Hand, wenn nicht locked, sauber und gemergt: `git -c core.longpaths=true worktree remove <dir>`, `git branch -d <branch>`; bleibt der Ordner („Directory not empty“, pnpm-node_modules), mit Node `fs.rmSync(dir, {recursive:true, force:true})` löschen (folgt Junctions nicht). Im FORGE-Repo stehen sie in `.gitignore`. Git meldet solche eingebetteten Repositorys als untracked Eintrag mit `/` am Ende; `parseStatusV2` lässt diese weg, sonst scheiterte Auto-Commit mit EISDIR und `git add` würde einen kaputten Gitlink einbetten.

## Automatisch zusammenführen (Tag auto-merge)
`packages/sidecar/src/automation/agent-auto-merge.ts` (`AgentAutoMerge`). Auslöser: `TurnAutomation.schedule` ruft nach Tests/Auto-Commit `host.turnDone(sessionId, testsOk)`, aber nur, wenn keine zurückgehaltene Nachricht nachfolgt.
- **Standard an (seit 2026-10-17, Nutzerwunsch):** `ProjectManager.import` gibt neuen Hauptprojekten mit Git das Tag `auto-merge`; eine Migration hat es einmalig allen bestehenden Hauptprojekten mit Git gegeben (auch solchen, bei denen es vorher bewusst aus war). Abschalten in den Projekteinstellungen bleibt möglich.
- Entscheidend ist das Tag am Hauptprojekt (`autoMergeOn`), nicht am Worktree (Worktrees kopieren die Tags beim Start).
- Kein Merge bei roten Tests oder `mergeBlocker` (dann `outcome: skipped`).
- **Laufende Hintergrundaufgaben des Agenten:** früher wurde einfach nichts getan, ein Agent mit einem weiterlaufenden Server wurde so nie zusammengeführt. Jetzt kommt er auf die Warteliste und meldet einmal "Wartet aufs Zusammenführen: … noch laufende Hintergrundaufgaben"; `retryWaiting` überspringt ihn, solange `hasBackground` gilt.
- Warten: Liefert der Finisher `waiting`, merkt sich AgentAutoMerge den Agenten (nur im Speicher) und versucht es am Ende jedes Durchlaufs irgendeiner Session und alle 30 s erneut (`WAITING_RETRY_MS`, vorher 2 Minuten).
- Konflikte gehen höchstens 3 mal an den Agenten zurück.
- Mit auto-merge öffnet der Desktop nie von selbst ein Modal: `skipped` wird ein Toast mit Knopf „Ansehen“.
- Das Event `agent.autoMerge` trägt `sessionIds` (Sessions des Worktrees, vor dem Merge gelesen, nur bei `merged` gefüllt). `agentAutoMerged` im Desktop schließt damit die Chat-Fenster des Agenten.
- Agenten bekommen im Start-Kontext den Hinweis, Rückfragen nur per AskUserQuestion zu stellen.

## Wohin die Arbeit zurückgeht
`branch.<name>.forgeOriginDir` und `branch.<name>.forgeOriginBranch` (siehe oben). Fehlt der Eintrag oder ist der Ordner weg: Hauptprojekt und dessen aktueller Branch. Ist im Zielordner ein anderer Branch als forgeOriginBranch ausgecheckt, wird blockiert (mergeBlocker).

## Modal im Hauptfenster (ohne auto-merge)
`apps/desktop/src/lib/agent-review.ts` reagiert auf `turn.result` einer Session in einem Worktree-Projekt und legt das Projekt in die Warteschlange `stores/agent-review.ts`. Nach Zusammenführen oder Verwerfen schließt der Desktop die Chat-Fenster der Sessions dieses Worktrees (`chatWindowsOfProject`); `applyReattach` öffnet keine Projekte mehr, die es nicht mehr gibt.

## Seitenleiste
Sessions eines Worktrees stehen in `OpenSessions` unter dem Hauptprojekt (`groupOf` in `lib/session-tabs.ts`), markiert mit Bot-Symbol.
