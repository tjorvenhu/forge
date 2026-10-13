---
title: "FORGE-Werkzeuge im Chat: Karten hängen an den Ergebnistexten"
summary: "Die Chat-Karten für mcp__forge__-Aufrufe werten die Ergebnistexte der Werkzeuge aus; wer Texte in forge-tools.ts ändert oder ein neues FORGE-Werkzeug anlegt, muss forge-tool.ts mitziehen."
tags: ["chat","forge-tools","ui","stolperfalle"]
updated: "2026-10-13T12:55:16.956Z"
---

## Worum es geht

Aufrufe von FORGE-Werkzeugen (`mcp__forge__…`) zeigt der Chat nicht als Rohnamen, sondern als eigene Karte mit Icon,
Titel, Bezug und Sprung-Knopf (`apps/desktop/src/components/workspace/ForgeToolCard.tsx`). Was angezeigt wird,
entscheidet `forgeToolView` in `apps/desktop/src/components/workspace/forge-tool.ts`. Der Aktivitäts-Verlauf
(`ActivityFeed.tsx`) nutzt dieselbe Funktion.

Jeder FORGE-Aufruf bekommt den hervorgehobenen Rahmen (`ForgeHighlight`) mit FORGE-Label, auch reine Abfragen wie
`agent_status`, `knowledge_search` oder `dev_environment` (Wunsch des Nutzers, 2026-10-13). Die frühere
Unterscheidung `prominent` (Änderungen mit Rahmen, Abfragen als schlichte Zeile) gibt es nicht mehr.

## Stolperfalle: Kopplung an die Ergebnistexte

`forgeToolView` liest die Texte, die die Werkzeuge in `packages/sidecar/src/sessions/forge-tools.ts` zurückgeben:

| Werkzeug | erwarteter Text | Wirkung in der Karte |
|---|---|---|
| alle | beginnt mit `Fehler:` (auch ohne `isError`) | rote Karte, Titel „… fehlgeschlagen / nicht …“, kein Sprung-Knopf |
| `knowledge_save` | `Gespeichert: <id> (…)` / `Aktualisiert: <id> (…)` | Titel und Kennung für „Eintrag öffnen“ |
| `knowledge_save` | beginnt mit `Nicht gespeichert` | gelbe Karte „ähnlicher Eintrag vorhanden“ |
| `knowledge_search` | beginnt mit `Keine Treffer` | Titel „…, keine Treffer“ |
| `knowledge_delete` | beginnt mit `Kein Eintrag` | gelbe Karte „nicht gefunden“ |
| `start_agent` | enthält `Branch <name>,` | Branch als Bezug |

Werden diese Texte im Sidecar umformuliert, zeigt die Karte stillschweigend Falsches, zum Beispiel einen Erfolg
statt einer Ablehnung. Die Tests dazu stehen in `ToolCard.test.tsx` („FORGE tools in the chat“).

## Neues FORGE-Werkzeug

Ein neues Werkzeug in `forge-tools.ts` erscheint ohne eigenen `case` in `forgeToolView` nur als „FORGE: <name>“ mit
Amboss-Icon. Für eine richtige Karte braucht es dort: Titel (läuft / fertig / fehlgeschlagen), Bezug, Icon und ggf.
ein Sprungziel (`knowledge`, `agents`, `devtools`).

## Weitere Entscheidungen

- `notify` wird ausgeblendet, sobald der Aufruf durch ist. Die Benachrichtigung hat schon eine eigene Karte aus dem
  `notify`-Event (`chat-items.ts`).
- „Eintrag öffnen“ setzt `knowledgeRequest` im UI-Store (`stores/ui.ts`). `KnowledgeTab` übernimmt den Eintrag,
  leert dabei die Suche und fragt bei ungespeicherten Änderungen zuerst nach.
