---
title: "Einstellungsseiten: Layout und Erklärtexte (Group, Row stacked, InfoTip, LabelWithDescription)"
summary: "Regeln für Einstellungsseiten und Formulare: eine Karte pro Thema, keine ungleich langen Spalten, kurze Erklärungen sichtbar und lange hinter einem Info-Symbol; dazu die Stolperfalle mit Row stacked. Wichtig für jede neue oder umgebaute Einstellung."
tags: ["ui","einstellungen","layout","tooltip","konvention","stolperfalle"]
updated: "2026-10-15T06:42:16.484Z"
---

Zwei Vorgaben des Nutzers, die für alle Einstellungsseiten, Formularfelder und Abschnitte gelten.

## Layout: eine Karte pro Thema (seit 2026-10-14)
Der Nutzer hat am 2026-10-14 die Telefon-Einstellungen als „durchmischt“ bemängelt und klargestellt: so etwas darf generell nicht vorkommen.

- **Eine Karte (`Group` aus `components/settings/layout.tsx`) pro Thema**, untereinander mit `gap-6`, wie auf allen anderen Seiten. Keine Themen-Spalten nebeneinander (`xl:grid-cols-2` mit verschiedenen Abschnitten links und rechts): Die Spalten werden ungleich lang, und Themen stehen zusammenhanglos nebeneinander.
- Zwei Spalten nur **innerhalb** einer Karte für zusammengehörige, gleich hohe Felder (Server + Port, Benutzer + Anzeigename).
- Teilbereiche einer Karte als eigene Kinder von `Group` (die Karte trennt Kinder mit Linien, `divide-y`), jeweils mit `p-4`.
- `Group.title` nimmt ReactNode (z. B. `LabelWithInfo`, Badge daneben); Aktionen rechts im Kopf über `action`.
- Selten Gebrauchtes hinter einen Aufklapper („Erweitert“), thematisch in der richtigen Karte (Modelle beim Gesprächspartner, nicht bei SIP).
- Skeletons spiegeln die Karten (`CardSkeleton` in `PhoneSettings.tsx`).

### Stolperfalle `Row stacked`
`Row` gibt der Beschriftung `flex-[1_1_14rem]`, damit breite Steuerelemente umbrechen. In `stacked` (flex-col) wäre diese Basis eine **Höhe** von 14rem: großer leerer Raum über dem Feld (so geschehen bei „Pfad zur Claude-CLI“). Darum bekommt die Beschriftung die Basis nur ohne `stacked`.

## Erklärtexte: kurze sichtbar, lange als Info-Symbol (seit 2026-10-13)
Der Nutzer will keine langen Erklärtexte in der UI, aber auch keine Seiten, auf denen nur noch Labels mit i stehen (wirkt leer). Regel: **kurze Erklärungen sichtbar, lange hinter ein Info-Symbol** (lucide `Info`, Tooltip bei Hover oder Tastaturfokus).

Grenze: `SHORT_INFO_MAX = 120` Zeichen Text (`apps/desktop/src/components/ui/misc.tsx`). Gezählt wird der reine Text, auch aus JSX (`textOf` läuft durch children).

### Bausteine (`components/ui/misc.tsx`)
- `InfoTip`: das i allein, Inhalt als children. Kurze Verzögerung (100 ms). Klick lässt den Tooltip offen und löst in einem `<label>` nichts aus.
- `LabelWithInfo info={...}`: Label plus i, immer als i (für bewusst gesetzte lange Texte).
- `LabelWithDescription description={...}`: entscheidet automatisch: kurz als `text-xs text-muted`-Zeile unter dem Label, lang als i.
- `isShortInfo(node)`: die Entscheidung allein, z. B. wenn der kurze Text an anderer Stelle stehen soll (Field: unter dem Eingabefeld).
- Braucht einen `TooltipProvider` (in main.tsx vorhanden). Tests mit Beschreibungen in `<TooltipProvider>` wrappen.

### Automatisch nach Länge
- `Group description`, `Row description`, `SwitchRow description` (`components/settings/layout.tsx`; auch Dev-Tools)
- `Field hint` (`components/ui/input.tsx`, kurz unter dem Feld), `PhoneNumberList hint` (kurz unter der Liste), `ToggleRow` children
- Neue Einstellungen also einfach mit `description`/`hint` anlegen, nicht als eigener `<p className="text-xs text-muted">`.
- Freie Stellen mit langem Text (Hooks, Marketplace, Backup, Remote Control, Telefon-SIP) nutzen `LabelWithInfo`/`InfoTip` direkt.

### Bleibt immer sichtbar
- Warnungen, Fehler, Statuszeilen
- Beschreibungen in Bestätigungsdialogen, Leerzustände (EmptyState)
- Beschreibungen von Auswahl-Optionen (Select-Optionen, Profil-Karten)

Test: `src/components/ui/info-tip.test.tsx`.
