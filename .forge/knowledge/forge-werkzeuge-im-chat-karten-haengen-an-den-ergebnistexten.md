---
title: "FORGE-Werkzeuge im Chat: Karten hängen an den Ergebnistexten"
summary: "Die Chat-Karten für mcp__forge__-Aufrufe werten die Ergebnistexte der Werkzeuge aus; wer Texte in forge-tools.ts ändert oder ein neues FORGE-Werkzeug anlegt, muss forge-tool.ts mitziehen."
tags: ["chat","forge-tools","ui","stolperfalle"]
updated: "2026-10-22T08:14:25.223Z"
---

## Worum es geht

Aufrufe von FORGE-Werkzeugen (`mcp__forge__…`) zeigt der Chat nicht als Rohnamen, sondern als eigene Karte mit Icon,
Titel, Bezug und Sprung-Knopf (`apps/desktop/src/components/workspace/ForgeToolCard.tsx`). Was angezeigt wird,
entscheidet `forgeToolView` in `apps/desktop/src/components/workspace/forge-tool.ts`. Der Aktivitäts-Verlauf
(`ActivityFeed.tsx`) nutzt dieselbe Funktion.

Jeder FORGE-Aufruf bekommt den hervorgehobenen Rahmen (`ForgeHighlight`) mit FORGE-Label, auch reine Abfragen wie
`agent_status`, `knowledge_search` oder `dev_environment` (Wunsch des Nutzers, 2026-10-13).

## Stolperfalle: Kopplung an die Ergebnistexte

`forgeToolView` liest die Texte, die die Werkzeuge in `packages/sidecar/src/sessions/forge-tools.ts` (bzw. für die
Vorschau `packages/sidecar/src/preview/preview.ts`) zurückgeben. Seit i18n (2026-10-18) antwortet der Sidecar in der
Sprache, die beim Aufruf eingestellt war; ältere Karten haben die andere. **Jede Erkennung muss deshalb beide Sprachen
prüfen** (`/^(?:Gespeichert|Saved)/`), ein reines `startsWith("Keine Treffer")` greift auf Englisch nicht.

| Werkzeug | erwarteter Text (DE / EN) | Wirkung in der Karte |
|---|---|---|
| alle | beginnt mit `Fehler:` / `Error:` (auch ohne `isError`) | rote Karte, kein Sprung-Knopf |
| `knowledge_save` | `Gespeichert:`/`Aktualisiert:` / `Saved:`/`Updated:` `<id> (…)` | Titel und Kennung für „Eintrag öffnen“ |
| `knowledge_save` | `Überschneidet sich stark mit` / `Overlaps heavily with` | gelbe Karte „überschneidet sich“ |
| `knowledge_save` | beginnt mit `Nicht gespeichert` / `Not saved` | gelbe Karte „ähnlicher Eintrag vorhanden“ |
| `knowledge_merge` | `Zusammengeführt:` / `Merged:` `<id>` | Kennung für „Eintrag öffnen“ |
| `knowledge_search` | beginnt mit `Keine Treffer` / `No hits` | Titel „…, keine Treffer“ |
| `knowledge_delete` | beginnt mit `Kein Eintrag` / `No entry` | gelbe Karte „nicht gefunden“ |
| `knowledge_check` | `Keine veralteten` / `No outdated`; sonst `Veraltete Verweise in N` / `Outdated references in N` | grün bzw. gelb mit „N Einträge betroffen“ |
| `knowledge_mark_checked` | beginnt mit `Nichts zu markieren` / `Nothing to mark` | gelbe Karte „Nichts zu markieren“ |
| `start_agent` | enthält `Branch <name>,` | Branch als Bezug |
| `preview_screenshot`, `preview_interact` | Zeile `Adresse: <url>` | Adresse als Bezug |
| `preview_screenshot`, `preview_interact` | Zeile `Screenshot: <B>x<H> JPEG…` | Bild in der Karte (`PreviewShot`) |
| `preview_screenshot` | Zeile `Konsole: …` mit Fehler | gelbe Karte „Konsole meldet Fehler“ |
| `preview_console` | Zeile `Zusammenfassung: …` | Bezug; mit Fehlern gelbe Karte |
| `preview_interact` | Zeile `Abgebrochen nach Schritt X von Y.` | gelbe Karte „Schritt X von Y … fehlgeschlagen“ |

Werden diese Texte im Sidecar umformuliert, zeigt die Karte stillschweigend Falsches, zum Beispiel einen Erfolg
statt einer Ablehnung. Die Tests dazu stehen in `ToolCard.test.tsx` („FORGE tools in the chat“).

## Neues FORGE-Werkzeug

Ein neues Werkzeug in `forge-tools.ts` erscheint ohne eigenen `case` in `forgeToolView` nur als „FORGE: <name>“ mit
Amboss-Icon. Für eine richtige Karte braucht es dort: Titel (läuft / fertig / fehlgeschlagen), Bezug, Icon (in
`ForgeToolIcon` und `ICONS` in `ForgeToolCard.tsx`) und ggf. ein Sprungziel (`knowledge`, `agents`, `devtools`).
Texte in `apps/desktop/src/i18n/{de,en}/chat.ts` (`forgeTools`), Werkzeugtexte im Sidecar in
`packages/sidecar/src/i18n/{de,en}/core/forge-tools.ts`. Etwas, das immer unter dem Titel stehen soll (z. B. ein
Bild), geht über die Prop `preview` von `ForgeToolCard`. Bilder aus Werkzeug-Ergebnissen stehen nicht im
Chat-Event, sondern nur im Transkript: `sessions.images` mit der seq des `tool.result`-Events liefert sie.

## Weitere Entscheidungen

- `notify` wird ausgeblendet, sobald der Aufruf durch ist. Die Benachrichtigung hat schon eine eigene Karte aus dem
  `notify`-Event (`chat-items.ts`).
- „Eintrag öffnen“ setzt `knowledgeRequest` im UI-Store (`stores/ui.ts`). `KnowledgeTab` übernimmt den Eintrag,
  leert dabei die Suche und fragt bei ungespeicherten Änderungen zuerst nach.
