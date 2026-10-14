---
title: "Projektwissen: Index-Budget, Überschneidungen, knowledge_merge"
summary: "Wie der Start-Index gebaut wird (Zusammenfassungen nur solange alles passt), wie Überschneidungen erkannt werden (Überdeckung statt Kosinus, Schwelle 0,55) und wann knowledge_merge greift; wichtig bei Änderungen an knowledge.ts oder den Wissens-Werkzeugen."
tags: ["wissen","forge-tools","sidecar","kontext"]
updated: "2026-10-14T18:51:04.027Z"
---

# Projektwissen: Index-Budget, Überschneidungen, knowledge_merge

Code: `packages/sidecar/src/knowledge/knowledge.ts` (Store, `index`, `overlaps`, `covering`, `merge`),
Werkzeuge und Start-Kontext in `packages/sidecar/src/sessions/forge-tools.ts` (`projectTools`).

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
- `knowledge_save` blockiert deswegen nicht (das macht nur die Titel-Ähnlichkeit, `similar`), sondern hängt an das
  Ergebnis `Überschneidet sich stark mit: …` an. Die Chat-Karte wird dann gelb.
- Beim Session-Start kommen bis zu 3 überschneidende Paare als Zeile „Aufräumen: …“ in den Kontext, dazu Einträge über
  `LONG_ENTRY_CHARS` (8000 Zeichen) als „Sehr lange Einträge“. Claude soll das nur nebenbei erledigen, wenn es ohnehin
  in dem Bereich arbeitet.

## knowledge_merge

- `ids` (2 bis 6), der erste behält Kennung und Datei, bekommt den neuen Text; die übrigen werden gelöscht. Alle Kennungen
  werden vorher geprüft, damit nichts halb zusammengeführt wird. Ohne `tags` gilt die Vereinigung der Tags.
- `autoAllow: true` (anders als `knowledge_delete`): Das Wissen bleibt im Zieleintrag, und alte Fassungen liegen dank
  Auto-Commit im Git.
- Ergebnistext `Zusammengeführt: <id> (…). Gelöscht: …` wertet die Chat-Karte aus
  (siehe [[forge-werkzeuge-im-chat-karten-haengen-an-den-ergebnistexten]]).
- Es gibt keine RPC-Methode dafür, nur das Claude-Werkzeug; im Tab „Wissen“ geht es weiter per Bearbeiten und Löschen.
