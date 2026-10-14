---
title: "FORGE-Werkzeuge im Chat: Karten hängen an den Ergebnistexten"
summary: "Die Chat-Karten für mcp__forge__-Aufrufe werten die Ergebnistexte der Werkzeuge aus; wer Texte in forge-tools.ts ändert oder ein neues FORGE-Werkzeug anlegt, muss forge-tool.ts mitziehen."
tags: ["chat","forge-tools","ui","stolperfalle"]
updated: "2026-10-14T18:06:52.305Z"
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

`forgeToolView` liest die Texte, die die Werkzeuge in `packages/sidecar/src/sessions/forge-tools.ts` (bzw. für die
Vorschau `packages/sidecar/src/preview/preview.ts`) zurückgeben:

| Werkzeug | erwarteter Text | Wirkung in der Karte |
|---|---|---|
| alle | beginnt mit `Fehler:` (auch ohne `isError`) | rote Karte, Titel „… fehlgeschlagen / nicht …“, kein Sprung-Knopf |
| `knowledge_save` | `Gespeichert: <id> (…)` / `Aktualisiert: <id> (…)` | Titel und Kennung für „Eintrag öffnen“ |
| `knowledge_save` | beginnt mit `Nicht gespeichert` | gelbe Karte „ähnlicher Eintrag vorhanden“ |
| `knowledge_search` | beginnt mit `Keine Treffer` | Titel „…, keine Treffer“ |
| `knowledge_delete` | beginnt mit `Kein Eintrag` | gelbe Karte „nicht gefunden“ |
| `start_agent` | enthält `Branch <name>,` | Branch als Bezug |
| `preview_screenshot`, `preview_interact` | Zeile `Adresse: <url>` | Adresse als Bezug |
| `preview_screenshot`, `preview_interact` | Zeile `Screenshot: <B>x<H> JPEG…` | Bild in der Karte (`PreviewShot`, Seitenverhältnis für den Platzhalter) |
| `preview_screenshot` | Zeile `Konsole: …` mit Fehler/Ausnahme/fehlgeschlagene Anfrage | gelbe Karte „Konsole meldet Fehler“ |
| `preview_console` | Zeile `Zusammenfassung: …` | Bezug; mit Fehlern gelbe Karte |
| `preview_interact` | Zeile `Abgebrochen nach Schritt X von Y.` | gelbe Karte „Schritt X von Y … fehlgeschlagen“ |

Werden diese Texte im Sidecar umformuliert, zeigt die Karte stillschweigend Falsches, zum Beispiel einen Erfolg
statt einer Ablehnung. Die Tests dazu stehen in `ToolCard.test.tsx` („FORGE tools in the chat“).

## Neues FORGE-Werkzeug

Ein neues Werkzeug in `forge-tools.ts` erscheint ohne eigenen `case` in `forgeToolView` nur als „FORGE: <name>“ mit
Amboss-Icon. Für eine richtige Karte braucht es dort: Titel (läuft / fertig / fehlgeschlagen), Bezug, Icon (in
`ForgeToolIcon` und `ICONS` in `ForgeToolCard.tsx`) und ggf. ein Sprungziel (`knowledge`, `agents`, `devtools`).
Etwas, das immer unter dem Titel stehen soll (z. B. ein Bild), geht über die Prop `preview` von `ForgeToolCard`.
Bilder aus Werkzeug-Ergebnissen stehen nicht im Chat-Event, sondern nur im Transkript: `sessions.images` mit der
seq des `tool.result`-Events liefert sie.

## Weitere Entscheidungen

- `notify` wird ausgeblendet, sobald der Aufruf durch ist. Die Benachrichtigung hat schon eine eigene Karte aus dem
  `notify`-Event (`chat-items.ts`).
- „Eintrag öffnen“ setzt `knowledgeRequest` im UI-Store (`stores/ui.ts`). `KnowledgeTab` übernimmt den Eintrag,
  leert dabei die Suche und fragt bei ungespeicherten Änderungen zuerst nach.
