---
title: "Veraltetes Projektwissen erkennen (RefChecker, knowledge.checkRefs, fixDraft, markChecked)"
summary: "Wie FORGE Verweise in Wissenseinträgen (Pfade, Dateinamen, Bezeichner) gegen das Projekt prüft, warum Bezeichner nur mit Git-Historie als fehlend gelten, Cache, Fehlalarm-Markierung und Claude-Korrektur; wichtig bei Änderungen an staleness.ts oder Fehlalarmen."
tags: ["wissen","sidecar","forge-tools","telefon","stolperfalle"]
updated: "2026-10-16T19:09:40.371Z"
---

# Veraltetes Projektwissen erkennen

Code: `packages/sidecar/src/knowledge/staleness.ts` (`extractRefs`, `pathRef`, `nameRef`, `looksLikeCode`, `RefChecker`), angebunden in `KnowledgeStore.staleness/markChecked/fixContext` (`knowledge.ts`). UI: `apps/desktop/src/components/knowledge/` (`KnowledgeTab.tsx` Hinweis + Filter + Rechtsklick, `FixDialog.tsx`, `knowledge-actions.ts`). Gebaut 2026-10-16.

## Was als Verweis zählt
- Pfade mit Ordner und bekannter Endung (auch im Fließtext), Ordner/Import-Pfade ohne Endung nur in Backticks, bloße Dateinamen nur in Backticks und nur mit Code-Endung (`CODE_EXT`; .md/.json bewusst nicht: `MEMORY.md`, `settings.json` liegen oft außerhalb des Projekts).
- Bezeichner nur in Backticks und nur, wenn sie wie Code aussehen: camelCase, PascalCase mit zwei Höckern, snake_case, CONSTANT_CASE. Einzelwörter (`Button`, `main`), Befehle, Optionen, Werte (`retry: false`) fallen raus. `mcp__forge__x` wird zu `x`, `foo(a, b)` zu `foo`. Gepunktete Namen (`ClaudeAssist.mergeKnowledge`) gelten als vorhanden, wenn die Code-Teile einzeln vorkommen (Notation steht so nie im Code).
- Ausgeschlossen: Codeblöcke (```), absolute Pfade, URLs/Hosts, Globs, `<platzhalter>`, Beispielnamen (`src/a.ts`, `foo.ts`), `node_modules`/`dist`/`target`…, Produktnamen (`NOT_NAMES`), Umgebungsvariablen bekannter Tools (`ENV_NAME`).

## Wann etwas fehlt
- Pfade: weder in `git ls-files -co --exclude-standard` noch auf der Platte, auch nicht als Pfadende (Claude schreibt relativ zu Unterordnern: `src-tauri/src/lib.rs`), `.js` darf `.ts` meinen. Zusätzlich muss der erste Ordner irgendwo im Projekt existieren (sonst: anderes Repo, Branch-Name, MIME-Typ), und versteckte Ordner, die es nicht gibt (`.preview-git`), zählen nicht.
- Bezeichner mit Git: `git grep -F -w` findet sie nicht (ohne `*.md` und `.forge`, sonst findet sich jeder Name im Wissen selbst) **und** `git log -G` zeigt, dass der Code sie einmal hatte. **Begründung:** Erste Messung am FORGE-Wissen ohne diese Bedingung meldete Windows-API-Namen, netstat-Ausgaben und Vorschläge (`extendTailwindMerge`) als fehlend. Mit Historie: 0 Fehlalarme bei 811 Verweisen. Bloße Dateinamen ebenso über `git log -- :(glob)**/<name>`.
- `GIT_LITERAL_PATHSPECS=1` setzt `GitEngine` immer; für `:(exclude)`/`:(glob)` überschreibt `RefChecker` es auf `0`.
- `git grep -o` meldet pro Stelle nur einen Treffer: ein Name innerhalb eines längeren auf derselben Zeile (`useUi` in `useUi.openFile`) braucht den zweiten Durchlauf mit den noch nicht gefundenen Namen.
- Ohne Git (oder `gitEnabled: false`): Dateidurchlauf (gedeckelt), Bezeichner nur als fehlend, wenn eine frühere Prüfung sie gefunden hatte (Liste `seen`). Die erste Prüfung meldet deshalb nur Pfade.

## Cache und Kosten
- Zustand = HEAD + Hash von `git status --porcelain`; pro Eintrag Text-Hash + Zustand. Ohne Git 5-Minuten-Fenster. `refresh: true` verwirft den Cache.
- Historien-Treffer und `seen` liegen in `<dataDir>/knowledge-refs.json`. Bei neuem HEAD wird nur `alterHead..HEAD` durchsucht. Erster Lauf am FORGE-Repo ~5 s (je nie vorhandenem Namen ~0,6 s `git log -G`, 6 parallel), danach ~0,1-0,3 s.
- `knowledge.checkRefs` und `knowledge.fixDraft` stehen in `LONG_METHODS`.

## Als geprüft markieren, Korrektur
- `knowledge.markChecked` schreibt die aktuell fehlenden Verweise ins Front Matter (`verified: [...]`), ohne `updated` zu ändern; die Markierung reist mit dem Repo. `save` behält nur Markierungen, deren Verweis noch im Text steht.
- `knowledge.fixDraft`: `ClaudeAssist.fixKnowledge` (Sonnet, `completeJson`, zählt im TokenMeter). Claude hat dort keine Werkzeuge, deshalb liefert `RefChecker.details` die Hinweise: Diff-Ausschnitte des Commits, der den Namen zuletzt änderte, und dessen Dateiliste (`--name-status -M`), bei Pfaden Dateien mit gleichem Namen. Übernehmen = `knowledge.save`.
- Der Hinweis „zuletzt geändert in <hash>“ ist bei noch nicht committeter Löschung der Commit, der den Namen eingeführt hat; deshalb nicht „entfernt in“.

## Anbindung
- `knowledge_read` schreibt `Veraltet: Diese Verweise gibt es im Projekt nicht mehr: …` unter den Kopf, `knowledge_search` je Treffer `Veraltet, gibt es nicht mehr: …`.
- Telefon: Werkzeug `knowledge` mit `stale`, `mark_checked` (mit id), `fix` (mit id, speichert ohne Prüfschritt). RPCs in `coverage.ts` auf `knowledge`.
- Palette: „Veraltetes Projektwissen anzeigen“ (`KNOWLEDGE_STALE_REQUEST`), „Projektwissen: Verweise neu prüfen“, je veraltetem Eintrag „Mit Claude prüfen: …“ (`knowledgeFixRequest(id)`) und „Als geprüft markieren: …“.
