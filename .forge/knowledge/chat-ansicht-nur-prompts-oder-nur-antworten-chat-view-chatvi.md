---
title: "Chat-Ansicht: nur Prompts oder nur Antworten (chat-view, ChatViewToggle)"
summary: "Wie der Chat auf nur Prompts oder nur Antworten umschaltet, wo der Zustand liegt und wie Suche/Sprünge damit umgehen; wichtig bei Änderungen am SessionThread, an Chat-Items oder an der Kopfzeile."
tags: ["chat","ui","ansicht","filter"]
updated: "2026-10-18T20:55:57.597Z"
---

Eingebaut 2026-10-18 auf Wunsch des Nutzers: im Chat nur die eigenen Prompts oder nur die Antworten von Claude sehen.

## Aufbau (apps/desktop/src/components/workspace/chat-view.tsx)
- `ChatView` = "all" | "prompts" | "answers". Zustand **pro Session** im Card-State-Store (`cardKey(sessionId, "chat", "view")`): bleibt beim Wechseln der Session und Schließen des Chats, nicht über einen Neustart. Ohne React: `chatView(id)`, `setChatView(id, v)` (Palette, Rechtsklick).
- `filterChatItems(items, view)`: Prompts = alle `user`-Items (auch von FORGE gesendete); Antworten = `assistant`-Items mit Text (Hauptgespräch; Werkzeuge, Karten, Ergebnisse fallen weg). `turnStarts` = Antworten nach einem Prompt: bekommen im Antwort-Modus Claudes Marker (`LeadMarker`) und den Abstand `turn`.
- `SessionThread` (ChatPanel.tsx) virtualisiert nur die gefilterten Items; `allItems` bleibt für Arrivals und die Zählung. Beim Wechsel der Ansicht springt der Verlauf ans Ende (Layout-Effekt mit `shownView`).
- Im gefilterten Modus: Leiste über dem Verlauf „Nur Prompts: 12 von 340 Einträgen · Alles zeigen“, leerer Zustand mit `EmptyState`, Hover-Knopf „Im Verlauf zeigen“ je Zeile (setzt `focusEvent`). Ausstehende Nachrichten nur außerhalb des Antwort-Modus.
- Sprünge (Suche, Strg+F, „Im Verlauf zeigen“): Der Fokus-Effekt schaltet zuerst auf "all" und läuft dann erneut, weil ein Treffer in einer ausgeblendeten Zeile liegen kann.

## Einstiege
Umschalter in der Kopfzeile (`ChatViewToggle` in `SessionBar`, in schmalen Ansichten nur Symbole), Rechtsklick im Chat („Ansicht: …“), Befehlspalette (`chat-view-<v>`). Texte in `t.chat.view` (de/en). Kein Telefon-Werkzeug: reine Bildschirm-Ansicht ohne RPC; am Telefon liest `sessions`/`details` den Verlauf ohnehin zusammengefasst vor.

## Tests
`chat-view.test.tsx` (Filter, Turn-Anfänge, Umschalter; Tooltip braucht `TooltipProvider`).
