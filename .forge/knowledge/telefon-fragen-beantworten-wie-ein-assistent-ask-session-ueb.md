---
title: "Telefon: Fragen beantworten wie ein Assistent (ask, Session-Übersicht beim Anrufstart, unscharfe Namen)"
summary: "Warum Gemini/Claude am Telefon Fragen zu Sessions über das Werkzeug ask beantwortet, die Session-Übersicht schon im Kontext hat und falsch erkannte Namen trotzdem findet; wichtig bei Änderungen am Telefon-Prompt oder an resolve()."
tags: ["telefon","gemini","sessions","kontext","stolperfalle"]
updated: "2026-10-20T16:01:25.962Z"
---

Eingebaut 2026-10-20, weil der Nutzer Gemini am Telefon „dumm“ fand. Die Anrufprotokolle (Tabelle `phone_calls`, Spalte `transcript` in forge.db) zeigten vier Ursachen:

1. **Kein Wissen beim Anrufstart:** Gemini kannte keine Session und fragte zurück („Welche Sessions laufen denn?“).
2. **Falsch erkannte Namen:** „Nebenstelle LEDs“ fand „Nebenstellen-LED …“ nicht, weil `resolve()` nur Teilstrings verglich.
3. **Inhaltsfragen ohne Werkzeug:** „Was ist der Ultra Thin Test?“ wurde aus Allgemeinwissen beantwortet (Schwangerschaftstest); `details` liefert nur das letzte Ergebnis.
4. **„Ein Satz, höchstens zwei“** im Prompt machte inhaltliche Antworten vage.

## Lösung
- **Werkzeug `ask`** (`tools.ts`, `PhoneToolset.ask`, Umsetzung in `phone-service.ts` bei `search`): Ohne `session` bewertet FORGE die Sessions selbst: jedes Wort der Frage einzeln per FTS (`db.searchEvents`, Gewicht 1/Anzahl Sessions mit Treffer, so zählen häufige Wörter kaum), dazu Titelähnlichkeit (`nameScore`), Bonus für die gerade besprochene (`a.focus`) und laufende Sessions. Die besten 3 (`ASK_SESSIONS`) gehen an `ClaudeAssist.answerQuestion` (haiku, purpose `phone`, 40k Zeichen Verlauf geteilt auf die Sessions). Antwort und Session-Namen sind als Daten markiert (`asData`). Kein RPC, daher kein Eintrag in `coverage.ts` nötig.
- **Übersicht im Kontext** (`PhoneService.overview`): laufende Sessions mit letzter Antwort, dazu 5 zuletzt beendete. Mit PIN-Pflicht steht sie nicht im Systemprompt, sondern kommt mit der Freischaltung: `onUnlock()` der Controller gibt jetzt einen String zurück, der an `pin.unlockedNote` angehängt wird. Getrennte Notizen würden Gemini Live zweimal antworten lassen, weil jedes `sendText` als Eingabe zählt.
- **Stolperfalle:** Die Übersicht vergibt die Kürzel S1, S2 … schon beim Anrufstart (`refFor`). Tests, die ein unvergebenes Kürzel brauchen, nehmen deshalb S9.
- **Unscharfe Namen:** `nameScore`/`bestByName` in `session-info.ts` (Präfix, Editierabstand 1 bzw. 2, Titel ohne Leerzeichen, zusammengezogene Wortpaare). `resolve()` nutzt das nur, wenn kein Teilstring passt. Passen mehrere gleich gut, bleibt es bei der Rückfrage „Mehrere Sessions passen“.
- **Prompt** (`i18n/*/phone.ts`, `prompt.system`): Abschnitt „So verstehst du ihn“: ähnlich klingende Namen nehmen, nichts fragen, was man nachsehen kann, Inhaltsfragen immer mit `ask`, vor `ask` kurz „Moment.“ (die Antwort dauert ein paar Sekunden), bei Inhaltsfragen bis zu vier Sätze.
