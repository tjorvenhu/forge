---
title: "Parallele Agenten: Worktree vorbereiten, abschließen (Zusammenführen/Verwerfen), Merge-Reste aufräumen"
summary: "Wie FORGE Agenten-Worktrees wie den Hauptordner einrichtet (WorktreeSetup), wie fertige Agenten zusammengeführt oder verworfen werden (auch wenn im Projekt ein anderer Branch ausgecheckt ist), wie Reste halb gelöschter Worktrees aufgeräumt werden, und die Junction-Falle beim Entfernen."
tags: ["agenten","worktree","git","auto-merge","windows","stolperfalle"]
updated: "2026-10-24T12:20:43.051Z"
---

Kern: `packages/sidecar/src/automation/agent-finish.ts` (`AgentFinisher`), RPC `agents.review` / `agents.finish`, MCP-Werkzeug `finish_agent` (autoAllow false), Telefon-Werkzeug `finish_agent` (discard dort nur nach Tastatur-Code).

`finish_agent` in Sessions erreicht alle Agenten des Projekts: eigene über ihr Kürzel, fremde (Agenten-Reiter, Telefon, andere Sessions) über ihren Branch, mit oder ohne `agent/`. `agent_status` ohne Argument listet die fremden mit. Die eigene Worktree-Session kann sich nicht selbst abschließen. Neue Werkzeuge bekommt eine Session erst nach ihrem (Neu-)Start.

Agenten brauchen ein Git-Repository mit mindestens einem Commit (`WorktreeService.create` wirft sonst GIT_NOT_REPO bzw. GIT_FAILED). FORGE-Agenten (`start_agent`) sind eigene Sessions; zusammengeführt wird von FORGE selbst (Tag auto-merge oder Prüfdialog), nicht von der startenden Session.

## Worktree vorbereiten (WorktreeSetup, seit 2026-10-17)
`automation/worktree-setup.ts`. `WorktreeService.create` startet am Ende `setup.start(parent, worktree)`, parallel zur Agent-Session; `WorktreeService.remove` ruft vorher `setup.release` (beendet laufende Installation, `devServers.forget`, `testDb.forget`). Beide `WorktreeService`-Instanzen (app.ts und SessionService für start_agent) bekommen den Dienst über `useSetup` bzw. `sessions.useWorktreeSetup`.
Schritte (Event `worktree.setup`, RPC `worktrees.setup`/`worktrees.prepare`, Telefon `dev_server` mit action setup/prepare):
1. **Lokale Konfiguration**: ignorierte Dateien des Hauptordners (`git ls-files -z --others --ignored --exclude-standard --directory`) nach `LOCAL_CONFIG` (.env*, *.local*, .npmrc, .dev.vars …), nur wenn `git check-ignore` sie im Worktree auch ignoriert (sonst könnten sie committet werden; der Rest-Commit wirft bei .env sogar POLICY_DENIED). Nur Namen in Details/Logs, nie Inhalte.
2. **Abhängigkeiten**: nächstes Lockfile vom Projekt aufwärts bis zur Checkout-Wurzel: `pnpm install --frozen-lockfile --prefer-offline`, `npm ci`, `yarn install --immutable/--frozen-lockfile`, `bun install --frozen-lockfile`; Python nur mit uv.lock (`uv sync --frozen`) oder wenn der Hauptordner ein venv hat. Env `CI=true` (pnpm fragt sonst ohne TTY). Fehler blockieren nicht, sie stehen in dev_environment.
3. **Build-Ausgaben** (nach der Installation): `dist`/`build` von Paketen mit package.json bis 200 MB; Rust: nur `target/debug/{.fingerprint,build,deps}` (nicht `incremental`, das ist an den Crate-Pfad gebunden; nicht `debug/runtime`, Tauris Ressourcenkopie); Ordner aus `bundle.resources` der tauri.conf.json. Kopiert mit robocopy `/E /XJ /MT:16` (Zeitstempel bleiben, Cargo vergleicht sie).
4. **Test-Datenbank**: jeder Worktree hat einen eigenen PostgreSQL-Server (`TestDbService`, Instanz pro projectId, Einstellungen vom Projekt, Port ab 55330). `seed()` kopiert den Datenordner des Projekts, aber nur wenn dessen Server nicht läuft (Dateikopie eines laufenden Clusters ist inkonsistent); sonst legt der erste Start eine leere an.
5. **Dev-Server**: Port ab 4100 pro Worktree (`devPort`), per `PORT` und, wo der Befehl es versteht (vite, next dev, astro, …; auch über `pnpm dev`, bei npm mit `--`), per `--port` (`devserver/port-args.ts`). Startet automatisch nur, wenn der Dev-Server des Hauptprojekts läuft; sonst auf Wunsch.
Agent-Kontext: `setupContext` sagt, was noch läuft; `dev_environment` mit `wait=true` wartet bis 4 Minuten.

Warum kein gemeinsamer target-Ordner (CARGO_TARGET_DIR): Cargo sperrt ihn pro Build, und `target/debug/forge-desktop.exe` wäre für beide Builds dieselbe Datei.

## Stolperfalle: Junctions in Worktrees (2026-10-17)
`git worktree remove --force` (Git für Windows) **folgt Junctions und leert ihr Ziel**. Ein Versuch, `src-tauri/runtime` per Junction aus dem Hauptordner einzubinden, hat beim Entfernen den runtime-Ordner des Hauptprojekts gelöscht. Deshalb nie Links in Worktrees anlegen, nur Kopien (robocopy mit `/XJ`). pnpm-Junctions in node_modules zeigen nur in den Worktree selbst; mit pnpm `enableGlobalVirtualStore` wäre das anders.
Weitere Windows-Fallen beim Entfernen: Pfade über 260 Zeichen (`GitEngine.exec` setzt `core.longpaths=true`, `deleteFolder` löscht bei „Filename too long“ mit Node `rm`, danach `worktree prune`); nach Exit 0 bleiben manchmal leere node_modules-Gerippe stehen, `deleteFolder` löscht sie nach.
`git check-ignore` verträgt `GIT_LITERAL_PATHSPECS=1` (setzt GitEngine immer) nicht: „pathspec magic not supported“. Für diesen Aufruf `GIT_LITERAL_PATHSPECS=0` übergeben.

## Stolperfalle: git-Timeout beim Löschen großer Worktrees (2026-10-24)
`git worktree remove` hat 60 s Timeout. Bei großem node_modules (cento, 6 Agenten gleichzeitig) wurde git abgebrochen: git löscht alphabetisch, `.git` war schon weg, README/apps/node_modules blieben, Fehlertext leer („Worktree konnte nicht entfernt werden“). Folge: Merge war durch, aber FORGE-Eintrag, Ordner und Branch blieben, und nichts räumte sie je auf (der alte Aufräumweg lief nur beim nächsten Durchlauf genau dieses Agenten, den es nie gab). Jetzt: `deleteFolder` fällt bei `r.timedOut` auf Node `rm` zurück.

## Merge-Reste aufräumen (isRemains / clearRemains)
Rest = Worktree-Eintrag, dessen Checkout-Wurzel kein `.git` mehr hat (und der gerade nicht in `finish()` steckt, Set `finishing`). `AgentFinisher.clearRemains`: liest vorher den Branch aus `git worktree list --porcelain` (`WorktreeService.registeredBranch`, geht nur vor `worktree prune`), entfernt Ordner und Eintrag, löscht den Branch nur, wenn FORGE ihn angelegt hat und er im Ursprungs-Branch aufgegangen ist (`merge-base --is-ancestor`). Unabhängig vom auto-merge-Tag. `AgentAutoMerge.clearRemains` läuft für alle Projekte nach jedem Durchlauf (parallel zum eigenen Merge, damit das Löschen ihn nicht aufhält) und 15 s nach dem Start (`REMAINS_DELAY_MS` in session-service.ts). Ein noch gesperrter Ordner bleibt bis zur nächsten Runde.

## Ablauf Zusammenführen
1. Nicht committete Änderungen im Worktree werden committet ("Restliche Änderungen von <branch>"). Steckt der Agent mitten in `git merge` (MERGE_HEAD, Konflikte gelöst, nicht committet), geht kein Commit einzelner Dateien („cannot do a partial commit during a merge“): dann `concludeMerge` (`add -A` + `commit --no-edit`), gleiche Sperre für sensible Dateien wie `GitEngine.commit`.
2. Hat der Ziel-Branch neue Commits: `git rebase refs/heads/<ziel>`. Scheitert er: `rebase --abort`, dann `git merge-tree --write-tree`; sauber → `git commit-tree <tree> -p <ziel> -p <branch>`, Ziel-Branch geht auf diesen Merge-Commit. Nur bei echten Konflikten bekommt der Agent per `sessions.send(..., "auto")` den Auftrag `git merge <ziel>`; Ergebnis `outcome: "conflict"`, Worktree bleibt.
3. Im Zielordner `git merge --ff-only <rev>`. Scheitert das an nicht committeten Änderungen: arbeitet dort eine Session oder gibt es eine gleichnamige neue Datei → warten; sonst Probelauf `git stash create` + `merge-tree`, sauber → `stash push`, `merge --ff-only`, `stash pop`, sonst warten (`outcome: "waiting"`).
4. Danach Worktree entfernen (Session beendet, Dev-Server und Test-Datenbank weg, Ordner und FORGE-Eintrag weg) und den Branch löschen, wenn er FORGE gehört.

## Ziel, wenn im Projekt ein anderer Branch ausgecheckt ist (seit 2026-10-24)
Früher Sperre „Der Agent ist von main abgezweigt, im Projekt ist jetzt X ausgecheckt“ → Agent `skipped`, nie wieder versucht, Agenten stapelten sich (passiert, wenn eine Session im Hauptordner einen Feature-Branch anlegt, während Agenten laufen). Jetzt in `locate()`: Ziel bleibt `forgeOriginBranch`. Ist er in einem anderen Arbeitsbaum ausgecheckt (`checkouts()`), wird dort per ff gemergt; ist er nirgends ausgecheckt, verschiebt `moveBranch` nur die Ref (`update-ref <ref> <neu> <alt>`, nur vorwärts, prüft vorher noch einmal, dass ihn niemand ausgecheckt hat); der Checkout des Projekts bleibt unberührt. Sperre nur noch, wenn der Ursprungs-Branch gelöscht ist (`blockerOriginGone`).

## Welche Branches FORGE löscht
`create()` merkt sich für neue Branches `branch.<b>.forgeOriginDir`/`forgeOriginBranch` und `branch.<b>.forgeWorktree`. `branchOwner()`: passendes `forgeWorktree` → `-D`; nur `forgeOriginDir` (ältere Agenten) → `-d`; sonst bleibt der Branch mit Hinweis. Ohne `.git` im Worktree-Ordner löscht `branchOf()` keinen Branch (clearRemains nimmt dafür `registeredBranch`). Ziel der Arbeit: forgeOriginDir/-Branch, sonst Hauptprojekt.

## Unterordner-Projekte (Monorepo)
Checkout neben dem Repository-Toplevel, Projekt = `path.join(checkout, prefix)`. `worktreeRoot()` findet aus `.forge-worktrees/<repo>/<slug>` den ganzen Checkout (Dirty-Check, Löschen, Rest-Commit, Vorbereitung).

## Claude-Code-Subagenten unter .claude/worktrees
`<projekt>/.claude/worktrees/agent-<hex>` gehören Claude Code, nicht FORGE; `locked` = Subagent arbeitet. FORGE räumt gemergte selbst auf (`pruneSubagentWorktrees`). `parseStatusV2` lässt solche eingebetteten Repositorys (untracked mit `/`) weg.

## Automatisch zusammenführen (Tag auto-merge)
`agent-auto-merge.ts`. Auslöser: `TurnAutomation` → `host.turnDone(sessionId, testsOk)`. Standard an für Hauptprojekte mit Git (seit 2026-10-17). Entscheidend ist das Tag am Hauptprojekt. Kein Merge bei roten Tests oder mergeBlocker (`skipped`, Toast mit „Ansehen“; `skipped` wird nicht wiederholt, erst der nächste Durchlauf des Agenten versucht es erneut). Laufende Hintergrundaufgaben → Warteliste; `waiting` → erneuter Versuch nach jedem Durchlauf und alle 30 s. Konflikte höchstens 3 mal zurück an den Agenten. `agent.autoMerge` trägt `sessionIds`, der Desktop schließt damit die Chat-Fenster.
Diagnose liegengebliebener Agenten: Tabelle `agent_log` in `%APPDATA%/forge/forge.db` (letzte Zeile je `worktree_id`: outcome + message), lesbar mit `node:sqlite` (`DatabaseSync`, readOnly).

## Desktop
Agenten-Reiter (`AgentsTab.tsx`, `AgentEnvironment.tsx`): Karte zeigt Vorbereitung und den eigenen Dev-Server; Rechtsklick: Öffnen, Dev-Server öffnen/stoppen, Vorbereitung wiederholen, Abschließen, Entfernen. Befehlspalette: „Dev-Server des Agenten öffnen: <branch>“, „Worktree des Agenten neu vorbereiten“. Modal ohne auto-merge: `lib/agent-review.ts` + `stores/agent-review.ts`. Seitenleiste: Worktree-Sessions unter dem Hauptprojekt (`groupOf`).
