---
title: "UI-Design: keine farbigen Streifen am linken Rand von Karten und Blöcken"
summary: "Gestaltungsvorgabe des Nutzers für App und Website: Status oder Art nie mit farbigem border-left zeigen, sondern mit Punkt und Text oder Hintergrund."
tags: ["ui","konvention","stats"]
updated: "2026-10-23T10:25:42.865Z"
---

Der Nutzer will keine farbigen Akzentstreifen am linken Rand (z. B. `border-left: 3px solid <grün>` an einer Agenten-Karte, Zitat-artige Blöcke mit Randlinie). Er findet das „so AI-like“ (2026-10-23, Crew im Browser).

So stattdessen:
- Status als kleiner Punkt mit Text (z. B. `.crew-status::before` in `services/stats/src/app/crew/crew.css`: 6 px Kreis in `currentColor` vor „ARBEITET“).
- Abgesetzte Blöcke über Hintergrund (`--color-surface-2`) und runde Ecken, nicht über eine Randlinie.

Gilt für FORGE-Desktop und Website. Vor einem Screenshot neues CSS auf `border-left` prüfen.
