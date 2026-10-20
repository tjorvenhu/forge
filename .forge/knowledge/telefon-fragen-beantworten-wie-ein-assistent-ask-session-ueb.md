---
title: "Telefon: Fragen beantworten wie ein Assistent (ask, Session-Übersicht beim Anrufstart, unscharfe Namen, Tempo)"
summary: "Warum Gemini/Claude am Telefon Fragen zu Sessions über ask beantwortet, die Session-Übersicht schon im Kontext hat, falsch erkannte Namen findet und wo die Wartezeit entsteht (Messwerte); wichtig bei Änderungen am Telefon-Prompt, an resolve() oder bei „Telefon zu langsam“."
tags: ["telefon","gemini","sessions","performance","stolperfalle"]
updated: "2026-10-20T16:31:59.957Z"
---

Eingebaut 2026-10-20, weil der Nutzer Gemini am Telefon „dumm“ fand. Die Anrufprotokolle (Tabelle `phone_calls`, Spalte `transcript` mit `ts` je Zeile, in `%APPDATA%/forge/forge.db`; lesbar mit `node:sqlite` und `readOnly: true`) zeigten vier Ursachen:

1. **Kein Wissen beim Anrufstart:** Gemini kannte keine Session und fragte zurück („Welche Sessions laufen denn?“).
2. **Falsch erkannte Namen:** „Nebenstelle LEDs“ fand „Nebenstellen-LED …“ nicht, weil `resolve()` nur Teilstrings verglich.
3. **Inhaltsfragen ohne Werkzeug:** „Was ist der Ultra Thin Test?“ wurde aus Allgemeinwissen beantwortet (Schwangerschaftstest); `details` liefert nur das letzte Ergebnis.
4. **„Ein Satz, höchstens zwei“** im Prompt machte inhaltliche Antworten vage.

## Lösung
- **Werkzeug `ask`** (`tools.ts`, `PhoneToolset.ask`, Umsetzung in `phone-service.ts` bei `search`): Ohne `session` bewertet FORGE die Sessions selbst: jedes Wort der Frage einzeln per FTS (`db.searchEvents`, Gewicht 1/Anzahl Sessions mit Treffer, so zählen häufige Wörter kaum; alle Wörter zusammen ~0,3 s bei 30k Events), dazu Titelähnlichkeit (`nameScore`), Bonus für die gerade besprochene (`a.focus`) und laufende Sessions. Die besten 3 (`ASK_SESSIONS`) gehen an `ClaudeAssist.answerQuestion` (haiku, `effort: "low"`, purpose `phone`, 24k Zeichen Verlauf geteilt auf die Sessions). Antwort und Session-Namen sind als Daten markiert (`asData`). Kein RPC, daher kein Eintrag in `coverage.ts` nötig.
- **Übersicht im Kontext** (`PhoneService.overview`): laufende Sessions mit letzter Antwort, dazu 5 zuletzt beendete. Mit PIN-Pflicht steht sie nicht im Systemprompt, sondern kommt mit der Freischaltung: `onUnlock()` der Controller gibt einen String zurück, der an `pin.unlockedNote` angehängt wird. Getrennte Notizen würden Gemini Live zweimal antworten lassen, weil jedes `sendText` als Eingabe zählt.
- **Stolperfalle:** Die Übersicht vergibt die Kürzel S1, S2 … schon beim Anrufstart (`refFor`). Tests, die ein unvergebenes Kürzel brauchen, nehmen deshalb S9.
- **Unscharfe Namen:** `nameScore`/`bestByName` in `session-info.ts` (Präfix, Editierabstand 1 bzw. 2, Titel ohne Leerzeichen, zusammengezogene Wortpaare). `resolve()` nutzt das nur, wenn kein Teilstring passt. Passen mehrere gleich gut, bleibt es bei der Rückfrage „Mehrere Sessions passen“.
- **Prompt** (`i18n/*/phone.ts`, `prompt.system`, Abschnitt „So verstehst du ihn“): ähnlich klingende Namen nehmen, nichts fragen, was man nachsehen kann; Antwort aus der Übersicht oder `details`, wenn das reicht; `ask` nur für Fragen über den letzten Stand hinaus, vorher kurz „Moment.“; bei Inhaltsfragen bis zu vier Sätze.

## Tempo (gemessen 2026-10-20)
- Gemini Live selbst ist schnell: ~0,5 bis 1,3 s bis zum ersten Ton oder Werkzeugaufruf (Text-Eingabe, `gemini-3.8-live`). `thinkingConfig.thinkingLevel` lehnt das Modell ab („not supported“), `thinkingBudget: 0` geht, bringt aber nur ~0,3 s.
- Die Wartezeit kam von `ask`: neuer Claude-Prozess pro Aufruf (~1 bis 2 s) plus Haiku, das trotz `thinking: { type: "disabled" }` ~550 Tokens denkt (~5,8 s). `maxThinkingTokens: 0` hilft kaum; `effort: "low"` halbiert auf ~2,7 s bei gleich guter Antwort. Darum `CompleteOptions.effort` in `claude/runtime.ts`.
- Die `ts` im Transkript sind kein Latenzmaß: Gemini-Text wird erst bei `turnComplete` geschrieben, also nach dem Sprechen.
