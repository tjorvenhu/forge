---
title: "Abgleich mit dem Server beim Projektöffnen (git.incoming, RemoteCheckDialog, resetToRemote, Pull mit Merge)"
summary: "Wie FORGE beim ersten Öffnen eines Projekts origin abruft und fragt, ob man übernehmen (Rebase), mergen oder auf den Server-Stand zurücksetzen will; einmal pro Start, Sicherung, Telefon und Palette."
tags: ["git","ui","telefon","sidecar","projekte"]
updated: "2026-10-22T08:08:59.354Z"
---

Stand 2026-10-22, Wunsch des Nutzers: Beim Öffnen eines Projekts parallel prüfen, ob origin neuer ist, und vor dem Weiterarbeiten fragen. **Nur beim ersten Öffnen nach dem Start von FORGE, nicht während der Arbeit** (ausdrücklicher Wunsch; eine erste Fassung prüfte alle 5 Minuten erneut).

## Sidecar (`packages/sidecar/src/git/git.ts`)
- `incoming(cwd)`: fetch origin, vergleicht HEAD mit `origin/<branch>` (nicht mit dem Upstream, wie `integrateRemote`). Liefert branch, `remoteHead`, behind, ahead, changedCount (nur Projektordner), bis 10 neue Commits. null ohne Branch, Remote, eigenen Commit oder Remote-Branch. Fetch-Fehler werfen.
- `pull(cwd, strategy)`: `"merge"` macht bei eigenen Commits `merge --autostash --no-edit`, bei Konflikt `merge --abort` und GIT_CONFLICT mit `integration.merge = true`. Der Claude-Prompt (`integration-prompt.ts`) sagt dann Merge statt Rebase. `GitIntegrated.mode` kennt `"merge"`.
- `resetToRemote(cwd)`: nichts geht verloren. Eigene Commits, die nicht auf origin sind, bleiben auf `forge-backup/<branch>-<YYYYMMDD-HHmm>` (UTC). Offene Arbeit kommt in den Stash, und zwar die **des ganzen Repos** (`reset --hard` träfe in einem Monorepo auch andere Ordner). Danach `reset --hard origin/<branch>`. Handler lehnt ab, solange eine Session im Projekt läuft (SESSION_BUSY).
- RPCs: `git.incoming`, `git.resetToRemote`, `git.pull` mit `strategy` (Standard rebase).

## Desktop
- `stores/remote-check.ts`: `checkRemote(projectId, manual)`. Automatisch einmal je Projekt pro FORGE-Start (Set `checked`), still bei Fehlern und wenn nichts neu ist. Das Ergebnis zeigt sich nur, wenn das Projekt noch aktiv ist. Manuell (Palette `git-remote-check`, Rechtsklick auf ProjectCard) fragt immer und meldet „Schon auf dem neuesten Stand“ per Toast. „Später“ schließt nur.
- `components/git/RemoteCheckDialog.tsx` (in `App.tsx` gemountet): prüft beim Wechsel von `activeProjectId` in der Workspace-Ansicht (nur mit Git, Remote, nicht detached). Wartet auf `useDictationQuiet`. Ohne lokale Arbeit gibt es nur „Aktualisieren“. Merge wird nur mit eigenen Commits angeboten, ohne sie wäre es derselbe Fast-Forward.
- `runGitSync` in `Sync.tsx` ist der gemeinsame Ablauf für Fetch/Pull/Push (Aktivität, Invalidierung, Konflikt-Session öffnen, Toast). Ihn nutzen SyncActions, die Palette und der Dialog.

## Telefon
Werkzeug `git`: `fetch` nennt über `git.incoming` die neuen Commits und die eigene offene Arbeit. `pull` mit `merge: true`. `reset_to_remote` mit Tastatur-Bestätigung (askKeypad).

Tests: `packages/sidecar/test/git-sync.test.ts` (describe „on opening a project“), `apps/desktop/src/components/git/RemoteCheckDialog.test.tsx`.
