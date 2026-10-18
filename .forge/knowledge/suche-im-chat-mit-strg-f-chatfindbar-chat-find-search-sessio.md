---
title: "Suche im Chat mit Strg+F (ChatFindBar, chat-find, search.sessions-Filter, CSS Highlight API)"
summary: "Wie die eigene Chat-Suche (Strg+F statt WebView-Suche) aufgebaut ist: Sidecar-Volltextsuche mit Session/Projekt-Filter, Springen per focusEvent, Markieren per CSS Custom Highlight API; wichtig bei Änderungen am Chat-Thread, an search.sessions oder an Tastenkürzeln."
tags: ["chat","suche","ui","telefon","sidecar"]
updated: "2026-10-18T15:57:43.546Z"
---

Eingebaut 2026-10-18 auf Wunsch des Nutzers: Strg+F im Chat öffnet eine eigene Suchleiste statt der Suche der WebView, durchsucht den **ganzen gespeicherten Verlauf** (der Chat ist virtualisiert und lädt seitenweise, darum sucht der Sidecar).

## Aufbau
- Sidecar: `db.searchEvents(query, limit, filter)` mit `SearchFilter` (protocol/models.ts): `sessionId`, `projectId` (schließt Worktrees der Agenten ein, `p.parent_id`), `phrase` (FTS5-Phrase `"a b"*`), `order: "time"` (neueste zuerst, zum Durchsteppen). Keine neue RPC-Methode: `search.sessions` hat die Filter als optionale Parameter bekommen (Limit bis 1000). Durchsucht werden Nachrichten, Antworten, Werkzeug-Aufrufe (Name + alle Strings der Eingabe, also Befehle und Pfade) und Werkzeug-Ergebnisse (FTS-Trigger in der Migration in db.ts).
- `lib/find-text.ts`: Wörter wie der Sidecar (`[\p{L}\p{N}_]+`, max. 8), Falten (klein, ohne Akzente, mit Offset-Abbildung), Muster „Wortanfang“ wie FTS-Präfixsuche.
- `lib/chat-find.ts`: Register aller Chats auf dem Bildschirm (`useChatFindTarget(surface, pane, open)` in `ChatPanel`), eigener `keydown`-Listener (läuft auch in Chat-Fenstern, die keine globalen Shortcuts haben). Ziel = Chat mit dem Fokus, sonst Hauptchat. Editoren (`.cm-editor`, `.monaco-editor`) und Terminal behalten ihr Strg+F; bei offenem Dialog nichts. Ohne Chat auf dem Bildschirm bleibt die WebView-Suche.
- `components/workspace/ChatFindBar.tsx`: schwebt oben rechts im ChatPanel (`top-13`). Umfang Session / Projekt / Alle (im Chat-Fenster ohne „Alle“; ohne Session gilt Projekt), Schalter „Exakte Wortfolge“. Session: Zähler „1 von 17“, Enter = älterer Treffer, Umschalt+Enter = neuerer (Reihenfolge neueste zuerst, wie Chat-Apps). Projekt/Alle: Liste mit `SearchHitRow`, Pfeiltasten + Enter, Klick öffnet die Session in **diesem** Bereich (`slot.select`), schon sichtbare Sessions per `openChat`, anderes Projekt im Hauptchat per `openProject`.
- Springen: `useUi.setFocusEvent({ sessionId, seq })` wie die globale Volltextsuche; `SessionThread` lädt ältere Seiten bis dorthin (`loadUntil`). Die Zeile des letzten Sprungs trägt dauerhaft `data-find-current`, der Thread-Scroller `data-chat-thread`.
- Markieren: **CSS Custom Highlight API** (`CSS.highlights`, Namen `forge-find` und `forge-find-current`, Stil in `styles.css`), kein Umbau des React-DOM. Ein MutationObserver auf der Chat-Fläche markiert neu, wenn Zeilen beim Scrollen kommen oder Antworten wachsen. Alle Chats teilen sich die beiden Highlight-Namen (Map pro Chat in chat-find.ts). jsdom kennt die API nicht, `paint()` prüft das.

## Einstiege
Strg+F, Befehlspalette „Im Chat suchen“ (`chat-find`, `openChatFindSoon`: wartet, bis die Palette weg ist, sonst holt Radix beim Schließen den Fokus aus dem Suchfeld zurück), Rechtsklick im Chat („Im Chat suchen“ bzw. „„Auswahl“ im Chat suchen“; markierter Text wird auch bei Strg+F übernommen). Telefon: Werkzeug `search` mit optional `session`, `project`, `phrase`.

## Stolperfallen
- Treffer in eingeklappten Werkzeug-Karten werden angesprungen, aber nicht markiert (Text nicht im DOM).
- Treffer von Subagenten-Ereignissen landen über `itemIndexForSeq` auf der nächsten Nachricht davor.
- Tests: `lib/find-text.test.ts`, `lib/chat-find.test.ts` (jsdom hat kein Layout: `getClientRects` stubben), `ChatFindBar.test.tsx`, Sidecar `search-devserver.test.ts`, `phone-call.test.ts`.
