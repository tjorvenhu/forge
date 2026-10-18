<a href="0009-rueckfragen-kontext-suche-devserver.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0009: Rückfragen und Plan-Freigabe, Kontextanzeige, Befehlspalette, Volltextsuche, Dev-Server

Datum: 2026-10-11 · Status: angenommen

## Rückfragen (AskUserQuestion) und Plan-Freigabe (ExitPlanMode)

Befund (Spike mit Claude Code 2.1.296, Agent SDK 0.3.296):

- Beide Tools laufen über `canUseTool`, **auch in `bypassPermissions`**. Die SDK-Warnung
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` trifft auf diese interaktiven Tools nicht zu.
- `AskUserQuestion` erwartet die Antworten in `updatedInput.answers` (Fragetext → Antwort, Mehrfachauswahl
  mit Komma). FORGE gab bisher `toolInput` unverändert zurück: Claude bekam keine Antwort.
- `ExitPlanMode` liefert `plan` und `planFilePath` im Input. Ein `allow` mit
  `updatedPermissions: [{ type: "setMode", mode, destination: "session" }]` verlässt den Plan-Modus; die CLI
  meldet den neuen Modus als `system/status` mit `permissionMode`.
- Im Plan-Modus schreibt Claude den Plan nach `~/.claude/plans/*.md`. Die Regel `write-outside-project`
  (Autonomous) hat das blockiert.

Entscheidung:

- `ApprovalDecision` trägt optional `updatedInput` und `mode`; `canUseTool` reicht beides durch.
- `sessions.respondApproval` nimmt `answers`. Für `AskUserQuestion` ist mindestens eine Antwort Pflicht,
  „Überspringen“ ist ein `deny` mit klarer Nachricht. Für `ExitPlanMode` setzt „Plan annehmen“ den Modus des
  Projektprofils, „Überarbeiten“ ist ein `deny` mit dem Feedback als Nachricht (Claude bleibt im Plan-Modus).
- Für beide Tools gibt es keine Freigabe „für die Session“.
- `approval.resolved` speichert die Antworten, damit die Karte sie nach einem Neustart zeigt.
- FORGE übernimmt `permissionMode` aus `system/status`, damit Anzeige und Datenbank dem CLI folgen.
- Die Sperrliste erlaubt Schreibzugriffe in `claudePlansDir()` (`$CLAUDE_CONFIG_DIR/plans` bzw.
  `~/.claude/plans`), sonst nichts außerhalb des Projekts.

UI: eigene Karten im Chat (`InteractiveCards.tsx`) statt der generischen Freigabekarte; Benachrichtigung
„Rückfrage von Claude“ bzw. „Plan zur Freigabe“.

## Kontextanzeige und Komprimieren

- Nach jedem `turn.result` und nach einer Komprimierung fragt FORGE `getContextUsage({ detail: "summary" })`
  ab. Das nutzt die Werte der letzten Antwort und lokale Schätzungen, ohne zusätzliche Token-Zählungen.
- Der Wert hängt am `Session`-Objekt (`context`), nur solange der Prozess läuft, und wird nicht gespeichert.
- Der Knopf „Komprimieren“ sendet `/compact` als normale Nachricht (im E2E-Test bestätigt).
  `system/compact_boundary` wird zu `context.compacted` und erscheint als Hinweis im Verlauf.
- Warnstufen: ab 70 % gelb, ab 90 % rot. FORGE komprimiert nie selbst, das macht Claude Code bei Bedarf.

## Volltextsuche

- SQLite FTS5 (`events_fts`, Tokenizer `unicode61 remove_diacritics 2`), `rowid` = `events.rowid`. Trigger
  halten den Index aktuell, auch beim Löschen einer Session (Cascade). Migration 6 füllt den Index aus dem
  Bestand.
- Indexiert werden nur `user.message` und `assistant.text`, also das, was im Verlauf als Text steht. Tool-Ein-
  und Ausgaben nicht, sie sind groß und meist nicht gemeint.
- Die Suchanfrage wird auf Wörter reduziert (`"wort"*`, alle müssen vorkommen). FTS-Syntax aus der Eingabe
  hat dadurch keine Wirkung.
- Ein Treffer öffnet die Session und scrollt zur Nachricht (`focusEvent` im UI-Store).

## Befehlspalette

Strg+K überall außer im Terminal (dort gehört die Taste der Shell). Aktionen abhängig vom geöffneten Projekt,
Projekte, Sessions und ab drei Zeichen die Volltexttreffer. Kein neues Paket: Radix-Dialog und eigene Liste.

## Dev-Server

- Befehl pro Projekt (`projects.dev_command`), sonst erkannt aus `package.json` (`dev`, sonst `start`).
  Bei npm wird daraus `npm run dev`, weil npm Skripte außer `start`/`test` nicht direkt kennt.
- Läuft wie der Testbefehl in einer Shell (Befehl kommt vom Nutzer oder aus dem eigenen Projekt).
  `BROWSER=none`, damit kein Dev-Server selbst einen Browser öffnet.
- Stoppen beendet den ganzen Prozessbaum mit `taskkill /T /F`. Beim Beenden
  von FORGE und beim Entfernen eines Projekts werden laufende Dev-Server gestoppt.
- Die erste lokale Adresse aus der Ausgabe (ANSI entfernt, `0.0.0.0` wird `localhost`) wird als Link gezeigt.
  Der Opener darf dafür zusätzlich `http://localhost:*` und `http://127.0.0.1:*` öffnen.
- „An Claude“ legt die letzten 80 Zeilen als Codeblock in den Entwurf der aktiven Session. Gesendet wird erst,
  wenn der Nutzer es tut.
