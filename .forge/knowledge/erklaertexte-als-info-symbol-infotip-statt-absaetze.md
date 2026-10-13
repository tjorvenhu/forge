---
title: "Erklärtexte: kurze sichtbar, lange als Info-Symbol (InfoTip)"
summary: "Konvention: kurze Erklärungen zu Einstellungen stehen als graue Zeile unter dem Label, nur lange wandern hinter ein kleines i mit Tooltip. Wichtig für jede neue Einstellung, jedes Formularfeld und jeden Abschnitt."
tags: ["ui","tooltip","einstellungen","konvention"]
updated: "2026-10-13T18:30:08.361Z"
---

Der Nutzer will keine langen Erklärtexte in der UI, aber auch keine Seiten, auf denen nur noch Labels mit i stehen (wirkt leer). Regel: **kurze Erklärungen sichtbar, lange hinter ein Info-Symbol** (lucide `Info`, Tooltip bei Hover oder Tastaturfokus).

Grenze: `SHORT_INFO_MAX = 120` Zeichen Text (apps/desktop/src/components/ui/misc.tsx). Gezählt wird der reine Text, auch aus JSX (`textOf` läuft durch children).

## Bausteine (components/ui/misc.tsx)
- `InfoTip`: das i allein, Inhalt als children. Kurze Verzögerung (100 ms). Klick lässt den Tooltip offen und löst in einem `<label>` nichts aus.
- `LabelWithInfo info={...}`: Label plus i, immer als i (für bewusst gesetzte lange Texte).
- `LabelWithDescription description={...}`: entscheidet automatisch: kurz als `text-xs text-muted`-Zeile unter dem Label, lang als i.
- `isShortInfo(node)`: die Entscheidung allein, z. B. wenn der kurze Text an anderer Stelle stehen soll (Field: unter dem Eingabefeld).
- Braucht einen `TooltipProvider` (in main.tsx vorhanden). Tests mit Beschreibungen in `<TooltipProvider>` wrappen.

## Automatisch nach Länge
- `Group description`, `Row description`, `SwitchRow description` (components/settings/layout.tsx; auch Dev-Tools)
- `Field hint` (components/ui/input.tsx, kurz unter dem Feld), `PhoneNumberList hint` (kurz unter der Liste), `ToggleRow` children
- Neue Einstellungen also einfach mit `description`/`hint` anlegen, nicht als eigener `<p className="text-xs text-muted">`.
- Freie Stellen mit langem Text (Hooks, Marketplace, Backup, Remote Control, Telefon-SIP) nutzen `LabelWithInfo`/`InfoTip` direkt.

## Bleibt immer sichtbar
- Warnungen, Fehler, Statuszeilen
- Beschreibungen in Bestätigungsdialogen, Leerzustände (EmptyState)
- Beschreibungen von Auswahl-Optionen (Select-Optionen, Profil-Karten)

Test: src/components/ui/info-tip.test.tsx.
