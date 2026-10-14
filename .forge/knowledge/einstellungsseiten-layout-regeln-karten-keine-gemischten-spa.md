---
title: "Einstellungsseiten: Layout-Regeln (Karten, keine gemischten Spalten)"
summary: "Wie Einstellungsseiten aufgebaut sein sollen (eine Karte pro Thema, keine ungleich langen Spalten nebeneinander) und die Stolperfalle mit Row stacked; wichtig bei neuen oder umgebauten Einstellungen."
tags: ["ui","einstellungen","layout","konvention","stolperfalle"]
updated: "2026-10-14T17:30:58.819Z"
---

Der Nutzer hat am 2026-10-14 die Telefon-Einstellungen als „durchmischt“ bemängelt und klargestellt: so etwas darf generell nicht vorkommen.

## Regeln
- **Eine Karte (`Group` aus `components/settings/layout.tsx`) pro Thema**, untereinander mit `gap-6`, wie auf allen anderen Seiten. Keine Themen-Spalten nebeneinander (`xl:grid-cols-2` mit verschiedenen Abschnitten links und rechts): Die Spalten werden ungleich lang, und Themen stehen zusammenhanglos nebeneinander.
- Zwei Spalten nur **innerhalb** einer Karte für zusammengehörige, gleich hohe Felder (Server + Port, Benutzer + Anzeigename).
- Teilbereiche einer Karte als eigene Kinder von `Group` (die Karte trennt Kinder mit Linien, `divide-y`), jeweils mit `p-4`.
- `Group.title` nimmt ReactNode (z. B. `LabelWithInfo`, Badge daneben); Aktionen rechts im Kopf über `action`.
- Selten Gebrauchtes hinter einen Aufklapper („Erweitert“), thematisch in der richtigen Karte (Modelle beim Gesprächspartner, nicht bei SIP).
- Skeletons spiegeln die Karten (`CardSkeleton` in `PhoneSettings.tsx`).

## Stolperfalle `Row stacked`
`Row` gibt der Beschriftung `flex-[1_1_14rem]`, damit breite Steuerelemente umbrechen. In `stacked` (flex-col) wäre diese Basis eine **Höhe** von 14rem: großer leerer Raum über dem Feld (so geschehen bei „Pfad zur Claude-CLI“). Darum bekommt die Beschriftung die Basis nur ohne `stacked`.
