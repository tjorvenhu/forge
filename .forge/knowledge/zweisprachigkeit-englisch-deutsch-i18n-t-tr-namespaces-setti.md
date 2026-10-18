---
title: "Zweisprachigkeit Englisch/Deutsch (i18n: t, tr(), Namespaces, Settings.language, Flaggen)"
summary: "Wie FORGE Texte auf Englisch und Deutsch hält (Desktop t.*, Sidecar tr().*, Protokoll pick), wie die Sprache umschaltet und was jede neue Funktion an Texten braucht."
tags: ["i18n","konvention","ui","sidecar","einstellungen","tests","stolperfalle"]
updated: "2026-10-18T15:45:32.513Z"
---

Seit 2026-10-18 ist FORGE zweisprachig. Standard für neue Installationen: **Englisch**. Bestehende Installationen (vor 0.1.97) setzt eine Migration in `persistence/db.ts` auf `de`. Entscheidung des Besitzers: Sprachwahl im ersten Schritt des Einrichtungsassistenten, Umschalter immer mit Flagge (SVG in `components/ui/flag.tsx`, keine Emoji: Windows zeigt Flaggen-Emoji als zwei Buchstaben).

## Einstellung
- `Settings.language` (`Language` = `"en" | "de"` aus `packages/protocol/src/i18n.ts`). Gilt für Oberfläche, Sidecar-Meldungen und Telefon.
- Umschalten: `LanguageSelect` / `LanguageChoice` (`components/settings/LanguageSelect.tsx`) speichern nur die Einstellung. `useLanguageSync()` (`src/i18n/sync.ts`, in `Shell` und `ChatWindowShell`) schreibt sie nach localStorage `forge.language` und lädt das Fenster neu. Laufende Sessions im Sidecar laufen weiter.
- Zu finden in Einstellungen > Allgemein > Bedienung, im Einrichtungsassistenten, in der Befehlspalette (`language-<l>` direkt umschalten, `option-language`), per Telefon (`forge_settings`).

## Desktop (`apps/desktop/src/i18n`)
- `import { t, locale, language } from "@/i18n"`. Die Sprache steht pro Seitenaufruf fest (aus localStorage, bevor etwas rendert). Deshalb darf `t.*` auch auf Modulebene stehen (Konstanten wie STEPS, SECTIONS).
- Texte liegen je Bereich in `i18n/de/<ns>.ts` (Quelle) und `i18n/en/<ns>.ts` (`export const ns: typeof De = {...}`). TypeScript erzwingt, dass Englisch jeden Schlüssel hat und keinen zusätzlichen. Texte mit Werten sind Funktionen: `stepOf: (n: number, total: number) => \`Schritt ${n} von ${total}\``. Mehrzahl in der Funktion lösen. Ein Satz mit Link oder Fettdruck: Funktion mit ReactNode-Parameter, die Datei darf dann `.tsx` sein.
- Datum und Zahlen über `locale` (`toLocaleString(locale, …)`), nie fest `"de-DE"`.
- Suchbegriffe (keywords) der Befehlspalette in beiden Sprachen, damit man in jeder Sprache findet.
- Tests: `src/test-setup.ts` stellt auf `de`, die bestehenden Tests prüfen deutsche Texte.

## Sidecar (`packages/sidecar/src/i18n`)
- `tr().<ns>.<key>`; `tr()` erst beim Erzeugen des Textes aufrufen (die Sprache kann während des Laufs wechseln). `setLanguage` folgt jedem `settings.updated` im `emit`-Wrapper von `app.ts` (RPC, Telefon, Sync, Backup).
- Tests: `test/setup-language.ts` (über `vitest.config.ts`) setzt `de` und `DEFAULT_SETTINGS.language = "de"`.

## Protokoll
- `pick({ en, de })` für Texte im Paket; `setProtocolLanguage` setzt jede Seite selbst (UI und Sidecar haben je eine Kopie). `formatTokens` (12.4k / 12,4 Tsd.), `forgeUsageLabel()`, `idleClosedDetail()`; gespeicherte Ereignisse behalten ihre Sprache, deshalb `isIdleClosedDetail` für beide.

## Neue Funktion
Jeder neue sichtbare Text kommt in beide Dateien. Kein Text direkt im JSX.
