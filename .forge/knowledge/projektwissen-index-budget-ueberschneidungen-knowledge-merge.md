---
title: "Projektwissen: Index-Budget, Überschneidungen, Zusammenführen (knowledge_merge, MergeDialog)"
summary: "Start-Index (Zusammenfassungen nur solange alles passt), Erkennung von Überschneidungen (Überdeckung, Schwelle 0,55) und Zusammenführen per Claude-Werkzeug, Knopf im Tab Wissen oder Telefon; wichtig bei Änderungen an knowledge.ts oder den Wissens-Werkzeugen."
tags: ["wissen","forge-tools","sidecar","kontext","telefon"]
updated: "2026-10-14T19:06:45.547Z"
---

# Projektwissen: Index-Budget, Überschneidungen, Zusammenführen

Code: `packages/sidecar/src/knowledge/knowledge.ts` (Store, `index`, `overlaps`, `covering`, `cleanup`, `merge`,
`buildMergePrompt`), Werkzeuge und Start-Kontext in `packages/sidecar/src/sessions/forge-tools.ts` (`projectTools`),
Entwurf in `ClaudeAssist.mergeKnowledge` (`sessions/claude-assist.ts`), UI in
`apps/desktop/src/components/knowledge/MergeDialog.tsx` und `knowledge-text.ts`.

## Index beim Session-Start

- Budget `INDEX_MAX_CHARS` = 8000 Zeichen (rund 2.000 bis 2.500 Tokens, im System-Prompt und damit gecacht).
- Passt der Index mit Zusammenfassungen ins Budget, kommen sie mit (`summaries: true`). Sonst bekommt jeder Eintrag nur
  `- id: Titel [tags]`. Begründung (2026-10-14): Vorher wurden bei 32 Einträgen nur die 15 neuesten gezeigt, weil die
  Zusammenfassungen (~200 Zeichen) das Budget fraßen. Die älteren sah Claude nie, ohne gezielt zu suchen. Die
  Zusammenfassung liefert `knowledge_search`.
- Kompakt braucht ein Eintrag ~150 Zeichen, also passen rund 50 Einträge. Erst darüber fallen die ältesten raus.
- Deshalb sind Titel und Tags das Suchwerkzeug: Titel mit Code-Namen in Klammern, Tags aus dem vorhandenen Vokabular.
  `knowledge_save` nennt in der Beschreibung des Felds `tags` die 30 häufigsten vorhandenen Tags (`store.tags`).

## Überschneidungen erkennen

- Maß: tf-idf-Gewichte (geglättete idf `log(1 + N/df)`, sonst zählen gemeinsame Wörter bei 2-3 Einträgen gar nicht),
  dann **Überdeckung**: Anteil des Gewichts des kürzeren Eintrags, dessen Wörter auch im längeren vorkommen.
- Nicht Kosinus: Eine kurze neue Notiz zu einem Thema, das ein langer Eintrag schon abdeckt, kommt im Kosinus nur auf
  ~0,2-0,3 (wie unverwandte Einträge). Bei der Überdeckung liegen echte Dubletten bei ~0,7, die 32 echten, verschiedenen
  Einträge dieses Projekts höchstens bei 0,40 (gemessen 2026-10-14). Schwelle `OVERLAP_MIN` = 0,55.
- Rein lokal gerechnet, kostet keine Tokens.
- `knowledge_save` blockiert deswegen nicht (das macht nur die Titel-Ähnlichkeit, `similar`), sondern hängt an das
  Ergebnis `Überschneidet sich stark mit: …` an. Die Chat-Karte wird dann gelb.
- Beim Session-Start kommen bis zu 3 überschneidende Paare als Zeile „Aufräumen: …“ in den Kontext, dazu Einträge über
  `LONG_ENTRY_CHARS` (8000 Zeichen) als „Sehr lange Einträge“. Claude soll das nur nebenbei erledigen, wenn es ohnehin
  in dem Bereich arbeitet.

## Zusammenführen

Drei Wege, alle über `KnowledgeStore.merge` (erster Eintrag behält Kennung und Datei, die übrigen werden gelöscht; alle
Kennungen werden vorher geprüft, damit nichts halb zusammengeführt wird):

1. **Claude-Werkzeug `knowledge_merge`** in Sessions: Claude liest die Einträge selbst und schreibt den Text. Ohne
   `tags` gilt die Vereinigung. `autoAllow: true` (anders als `knowledge_delete`): Das Wissen bleibt im Zieleintrag,
   alte Fassungen liegen dank Auto-Commit im Git. Ergebnistext `Zusammengeführt: <id> (…). Gelöscht: …` wertet die
   Chat-Karte aus (siehe [[forge-werkzeuge-im-chat-karten-haengen-an-den-ergebnistexten]]).
2. **Knopf im Tab „Wissen“** (Combine-Icon neben „Neuer Eintrag“, mit Zahl der Überschneidungen; außerdem
   „Zusammenführen“ im geöffneten Eintrag; Suche: „Projektwissen: Einträge zusammenführen“ über
   `openKnowledge(KNOWLEDGE_MERGE_REQUEST)`). Ablauf: Auswahl (Überschneidende zuerst, mit Prozent) ->
   `knowledge.mergeDraft` -> Entwurf prüfen und bearbeiten -> `knowledge.merge`. Bis zum letzten Schritt ändert sich nichts.
3. **Telefon**: Werkzeug `knowledge` mit `cleanup = true` (listet Überschneidungen und lange Einträge) bzw.
   `merge = "a, b"` (Entwurf und Zusammenführen ohne Prüfschritt).

RPC: `knowledge.cleanup`, `knowledge.mergeDraft` (Einmal-Aufruf, speichert nichts), `knowledge.merge`; in
`phone/coverage.ts` auf `knowledge` gemappt.

Stolperfalle im Desktop-Test: `beforeEach(() => callMock.mockReset())` gibt die Mock-Funktion zurück, und Vitest ruft
einen zurückgegebenen Wert als Aufräum-Funktion auf. Wirft der Mock bei unbekannten Methoden, scheitert der Test
scheinbar grundlos. Den Körper in geschweifte Klammern setzen.

### Entwurf und Kosten

- Modell `MERGE_MODEL` = `sonnet` (nicht Haiku wie Commit-Nachrichten): Beim Zusammenführen darf nichts verloren gehen.
- Prompt `buildMergePrompt`: alle Einträge vollständig plus ~350 Tokens Regeln (alles erhalten, nur Doppeltes weg, bei
  Widerspruch gilt der neuere Stand, nichts erfinden). Strukturierte Antwort über `completeJson` mit `MERGE_SCHEMA`.
- Kosten grob: Eingabe = Länge aller Einträge (~1 Token je 3,5 Zeichen) + Regeln, Ausgabe = Länge des neuen Eintrags.
  Zwei typische Einträge (je 2-4 KB): ~2.000-3.000 Tokens rein, ~1.000-2.000 raus. Obergrenze 6 x 8 KB: ~15.000 rein.
- Über `knowledge_merge` in einer Session kostet es ähnlich viel, aber auf dem Modell der Session und im Kontext der Session.
