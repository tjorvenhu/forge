---
title: "Git-Reiter: Aufbau, Commit-Ansicht und Desktop-UI im Browser prüfen (git.commitFiles, CommitView)"
summary: "Wie der Git-Reiter aufgebaut ist (rechts immer ein Commit), welche RPCs Commit-Dateien und -Diffs liefern, Monorepo- und Merge-Eigenheiten, und wie man Desktop-Komponenten ohne Tauri im Browser mit echten Git-Daten ansieht."
tags: ["git","ui","preview","tests","stolperfalle"]
updated: "2026-10-15T14:33:03.871Z"
---

## Aufbau (Stand 2026-10-15)
- `components/git/GitCenter.tsx`: links Werkzeugleiste (Branch-Menü, `SyncActions labeled`, ⋯-Menü), Reiter Verlauf / Änderungen / Branches / Tags; rechts **immer** ein Commit (`CommitView`), Standard ist der ausgecheckte (`log[0]`). Nur eine angeklickte Datei unter Änderungen ersetzt ihn durch ihren `DiffView`.
- `GitPanel` bleibt immer gemountet (bei anderen Reitern nur `hidden`): Remount bei „kein Repo“ würde den fehlgeschlagenen Status neu holen und die Bedingung im Kreis kippen; außerdem überlebt so die Commit-Nachricht den Reiterwechsel.
- Verlauf (`CommitGraph.tsx`): zweizeilige Zeilen, Tagesköpfe („Heute“, „Gestern“, Datum). Die Lanes laufen durch die Tagesköpfe (Segmente der Vorzeile mit `toY === "bottom"`). Bei Suche/Autorfilter kein Graph (Lanes wären falsch), nur Punkte. Tags werden aus den `refs` der geladenen 200 Commits abgeleitet, ältere Tags fehlen bewusst.
- Suche: Gruppe „Commits“ in der Befehlspalette (`palette-sources.tsx`, gleicher Query-Key und `LOG_LIMIT` wie der Reiter), Klick ruft `useUi.openCommit(projectId, hash)`; GitCenter liest `commitRequest` und löscht ihn.
- Telefon: `git` mit Aktion `show` (Dateien eines Commits, mit `path` der Diff daraus; sensible Dateien werden nicht vorgelesen).

## RPCs
- `git.commitFiles` (Body + Dateien mit +/-), `git.commitDiff` (Diff einer Datei, `origPath` bei Umbenennung). Vergleich immer gegen den **ersten Elternteil**, Root-Commits gegen den leeren Baum (`git hash-object -t tree --stdin` mit leerer Eingabe).
- `--relative` ist nötig: Ist das Projekt ein Unterordner eines Repos, liefert `git diff` sonst Pfade relativ zur Repo-Wurzel und Dateien außerhalb des Projekts.
- `git diff --numstat -z` schreibt bei Umbenennungen einen leeren Pfad und danach alt/neu als eigene NUL-Felder (`parseCommitFiles`).
- Anzeige des Bodys ohne Trailer (`Co-Authored-By` usw., `withoutTrailers`); „Nachricht kopieren“ nimmt den vollen Text.

## Desktop-UI im Browser mit echten Git-Daten ansehen
Die App braucht Tauri und den Sidecar. Für einen schnellen Blick: temporäre Seite `apps/desktop/.preview-git/index.html` + `main.tsx`, die vor dem Import von `@/lib/rpc` ein `window.__TAURI_INTERNALS__` mit `invoke`/`transformCallback` setzt (`plugin:event|listen` merkt sich die Callback-ID, `sidecar_send` schickt die Zeile per `fetch` an eine Brücke und liefert die Antwort als `sidecar://messages`-Event mit `payload: [line]`). Brücke: kleines `http.createServer` in `packages/sidecar`, gestartet mit `pnpm exec tsx`, ruft `GitEngine`-Methoden auf das Repo auf. Vite separat mit `pnpm exec vite --port 1430` (1420 ist der Tauri-Dev-Port), dann `preview_screenshot` auf `http://127.0.0.1:1430/.preview-git/index.html`. Danach beide Hintergrundprozesse per TaskStop beenden und die Dateien löschen.

## Tests
- jsdom kennt weder `ResizeObserver` (TabBar) noch `Element.scrollIntoView` (CommitGraph): in Tests stubben, siehe `GitCenter.test.tsx`.
