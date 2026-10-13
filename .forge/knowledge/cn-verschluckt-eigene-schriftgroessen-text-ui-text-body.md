---
title: "cn() verschluckt eigene Schriftgrößen (text-ui, text-body …)"
summary: "tailwind-merge in cn() kennt die eigenen Schriftgrößen-Tokens nicht, hält sie für Textfarben und wirft sie neben text-fg/text-muted weg; wichtig, wenn eine Schriftgröße im UI nicht greift oder Klassen per cn kombiniert werden."
tags: ["ui","tailwind","css","stolperfalle"]
updated: "2026-10-13T20:13:04.614Z"
---

`cn` in `apps/desktop/src/lib/utils.ts` ist `twMerge(clsx(...))` ohne Konfiguration. tailwind-merge kennt die Schriftgrößen aus `@theme` in `src/styles.css` nicht (`--text-3xs` bis `--text-display`: `text-ui`, `text-body`, `text-caption`, `text-small` …). Es hält `text-ui` für eine Textfarbe und lässt bei `cn("text-ui", "text-fg")` nur `text-fg` übrig. Die Schrift fällt dann auf die geerbte Größe zurück (body: 13px).

Aufgefallen am 2026-10-13: Die ultrathink-Kopie hinter dem Composer-Textfeld hatte 14px, das Feld nach `cn(..., "text-fg")` nur noch 13px, der Cursor stand vor dem „k“. Behoben, indem die Klassen des Textfelds nicht durch `cn` laufen (Kommentar in `Composer.tsx`). Nachgestellt mit der echten Composer-Komponente in headless Chrome (Tauri-Stub `window.__TAURI_INTERNALS__`, CDP-Tastendruck). Das Chrome-Profil gehört dabei nicht in den Projektordner, sonst lädt Vite die Seite neu.

Gleiches Muster steckt laut Prüfskript an weiteren Stellen, dort fehlt die gewollte Größe heute schon: `OpenSessions.tsx` (Zeilen ~227, ~280), `Sidebar.tsx` (~56, ~67), `ui/dropdown.tsx` (~27), `FileTree.tsx` (~125), `RemoteControl.tsx` (~36), `ToolCard.tsx` (~275, ~319), `github/DeviceCode.tsx` (~17), `ChatItemView.tsx` (Hinweiszeile `cn("text-body", NOTICE_TONE[…])`). Die richtige Lösung wäre `extendTailwindMerge({ extend: { classGroups: { "font-size": [{ text: [<die Tokens>] }] } } })` in `utils.ts`. Das ändert aber sichtbar Schriftgrößen an diesen Stellen und ist noch nicht mit dem Nutzer abgestimmt.
