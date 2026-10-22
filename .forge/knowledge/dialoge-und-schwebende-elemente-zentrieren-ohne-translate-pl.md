---
title: "Dialoge und schwebende Elemente zentrieren ohne translate plus Animation (WebKit, macOS, verschobene Knöpfe)"
summary: "Warum Dialoge auf macOS manchmal verschoben waren und wie Elemente mit Einblend-Animation zentriert werden müssen (inset-0 m-auto statt -translate-1/2)."
tags: ["ui","stolperfalle","tauri","konvention"]
updated: "2026-10-22T08:05:11.278Z"
---

Gemeldet 2026-10-22: Auf macOS lagen die Bestätigungs-Knöpfe in Dialogen ab und zu verschoben.

Ursache (Annahme, nicht in WebKit nachgestellt, weil auf dem Rechner kein WebKit-Testbrowser lief): Tailwind v4 setzt `-translate-x-1/2` über die CSS-Eigenschaft `translate`. Die Einblend-Keyframes (`forge-pop-in`, `forge-palette-in`, `forge-rise-in` in `styles.css`) animieren `transform`, mit fill-mode `both`. WKWebView (macOS) wendet `translate` bei einer beschleunigten transform-Animation auf demselben Element nicht zuverlässig an. Dann sitzt der Dialog um die halbe Breite und Höhe nach rechts unten versetzt. WebView2 (Windows) ist nicht betroffen, deshalb fiel es dort nie auf.

Regel: Ein Element mit transform-Animation wird nicht über `translate` zentriert.
- Dialoge (`components/ui/dialog.tsx`): `fixed inset-0 m-auto h-fit` plus Breite und `max-h`. Eigene Höhen (`h-[80vh]`, `h-150`) überschreiben `h-fit` über twMerge.
- Nur horizontal (CommandPalette, JumpToEnd in `FollowScroll.tsx`): `inset-x-0 mx-auto` plus Breite bzw. `w-fit`.
- Ist die Position berechnet (Screenshot-Leiste in `ScreenshotOverlay.tsx`): außen ein Element mit `-translate-x-1/2`, innen ein eigenes für die Animation.
Unproblematisch sind Radix-Popper (Menüs, Tooltips): Der Wrapper positioniert, der Inhalt animiert.
