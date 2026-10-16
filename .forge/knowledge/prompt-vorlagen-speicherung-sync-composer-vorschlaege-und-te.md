---
title: "Prompt-Vorlagen: Speicherung, Sync, Composer-Vorschläge und # (templates.*, TemplateService, suggestTemplates)"
summary: "Wie Prompt-Vorlagen gebaut sind (SQLite, Sync mit Projekt-Schlüssel, Backup-Teil), wie die Vorschläge im Composer matchen und welche Tastenregeln gelten; wichtig bei Änderungen an Vorlagen, Composer-Tasten oder Sync-Items."
tags: ["chat","composer","sidecar","sync","telefon","konvention"]
updated: "2026-10-16T19:50:54.316Z"
---

# Prompt-Vorlagen (Stand 2026-10-16)

## Daten
- Tabelle `prompt_templates` (Migration in `persistence/db.ts`), `project_id` NULL = global, FK mit ON DELETE CASCADE. `sort_order` zählt getrennt je Liste (global, pro Projekt).
- `packages/sidecar/src/templates/templates.ts` (`TemplateService`): Vorlagen eines Agent-Worktrees werden immer beim Hauptprojekt gespeichert/gelesen (`rootOf`). Jede Änderung sendet `templates.updated` (UI invalidiert `["templates"]`, Sync prüft danach).
- RPC: `templates.list` ({projectId} = global + Projekt, {all:true} = alle), `templates.save`, `templates.delete`, `templates.reorder` (nur innerhalb einer Liste).
- Reine Funktionen in `packages/protocol/src/templates.ts` (Desktop und Telefon nutzen sie): `templatePlaceholders`, `fillTemplate`, `knownTemplateValues` (projekt/project, branch, datei/file, datum/date), `suggestTemplates`, `findTemplates`. Platzhalter nur `{wort}` ohne Leerzeichen, damit Code/JSON-Klammern keine sind.

## Sync und Backup
- Sync-Item `template:<id>` mit `project` = Item-Schlüssel des Projekts (`project:github.com/...`) statt Projekt-ID. Vorlagen eines Projekts, das auf diesem PC fehlt, bleiben im Repo und werden übernommen, sobald das Projekt da ist (Schleife in `syncOnce`: Vorlage nie hier gewesen, Projekt jetzt da). Kein Zeitstempel im Item (sonst Commit-Pingpong).
- Backup: eigener Teil `templates` (BackupPart). Ältere Backups haben `templates: []` (Default). Vorlagen eines Projekts, das nicht in FORGE ist, werden beim Restore übersprungen (Hinweis in notes).

## Composer
- Unscharfe Vorschläge erst ab 4 Zeichen, nur einzeilig, bis 240 Zeichen, Score >= 0,7. Textanfang einer Vorlage zählt erst ab 10 Zeichen und zwei Wörtern (viele Nachrichten beginnen mit demselben Verb). Bei nur einem aussagekräftigen Wort zählt nur der Name.
- Tasten: Tab übernimmt den gewählten oder ersten Vorschlag, Pfeile wählen, Enter übernimmt nur einen gewählten Vorschlag, sonst sendet Enter wie bisher. Esc blendet aus bis zur nächsten Textänderung. Nach einer übernommenen Vorlage keine Vorschläge mehr, bis das Feld leer ist.
- Direktaufruf mit `#wort` (kollidiert mit nichts, `/` bleibt den Slash-Befehlen): erste Vorlage ist vorgewählt, Enter übernimmt.
- Mit Platzhaltern öffnet `TemplateFillDialog` (bekannte vorbelegt, Fokus auf erstes leeres Feld, auch wenn Projekt/Branch erst nachladen). Senden geht über `useSendMessage.send` des Composers.
- Außerhalb des Composers (Palette, Rechtsklick auf Datei/Projekt): `useTemplateDialogs` (stores/templates.ts) + `TemplateHost` (in App.tsx; im Chat-Fenster nur der Editor). Dort nur „In den Chat übernehmen“ (`insertIntoChat`), kein Direktsenden.

## Tests
- Composer-Tests: Mocks, die für unbekannte Methoden ein Objekt liefern, müssen für `templates.list` ein Array liefern, sonst bricht `suggestTemplates`.
- Telefon: Aktionen `templates`, `template_send`, `template_save`, `template_delete` (askKeypad), `template_move` am Werkzeug `sessions`.
