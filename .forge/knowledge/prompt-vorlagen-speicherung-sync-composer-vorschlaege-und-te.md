---
title: "Prompt-Vorlagen: Speicherung, Sync, Composer, # und automatisches Lernen (TemplateService, TemplateLearner)"
summary: "Wie Prompt-Vorlagen gebaut sind (SQLite, Sync mit Projekt-Schlüssel, Backup-Teil), wie FORGE sie aus wiederkehrenden Nachrichten selbst lernt, wie die Vorschläge im Composer matchen und welche Tastenregeln gelten."
tags: ["chat","composer","sidecar","sync","telefon","konvention"]
updated: "2026-10-18T12:42:49.940Z"
---

# Prompt-Vorlagen (Stand 2026-10-18)

## Daten
- Tabelle `prompt_templates` (Migration in `persistence/db.ts`), `project_id` NULL = global, FK mit ON DELETE CASCADE. `sort_order` zählt getrennt je Liste (global, pro Projekt). Spalte `learned` (0/1), im Modell `learned?: true`.
- `packages/sidecar/src/templates/templates.ts` (`TemplateService`): Vorlagen eines Agent-Worktrees werden immer beim Hauptprojekt gespeichert/gelesen (`rootOf`). Jede Änderung sendet `templates.updated` (UI invalidiert `["templates"]`, Sync prüft danach).
- RPC: `templates.list` ({projectId} = global + Projekt, {all:true} = alle), `templates.save`, `templates.delete`, `templates.reorder` (nur innerhalb einer Liste), `templates.learn`.
- Reine Funktionen in `packages/protocol/src/templates.ts` (Desktop und Telefon nutzen sie): `templatePlaceholders`, `fillTemplate`, `knownTemplateValues` (projekt/project, branch, datei/file, datum/date), `suggestTemplates`, `findTemplates`, `templateScore`, `normalizeForMatch`. Platzhalter nur `{wort}` ohne Leerzeichen, damit Code/JSON-Klammern keine sind.

## Automatisch lernen (TemplateLearner, seit 2026-10-18)
Wunsch des Nutzers: Vorlagen sollen sich mit der Zeit selbst aufbauen. Exakt gleiche Nachrichten sind selten (Messung: fast nur „push“), darum kein Zählen gleicher Texte, sondern ein Haiku-Aufruf, der sinngemäße Wiederholungen findet und verallgemeinert (mit Platzhaltern).
- `templates/learner.ts`: nach 30 eigenen Nachrichten (`noteMessage` über `SessionService.useMessageListener`, `source: "auto"` zählt nicht), höchstens alle 6 h; erster Blick 3 min nach dem Start, sobald 20 Nachrichten da sind. Nur in der App (`start()` im `FORGE_APP_VERSION`-Block von `app.ts`), nicht in Tests/CLI. `templates.learn` läuft immer, auch mit ausgeschalteter Einstellung.
- Liest die neuesten 400 `user.message` aller Sessions (`Db.recentUserMessages`), ohne automatische (`source`, `task`, `UPDATE_CONTINUE_PROMPT`, `AUTO_CONTINUE_PROMPT`) und ohne Texte über 1500 Zeichen, redigiert. `runtime.completeJson` mit `ASSIST_MODEL`, purpose `templates`.
- Filter danach: count >= 3, keine Dublette (gleicher Text/Name normalisiert oder `templateScore` >= 0,85), nicht abgelehnt, max. 3 neue pro Blick, max. 30 gelernte insgesamt. Projektname aus der Antwort → Projekt-Vorlage, sonst global.
- Gelöschte gelernte Vorlagen landen normalisiert in `settings`-Schlüssel `templateLearning.dismissed` (max. 300) und gehen als „Abgelehnte Vorlagen“ in den Prompt. Bearbeitet der Nutzer eine gelernte, ist sie seine (`learned` fällt weg).
- Selbst gelernte melden Event `templates.learned` → Toast mit „Ansehen“ im Hauptfenster.
- Einstellung `learnTemplates` (Standard an): Vorlagen-Seite der Einstellungen (Gruppe „Automatisch lernen“, Knopf „Jetzt lernen“), Palette, Telefon `settings` `learn_templates`. Telefon `sessions` Aktion `template_learn`.

## Sync und Backup
- Sync-Item `template:<id>` mit `project` = Item-Schlüssel des Projekts (`project:github.com/...`) statt Projekt-ID, `learned: true` nur wenn gesetzt (Items manueller Vorlagen bleiben unverändert). Vorlagen eines Projekts, das auf diesem PC fehlt, bleiben im Repo und werden übernommen, sobald das Projekt da ist. Kein Zeitstempel im Item (sonst Commit-Pingpong).
- Backup: eigener Teil `templates` (BackupPart). Ältere Backups haben `templates: []` (Default). Vorlagen eines Projekts, das nicht in FORGE ist, werden beim Restore übersprungen (Hinweis in notes).

## Composer
- Unscharfe Vorschläge erst ab 4 Zeichen, nur einzeilig, bis 240 Zeichen, Score >= 0,7. Textanfang einer Vorlage zählt erst ab 10 Zeichen und zwei Wörtern. Bei nur einem aussagekräftigen Wort zählt nur der Name.
- Tasten: Tab übernimmt den gewählten oder ersten Vorschlag, Pfeile wählen, Enter übernimmt nur einen gewählten Vorschlag, sonst sendet Enter. Esc blendet aus bis zur nächsten Textänderung. Nach einer übernommenen Vorlage keine Vorschläge mehr, bis das Feld leer ist.
- Direktaufruf mit `#wort` (`/` bleibt den Slash-Befehlen): erste Vorlage ist vorgewählt, Enter übernimmt.
- Mit Platzhaltern öffnet `TemplateFillDialog`. Senden geht über `useSendMessage.send` des Composers.
- Außerhalb des Composers (Palette, Rechtsklick): `useTemplateDialogs` (stores/templates.ts) + `TemplateHost`. Dort nur „In den Chat übernehmen“, kein Direktsenden.

## Tests
- Composer-Tests: Mocks, die für unbekannte Methoden ein Objekt liefern, müssen für `templates.list` ein Array liefern.
- `test/template-learner.test.ts`: Lernen mit falschem `ask`, Uhr über `now`.
- Telefon: Aktionen `templates`, `template_send`, `template_save`, `template_delete` (askKeypad), `template_move`, `template_learn` am Werkzeug `sessions`.
