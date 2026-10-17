---
title: "Parallele Agenten: Worktree vorbereiten, abschließen (Zusammenführen/Verwerfen)"
summary: "Wie FORGE Agenten-Worktrees wie den Hauptordner einrichtet (WorktreeSetup: Abhängigkeiten, .env, Build-Cache, eigene Test-Datenbank, eigener Dev-Server-Port), wie fertige Agenten zusammengeführt oder verworfen werden und die Junction-Falle beim Entfernen."
tags: ["agenten","worktree","git","auto-merge","windows","stolperfalle"]
updated: "2026-10-17T11:56:31.932Z"
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

Gemessen am FORGE-Repo (2026-10-17): vorher fehlte alles (pnpm install 15 s von Hand, Rust-Build frisch 110 s, runtime fehlte, ohne die baut Tauri gar nicht). Nachher: Vorbereitung 20 s gesamt (pnpm 13 s, Kopien 6 s, 3,4 GB Rust-Cache + 462 MB runtime), danach `pnpm typecheck` sofort grün, `cargo build` 43 s (nur das App-Crate).
Warum kein gemeinsamer target-Ordner (CARGO_TARGET_DIR): Cargo sperrt ihn pro Build, und `target/debug/forge-desktop.exe` wäre für beide Builds dieselbe Datei.

## Stolperfalle: Junctions in Worktrees (2026-10-17)
`git worktree remove --force` (Git für Windows) **folgt Junctions und leert ihr Ziel**. Ein Versuch, `src-tauri/runtime` per Junction aus dem Hauptordner einzubinden, hat beim Entfernen den runtime-Ordner des Hauptprojekts gelöscht (wiederhergestellt aus `target/debug/runtime`). Deshalb nie Links in Worktrees anlegen, nur Kopien (robocopy mit `/XJ`). pnpm-Junctions in node_modules zeigen nur in den Worktree selbst; mit pnpm `enableGlobalVirtualStore` wäre das anders.
Weitere Windows-Fallen beim Entfernen: Pfade über 260 Zeichen (`GitEngine.exec` setzt `core.longpaths=true`, `deleteFolder` löscht bei „Filename too long“ mit Node `rm`, danach `worktree prune`); nach Exit 0 bleiben manchmal leere node_modules-Gerippe stehen, `deleteFolder` löscht sie nach. `AgentAutoMerge.run`: Ordner ohne `.git` sind Reste und werden still verworfen.
`git check-ignore` verträgt `GIT_LITERAL_PATHSPECS=1` (setzt GitEngine immer) nicht: „pathspec magic not supported“. Für diesen Aufruf `GIT_LITERAL_PATHSPECS=0` übergeben.

## Ablauf Zusammenführen
1. Nicht committete Änderungen im Worktree werden committet ("Restliche Änderungen von <branch>").
2. Hat der Ziel-Branch neue Commits: `git rebase refs/heads/<ziel>`. Scheitert er: `rebase --abort`, dann `git merge-tree --write-tree`; sauber → `git commit-tree <tree> -p <ziel> -p <branch>`, Ziel-Branch geht auf diesen Merge-Commit (ein Rebase scheitert oft an Zwischenständen). Nur bei echten Konflikten bekommt der Agent per `sessions.send(..., "auto")` den Auftrag `git merge <ziel>`; Ergebnis `outcome: "conflict"`, Worktree bleibt.
3. Im Zielordner `git merge --ff-only <rev>`. Scheitert das an nicht committeten Änderungen: arbeitet dort eine Session oder gibt es eine gleichnamige neue Datei → warten; sonst Probelauf `git stash create` + `merge-tree`, sauber → `stash push`, `merge --ff-only`, `stash pop`, sonst warten (`outcome: "waiting"`).
4. Danach Worktree entfernen (Session beendet, Dev-Server und Test-Datenbank weg, Ordner und FORGE-Eintrag weg) und den Branch löschen, wenn er FORGE gehört.

## Welche Branches FORGE löscht
`create()` merkt sich für neue Branches `branch.<b>.forgeOriginDir`/`forgeOriginBranch` und `branch.<b>.forgeWorktree`. `branchOwner()`: passendes `forgeWorktree` → `-D`; nur `forgeOriginDir` (ältere Agenten) → `-d`; sonst bleibt der Branch mit Hinweis. Ohne `.git` im Worktree-Ordner löscht `branchOf()` keinen Branch. Ziel der Arbeit: forgeOriginDir/-Branch, sonst Hauptprojekt; anderer Branch im Zielordner ausgecheckt → mergeBlocker.

## Unterordner-Projekte (Monorepo)
Checkout neben dem Repository-Toplevel, Projekt = `path.join(checkout, prefix)`. `worktreeRoot()` findet aus `.forge-worktrees/<repo>/<slug>` den ganzen Checkout (Dirty-Check, Löschen, Rest-Commit, Vorbereitung).

## Claude-Code-Subagenten unter .claude/worktrees
`<projekt>/.claude/worktrees/agent-<hex>` gehören Claude Code, nicht FORGE; `locked` = Subagent arbeitet. FORGE räumt gemergte selbst auf (`pruneSubagentWorktrees`). `parseStatusV2` lässt solche eingebetteten Repositorys (untracked mit `/`) weg.

## Automatisch zusammenführen (Tag auto-merge)
`agent-auto-merge.ts`. Auslöser: `TurnAutomation` → `host.turnDone(sessionId, testsOk)`. Standard an für Hauptprojekte mit Git (seit 2026-10-17). Entscheidend ist das Tag am Hauptprojekt. Kein Merge bei roten Tests oder mergeBlocker (`skipped`, Toast mit „Ansehen“). Laufende Hintergrundaufgaben → Warteliste; `waiting` → erneuter Versuch nach jedem Durchlauf und alle 30 s. Konflikte höchstens 3 mal zurück an den Agenten. `agent.autoMerge` trägt `sessionIds`, der Desktop schließt damit die Chat-Fenster.

## Desktop
Agenten-Reiter (`AgentsTab.tsx`, `AgentEnvironment.tsx`): Karte zeigt Vorbereitung (Punkt + Text, Details im Tooltip, Knopf zum Wiederholen bei Fehlern) und den eigenen Dev-Server (`:port`, Klick startet und öffnet, `lib/dev-server-actions.ts`); Rechtsklick: Öffnen, Dev-Server öffnen/stoppen, Vorbereitung wiederholen, Abschließen, Entfernen. Befehlspalette: „Dev-Server des Agenten öffnen: <branch>“, „Worktree des Agenten neu vorbereiten“. Modal ohne auto-merge: `lib/agent-review.ts` + `stores/agent-review.ts`. Seitenleiste: Worktree-Sessions unter dem Hauptprojekt (`groupOf`).
