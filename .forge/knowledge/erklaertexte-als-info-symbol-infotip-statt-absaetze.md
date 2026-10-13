---
title: "Erklärtexte als Info-Symbol (InfoTip) statt Absätze"
summary: "Konvention: Erklärungen zu Einstellungen und Bereichen stehen hinter einem kleinen i mit Tooltip, nicht als Fließtext. Wichtig für jede neue Einstellung, jedes Formularfeld und jeden Abschnitt."
tags: ["ui","tooltip","einstellungen","konvention"]
updated: "2026-10-13T15:36:24.600Z"
---

Der Nutzer will keine langen Erklärtexte in der UI. Erklärungen gehören hinter ein kleines Info-Symbol (lucide `Info`), das beim Drüberfahren oder per Tastaturfokus einen Tooltip zeigt.

## Bausteine (apps/desktop/src/components/ui/misc.tsx)
- `InfoTip`: das i allein, Inhalt als children (String oder JSX, z. B. zwei `<p>` in `flex flex-col gap-1.5`). Kurze Verzögerung (100 ms). Klick lässt den Tooltip offen und löst in einem `<label>` nichts aus (preventDefault auf click und pointerdown).
- `LabelWithInfo info={...}`: Label plus i dahinter; ohne `info` nur das Label.
- Braucht einen `TooltipProvider` (in main.tsx vorhanden). Tests, die Komponenten mit Beschreibungen rendern, müssen in `<TooltipProvider>` wrappen, sonst Fehler "Tooltip must be used within TooltipProvider".

## Automatisch als i dargestellt
- `Group description`, `Row description`, `SwitchRow description` (components/settings/layout.tsx; auch Dev-Tools nutzen diese)
- `Field hint` (components/ui/input.tsx), `PhoneNumberList hint`, `ToggleRow` children
- Neue Einstellungen also einfach mit `description`/`hint` anlegen, nicht als eigener `<p className="text-xs text-muted">`.
- Bei `SectionTitle` den Inhalt in `LabelWithInfo` packen.

## Bleibt sichtbar
- Warnungen (z. B. Autonomous-Profil, ausgeschaltete Sperrlisten-Regeln), Fehler, Statuszeilen
- Beschreibungen in Bestätigungsdialogen (ConfirmDialog, Dialog description), Leerzustände (EmptyState)
- Beschreibungen von Auswahl-Optionen (Select-Optionen, Profil-Karten), weil sie die Wahl unterscheiden

Test: src/components/ui/info-tip.test.tsx.
